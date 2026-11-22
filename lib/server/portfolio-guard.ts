import {
  calcLiquidationPrice,
  calcMaintenanceMarginRate,
  sizePosition,
  validateStopBeforeLiquidation,
} from '../cx-engine/planner';
import { isN, util } from '../cx-engine/indicators';
import { computeOrderFlowSnapshot } from '../cx-engine/orderflow';
import { detectMomentumReversalSignal } from '../cx-engine/smart-tp';
import type {
  BotSettings,
  BtcContext,
  Candle,
  EqualAllocationPlan,
  OrderBookAnalysis,
  PaperPosition,
  PaperWallet,
  SignalEvaluation,
  SymbolMeta,
} from '../cx-engine/types';
import { binanceServer } from './binance-client';
import { emitAlert } from './push-service';
import { DEFAULT_USER_ID, repo } from './repository';

const F = (p: number, tick?: number) => util.fmtP(p, tick);

export function computeEqualAllocationPlan(params: {
  wallet: Pick<PaperWallet, 'balanceUsdt' | 'lockedMarginUsdt'>;
  settings: Pick<BotSettings, 'equalAllocationEnabled' | 'cashReservePct' | 'maxOpenPositions' | 'riskPct'>;
  openTradesCount: number;
}): EqualAllocationPlan {
  const { wallet, settings, openTradesCount } = params;
  const totalEquityUsdt = Math.max(0, (wallet.balanceUsdt || 0) + (wallet.lockedMarginUsdt || 0));
  const equalAllocationEnabled = settings.equalAllocationEnabled !== false;
  const cashReservePct = Math.max(0, Math.min(50, Number(settings.cashReservePct ?? 10)));
  const maxOpenPositions = Math.max(1, Number(settings.maxOpenPositions || 4));
  const reservedCashUsdt = equalAllocationEnabled ? (totalEquityUsdt * cashReservePct) / 100 : 0;
  const allocatableUsdt = Math.max(0, totalEquityUsdt - reservedCashUsdt);
  const perPositionSleeveUsdt = equalAllocationEnabled
    ? allocatableUsdt / maxOpenPositions
    : allocatableUsdt;
  const availableSleevesCount = Math.max(0, maxOpenPositions - openTradesCount);
  const maxPositionRiskUsd = (totalEquityUsdt * Number(settings.riskPct || 1)) / 100;

  return {
    equalAllocationEnabled,
    totalEquityUsdt: +totalEquityUsdt.toFixed(2),
    cashReservePct,
    reservedCashUsdt: +reservedCashUsdt.toFixed(2),
    allocatableUsdt: +allocatableUsdt.toFixed(2),
    maxOpenPositions,
    perPositionSleeveUsdt: +perPositionSleeveUsdt.toFixed(2),
    usedMarginUsdt: +(wallet.lockedMarginUsdt || 0).toFixed(2),
    availableSleevesCount,
    openCount: openTradesCount,
    maxPositionRiskUsd: +maxPositionRiskUsd.toFixed(2),
  };
}

const recentRejectAlerts = new Map<string, number>();
async function emitRejectAlertOnce(userId: string, symbol: string, tag: string, title: string, body: string) {
  const key = `${userId}:${symbol}:${tag}`;
  const last = recentRejectAlerts.get(key) || 0;
  if (Date.now() - last < 30 * 60_000) return;
  recentRejectAlerts.set(key, Date.now());
  await emitAlert({
    userId,
    eventType: 'TRADE_REJECTED',
    severity: 'warning',
    symbol,
    title,
    body,
  });
}

export function calcPortfolioHeatUsd(trades: PaperPosition[]): number {
  let total = 0;
  for (const t of trades) {
    if (t.status !== 'OPEN' && t.status !== 'PENDING') continue;
    const perUnitRisk =
      t.side === 'LONG'
        ? Math.max(0, t.entryPrice - t.stopCurrent)
        : Math.max(0, t.stopCurrent - t.entryPrice);
    total += perUnitRisk * t.remainingQty;
  }
  return total;
}

export interface OpenTradeInput {
  userId?: string;
  symbol: string;
  evaluation: SignalEvaluation;
  meta?: Partial<SymbolMeta>;
  markPrice?: number;
  lastFundingTs?: number;
  vol24h?: number;
  spreadBps?: number;
  btcContext?: BtcContext | null;
  expireBars?: number;
  triggerMs?: number;
  idempotencyKey?: string;
  source: 'AUTO' | 'MANUAL';
}

