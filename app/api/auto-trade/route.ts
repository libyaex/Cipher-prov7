import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from '@/lib/cx-engine/early-entry';
import type { TradingModeKey } from '@/lib/cx-engine/types';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { getBackgroundEngine } from '@/lib/server/background-engine';
import { computeEqualAllocationPlan, triggerEmergencyStop } from '@/lib/server/portfolio-guard';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

const VALID_MODES: TradingModeKey[] = ['scalp', 'intraday', 'swing', 'early'];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await resolveAuthenticatedUser(req, body.userId);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const userId = auth.userId;
    const action = body.action;
    const engine = getBackgroundEngine();

    if (action === 'emergency_stop') {
      const res = await triggerEmergencyStop(userId, body.reason || 'تفعيل الإيقاف الطارئ من المستخدم');
      await repo.appendEngineLog({
        userId,
        level: 'WARN',
        category: 'PROTECT',
        symbol: null,
        message: `إيقاف طارئ: تم إغلاق ${res.closedCount} صفقة/أمر وتعطيل التداول الآلي.`,
      });
      const [wallet, trades, ledger, workerState] = await Promise.all([
        repo.getWallet(userId),
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
        repo.getEngineState(userId),
      ]);
      return NextResponse.json({
        ok: true,
        ...res,
        wallet,
        trades,
        ledger,
        workerState,
        engine: engine.status,
      });
    }

    if (action === 'run_cycle') {
      const cycleResult = await engine.scanLoop(true);
      await engine.monitorLoop();
      const [wallet, trades, ledger, settings, workerState, engineLogs] = await Promise.all([
        repo.getWallet(userId),
        repo.getTrades(userId),
        repo.getLedger(userId, 80),
        repo.getBotSettings(userId),
        repo.getEngineState(userId),
        repo.getEngineLogs(userId, 40),
      ]);
      return NextResponse.json({
        ok: true,
        cycleResult,
        wallet,
        trades,
        ledger,
        settings,
        workerState,
        engineLogs,
        engine: engine.status,
      });
    }

    if (action === 'get_logs') {
      const engineLogs = await repo.getEngineLogs(userId, Number(body.limit || 60));
      const workerState = await repo.getEngineState(userId);
      return NextResponse.json({ ok: true, engineLogs, workerState });
    }

    if (action === 'update_settings') {
      const current = await repo.getBotSettings(userId);
      const patch = body.settings || {};

      let watchScore = Math.max(45, Math.min(90, Number(patch.watchScore ?? current.watchScore)));
      let minScore = Math.max(50, Math.min(95, Number(patch.minScore ?? current.minScore)));
      let strongScore = Math.max(60, Math.min(98, Number(patch.strongScore ?? current.strongScore)));

      if (minScore <= watchScore) minScore = Math.min(95, watchScore + 3);
      if (strongScore <= minScore) strongScore = Math.min(98, minScore + 5);

      const nextExecMode =
        patch.executionMode === 'AUTO' || patch.executionMode === 'MANUAL'
          ? patch.executionMode
          : patch.autoTradeEnabled !== undefined
            ? patch.autoTradeEnabled
              ? 'AUTO'
              : 'MANUAL'
            : current.executionMode || (current.autoTradeEnabled ? 'AUTO' : 'MANUAL');

      const nextMode: TradingModeKey = VALID_MODES.includes(patch.mode) ? patch.mode : current.mode;

      const rawTpPcts = Array.isArray(patch.tpPcts) && patch.tpPcts.length === 3
        ? patch.tpPcts.map((n: any) => Math.max(5, Math.min(90, Number(n) || 0)))
        : current.tpPcts || [40, 35, 25];
      const tpSum = rawTpPcts[0] + rawTpPcts[1] + rawTpPcts[2];
      const normalizedTpPcts: [number, number, number] =
        tpSum === 100
          ? [rawTpPcts[0], rawTpPcts[1], rawTpPcts[2]]
          : [
              Math.round((rawTpPcts[0] / (tpSum || 100)) * 100),
              Math.round((rawTpPcts[1] / (tpSum || 100)) * 100),
              100 -
                Math.round((rawTpPcts[0] / (tpSum || 100)) * 100) -
                Math.round((rawTpPcts[1] / (tpSum || 100)) * 100),
            ];

      const next = {
        ...current,
        ...patch,
        userId,
        mode: nextMode,
        earlyTriggerTf: ['5m', '15m', '1h'].includes(String(patch.earlyTriggerTf))
          ? String(patch.earlyTriggerTf)
          : current.earlyTriggerTf || '15m',
        executionMode: nextExecMode,
        autoTradeEnabled: nextExecMode === 'AUTO',
        riskPct: Math.max(0.1, Math.min(10, Number(patch.riskPct ?? current.riskPct))),
        maxLeverage: Math.max(1, Math.min(50, Math.round(Number(patch.maxLeverage ?? current.maxLeverage)))),
        maxOpenPositions: Math.max(1, Math.min(15, Math.round(Number(patch.maxOpenPositions ?? current.maxOpenPositions)))),
        equalAllocationEnabled:
          patch.equalAllocationEnabled !== undefined
            ? Boolean(patch.equalAllocationEnabled)
            : (current.equalAllocationEnabled ?? true),
        cashReservePct: Math.max(0, Math.min(50, Number(patch.cashReservePct ?? current.cashReservePct ?? 10))),
        maxPortfolioHeatPct: Math.max(1, Math.min(30, Number(patch.maxPortfolioHeatPct ?? current.maxPortfolioHeatPct ?? 6))),
        maxSameSidePositions: Math.max(1, Math.min(10, Math.round(Number(patch.maxSameSidePositions ?? current.maxSameSidePositions ?? 3)))),
        btcFilterEnabled: patch.btcFilterEnabled !== undefined ? Boolean(patch.btcFilterEnabled) : current.btcFilterEnabled,
        minVolumeUsdt: Math.max(0, Number(patch.minVolumeUsdt ?? current.minVolumeUsdt ?? 25_000_000)),
        maxSpreadBps: Math.max(1, Math.min(50, Number(patch.maxSpreadBps ?? current.maxSpreadBps ?? 8))),
        dailyLossLimitUsdt: Math.max(10, Number(patch.dailyLossLimitUsdt ?? current.dailyLossLimitUsdt)),
        dailyLossLimitPct: Math.max(0.5, Math.min(50, Number(patch.dailyLossLimitPct ?? current.dailyLossLimitPct))),
        minLiqSafetyPct: Math.max(10, Math.min(70, Number(patch.minLiqSafetyPct ?? current.minLiqSafetyPct))),
        tpPcts: normalizedTpPcts,
        limitExpireBars: Math.max(2, Math.min(48, Math.round(Number(patch.limitExpireBars ?? current.limitExpireBars ?? 8)))),
        cancelChasedAtr: Math.max(1.2, Math.min(5.0, Number(patch.cancelChasedAtr ?? current.cancelChasedAtr ?? 2.4))),
        allowReentry: patch.allowReentry !== undefined ? Boolean(patch.allowReentry) : (current.allowReentry ?? true),
        reentryCooldownBars: Math.max(1, Math.min(30, Math.round(Number(patch.reentryCooldownBars ?? current.reentryCooldownBars ?? 6)))),
        trailingStopEnabled:
          patch.trailingStopEnabled !== undefined
            ? Boolean(patch.trailingStopEnabled)
            : (current.trailingStopEnabled ?? true),
        filterFlags: {
          ...(current.filterFlags || {
            useFvg: true,
            useOb: true,
            useChochBos: true,
            useMomentum: true,
            useOrderFlow: true,
            btcShockBlock: true,
          }),
          ...(patch.filterFlags || {}),
        },
        notifyPrefs: {
          ...(current.notifyPrefs || {
            browser: true,
            push: true,
            sound: true,
            onOpen: true,
            onClose: true,
            onRisk: true,
            onError: true,
          }),
          ...(patch.notifyPrefs || {}),
        },
        earlyWeights: patch.earlyWeights
          ? normalizeEarlyWeights(patch.earlyWeights)
          : (current.earlyWeights || DEFAULT_EARLY_WEIGHTS),
        smartProfitShield:
          patch.smartProfitShield !== undefined
            ? Boolean(patch.smartProfitShield)
            : (current.smartProfitShield ?? true),
        smartTakeProfitEnabled:
          patch.smartTakeProfitEnabled !== undefined
            ? Boolean(patch.smartTakeProfitEnabled)
            : (current.smartTakeProfitEnabled ?? true),
        smartTakeProfitMinR: Math.max(
          0.25,
          Math.min(3, Number(patch.smartTakeProfitMinR ?? current.smartTakeProfitMinR ?? 0.6))
        ),
        smartTakeProfitPartialPct: Math.max(
          10,
          Math.min(100, Math.round(Number(patch.smartTakeProfitPartialPct ?? current.smartTakeProfitPartialPct ?? 50)))
        ),
        smartTakeProfitSensitivity: (['conservative', 'balanced', 'aggressive'].includes(
          String(patch.smartTakeProfitSensitivity)
        )
          ? patch.smartTakeProfitSensitivity
          : current.smartTakeProfitSensitivity || 'balanced') as 'conservative' | 'balanced' | 'aggressive',
        watchScore,
        minScore,
        strongScore,
        allowedSymbols: Array.isArray(patch.allowedSymbols)
          ? [...new Set(patch.allowedSymbols.map((s: string) => s.trim().toUpperCase()).filter(Boolean))]
          : current.allowedSymbols,
      };

      if (body.clearEmergency || (next.autoTradeEnabled === true && current.emergencyStopped)) {
        next.emergencyStopped = false;
        next.emergencyReason = null;
      }

      const saved = await repo.saveBotSettings(next);

      if (current.executionMode !== saved.executionMode || current.mode !== saved.mode) {
        await repo.appendEngineLog({
          userId,
          level: 'INFO',
          category: 'WORKER',
          symbol: null,
          message: `تحديث نمط التشغيل: ${saved.executionMode} · الاستراتيجية: ${saved.mode} (${saved.earlyTriggerTf})`,
        });
      }

      const [wallet, trades] = await Promise.all([repo.getWallet(userId), repo.getTrades(userId)]);
      const openCount = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
      const allocation = computeEqualAllocationPlan({ wallet, settings: saved, openTradesCount: openCount });

      return NextResponse.json({
        ok: true,
        settings: saved,
        allocation,
        engine: engine.status,
      });
    }

    return NextResponse.json({ ok: false, error: 'عملية غير مدعومة' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
