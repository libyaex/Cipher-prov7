import { NextRequest, NextResponse } from 'next/server';
import { prepare, resolveModeConfig } from '@/lib/cx-engine/analyzer';
import { TF_MS } from '@/lib/cx-engine/indicators';
import { evaluate } from '@/lib/cx-engine/planner';
import type { Candle, DerivData } from '@/lib/cx-engine/types';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { getBackgroundEngine } from '@/lib/server/background-engine';
import { binanceServer } from '@/lib/server/binance-client';
import {
  closePaperPosition,
  computeEqualAllocationPlan,
  openPaperTrade,
} from '@/lib/server/portfolio-guard';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req, req.nextUrl.searchParams.get('userId'));
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const userId = auth.userId;
    const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true';
    const engine = getBackgroundEngine();

    const [wallet, trades, ledger, settings, workerState, engineLogs] = await Promise.all([
      repo.getWallet(userId),
      repo.getTrades(userId, includeArchived),
      repo.getLedger(userId, 80),
      repo.getBotSettings(userId),
      repo.getEngineState(userId),
      repo.getEngineLogs(userId, 40),
    ]);

    const openTrades = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
    const allocation = computeEqualAllocationPlan({
      wallet,
      settings,
      openTradesCount: openTrades.length,
    });

    return NextResponse.json({
      ok: true,
      serverTime: Date.now(),
      wallet,
      trades,
      ledger,
      settings,
      allocation,
      workerState,
      engineLogs,
      engine: engine.status,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await resolveAuthenticatedUser(req, body.userId);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const userId = auth.userId;
    const action = body.action;

    if (action === 'set_initial_capital') {
      const cap = Number(body.initialCapitalUsdt);
      if (!Number.isFinite(cap) || cap < 10 || cap > 100_000_000) {
        return NextResponse.json(
          { ok: false, error: 'رأس المال يجب أن يكون بين 10 و 100,000,000 USDT' },
          { status: 400 }
        );
      }
      const wallet = await repo.setInitialCapital(userId, cap);
      await repo.appendEngineLog({
        userId,
        level: 'INFO',
        category: 'CAPITAL',
        symbol: null,
        message: `تم تحديث رأس المال الافتراضي للمحفظة التجريبية إلى ${cap.toFixed(2)} USDT دون المساس بسجل الصفقات التاريخي.`,
      });
      const [trades, ledger, settings] = await Promise.all([
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
        repo.getBotSettings(userId),
      ]);
      const openCount = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
      const allocation = computeEqualAllocationPlan({ wallet, settings, openTradesCount: openCount });
      return NextResponse.json({ ok: true, wallet, allocation, trades, ledger });
    }

    if (action === 'reset_wallet' || action === 'reset_simulation') {
      const archiveHistory = body.archiveHistory !== false;
      const newCap = body.newInitialCapital != null ? Number(body.newInitialCapital) : undefined;
      if (newCap != null && (!Number.isFinite(newCap) || newCap < 10 || newCap > 100_000_000)) {
        return NextResponse.json(
          { ok: false, error: 'رأس المال غير صالح' },
          { status: 400 }
        );
      }
      const wallet = await repo.resetSimulation(userId, {
        archiveHistory,
        newInitialCapital: newCap,
      });
      await repo.appendEngineLog({
        userId,
        level: 'WARN',
        category: 'CAPITAL',
        symbol: null,
        message: `إعادة تعيين المحفظة التجريبية إلى ${wallet.initialBalanceUsdt.toFixed(2)} USDT (${archiveHistory ? 'مع أرشفة السجل السابق' : 'مسح سريع'}).`,
      });
      const [trades, ledger, settings] = await Promise.all([
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
        repo.getBotSettings(userId),
      ]);
      const allocation = computeEqualAllocationPlan({ wallet, settings, openTradesCount: 0 });
      return NextResponse.json({ ok: true, wallet, allocation, trades, ledger });
    }

    if (action === 'close_position') {
      const positionId = String(body.positionId || '');
      const trades = await repo.getTrades(userId);
      const pos = trades.find((t) => t.id === positionId && t.userId === userId);
      if (!pos) {
        return NextResponse.json({ ok: false, error: 'المركز غير موجود أو غير مصرح به' }, { status: 404 });
      }
      let exitPrice = Number(body.exitPrice);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        exitPrice = await binanceServer.tickerPrice(pos.symbol).catch(() => pos.markPriceLast || pos.entryPrice);
      }
      const closed = await closePaperPosition({
        userId,
        position: pos,
        exitPrice,
        outcome: pos.status === 'PENDING' ? 'CANCELLED_MANUAL' : 'MANUAL',
        reasonLabel: pos.status === 'PENDING' ? 'إلغاء يدوي للأمر المعلق' : 'إغلاق يدوي من المحفظة التجريبية',
      });
      const [wallet, updatedTrades, ledger, settings] = await Promise.all([
        repo.getWallet(userId),
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
        repo.getBotSettings(userId),
      ]);
      const openCount = updatedTrades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
      const allocation = computeEqualAllocationPlan({ wallet, settings, openTradesCount: openCount });
      return NextResponse.json({
        ok: true,
        position: closed,
        wallet,
        allocation,
        trades: updatedTrades,
        ledger,
      });
    }

    if (action === 'open_manual') {
      const symbol = String(body.symbol || '').toUpperCase();
      if (!symbol || !/^[A-Z0-9]+$/.test(symbol)) {
        return NextResponse.json({ ok: false, error: 'رمز العملة غير صالح' }, { status: 400 });
      }
      const settings = await repo.getBotSettings(userId);
      const wallet = await repo.getWallet(userId);
      let evaluation = body.evaluation;
      const metaAll = await binanceServer.exchangeInfo();
      const meta = metaAll[symbol] || body.meta || {};
      const pm = await binanceServer.premium().catch(() => ({} as Record<string, any>));
      const pInfo = pm[symbol];
      const tfs = resolveModeConfig(settings.mode, settings.earlyTriggerTf);
      const trigMs = TF_MS[tfs.trigger] || 900e3;

      if (!evaluation || !evaluation.plan) {
        const tfList = [...new Set([tfs.trigger, tfs.setup, tfs.trend, tfs.htf].filter(Boolean) as string[])];
        const klineResults = await Promise.all(
          tfList.map((tf) => binanceServer.klines(symbol, tf, tf === tfs.htf ? 120 : 400))
        );
        const candlesMap: Record<string, Candle[]> = {};
        tfList.forEach((tf, idx) => {
          candlesMap[tf] = klineResults[idx].filter((c) => c.x !== false);
        });
        const ctx = prepare(candlesMap, tfs, meta, {
          mode: settings.mode,
          earlyTriggerTf: settings.earlyTriggerTf,
          minScore: settings.minScore,
          strongScore: settings.strongScore,
          watchScore: settings.watchScore,
          equity: wallet.balanceUsdt,
          riskPct: settings.riskPct,
          maxLev: settings.maxLeverage,
          takerFee: settings.takerFee,
          makerFee: settings.makerFee,
          slip: settings.slippage,
          minLiqSafetyPct: settings.minLiqSafetyPct,
          tpPcts: settings.tpPcts,
          limitExpireBars: settings.limitExpireBars,
          cancelChasedAtr: settings.cancelChasedAtr,
          earlyWeights: settings.earlyWeights,
        });
        const T = ctx.B.trigger;
        if (!T) {
          return NextResponse.json({ ok: false, error: 'بيانات الشموع غير كافية' }, { status: 400 });
        }
        const livePx = await binanceServer.tickerPrice(symbol).catch(() => T.c[T.n - 1]);
        const deriv: DerivData = pInfo
          ? {
              funding: pInfo.funding,
              fundingMs: pInfo.next,
              basisBps: pInfo.index > 0 ? (1e4 * (pInfo.mark - pInfo.index)) / pInfo.index : undefined,
            }
          : {};
        const microCandles: Record<string, Candle[]> = {};
        if (candlesMap['5m']?.length) microCandles['5m'] = candlesMap['5m'].slice(-90);
        let book = null;
        let vol24h: number | undefined;
        const [c1mRes, c5mRes, dpRes, tkRes] = await Promise.allSettled([
          binanceServer.klines(symbol, '1m', 90),
          microCandles['5m'] ? Promise.resolve(microCandles['5m']) : binanceServer.klines(symbol, '5m', 90),
          binanceServer.depth(symbol, 100),
          binanceServer.tickers(),
        ]);
        if (c1mRes.status === 'fulfilled') microCandles['1m'] = c1mRes.value;
        if (c5mRes.status === 'fulfilled' && !microCandles['5m']) microCandles['5m'] = c5mRes.value;
        if (dpRes.status === 'fulfilled') book = binanceServer.bookAnalysis(dpRes.value);
        if (tkRes.status === 'fulfilled' && tkRes.value[symbol]) vol24h = tkRes.value[symbol].vol;

        evaluation = evaluate(ctx, T.n - 1, {
          price: livePx,
          deriv,
          book,
          microCandles,
          vol24h,
          minVolumeUsdt: settings.minVolumeUsdt,
          maxSpreadBps: settings.maxSpreadBps,
          now: binanceServer.now(),
        });
      }

      const res = await openPaperTrade({
        userId,
        symbol,
        evaluation,
        meta,
        markPrice: pInfo?.mark ?? evaluation?.price,
        expireBars: evaluation?.plan?.expireBars,
        triggerMs: trigMs,
        idempotencyKey: body.idempotencyKey,
        source: 'MANUAL',
      });

      const [updatedWallet, updatedTrades, ledger] = await Promise.all([
        repo.getWallet(userId),
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
      ]);
      const openCount = updatedTrades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
      const allocation = computeEqualAllocationPlan({ wallet: updatedWallet, settings, openTradesCount: openCount });

      return NextResponse.json(
        {
          ok: res.ok,
          reason: res.reason,
          position: res.position,
          wallet: updatedWallet,
          allocation,
          trades: updatedTrades,
          ledger,
        },
        { status: res.ok ? 200 : 400 }
      );
    }

    return NextResponse.json({ ok: false, error: 'عملية غير معروفة' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