export async function openPaperTrade(
  input: OpenTradeInput
): Promise<{ ok: boolean; reason?: string; position?: PaperPosition }> {
  const userId = input.userId || DEFAULT_USER_ID;
  const settings = await repo.getBotSettings(userId);
  const wallet = await repo.getWallet(userId);
  const allTrades = await repo.getTrades(userId);
  const openTrades = allTrades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
  const { symbol, evaluation: R, meta } = input;

  if (!R.plan || !R.plan.ok || !R.dir) {
    return { ok: false, reason: 'لا توجد خطة صفقة صالحة' };
  }
  const plan = R.plan;
  const side: 'LONG' | 'SHORT' = plan.dir! > 0 ? 'LONG' : 'SHORT';
  const long = side === 'LONG';
  const idemKey =
    input.idempotencyKey || `open:${userId}:${symbol}:${R.t}:${side}:${plan.type}`;

  // 1. Prevent duplicate execution for same signal/bar
  if (allTrades.some((t) => t.idempotencyKey === idemKey)) {
    return { ok: false, reason: 'تم تنفيذ هذه الإشارة مسبقاً (حماية التكرار)' };
  }

  // 2. Auto-Trade Circuit Breakers & Portfolio Risk Shield
  if (input.source === 'AUTO') {
    if (settings.emergencyStopped) {
      return { ok: false, reason: 'التداول متوقف بسبب زر الإيقاف الطارئ' };
    }
    if (!settings.autoTradeEnabled) {
      return { ok: false, reason: 'التداول الآلي غير مفعّل' };
    }
    if (
      settings.allowedSymbols.length > 0 &&
      !settings.allowedSymbols.includes(symbol)
    ) {
      return { ok: false, reason: `العملة ${symbol} غير مدرجة في العملات المسموحة` };
    }
    if (openTrades.length >= settings.maxOpenPositions) {
      return {
        ok: false,
        reason: `تم بلوغ الحد الأقصى للصفقات المفتوحة (${settings.maxOpenPositions})`,
      };
    }

    // Same-Side Correlation Cap
    const sameSideCount = openTrades.filter((t) => t.side === side).length;
    if (sameSideCount >= (settings.maxSameSidePositions || 3)) {
      const msg = `تم بلوغ الحد الأقصى للصفقات في نفس الاتجاه (${sameSideCount}/${settings.maxSameSidePositions} ${side})`;
      await emitRejectAlertOnce(userId, symbol, `sameside:${side}`, `حظر تركّز الاتجاه — ${symbol}`, msg);
      return { ok: false, reason: msg };
    }

    // Liquidity / 24h Volume Filter
    if (
      isN(input.vol24h) &&
      (settings.minVolumeUsdt || 0) > 0 &&
      input.vol24h < settings.minVolumeUsdt
    ) {
      const msg = `سيولة 24h منخفضة (${(input.vol24h / 1e6).toFixed(1)}M$ < ${(settings.minVolumeUsdt / 1e6).toFixed(1)}M$)`;
      await emitRejectAlertOnce(userId, symbol, 'lowvol', `فلتر السيولة — ${symbol}`, msg);
      return { ok: false, reason: msg };
    }

    // Spread Filter
    const effSpread = isN(input.spreadBps) ? input.spreadBps : R.book?.spreadBps;
    if (
      isN(effSpread) &&
      (settings.maxSpreadBps || 0) > 0 &&
      effSpread > settings.maxSpreadBps
    ) {
      const msg = `سبريد دفتر الأوامر مرتفع (${effSpread.toFixed(1)} bps > ${settings.maxSpreadBps} bps)`;
      await emitRejectAlertOnce(userId, symbol, 'spread', `فلتر السبريد — ${symbol}`, msg);
      return { ok: false, reason: msg };
    }

    // Integrated Lower-TF Order Flow Radar & Liquidity Gate
    if (R.orderFlow) {
      const dirNum = long ? 1 : -1;
      if (!R.orderFlow.liquidity.liquidityPass) {
        const msg = R.orderFlow.liquidity.reasons[0] || `فشل فلتر السيولة المدمج على ${symbol}`;
        await emitRejectAlertOnce(userId, symbol, 'radar_liq', `رادار السيولة — ${symbol}`, msg);
        return { ok: false, reason: msg };
      }
      if (
        R.orderFlow.verdict === 'COUNTER_FLOW' &&
        R.orderFlow.confidence >= 0.48 &&
        dirNum * R.orderFlow.netBias <= -0.42
      ) {
        const msg = `رادار السيولة (${R.orderFlow.primaryTf}): تدفق أوامر معاكس (${(R.orderFlow.netBias * 100).toFixed(0)}%)`;
        await emitRejectAlertOnce(userId, symbol, `flow:${side}`, `حماية تدفق السيولة — ${symbol}`, msg);
        return { ok: false, reason: msg };
      }
    }

    // BTC Macro Trend & Shock Guard
    const btc = input.btcContext || R.btcContext;
    if (settings.btcFilterEnabled && btc && symbol !== 'BTCUSDT') {
      const dirNum = long ? 1 : -1;
      if (btc.shock && btc.dir !== dirNum) {
        const msg = `حماية BTC: ${btc.detail} تعاكس ${side}`;
        await emitRejectAlertOnce(userId, symbol, `btc:${side}`, `حماية BTC — ${symbol}`, msg);
        return { ok: false, reason: msg };
      }
      if (!btc.shock && Math.abs(btc.score) >= 0.48 && btc.dir && btc.dir !== dirNum) {
        const msg = `اتجاه BTC الماكرو قوي ومعاكس (${btc.detail})`;
        await emitRejectAlertOnce(userId, symbol, `btc:${side}`, `حماية اتجاه BTC — ${symbol}`, msg);
        return { ok: false, reason: msg };
      }
    }

    // Daily Loss Limit Circuit Breaker
    const maxDailyLoss = Math.min(
      settings.dailyLossLimitUsdt,
      (wallet.initialBalanceUsdt * settings.dailyLossLimitPct) / 100
    );
    if (wallet.dailyPnlUsdt <= -Math.abs(maxDailyLoss)) {
      await emitRejectAlertOnce(
        userId,
        symbol,
        'daily_loss',
        `تجاوز حد الخسارة اليومي — ${symbol}`,
        `تم رفض صفقة ${side} لأن الخسارة اليومية (${wallet.dailyPnlUsdt.toFixed(2)} USDT) تجاوزت الحد (${maxDailyLoss.toFixed(2)} USDT).`
      );
      return { ok: false, reason: 'تم بلوغ حد الخسارة اليومي' };
    }
  }

  if (openTrades.some((t) => t.symbol === symbol)) {
    return { ok: false, reason: `يوجد مركز مفتوح بالفعل على ${symbol}` };
  }

  // 3. Available balance, Equal Capital Allocation sleeve, & realistic entry price
  const allocPlan = computeEqualAllocationPlan({
    wallet,
    settings,
    openTradesCount: openTrades.length,
  });
  const availableUsdt = Math.max(0, wallet.balanceUsdt - wallet.lockedMarginUsdt);
  const freeUnreservedUsdt = Math.max(0, availableUsdt - (allocPlan.equalAllocationEnabled ? allocPlan.reservedCashUsdt * 0.5 : 0));
  if (availableUsdt < 10) {
    return { ok: false, reason: 'الرصيد المتاح في المحفظة التجريبية غير كافٍ' };
  }

  const rawEntry = plan.entry!;
  const slipRate = plan.type === 'MARKET' ? settings.slippage : 0;
  const entryPrice =
    plan.type === 'MARKET'
      ? long
        ? rawEntry * (1 + slipRate)
        : rawEntry * (1 - slipRate)
      : rawEntry;
  const stopLoss = plan.stop!;

  // 4. Size position & enforce Portfolio Protection (RiskPct ALWAYS takes strict precedence over leverage)
  const size = sizePosition({
    entry: entryPrice,
    stop: stopLoss,
    equity: wallet.balanceUsdt,
    riskPct: settings.riskPct * (plan.type === 'MARKET' && !plan.confirmed ? 0.5 : 1),
    maxLev: settings.maxLeverage,
    mmr: 0.005,
    takerFee: settings.takerFee,
    minSafetyPct: settings.minLiqSafetyPct,
    step: meta?.step,
    minQty: meta?.minQty,
    minNotional: meta?.minNotional,
    long,
  });

  if (!size.ok || !size.safetyOk) {
    const reason = size.note || 'تم رفض الصفقة لعدم توفر مسافة أمان كافية قبل التصفية';
    await emitRejectAlertOnce(userId, symbol, 'safety', `رفض حماية المحفظة — ${symbol}`, reason);
    return { ok: false, reason };
  }

  // Enforce Equal Capital Allocation margin ceiling per sleeve WITHOUT exceeding riskPct or raising leverage
  if (allocPlan.equalAllocationEnabled && size.margin > allocPlan.perPositionSleeveUsdt + 0.01) {
    const targetMaxNotional = allocPlan.perPositionSleeveUsdt * size.lev;
    const step = meta?.step || 0;
    let cappedQty = targetMaxNotional / entryPrice;
    if (step > 0) {
      const d = Math.max(0, Math.round(-Math.log10(step)));
      cappedQty = +(Math.floor(cappedQty / step + 1e-9) * step).toFixed(d);
    }
    const cappedNotional = cappedQty * entryPrice;
    const minQty = meta?.minQty || 0;
    const minNotional = meta?.minNotional || 5;
    if (cappedQty <= 0 || (minQty > 0 && cappedQty < minQty) || cappedNotional < minNotional) {
      const reason = `شريحة التوزيع المتساوي (${allocPlan.perPositionSleeveUsdt.toFixed(2)}$) لا تكفي الحد الأدنى لعقد ${symbol}`;
      await emitRejectAlertOnce(userId, symbol, 'sleeve', `توزيع رأس المال — ${symbol}`, reason);
      return { ok: false, reason };
    }
    const riskDist = Math.abs(entryPrice - stopLoss);
    size.qty = cappedQty;
    size.notional = cappedNotional;
    size.margin = cappedNotional / size.lev;
    size.effRiskUsd = cappedQty * riskDist;
    size.effRiskPct = wallet.balanceUsdt > 0 ? (100 * size.effRiskUsd) / wallet.balanceUsdt : 0;
    size.limited = true;
    size.note = `تم تقييد الهامش بشريحة التوزيع المتساوي (${allocPlan.perPositionSleeveUsdt.toFixed(2)}$)`;
  }

  // Portfolio Total Heat Cap check
  const activeHeatUsd = calcPortfolioHeatUsd(openTrades);
  const newHeatUsd = size.effRiskUsd;
  const totalHeatPct = wallet.balanceUsdt > 0 ? ((activeHeatUsd + newHeatUsd) / wallet.balanceUsdt) * 100 : 100;
  if (input.source === 'AUTO' && totalHeatPct > (settings.maxPortfolioHeatPct || 6) + 0.01) {
    const reason = `تجاوز حد المخاطرة الكلية للمحفظة (${totalHeatPct.toFixed(2)}% > ${settings.maxPortfolioHeatPct}%)`;
    await emitRejectAlertOnce(userId, symbol, 'heat', `حظر المخاطرة الكلية — ${symbol}`, reason);
    return { ok: false, reason };
  }

  if (size.margin > freeUnreservedUsdt && size.margin > availableUsdt) {
    return {
      ok: false,
      reason: `الهامش المطلوب (${size.margin.toFixed(2)}$) يتجاوز الرصيد المتاح (${availableUsdt.toFixed(2)}$)`,
    };
  }

  const effMmr = calcMaintenanceMarginRate(size.notional, 0.005);
  const liqPrice = calcLiquidationPrice({
    entry: entryPrice,
    lev: size.lev,
    mmr: effMmr,
    long,
    takerFee: settings.takerFee,
  });
  const safety = validateStopBeforeLiquidation({
    entry: entryPrice,
    stop: stopLoss,
    liq: liqPrice,
    long,
    minSafetyPct: settings.minLiqSafetyPct,
  });
  if (!safety.safetyOk) {
    await emitRejectAlertOnce(
      userId,
      symbol,
      'liq_safety',
      `رفض حماية التصفية — ${symbol}`,
      safety.reason || 'مسافة الأمان قبل التصفية غير كافية'
    );
    return { ok: false, reason: safety.reason };
  }

  const isImmediate = plan.type === 'MARKET';
  const feeRate = isImmediate ? settings.takerFee : settings.makerFee;
  const openFeeUsdt = isImmediate ? size.notional * feeRate : 0;
  const slippageUsdt = isImmediate ? Math.abs(entryPrice - rawEntry) * size.qty : 0;
  const posId = `pos-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();
  const expiresAt =
    plan.type === 'LIMIT'
      ? new Date(Date.now() + (input.expireBars || plan.expireBars || 8) * (input.triggerMs || 900e3)).toISOString()
      : null;

  const entryKind = R.earlyEntry?.entryKind || 'CONFIRMED_ENTRY';
  const position: PaperPosition = {
    id: posId,
    userId,
    idempotencyKey: idemKey,
    symbol,
    side,
    orderType: plan.type || 'MARKET',
    status: plan.type === 'MARKET' ? 'OPEN' : 'PENDING',
    score: R.score,
    tier: R.tier,
    mode: settings.mode,
    entryKind,
    simulationRunId: wallet.simulationRunId || 'run-1',
    archivedAt: null,
    entryPrice,
    stopLoss,
    stopCurrent: stopLoss,
    liqPrice,
    markPriceLast: input.markPrice ?? entryPrice,
    maintenanceMarginRate: effMmr,
    maintenanceMarginUsdt: size.notional * effMmr,
    leverage: size.lev,
    qty: size.qty,
    remainingQty: size.qty,
    notionalUsdt: size.notional,
    marginUsdt: size.margin,
    tps: (plan.tps || []).map((t) => ({ p: t.p, pct: t.pct, hit: false, r: t.r })),
    feesUsdt: openFeeUsdt,
    slippageUsdt,
    fundingUsdt: 0,
    realizedPnlUsdt: 0,
    netPnlUsdt: -openFeeUsdt,
    rMultiple: null,
    outcome: null,
    exitPrice: null,
    lastFundingTs: input.lastFundingTs || Date.now(),
    safetyBufferPct: safety.safetyBufferPct,
    openedAt: nowIso,
    filledAt: plan.type === 'MARKET' ? nowIso : null,
    closedAt: null,
    expiresAt,
    liqWarningSent: false,
    meta: {
      tick: meta?.tick || 0,
      source: input.source,
      stopRef: plan.stopRef,
      expiresAt,
      entryKind,
      sleeveUsdt: allocPlan.perPositionSleeveUsdt,
      distanceMovedPct: R.earlyEntry?.distanceMovedPct ?? 0,
      earlyReason: R.earlyEntry?.earlyReason || '',
    },
  };

  // 5. Idempotent wallet lock (+ entry fee deduction only for immediate MARKET fills)
  const ledgerRes = await repo.applyWalletOp({
    userId,
    idempotencyKey: `lock:${idemKey}`,
    opType: isImmediate ? 'OPEN_TRADE' : 'MARGIN_LOCK',
    symbol,
    positionId: posId,
    balanceDelta: -openFeeUsdt,
    marginDelta: size.margin,
    realizedDelta: -openFeeUsdt,
    feeDelta: openFeeUsdt,
    fundingDelta: 0,
    note: isImmediate
      ? `فتح صفقة ${side} ${symbol} (${size.lev}x) · رسوم ${openFeeUsdt.toFixed(2)}$`
      : `حجز هامش أمر معلق ${side} ${symbol} (${size.lev}x · بدون رسوم حتى التنفيذ)`,
  });

  if (!ledgerRes.applied && ledgerRes.duplicate) {
    return { ok: false, reason: 'عملية مالية مكررة تم حظرها' };
  }

  await repo.upsertTrade(position);

  await repo.upsertSignalAnalytics({
    id: `sig-tr-${posId}`,
    userId,
    symbol,
    side,
    strategyMode: settings.mode,
    entryKind,
    entryStatus: R.earlyEntry?.entryStatus || (plan.type === 'LIMIT' ? 'WAIT_RETEST' : 'CONFIRMED'),
    timeframe: R.tf?.trigger || '15m',
    regime: R.regime?.type || 'range',
    score: R.score,
    rawScore: R.rawScore,
    signalPrice: R.price,
    entryPrice,
    fillPrice: plan.type === 'MARKET' ? entryPrice : null,
    distanceMovedPct: R.earlyEntry?.distanceMovedPct ?? 0,
    delayMs: 0,
    stillValid: true,
    earlyReason: R.earlyEntry?.earlyReason || '',
    confirmFactors: R.earlyEntry?.confirmFactors || plan.confirmBits || [],
    missingConfirmations: R.earlyEntry?.missingConfirmations || [],
    scoreBreakdown: R.earlyEntry?.breakdown || {},
    takenByUserOrAuto: true,
    positionId: posId,
    wasLateEntry: Boolean(R.earlyEntry?.fomoChasing || (R.earlyEntry?.distanceMovedPct ?? 0) >= 2.0),
    simulationRunId: wallet.simulationRunId || 'run-1',
    createdAt: nowIso,
  });

  await repo.appendEngineLog({
    userId,
    level: 'DECISION',
    category: 'EXECUTE',
    symbol,
    message: `${input.source === 'AUTO' ? 'تنفيذ آلي' : 'تنفيذ يدوي'}: ${side} ${symbol} (${entryKind}) · هامش ${size.margin.toFixed(2)}$ / شريحة ${allocPlan.perPositionSleeveUsdt.toFixed(2)}$`,
    details: { posId, leverage: size.lev, score: R.score, entryPrice, stopLoss },
  });

  await emitAlert({
    userId,
    eventType: 'TRADE_OPEN',
    severity: 'success',
    symbol,
    title: `${plan.type === 'LIMIT' ? 'تعليق أمر' : 'فتح صفقة'} ${side} — ${symbol}`,
    body: `دخول ${F(entryPrice, meta?.tick)} · وقف ${F(stopLoss, meta?.tick)} · تصفية ${F(liqPrice, meta?.tick)} · رافعة ${size.lev}x · هامش ${size.margin.toFixed(2)}$`,
  });

  return { ok: true, position };
}

export async function closePaperPosition(params: {
  userId?: string;
  position: PaperPosition;
  exitPrice: number;
  outcome: string;
  reasonLabel: string;
  isLiquidation?: boolean;
}) {
  const userId = params.userId || DEFAULT_USER_ID;
  const settings = await repo.getBotSettings(userId);
  const pos = params.position;
  if (pos.status === 'CLOSED' || pos.status === 'CANCELLED' || pos.status === 'LIQUIDATED') {
    return pos;
  }

  const long = pos.side === 'LONG';
  const dir = long ? 1 : -1;

  if (pos.status === 'PENDING') {
    pos.status = 'CANCELLED';
    pos.outcome = params.outcome;
    pos.closedAt = new Date().toISOString();
    await repo.applyWalletOp({
      userId,
      idempotencyKey: `cancel:${pos.id}`,
      opType: 'MARGIN_RELEASE',
      symbol: pos.symbol,
      positionId: pos.id,
      balanceDelta: 0,
      marginDelta: -pos.marginUsdt,
      realizedDelta: 0,
      feeDelta: 0,
      fundingDelta: 0,
      note: `إلغاء أمر معلق ${pos.symbol}: ${params.reasonLabel}`,
    });
    await repo.upsertTrade(pos);
    return pos;
  }

  const closeNotional = pos.remainingQty * params.exitPrice;
  const closeFee = closeNotional * settings.takerFee;
  const slipCost = params.isLiquidation ? 0 : closeNotional * settings.slippage;
  const rawPricePnl = params.isLiquidation
    ? -pos.marginUsdt
    : dir * (params.exitPrice - pos.entryPrice) * pos.remainingQty;
  const netCloseDelta = params.isLiquidation
    ? -pos.marginUsdt
    : rawPricePnl - closeFee - slipCost;

  pos.realizedPnlUsdt += rawPricePnl;
  pos.feesUsdt += closeFee;
  pos.slippageUsdt += slipCost;
  pos.netPnlUsdt = pos.realizedPnlUsdt - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;
  const initialRiskUsd = Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty;
  pos.rMultiple = initialRiskUsd > 0 ? pos.netPnlUsdt / initialRiskUsd : 0;
  pos.remainingQty = 0;
  pos.exitPrice = params.exitPrice;
  pos.outcome = params.outcome;
  pos.status = params.isLiquidation ? 'LIQUIDATED' : 'CLOSED';
  pos.closedAt = new Date().toISOString();

  await repo.applyWalletOp({
    userId,
    idempotencyKey: `close:${pos.id}:${params.outcome}`,
    opType: params.isLiquidation ? 'LIQUIDATION' : 'CLOSE_PNL',
    symbol: pos.symbol,
    positionId: pos.id,
    balanceDelta: netCloseDelta,
    marginDelta: -pos.marginUsdt,
    realizedDelta: netCloseDelta,
    feeDelta: closeFee,
    fundingDelta: 0,
    note: `${params.reasonLabel} — ${pos.symbol} (${pos.netPnlUsdt >= 0 ? '+' : ''}${pos.netPnlUsdt.toFixed(2)}$)`,
  });

  await repo.upsertTrade(pos);

  await repo.upsertSignalAnalytics({
    id: `sig-tr-${pos.id}`,
    userId,
    symbol: pos.symbol,
    side: pos.side,
    strategyMode: (pos.mode as any) || 'intraday',
    entryKind: pos.entryKind || 'CONFIRMED_ENTRY',
    entryStatus: 'CONFIRMED',
    timeframe: '15m',
    regime: 'range',
    score: pos.score,
    rawScore: pos.score,
    signalPrice: pos.entryPrice,
    entryPrice: pos.entryPrice,
    fillPrice: pos.entryPrice,
    distanceMovedPct: Number(pos.meta?.distanceMovedPct || 0),
    stillValid: true,
    earlyReason: String(pos.meta?.earlyReason || ''),
    confirmFactors: [],
    missingConfirmations: [],
    takenByUserOrAuto: true,
    positionId: pos.id,
    outcome: params.outcome,
    closeReason: params.reasonLabel,
    netR: pos.rMultiple,
    netPnlUsdt: pos.netPnlUsdt,
    mfeR: pos.meta?.peakFavR ?? null,
    tp1Hit: Boolean(pos.tps[0]?.hit),
    tp2Hit: Boolean(pos.tps[1]?.hit),
    tp3Hit: Boolean(pos.tps[2]?.hit),
    missedOpportunity: params.outcome === 'EXPIRED' || params.outcome === 'MISSED',
    simulationRunId: pos.simulationRunId || 'run-1',
    createdAt: pos.openedAt,
    closedAt: pos.closedAt,
  });

  await repo.appendEngineLog({
    userId,
    level: params.isLiquidation ? 'ERROR' : 'DECISION',
    category: 'PROTECT',
    symbol: pos.symbol,
    message: `إغلاق ${pos.symbol} (${params.outcome}): ${pos.netPnlUsdt >= 0 ? '+' : ''}${pos.netPnlUsdt.toFixed(2)}$ (${(pos.rMultiple ?? 0).toFixed(2)}R)`,
    details: { outcome: params.outcome, reason: params.reasonLabel },
  });

  const eventType = params.isLiquidation
    ? 'LIQUIDATED'
    : params.outcome === 'SL'
      ? 'SL_HIT'
      : 'TRADE_CLOSE';

  await emitAlert({
    userId,
    eventType,
    severity: pos.netPnlUsdt >= 0 ? 'success' : 'danger',
    symbol: pos.symbol,
    title: params.isLiquidation
      ? `تصفية مركز ${pos.symbol}!`
      : `إغلاق ${pos.symbol} (${params.outcome})`,
    body: `${params.reasonLabel} · الصافي: ${pos.netPnlUsdt >= 0 ? '+' : ''}${pos.netPnlUsdt.toFixed(2)} USDT (${(pos.rMultiple ?? 0).toFixed(2)}R)`,
  });

  return pos;
}

export async function settleFundingForPosition(params: {
  userId?: string;
  pos: PaperPosition;
  fundingRate: number;
  nextFundingTime: number;
  markPrice: number;
}) {
  const { pos, fundingRate, markPrice } = params;
  const userId = params.userId || DEFAULT_USER_ID;
  if (pos.status !== 'OPEN' || !isN(fundingRate) || !(markPrice > 0)) return pos;

  const EPOCH_MS = 8 * 3600e3;
  const lastPeriod = Math.floor((pos.lastFundingTs || Date.now()) / EPOCH_MS);
  const currentPeriod = Math.floor(Date.now() / EPOCH_MS);
  if (currentPeriod <= lastPeriod) return pos;

  // Fetch historical funding rates if multiple 8h periods were missed (e.g. server restart)
  let histRates: { t: number; r: number }[] = [];
  if (currentPeriod - lastPeriod > 1) {
    try {
      histRates = await binanceServer.fundingHistory(
        pos.symbol,
        (lastPeriod + 1) * EPOCH_MS - 3600e3,
        Date.now(),
        50
      );
    } catch {
      histRates = [];
    }
  }

  let updated = false;
  for (let p = lastPeriod + 1; p <= currentPeriod; p++) {
    const boundaryMs = p * EPOCH_MS;
    const match = histRates.find((h) => Math.abs(h.t - boundaryMs) <= 1800e3);
    const rate = match ? match.r : fundingRate;
    const idemKey = `funding:${pos.id}:${p}`;
    const activeNotional = pos.remainingQty * markPrice;
    const sign = pos.side === 'LONG' ? -1 : 1;
    const fundingCashflow = sign * activeNotional * rate;

    const res = await repo.applyWalletOp({
      userId,
      idempotencyKey: idemKey,
      opType: 'FUNDING',
      symbol: pos.symbol,
      positionId: pos.id,
      balanceDelta: fundingCashflow,
      marginDelta: 0,
      realizedDelta: fundingCashflow,
      feeDelta: 0,
      fundingDelta: fundingCashflow,
      note: `تمويل ${pos.side} ${pos.symbol} (${(rate * 100).toFixed(4)}%): ${fundingCashflow >= 0 ? '+' : ''}${fundingCashflow.toFixed(4)}$`,
    });

    if (res.applied) {
      pos.fundingUsdt += fundingCashflow;
      pos.netPnlUsdt = pos.realizedPnlUsdt - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;
      pos.lastFundingTs = boundaryMs + 1000;
      updated = true;
    }
  }

  if (updated) {
    await repo.upsertTrade(pos);
  }
  return pos;
}

/**
 * Layer A of Smart Profit Shield:
 * Tracks peak favorable R-excursion (`peakFavR` / `peakPrice`) and progressively tightens
 * `stopCurrent` once the trade reaches >= +1.85R (or >= +1.65R after TP1),
 * ensuring major unrealized gains cannot collapse all the way back to Break-Even.
 */
export function applyDynamicProfitLock(
  pos: PaperPosition,
  settings: Pick<BotSettings, 'smartProfitShield'>,
  favPrice: number
): { changed: boolean; stopTightened: boolean; peakFavR: number } {
  if (pos.status !== 'OPEN' || !isN(favPrice) || !(favPrice > 0)) {
    return { changed: false, stopTightened: false, peakFavR: Number(pos.meta?.peakFavR || 0) };
  }
  const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
  if (!(riskDist > 0)) {
    return { changed: false, stopTightened: false, peakFavR: Number(pos.meta?.peakFavR || 0) };
  }
  const long = pos.side === 'LONG';
  const dir = long ? 1 : -1;
  const favR = (dir * (favPrice - pos.entryPrice)) / riskDist;
  pos.meta = pos.meta || {};
  const prevPeakR = Number(pos.meta.peakFavR || 0);
  const prevStoredPeakR = Number(pos.meta.persistedPeakR || 0);
  let peakChanged = false;
  if (favR > prevPeakR) {
    pos.meta.peakFavR = +favR.toFixed(3);
    pos.meta.peakPrice = favPrice;
    if (favR - prevStoredPeakR >= 0.15 || favR >= 1.5) {
      pos.meta.persistedPeakR = +favR.toFixed(3);
      peakChanged = true;
    }
  }
  const peakFavR = Number(pos.meta.peakFavR || 0);
  if (settings.smartProfitShield === false) {
    return { changed: peakChanged, stopTightened: false, peakFavR };
  }

  const tp1Hit = Boolean(pos.tps[0]?.hit);
  if (!((tp1Hit && peakFavR >= 1.65) || peakFavR >= 1.85)) {
    return { changed: peakChanged, stopTightened: false, peakFavR };
  }

  const lockRatio = peakFavR >= 3.2 ? 0.72 : peakFavR >= 2.2 ? 0.65 : 0.50;
  const lockMoveR = peakFavR * lockRatio;
  const shieldStop = pos.entryPrice + dir * lockMoveR * riskDist;
  const tightens = long ? shieldStop > pos.stopCurrent : shieldStop < pos.stopCurrent;
  if (tightens) {
    pos.stopCurrent = shieldStop;
    pos.meta.shieldActive = true;
    pos.meta.shieldLockR = +lockMoveR.toFixed(2);
    return { changed: true, stopTightened: true, peakFavR };
  }
  return { changed: peakChanged, stopTightened: false, peakFavR };
}

export async function reconcilePositionIntrabar(params: {
  userId?: string;
  pos: PaperPosition;
  candles1m: Candle[];
  fundingRate?: number;
  nextFundingTime?: number;
}) {
  const { pos, candles1m } = params;
  if (!candles1m.length || (pos.status !== 'OPEN' && pos.status !== 'PENDING')) return pos;
  const userId = params.userId || DEFAULT_USER_ID;
  const settings = await repo.getBotSettings(userId);
  const activeSinceMs = new Date(pos.filledAt || pos.openedAt).getTime();
  const openedMs = new Date(pos.openedAt).getTime();

  for (const bar of candles1m) {
    if (pos.status !== 'OPEN' && pos.status !== 'PENDING') break;
    const barEndMs = bar.T ?? bar.t + 60_000;
    const long = pos.side === 'LONG';

    if (pos.status === 'PENDING') {
      if (barEndMs <= openedMs) continue;
      const fullBarSinceOpen = bar.t >= openedMs - 2000;
      const barLo = fullBarSinceOpen ? bar.l : Math.min(bar.c, pos.markPriceLast || bar.c);
      const barHi = fullBarSinceOpen ? bar.h : Math.max(bar.c, pos.markPriceLast || bar.c);

      if (pos.expiresAt && bar.t >= new Date(pos.expiresAt).getTime()) {
        return closePaperPosition({
          userId,
          position: pos,
          exitPrice: bar.o,
          outcome: 'EXPIRED',
          reasonLabel: 'انتهاء صلاحية الأمر المعلق',
        });
      }
      const touched = long ? barLo <= pos.entryPrice : barHi >= pos.entryPrice;
      if (touched) {
        await monitorPositionWithMarket({
          userId,
          pos,
          markPrice: pos.entryPrice,
          lastPrice: pos.entryPrice,
          fundingRate: params.fundingRate,
          nextFundingTime: params.nextFundingTime,
        });
        continue;
      }
      const brokeStop = long ? barLo <= pos.stopLoss : barHi >= pos.stopLoss;
      if (brokeStop) {
        return closePaperPosition({
          userId,
          position: pos,
          exitPrice: bar.c,
          outcome: 'MISSED',
          reasonLabel: 'كسر الوقف قبل تنفيذ الأمر المعلق',
        });
      }
      continue;
    }

    // Ignore 1m bars that closed before position was filled/opened
    if (barEndMs <= activeSinceMs) continue;
    const fullBarSinceFill = bar.t >= activeSinceMs - 2000;
    const extremeFav = fullBarSinceFill ? (long ? bar.h : bar.l) : bar.c;
    const extremeAdv = fullBarSinceFill ? (long ? bar.l : bar.h) : bar.c;

    // Conservative intrabar order: Liquidation / Stop entering bar -> TP targets -> Peak-R Shield update
    const hitLiq = long ? extremeAdv <= pos.liqPrice : extremeAdv >= pos.liqPrice;
    const hitSl = long ? extremeAdv <= pos.stopCurrent : extremeAdv >= pos.stopCurrent;
    if (hitLiq || hitSl) {
      return monitorPositionWithMarket({
        userId,
        pos,
        markPrice: extremeAdv,
        lastPrice: extremeAdv,
        fundingRate: params.fundingRate,
        nextFundingTime: params.nextFundingTime,
      });
    }

    const hitTp = pos.tps.some((t) => !t.hit && (long ? extremeFav >= t.p : extremeFav <= t.p));
    if (hitTp) {
      await monitorPositionWithMarket({
        userId,
        pos,
        markPrice: bar.c,
        lastPrice: extremeFav,
        fundingRate: params.fundingRate,
        nextFundingTime: params.nextFundingTime,
      });
    } else if (pos.status === 'OPEN') {
      const lockRes = applyDynamicProfitLock(pos, settings, extremeFav);
      if (lockRes.changed) {
        await repo.upsertTrade(pos);
      }
    }
  }
  return pos;
}

export async function monitorPositionWithMarket(params: {
  userId?: string;
  pos: PaperPosition;
  markPrice: number;
  lastPrice: number;
  fundingRate?: number;
  nextFundingTime?: number;
}) {
  const { pos, markPrice, lastPrice, fundingRate, nextFundingTime } = params;
  const userId = params.userId || DEFAULT_USER_ID;
  if (pos.status !== 'OPEN' && pos.status !== 'PENDING') return pos;

  const long = pos.side === 'LONG';
  const settings = await repo.getBotSettings(userId);
  const tick = pos.meta?.tick || 0;

  if (isN(markPrice) && markPrice > 0) {
    pos.markPriceLast = markPrice;
  }

  // Handle PENDING limit order fill, expiration, or invalidation
  if (pos.status === 'PENDING') {
    const expMs = pos.expiresAt ? new Date(pos.expiresAt).getTime() : pos.meta?.expiresAt ? new Date(pos.meta.expiresAt).getTime() : 0;
    if (expMs > 0 && Date.now() >= expMs) {
      return closePaperPosition({
        userId,
        position: pos,
        exitPrice: lastPrice || pos.entryPrice,
        outcome: 'EXPIRED',
        reasonLabel: 'انتهاء صلاحية الأمر المعلق بدون تنفيذ',
      });
    }
    if (isN(lastPrice) && lastPrice > 0) {
      const filled = long ? lastPrice <= pos.entryPrice : lastPrice >= pos.entryPrice;
      if (filled) {
        const fillFeeUsdt = pos.notionalUsdt * settings.makerFee;
        pos.status = 'OPEN';
        pos.filledAt = new Date().toISOString();
        pos.lastFundingTs = Date.now();
        pos.feesUsdt = (pos.feesUsdt || 0) + fillFeeUsdt;
        pos.netPnlUsdt = pos.realizedPnlUsdt - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;

        await repo.applyWalletOp({
          userId,
          idempotencyKey: `fillfee:${pos.id}`,
          opType: 'OPEN_FEE',
          symbol: pos.symbol,
          positionId: pos.id,
          balanceDelta: -fillFeeUsdt,
          marginDelta: 0,
          realizedDelta: -fillFeeUsdt,
          feeDelta: fillFeeUsdt,
          fundingDelta: 0,
          note: `رسوم تنفيذ أمر Limit ${pos.symbol} (${fillFeeUsdt.toFixed(2)}$)`,
        });
        await repo.upsertTrade(pos);
        await emitAlert({
          userId,
          eventType: 'TRADE_OPEN',
          severity: 'success',
          symbol: pos.symbol,
          title: `تم تنفيذ أمر Limit — ${pos.symbol}`,
          body: `تم الدخول ${pos.side} عند ${F(pos.entryPrice, tick)} · رسوم ${fillFeeUsdt.toFixed(2)}$`,
        });
        return pos;
      }
      const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
      const brokeSl = long ? lastPrice <= pos.stopLoss : lastPrice >= pos.stopLoss;
      const ranAway = riskDist > 0 && (long ? lastPrice >= pos.entryPrice + 4 * riskDist : lastPrice <= pos.entryPrice - 4 * riskDist);
      if (brokeSl || ranAway) {
        return closePaperPosition({
          userId,
          position: pos,
          exitPrice: lastPrice,
          outcome: 'MISSED',
          reasonLabel: brokeSl ? 'كسر الوقف قبل تنفيذ الأمر المعلق' : 'ابتعد السعر (+4R) قبل تنفيذ الأمر المعلق',
        });
      }
    }
    return pos;
  }

  if (pos.status !== 'OPEN') return pos;

  // 1. Funding Settlement (handles missed multi-epoch gaps)
  if (isN(fundingRate) && nextFundingTime) {
    await settleFundingForPosition({
      userId,
      pos,
      fundingRate,
      nextFundingTime,
      markPrice: markPrice || lastPrice,
    });
  }

  // 2. Mark Price Liquidation Check (PRIORITY 1)
  if (isN(markPrice) && markPrice > 0) {
    const liqHit = long ? markPrice <= pos.liqPrice : markPrice >= pos.liqPrice;
    if (liqHit) {
      return closePaperPosition({
        userId,
        position: pos,
        exitPrice: pos.liqPrice,
        outcome: 'LIQUIDATED',
        reasonLabel: `تجاوز Mark Price (${F(markPrice, tick)}) سعر التصفية (${F(pos.liqPrice, tick)})`,
        isLiquidation: true,
      });
    }

    const distTotal = Math.abs(pos.entryPrice - pos.liqPrice);
    const distRem = long ? markPrice - pos.liqPrice : pos.liqPrice - markPrice;
    if (!pos.liqWarningSent && distTotal > 0 && distRem / distTotal <= 0.25) {
      pos.liqWarningSent = true;
      await repo.upsertTrade(pos);
      await emitAlert({
        userId,
        eventType: 'LIQ_WARNING',
        severity: 'danger',
        symbol: pos.symbol,
        title: `تحذير اقتراب التصفية — ${pos.symbol}`,
        body: `Mark Price (${F(markPrice, tick)}) يقترب من التصفية (${F(pos.liqPrice, tick)})`,
      });
    }
  }

  // 3. Stop Loss / Dynamic Trailing Shield Check
  const checkPx = isN(markPrice) && markPrice > 0 ? markPrice : lastPrice;
  if (isN(checkPx) && checkPx > 0) {
    const slHit = long ? checkPx <= pos.stopCurrent : checkPx >= pos.stopCurrent;
    if (slHit) {
      const tpHits = pos.tps.filter((t) => t.hit).length;
      const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
      const dir = long ? 1 : -1;
      const lockedMoveR =
        riskDist > 0 ? (dir * (pos.stopCurrent - pos.entryPrice)) / riskDist : 0;
      const tp1MoveR =
        pos.tps[0] && riskDist > 0
          ? (dir * (pos.tps[0].p - pos.entryPrice)) / riskDist
          : 1.5;
      const isShieldStop =
        Boolean(pos.meta?.shieldActive) &&
        lockedMoveR >= 0.45 &&
        (tpHits <= 1 || lockedMoveR > tp1MoveR + 0.05);
      const isSmartPartialProt =
        tpHits === 0 && Boolean(pos.meta?.smartTpPartialDone) && lockedMoveR >= -0.05;

      return closePaperPosition({
        userId,
        position: pos,
        exitPrice: pos.stopCurrent,
        outcome: isSmartPartialProt
          ? 'SMART_PARTIAL_TP'
          : isShieldStop
            ? 'TRAIL_PROFIT'
            : tpHits > 0
              ? `TP${tpHits}+BE`
              : 'SL',
        reasonLabel: isSmartPartialProt
          ? 'تفعيل وقف حماية الأرباح بعد جني جزئي ذكي'
          : isShieldStop
            ? `حماية الأرباح الديناميكية عند +${lockedMoveR.toFixed(2)}R`
            : tpHits >= 2
              ? 'ضرب الوقف المتحرك عند TP1'
              : tpHits === 1
                ? 'تفعيل وقف التعادل الصافي'
                : 'ضرب وقف الخسارة',
      });
    }

    // 4. Take Profit Targets Check
    let modified = false;
    for (let k = 0; k < pos.tps.length; k++) {
      const tp = pos.tps[k];
      if (tp.hit) continue;
      const tpHit = long ? lastPrice >= tp.p : lastPrice <= tp.p;
      if (!tpHit) break;

      tp.hit = true;
      modified = true;
      const partQty = Math.min(pos.remainingQty, (pos.qty * tp.pct) / 100);
      const partPnl = (long ? 1 : -1) * (tp.p - pos.entryPrice) * partQty;
      const partFee = partQty * tp.p * settings.makerFee;
      const netPart = partPnl - partFee;

      pos.remainingQty = Math.max(0, +(pos.remainingQty - partQty).toFixed(8));
      pos.realizedPnlUsdt += partPnl;
      pos.feesUsdt += partFee;
      pos.netPnlUsdt = pos.realizedPnlUsdt - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;

      // Baseline: Net Break-Even after TP1; TP2 moves stop to TP1 (never loosen an existing tighter shield stop).
      if (k === 0 && pos.remainingQty > 1e-8) {
        const closeFeeReserve = pos.remainingQty * pos.entryPrice * settings.takerFee;
        const netCostToCover = pos.feesUsdt + pos.slippageUsdt + closeFeeReserve - pos.fundingUsdt;
        const offset = Math.max(0, netCostToCover / pos.remainingQty);
        const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
        const cappedOffset = riskDist > 0 ? Math.min(offset, riskDist * 0.4) : offset;
        const beStop = long ? pos.entryPrice + cappedOffset : pos.entryPrice - cappedOffset;
        pos.stopCurrent = long ? Math.max(pos.stopCurrent, beStop) : Math.min(pos.stopCurrent, beStop);
      }
      if (k === 1 && pos.tps[0]) {
        pos.stopCurrent = long
          ? Math.max(pos.stopCurrent, pos.tps[0].p)
          : Math.min(pos.stopCurrent, pos.tps[0].p);
      }

      await repo.applyWalletOp({
        userId,
        idempotencyKey: `tp:${pos.id}:TP${k + 1}`,
        opType: 'PARTIAL_TP',
        symbol: pos.symbol,
        positionId: pos.id,
        balanceDelta: netPart,
        marginDelta: 0,
        realizedDelta: netPart,
        feeDelta: partFee,
        fundingDelta: 0,
        note: `تحقق TP${k + 1} لصفقة ${pos.symbol} (+${netPart.toFixed(2)}$)`,
      });

      await emitAlert({
        userId,
        eventType: 'TP_HIT',
        severity: 'success',
        symbol: pos.symbol,
        title: `تحقق الهدف TP${k + 1} — ${pos.symbol}`,
        body: `تم جني ${tp.pct}% عند ${F(tp.p, tick)} (+${netPart.toFixed(2)} USDT)`,
      });
    }

    if (pos.remainingQty <= 1e-8) {
      pos.status = 'CLOSED';
      pos.outcome = 'TP3';
      pos.exitPrice = pos.tps[pos.tps.length - 1]?.p ?? lastPrice;
      pos.closedAt = new Date().toISOString();
      const initialRiskUsd = Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty;
      pos.rMultiple = initialRiskUsd > 0 ? pos.netPnlUsdt / initialRiskUsd : 0;

      await repo.applyWalletOp({
        userId,
        idempotencyKey: `release:${pos.id}:TP3`,
        opType: 'MARGIN_RELEASE',
        symbol: pos.symbol,
        positionId: pos.id,
        balanceDelta: 0,
        marginDelta: -pos.marginUsdt,
        realizedDelta: 0,
        feeDelta: 0,
        fundingDelta: 0,
        note: `تحرير هامش ${pos.symbol} بعد اكتمال TP3`,
      });
      await repo.upsertTrade(pos);
      await emitAlert({
        userId,
        eventType: 'TRADE_CLOSE',
        severity: 'success',
        symbol: pos.symbol,
        title: `اكتمال جميع الأهداف — ${pos.symbol}`,
        body: `إغلاق كامل TP3 بصافي ربح +${pos.netPnlUsdt.toFixed(2)} USDT`,
      });
      return pos;
    }

    const favCandidate =
      isN(lastPrice) && lastPrice > 0 && isN(markPrice) && markPrice > 0
        ? long
          ? Math.max(lastPrice, markPrice)
          : Math.min(lastPrice, markPrice)
        : lastPrice || markPrice;
    const lockRes = applyDynamicProfitLock(pos, settings, favCandidate);

    if (modified || lockRes.changed) {
      await repo.upsertTrade(pos);
    }
  }

  return pos;
}

export async function executePartialSmartTakeProfit(params: {
  userId?: string;
  pos: PaperPosition;
  closePct: number;
  exitPrice: number;
  curFavR: number;
  reasons: string[];
  reasonLabel: string;
}) {
  const { pos, closePct, exitPrice, curFavR, reasons, reasonLabel } = params;
  const userId = params.userId || DEFAULT_USER_ID;
  if (pos.status !== 'OPEN' || pos.remainingQty <= 1e-8) return pos;

  const settings = await repo.getBotSettings(userId);
  const tick = pos.meta?.tick || 0;
  const long = pos.side === 'LONG';
  const dir = long ? 1 : -1;
  const pct = Math.max(10, Math.min(95, closePct));
  const partQty = Math.min(pos.remainingQty, +((pos.remainingQty * pct) / 100).toFixed(8));
  if (!(partQty > 0)) return pos;

  const partPnl = dir * (exitPrice - pos.entryPrice) * partQty;
  const partNotional = partQty * exitPrice;
  const partFee = partNotional * settings.takerFee;
  const partSlip = partNotional * settings.slippage;
  const netPart = partPnl - partFee - partSlip;

  pos.remainingQty = Math.max(0, +(pos.remainingQty - partQty).toFixed(8));
  pos.realizedPnlUsdt += partPnl;
  pos.feesUsdt += partFee;
  pos.slippageUsdt += partSlip;
  pos.netPnlUsdt = pos.realizedPnlUsdt - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;

  pos.meta = pos.meta || {};
  pos.meta.smartTpPartialDone = true;
  pos.meta.smartTpPartialR = +curFavR.toFixed(2);
  pos.meta.smartTpReasons = reasons.slice(0, 3);

  // Move stop safely toward Break-Even / protective cushion to secure the remaining position
  if (pos.remainingQty > 1e-8 && curFavR >= 0.45) {
    const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
    const feeOffset = pos.remainingQty > 0 ? Math.min(riskDist * 0.25, (pos.feesUsdt + pos.slippageUsdt) / pos.remainingQty) : 0;
    const protStop = pos.entryPrice + dir * Math.min(curFavR * 0.25 * riskDist, feeOffset);
    if (long ? protStop > pos.stopCurrent : protStop < pos.stopCurrent) {
      pos.stopCurrent = protStop;
    }
  }

  await repo.applyWalletOp({
    userId,
    idempotencyKey: `smarttp:${pos.id}`,
    opType: 'PARTIAL_TP',
    symbol: pos.symbol,
    positionId: pos.id,
    balanceDelta: netPart,
    marginDelta: 0,
    realizedDelta: netPart,
    feeDelta: partFee,
    fundingDelta: 0,
    note: `جني أرباح ذكي جزئي (${pct}%) لصفقة ${pos.symbol} (${netPart >= 0 ? '+' : ''}${netPart.toFixed(2)}$)`,
  });

  if (pos.remainingQty <= 1e-8) {
    pos.status = 'CLOSED';
    pos.outcome = 'SMART_PARTIAL_TP';
    pos.exitPrice = exitPrice;
    pos.closedAt = new Date().toISOString();
    const initialRiskUsd = Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty;
    pos.rMultiple = initialRiskUsd > 0 ? pos.netPnlUsdt / initialRiskUsd : 0;

    await repo.applyWalletOp({
      userId,
      idempotencyKey: `release:${pos.id}:SMART_PARTIAL_TP`,
      opType: 'MARGIN_RELEASE',
      symbol: pos.symbol,
      positionId: pos.id,
      balanceDelta: 0,
      marginDelta: -pos.marginUsdt,
      realizedDelta: 0,
      feeDelta: 0,
      fundingDelta: 0,
      note: `تحرير هامش ${pos.symbol} بعد جني الأرباح الذكي`,
    });
  }

  await repo.upsertTrade(pos);

  await emitAlert({
    userId,
    eventType: 'TP_HIT',
    severity: netPart >= 0 ? 'success' : 'warning',
    symbol: pos.symbol,
    title: `جني أرباح ذكي جزئي (${pct}%) — ${pos.symbol}`,
    body: `${reasonLabel} · عند ${F(exitPrice, tick)} (${netPart >= 0 ? '+' : ''}${netPart.toFixed(2)} USDT)`,
  });

  return pos;
}

/**
 * Unified Lower-TF Smart Take Profit & Smart Profit Shield Exit:
 * 1) Smart Take Profit (Pre-TP partial or full exit on lower-TF momentum & candle reversal)
 * 2) Layer B Smart Profit Shield (High-profit order-flow + strong reversal candle exit)
 */
export async function evaluateSmartProfitShieldExit(params: {
  userId?: string;
  pos: PaperPosition;
  livePrice: number;
  microCandles1m: Candle[];
  microCandles5m: Candle[];
  book?: OrderBookAnalysis | null;
}) {
  const { pos, livePrice, microCandles1m, microCandles5m, book = null } = params;
  const userId = params.userId || DEFAULT_USER_ID;
  if (pos.status !== 'OPEN' || pos.remainingQty <= 1e-8 || !isN(livePrice) || !(livePrice > 0)) {
    return pos;
  }

  const settings = await repo.getBotSettings(userId);
  const useSmartTp = settings.smartTakeProfitEnabled !== false;
  const useShield = settings.smartProfitShield !== false;
  if (!useSmartTp && !useShield) return pos;

  const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
  if (!(riskDist > 0)) return pos;

  const long = pos.side === 'LONG';
  const dir = long ? 1 : -1;
  const curFavR = (dir * (livePrice - pos.entryPrice)) / riskDist;
  const peakFavR = Math.max(Number(pos.meta?.peakFavR || 0), curFavR);
  const tp1Hit = Boolean(pos.tps[0]?.hit);
  const smartTpMinR = settings.smartTakeProfitMinR ?? 0.6;

  const smartTpEligible = useSmartTp && (curFavR >= smartTpMinR || (peakFavR >= 1.5 && curFavR >= 0.45));
  const shieldEligible = useShield && ((tp1Hit && curFavR >= 0.65) || (peakFavR >= 1.6 && curFavR >= 0.8));
  if (!smartTpEligible && !shieldEligible) {
    return pos;
  }

  const flow = computeOrderFlowSnapshot({
    microCandles: { '1m': microCandles1m, '5m': microCandles5m },
    book,
    dirHint: dir,
  });

  // 1) Smart Take Profit: Momentum + Lower-TF Candle Reversal Detector (Partial & Full before TP)
  if (smartTpEligible) {
    const sig = detectMomentumReversalSignal({
      dir,
      candlesPrimary: microCandles5m.length >= 6 ? microCandles5m : microCandles1m,
      candlesMicro: microCandles1m,
      orderFlow: flow,
      riskDist,
      curFavR,
      peakFavR,
      minR: smartTpMinR,
      sensitivity: settings.smartTakeProfitSensitivity || 'balanced',
      partialAlreadyDone: Boolean(pos.meta?.smartTpPartialDone),
    });

    if (sig.action === 'FULL') {
      return closePaperPosition({
        userId,
        position: pos,
        exitPrice: livePrice,
        outcome: 'SMART_EXIT',
        reasonLabel: `جني أرباح ذكي كامل (${sig.strength}%): ${sig.summary} عند +${curFavR.toFixed(2)}R`,
      });
    }

    if (sig.action === 'PARTIAL' && !pos.meta?.smartTpPartialDone) {
      const partialPct = settings.smartTakeProfitPartialPct ?? 50;
      if (partialPct >= 95) {
        return closePaperPosition({
          userId,
          position: pos,
          exitPrice: livePrice,
          outcome: 'SMART_EXIT',
          reasonLabel: `جني أرباح ذكي كامل (${sig.strength}%): ${sig.summary} عند +${curFavR.toFixed(2)}R`,
        });
      }
      return executePartialSmartTakeProfit({
        userId,
        pos,
        closePct: partialPct,
        exitPrice: livePrice,
        curFavR,
        reasons: sig.reasons,
        reasonLabel: `تأكيد انعكاس (${sig.strength}%): ${sig.summary}`,
      });
    }
  }

  // 2) Legacy / High-Profit Shield Fallback (post-TP1 or >= 1.6R peak sharp reversal)
  if (!shieldEligible) return pos;

  const flowAgainst =
    (flow.verdict === 'COUNTER_FLOW' && flow.confidence >= 0.42 && dir * flow.netBias <= -0.32) ||
    ((long ? flow.absorption === 'BEAR' : flow.absorption === 'BULL') && dir * flow.netBias <= -0.15);

  const closed5m = microCandles5m.filter((c) => c.x !== false);
  let strong5mRev = false;
  let two5mRev = false;
  if (closed5m.length >= 6) {
    const b = closed5m[closed5m.length - 1];
    const prev = closed5m[closed5m.length - 2];
    const baseBars = closed5m.slice(-17, -1);
    const avgVol =
      baseBars.length > 0
        ? baseBars.reduce((s, x) => s + (x.q || x.v * x.c || 0), 0) / baseBars.length
        : 0;
    const bVol = b.q || b.v * b.c || 0;
    const rvol = avgVol > 0 ? bVol / avgVol : 1;

    const bCounter = long ? b.c < b.o : b.c > b.o;
    const bBody = Math.abs(b.c - b.o);
    const bRange = Math.max(1e-12, b.h - b.l);
    strong5mRev = bCounter && bBody / bRange >= 0.52 && bBody >= 0.25 * riskDist && rvol >= 1.2;

    const pCounter = long ? prev.c < prev.o : prev.c > prev.o;
    const twoSpan = long ? prev.o - b.c : b.c - prev.o;
    two5mRev = bCounter && pCounter && twoSpan >= 0.35 * riskDist;
  }

  let extreme1mBurst = false;
  const f1m = flow.frames['1m'];
  const closed1m = microCandles1m.filter((c) => c.x !== false);
  if (f1m && closed1m.length >= 4 && dir * f1m.score <= -0.45 && f1m.rvol >= 1.6) {
    const c0 = closed1m[closed1m.length - 3];
    const c2 = closed1m[closed1m.length - 1];
    const span1m = long ? c0.o - c2.c : c2.c - c0.o;
    if (span1m >= 0.4 * riskDist) extreme1mBurst = true;
  }

  if (
    (flowAgainst && (strong5mRev || two5mRev || extreme1mBurst)) ||
    (two5mRev && dir * flow.netBias <= -0.18)
  ) {
    return closePaperPosition({
      userId,
      position: pos,
      exitPrice: livePrice,
      outcome: 'SMART_EXIT',
      reasonLabel: `خروج ذكي لحماية الأرباح (${flow.primaryTf}): انعكاس السيولة والزخم عند +${curFavR.toFixed(2)}R من قمة +${peakFavR.toFixed(2)}R`,
    });
  }

  return pos;
}

export async function triggerEmergencyStop(userId = DEFAULT_USER_ID, reason = 'تم تفعيل زر الإيقاف الطارئ') {
  const settings = await repo.getBotSettings(userId);
  settings.autoTradeEnabled = false;
  settings.emergencyStopped = true;
  settings.emergencyReason = reason;
  await repo.saveBotSettings(settings);

  const trades = await repo.getTrades(userId);
  const live = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');

  for (const pos of live) {
    const px = pos.markPriceLast || pos.entryPrice;
    await closePaperPosition({
      userId,
      position: pos,
      exitPrice: px,
      outcome: 'EMERGENCY_STOP',
      reasonLabel: reason,
    });
  }

  await emitAlert({
    userId,
    eventType: 'EMERGENCY_STOP',
    severity: 'danger',
    symbol: null,
    title: 'تم تفعيل الإيقاف الطارئ',
    body: `تم إيقاف التداول الآلي وإغلاق ${live.length} مركز/أمر فوراً.`,
  });

  return { closedCount: live.length, settings };
}
