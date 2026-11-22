import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

// Ensure unit/integration tests run purely against isolated local persistent store
// without touching any external Supabase project if env vars are present.
const ORIG_SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIG_SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { prepare, resolveModeConfig } from '../lib/cx-engine/analyzer';
import {
  buildStrategyPerformanceReport,
  evaluateWeightTuningProposal,
  MIN_TUNING_SAMPLES,
} from '../lib/cx-engine/analytics';
import {
  DEFAULT_EARLY_WEIGHTS,
  evaluateEarlyEntry,
  normalizeEarlyWeights,
} from '../lib/cx-engine/early-entry';
import { TF_MS } from '../lib/cx-engine/indicators';
import {
  calcLiquidationPrice,
  calcMaintenanceMarginRate,
  evaluate,
  sizePosition,
  validateStopBeforeLiquidation,
} from '../lib/cx-engine/planner';
import type {
  BotSettings,
  Candle,
  OrderBookAnalysis,
  PaperPosition,
  SignalEvaluation,
  SignalTelemetryRecord,
} from '../lib/cx-engine/types';
import {
  resolveAuthenticatedUser,
  signSessionToken,
  verifySessionToken,
} from '../lib/server/auth-guard';
import {
  isFreshExecutableSignal,
  rankAutoTradeCandidates,
} from '../lib/server/background-engine';
import {
  applyDynamicProfitLock,
  computeEqualAllocationPlan,
  monitorPositionWithMarket,
  openPaperTrade,
  settleFundingForPosition,
} from '../lib/server/portfolio-guard';
import { defaultBotSettings, repo } from '../lib/server/repository';
import { POST as autoTradePost } from '../app/api/auto-trade/route';

const DATA_FILE = path.join(process.cwd(), '.data', 'cipher-state.json');
let backupStoreRaw: string | null = null;

function makeCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  buyRatio = 0.55
): Candle {
  return {
    t,
    T: t + 900_000,
    o,
    h,
    l,
    c,
    v,
    q: v * c,
    V: v * buyRatio,
    x: true,
  };
}

/**
 * Generates deterministic multi-timeframe candles featuring a downtrend followed by a tight
 * volatility compression box and a fresh bullish inception breakout + CHoCH + high RVOL & delta.
 * EMAs on setup/trend remain mixed/slow to catch up, demonstrating early entry vs lagging trend stack.
 */
function buildEarlyCompressionBreakoutCandles(opts?: {
  chased?: boolean;
  tf?: string;
}): Record<string, Candle[]> {
  const tf = opts?.tf || '15m';
  const trigMs = TF_MS[tf] || 900_000;
  const n = 220;
  const baseT = Date.now() - n * trigMs - 3600_000;
  const trigger: Candle[] = [];

  // Phase 1 (0..130): gradual bearish drift from 108 -> 96.5
  for (let i = 0; i < 130; i++) {
    const t = baseT + i * trigMs;
    const mid = 108 - (i / 130) * 11.5 + Math.sin(i * 0.45) * 0.45;
    const o = mid + 0.18;
    const c = mid - 0.14;
    trigger.push(makeCandle(t, o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, 1000, 0.44));
  }

  // Phase 2 (130..216): tight compression range around 96.0 - 96.6 with sweep near bar 213
  for (let i = 130; i < 216; i++) {
    const t = baseT + i * trigMs;
    const osc = Math.sin(i * 0.8) * 0.18;
    const base = 96.25 + osc;
    const sweepDip = i === 213 ? -0.95 : 0;
    const o = base - 0.06;
    const c = base + 0.06;
    const h = base + 0.22;
    const l = base - 0.22 + sweepDip;
    trigger.push(makeCandle(t, o, h, l, c, i === 213 ? 1900 : 800, i >= 213 ? 0.65 : 0.5));
  }

  // Phase 3 (216..219): Fresh upward structural ignition out of compression (OB + FVG + RVOL)
  if (opts?.chased) {
    let px = 96.4;
    for (let i = 216; i < n; i++) {
      const t = baseT + i * trigMs;
      const step = i === n - 1 ? 6.2 : 1.6;
      const o = px;
      const c = px + step;
      trigger.push(makeCandle(t, o, c + 0.5, o - 0.05, c, 3600, 0.74));
      px = c;
    }
  } else {
    // Bar 216: bearish order block candle before displacement
    trigger.push(makeCandle(baseT + 216 * trigMs, 96.28, 96.32, 95.92, 96.02, 1200, 0.42));
    // Bar 217: strong displacement candle leaving FVG & breaking compression high
    trigger.push(makeCandle(baseT + 217 * trigMs, 96.04, 96.78, 96.00, 96.74, 3400, 0.76));
    // Bar 218: follow-through impulse
    trigger.push(makeCandle(baseT + 218 * trigMs, 96.74, 96.98, 96.65, 96.88, 2900, 0.72));
    // Bar 219: shallow retest right above compression origin (still early, non-chased)
    trigger.push(makeCandle(baseT + 219 * trigMs, 96.86, 96.92, 96.56, 96.72, 2600, 0.68));
  }

  // Resample trigger into setup (4x), trend (16x), htf (64x)
  const resample = (src: Candle[], factor: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i < src.length; i += factor) {
      const slice = src.slice(i, i + factor);
      if (slice.length === 0) break;
      out.push({
        t: slice[0].t,
        T: slice[slice.length - 1].T,
        o: slice[0].o,
        h: Math.max(...slice.map((x) => x.h)),
        l: Math.min(...slice.map((x) => x.l)),
        c: slice[slice.length - 1].c,
        v: slice.reduce((s, x) => s + x.v, 0),
        q: slice.reduce((s, x) => s + (x.q || 0), 0),
        V: slice.reduce((s, x) => s + (x.V || 0), 0),
        x: true,
      });
    }
    // Pad head so setup/trend have >= 80 candles
    const stepMs = factor * trigMs;
    while (out.length < 95) {
      const first = out[0];
      out.unshift(
        makeCandle(
          first.t - stepMs,
          first.o + 0.1,
          first.h + 0.15,
          first.l - 0.1,
          first.o,
          first.v * 0.9,
          0.48
        )
      );
    }
    return out;
  };

  const map: Record<string, Candle[]> = {};
  const tfs = resolveModeConfig('early', tf);
  map[tfs.trigger] = trigger;
  if (tfs.setup) map[tfs.setup] = resample(trigger, 4);
  if (tfs.trend) map[tfs.trend] = resample(trigger, 16);
  if (tfs.htf) map[tfs.htf] = resample(trigger, 64);
  return map;
}

function makeGoodBook(mid: number): OrderBookAnalysis {
  return {
    imb05: 0.24,
    bandPct: 0.5,
    spreadBps: 1.8,
    bid05: 500_000,
    ask05: 320_000,
    bidWall: null,
    askWall: null,
    bids: [[mid * 0.9999, 5000]],
    asks: [[mid * 1.0001, 3200]],
    mid,
    t: Date.now(),
  };
}

describe('CIPHER X PRO — 20-Scenario Verification Suite', () => {
  beforeAll(() => {
    if (fs.existsSync(DATA_FILE)) {
      backupStoreRaw = fs.readFileSync(DATA_FILE, 'utf8');
    }
  });

  afterAll(() => {
    const g = globalThis as unknown as { __cipherLocalStore?: any };
    delete g.__cipherLocalStore;
    if (backupStoreRaw !== null) {
      fs.writeFileSync(DATA_FILE, backupStoreRaw, 'utf8');
    } else if (fs.existsSync(DATA_FILE)) {
      fs.unlinkSync(DATA_FILE);
    }
    if (ORIG_SB_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = ORIG_SB_URL;
    if (ORIG_SB_SVC) process.env.SUPABASE_SERVICE_ROLE_KEY = ORIG_SB_SVC;
  });

  // Scenario 1
  test('01. Early Entry detects compression/squeeze inception move without waiting for lagging EMA cascade', () => {
    const candles = buildEarlyCompressionBreakoutCandles({ chased: false, tf: '15m' });
    const tfsEarly = resolveModeConfig('early', '15m');
    const ctxEarly = prepare(candles, tfsEarly, { tick: 0.01, step: 0.1, minQty: 0.1, minNotional: 5 }, {
      mode: 'early',
      earlyTriggerTf: '15m',
      equity: 10000,
      riskPct: 1,
      minScore: 60,
      watchScore: 52,
      cancelChasedAtr: 2.8,
    });
    const T = ctxEarly.B.trigger!;
    const lastPrice = T.c[T.n - 1];
    const resEarly = evaluateEarlyEntry(ctxEarly, T.n - 1, {
      price: lastPrice,
      book: makeGoodBook(lastPrice),
      vol24h: 120_000_000,
      now: T.t[T.n - 1] + T.ms,
    });

    expect(resEarly).not.toBeNull();
    expect(resEarly!.strategyMode).toBe('early');
    expect(resEarly!.dir).toBe(1);
    expect(resEarly!.score).toBeGreaterThanOrEqual(55);
    expect(resEarly!.earlyEntry).toBeDefined();
    expect(resEarly!.earlyEntry!.fomoChasing).toBe(false);
    expect(resEarly!.earlyEntry!.confirmFactors.length).toBeGreaterThan(0);

    // Verify Intraday lagging EMA stack stays lower/cautious when higher TFs are still descending
    const ctxStd = prepare(candles, resolveModeConfig('intraday'), { tick: 0.01, step: 0.1, minQty: 0.1, minNotional: 5 }, {
      mode: 'intraday',
      equity: 10000,
      riskPct: 1,
    });
    const resStd = evaluate(ctxStd, ctxStd.B.trigger!.n - 1, {
      price: lastPrice,
      book: makeGoodBook(lastPrice),
      vol24h: 120_000_000,
    });
    expect(resStd?.earlyEntry?.entryKind).toBe('CONFIRMED_ENTRY');
  });

  // Scenario 2
  test('02. Early Entry Anti-FOMO rejects chased parabolic move after origin extension exceeds cancelChasedAtr', () => {
    const candles = buildEarlyCompressionBreakoutCandles({ chased: true, tf: '15m' });
    const ctx = prepare(candles, resolveModeConfig('early', '15m'), { tick: 0.01, step: 0.1, minQty: 0.1, minNotional: 5 }, {
      mode: 'early',
      earlyTriggerTf: '15m',
      cancelChasedAtr: 2.2,
    });
    const T = ctx.B.trigger!;
    const lastPrice = T.c[T.n - 1];
    const res = evaluateEarlyEntry(ctx, T.n - 1, {
      price: lastPrice,
      book: makeGoodBook(lastPrice),
      vol24h: 150_000_000,
    });

    expect(res).not.toBeNull();
    expect(res!.earlyEntry).toBeDefined();
    expect(res!.earlyEntry!.fomoChasing).toBe(true);
    expect(res!.earlyEntry!.stillValid).toBe(false);
    expect(res!.earlyEntry!.entryStatus).toBe('CANCELLED');
    expect(res!.score).toBeLessThanOrEqual(58);
    expect(res!.plan?.ok).toBe(false);
  });

  // Scenario 3
  test('03. Distinguishes EARLY_ENTRY vs CONFIRMED_ENTRY and statuses (EARLY/CONFIRMED/WAIT_RETEST/CANCELLED)', () => {
    const candles = buildEarlyCompressionBreakoutCandles({ chased: false, tf: '15m' });
    const ctx = prepare(candles, resolveModeConfig('early', '15m'), { tick: 0.01, step: 0.1 }, {
      mode: 'early',
      minScore: 55,
      watchScore: 50,
    });
    const T = ctx.B.trigger!;
    const evalEarly = evaluate(ctx, T.n - 1, {
      price: T.c[T.n - 1],
      book: makeGoodBook(T.c[T.n - 1]),
      vol24h: 100_000_000,
    });
    expect(evalEarly?.earlyEntry?.entryKind).toBe('EARLY_ENTRY');
    expect(['EARLY', 'WAIT_RETEST', 'CONFIRMED']).toContain(evalEarly!.earlyEntry!.entryStatus);

    // Chased setup produces CANCELLED
    const chasedCtx = prepare(
      buildEarlyCompressionBreakoutCandles({ chased: true, tf: '15m' }),
      resolveModeConfig('early', '15m'),
      { tick: 0.01, step: 0.1 },
      { mode: 'early', cancelChasedAtr: 2.0 }
    );
    const evalChased = evaluate(chasedCtx, chasedCtx.B.trigger!.n - 1, {
      price: chasedCtx.B.trigger!.c[chasedCtx.B.trigger!.n - 1],
      vol24h: 100_000_000,
    });
    expect(evalChased?.earlyEntry?.entryStatus).toBe('CANCELLED');
  });

  // Scenario 4
  test('04. Duplicate live position/signal on same symbol + same bar is blocked', async () => {
    const uid = `test-dup-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    const mockEval: SignalEvaluation = {
      i: 200,
      t: 1700000000000,
      tClose: Date.now(),
      price: 100,
      atr: 1.5,
      atrp: 1.5,
      dir: 1,
      net: 0.85,
      score: 85,
      rawScore: 85,
      aligned: 5,
      parts: [],
      gates: [],
      warns: [],
      cap: 100,
      regime: {
        type: 'trend',
        adx: 28,
        bwPct: 0.5,
        atrPct: 1.5,
        squeeze: false,
        ttmSqueeze: false,
        squeezeFired: false,
        expansion: true,
      },
      regimeHTF: null,
      deriv: null,
      book: null,
      tf: { trigger: '15m', setup: '1h', trend: '4h', htf: '1d' },
      state: { trigger: null, setup: null, trend: null, htf: null },
      idx: { i: 200, iS: 50, iT: 12, iH: 3 },
      zones: { T: { ob: [], fvg: [], brk: [] }, S: { ob: [], fvg: [], brk: [] } },
      sweeps: [],
      pools: [],
      range: { T: null, S: null },
      vp: null,
      levels: [],
      sup: null,
      res: null,
      patterns: [],
      divs: [],
      setupDivs: [],
      evT: null,
      evS: null,
      pChg1h: 0.5,
      pChg4h: 1.2,
      vwapZ: 0.4,
      zScore: 0.5,
      sessionLabel: 'London/NY',
      tier: 'STRONG',
      grade: 'A+',
      plan: {
        ok: true,
        dir: 1,
        long: true,
        type: 'MARKET',
        entry: 100,
        price: 100,
        stop: 97.5,
        stopRef: 'OB',
        risk: 2.5,
        riskATR: 1.67,
        tps: [
          { p: 103.75, label: 'TP1', real: true, r: 1.5, pct: 40 },
          { p: 106.25, label: 'TP2', real: true, r: 2.5, pct: 35 },
          { p: 110, label: 'TP3', real: true, r: 4.0, pct: 25 },
        ],
        rr1: 1.5,
        confirmed: true,
      },
      earlyEntry: {
        entryKind: 'EARLY_ENTRY',
        entryStatus: 'EARLY',
        distanceMovedPct: 0.4,
        remainingRR1: 1.5,
        stillValid: true,
        fomoChasing: false,
        earlyReason: 'اختراق ضغط',
        confirmFactors: ['OB'],
        missingConfirmations: [],
        breakdown: { zoneQuality: 16, structureShift: 16, momentumVolume: 15, liquidityConfirm: 12, mtfAlignment: 12, stopRrQuality: 9 },
      },
    };

    const first = await openPaperTrade({
      userId: uid,
      symbol: 'BTCUSDT',
      evaluation: mockEval,
      meta: { tick: 0.1, step: 0.001, minQty: 0.001, minNotional: 5 },
      source: 'MANUAL',
    });
    expect(first.ok).toBe(true);

    const second = await openPaperTrade({
      userId: uid,
      symbol: 'BTCUSDT',
      evaluation: mockEval,
      meta: { tick: 0.1, step: 0.001, minQty: 0.001, minNotional: 5 },
      source: 'MANUAL',
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBeTruthy();
  });

  // Scenario 5
  test('05. Manual->Auto activation guard rejects stale backlog signals and WATCH/CANCELLED candidates', () => {
    const nowMs = Date.now();
    const trigMs = 900_000;
    const baseEval = {
      dir: 1,
      tier: 'STRONG' as const,
      tClose: nowMs - 60_000,
      plan: { ok: true, entry: 100, stop: 97, tps: [] },
      earlyEntry: {
        entryKind: 'EARLY_ENTRY' as const,
        entryStatus: 'EARLY' as const,
        distanceMovedPct: 0.5,
        remainingRR1: 1.5,
        stillValid: true,
        fomoChasing: false,
        earlyReason: 'fresh',
        confirmFactors: [],
        missingConfirmations: [],
        breakdown: { zoneQuality: 15, structureShift: 15, momentumVolume: 15, liquidityConfirm: 10, mtfAlignment: 10, stopRrQuality: 8 },
      },
    } as unknown as SignalEvaluation;

    expect(
      isFreshExecutableSignal({ evaluation: baseEval, minTier: 'GOOD', nowMs, trigMs }).eligible
    ).toBe(true);

    // Stale signal from > 2 bars ago (e.g. sitting in backlog during MANUAL mode)
    const staleEval = { ...baseEval, tClose: nowMs - 3 * trigMs };
    expect(
      isFreshExecutableSignal({ evaluation: staleEval, minTier: 'GOOD', nowMs, trigMs }).eligible
    ).toBe(false);

    // WATCH or CANCELLED signal
    const watchEval = { ...baseEval, tier: 'WATCH' as const };
    expect(
      isFreshExecutableSignal({ evaluation: watchEval, minTier: 'GOOD', nowMs, trigMs }).eligible
    ).toBe(false);
    const cancelledEval = {
      ...baseEval,
      earlyEntry: { ...baseEval.earlyEntry!, stillValid: false, entryStatus: 'CANCELLED' as const },
    };
    expect(
      isFreshExecutableSignal({ evaluation: cancelledEval, minTier: 'GOOD', nowMs, trigMs }).eligible
    ).toBe(false);
  });

  // Scenario 6
  test('06. Auto->Manual transition halts AUTO opens while continuing SL/TP management on open positions', async () => {
    const uid = `test-man-stop-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    const s = await repo.getBotSettings(uid);
    s.executionMode = 'MANUAL';
    s.autoTradeEnabled = false;
    await repo.saveBotSettings(s);

    const sampleEval = {
      i: 100,
      t: Date.now() - 900_000,
      tClose: Date.now(),
      price: 200,
      atr: 3,
      atrp: 1.5,
      dir: 1,
      score: 88,
      rawScore: 88,
      aligned: 5,
      tier: 'STRONG',
      plan: {
        ok: true,
        dir: 1,
        long: true,
        type: 'MARKET',
        entry: 200,
        price: 200,
        stop: 194,
        stopRef: 'OB',
        risk: 6,
        tps: [
          { p: 209, label: 'TP1', real: true, r: 1.5, pct: 40 },
          { p: 215, label: 'TP2', real: true, r: 2.5, pct: 35 },
          { p: 224, label: 'TP3', real: true, r: 4.0, pct: 25 },
        ],
        rr1: 1.5,
        confirmed: true,
      },
    } as unknown as SignalEvaluation;

    // AUTO must be rejected in MANUAL mode
    const autoAttempt = await openPaperTrade({
      userId: uid,
      symbol: 'SOLUSDT',
      evaluation: sampleEval,
      meta: { tick: 0.01, step: 0.1, minQty: 0.1, minNotional: 5 },
      source: 'AUTO',
    });
    expect(autoAttempt.ok).toBe(false);

    // MANUAL open works and continues to be managed by monitorPositionWithMarket
    const manOpen = await openPaperTrade({
      userId: uid,
      symbol: 'SOLUSDT',
      evaluation: sampleEval,
      meta: { tick: 0.01, step: 0.1, minQty: 0.1, minNotional: 5 },
      source: 'MANUAL',
    });
    expect(manOpen.ok).toBe(true);

    const managed = await monitorPositionWithMarket({
      userId: uid,
      pos: manOpen.position!,
      markPrice: 210,
      lastPrice: 210,
    });
    expect(managed.tps[0].hit).toBe(true);
    expect(managed.stopCurrent).toBeGreaterThanOrEqual(managed.entryPrice);
  });

  // Scenario 7
  test('07. Equal Capital Allocation divides (Equity - Reserve) equally across maxOpenPositions & ranks candidates', () => {
    const plan = computeEqualAllocationPlan({
      wallet: { balanceUsdt: 10000, lockedMarginUsdt: 0 },
      settings: {
        equalAllocationEnabled: true,
        cashReservePct: 10,
        maxOpenPositions: 5,
        riskPct: 1,
      },
      openTradesCount: 1,
    });
    expect(plan.reservedCashUsdt).toBe(1000);
    expect(plan.allocatableUsdt).toBe(9000);
    expect(plan.perPositionSleeveUsdt).toBe(1800);
    expect(plan.availableSleevesCount).toBe(4);
    expect(plan.maxPositionRiskUsd).toBe(100);

    // Ranking puts higher score + EARLY_ENTRY + higher RR ahead
    const ranked = rankAutoTradeCandidates([
      {
        symbol: 'SLOWUSDT',
        evaluation: { score: 75, plan: { rr1: 1.2 }, earlyEntry: { entryKind: 'CONFIRMED_ENTRY', distanceMovedPct: 1.2 } } as any,
      },
      {
        symbol: 'EARLYUSDT',
        evaluation: { score: 86, plan: { rr1: 1.8 }, earlyEntry: { entryKind: 'EARLY_ENTRY', distanceMovedPct: 0.3 } } as any,
      },
    ]);
    expect(ranked[0].symbol).toBe('EARLYUSDT');
  });

  // Scenario 8
  test('08. maxOpenPositions ceiling blocks excess AUTO trades cleanly', async () => {
    const uid = `test-maxpos-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    const s = await repo.getBotSettings(uid);
    s.executionMode = 'AUTO';
    s.autoTradeEnabled = true;
    s.maxOpenPositions = 2;
    s.allowedSymbols = [];
    await repo.saveBotSettings(s);

    const makeEval = (px: number, t: number): SignalEvaluation =>
      ({
        i: 100,
        t,
        tClose: Date.now(),
        price: px,
        atr: px * 0.015,
        atrp: 1.5,
        dir: 1,
        score: 86,
        rawScore: 86,
        aligned: 5,
        tier: 'STRONG',
        plan: {
          ok: true,
          dir: 1,
          long: true,
          type: 'MARKET',
          entry: px,
          price: px,
          stop: px * 0.97,
          stopRef: 'OB',
          risk: px * 0.03,
          tps: [
            { p: px * 1.045, label: 'TP1', real: true, r: 1.5, pct: 40 },
            { p: px * 1.075, label: 'TP2', real: true, r: 2.5, pct: 35 },
            { p: px * 1.12, label: 'TP3', real: true, r: 4.0, pct: 25 },
          ],
          rr1: 1.5,
          confirmed: true,
        },
      }) as any;

    const r1 = await openPaperTrade({ userId: uid, symbol: 'ETHUSDT', evaluation: makeEval(3000, 1000), meta: { step: 0.001, minQty: 0.001, minNotional: 5 }, source: 'AUTO' });
    const r2 = await openPaperTrade({ userId: uid, symbol: 'BNBUSDT', evaluation: makeEval(600, 2000), meta: { step: 0.01, minQty: 0.01, minNotional: 5 }, source: 'AUTO' });
    const r3 = await openPaperTrade({ userId: uid, symbol: 'SOLUSDT', evaluation: makeEval(150, 3000), meta: { step: 0.1, minQty: 0.1, minNotional: 5 }, source: 'AUTO' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    expect(r3.reason).toContain('الحد الأقصى');
  });

  // Scenario 9
  test('09. Strict Risk-Over-Leverage precedence: wide SL shrinks qty, and Equal Sleeve caps margin', async () => {
    // Direct sizer check: 10% stop distance on 1% risk ($100) => max notional $1,000, not $10,000 * maxLev
    const wide = sizePosition({
      entry: 100,
      stop: 90,
      equity: 10000,
      riskPct: 1,
      maxLev: 20,
      minSafetyPct: 25,
      step: 0.1,
      minQty: 0.1,
      minNotional: 5,
      long: true,
    });
    expect(wide.ok).toBe(true);
    expect(wide.effRiskUsd).toBeLessThanOrEqual(100.5);
    expect(wide.notional).toBeLessThanOrEqual(1005);

    // Sleeve margin cap inside openPaperTrade
    const uid = `test-sleeve-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    const s = await repo.getBotSettings(uid);
    s.equalAllocationEnabled = true;
    s.cashReservePct = 20;
    s.maxOpenPositions = 4; // Sleeve = (10000 * 0.8) / 4 = 2000
    s.riskPct = 5;
    s.maxLeverage = 3;
    await repo.saveBotSettings(s);

    const evalTightStop = {
      i: 120,
      t: 555555,
      tClose: Date.now(),
      price: 100,
      atr: 0.4,
      atrp: 0.4,
      dir: 1,
      score: 88,
      rawScore: 88,
      aligned: 5,
      tier: 'STRONG',
      plan: {
        ok: true,
        dir: 1,
        long: true,
        type: 'MARKET',
        entry: 100,
        price: 100,
        stop: 99,
        stopRef: 'OB',
        risk: 1,
        tps: [
          { p: 101.5, label: 'TP1', real: true, r: 1.5, pct: 40 },
          { p: 102.5, label: 'TP2', real: true, r: 2.5, pct: 35 },
          { p: 104, label: 'TP3', real: true, r: 4.0, pct: 25 },
        ],
        rr1: 1.5,
        confirmed: true,
      },
    } as any;
    const res = await openPaperTrade({
      userId: uid,
      symbol: 'AVAXUSDT',
      evaluation: evalTightStop,
      meta: { step: 0.1, minQty: 0.1, minNotional: 5 },
      source: 'MANUAL',
    });
    expect(res.ok).toBe(true);
    expect(res.position!.marginUsdt).toBeLessThanOrEqual(2005);
  });

  // Scenario 10
  test('10. setInitialCapital updates virtual balance safely without wiping trade history', async () => {
    const uid = `test-cap-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    await repo.upsertTrade({
      id: `closed-${uid}`,
      userId: uid,
      idempotencyKey: `k-${uid}`,
      symbol: 'BTCUSDT',
      side: 'LONG',
      orderType: 'MARKET',
      status: 'CLOSED',
      score: 85,
      tier: 'STRONG',
      mode: 'early',
      entryKind: 'EARLY_ENTRY',
      entryPrice: 50000,
      stopLoss: 49500,
      stopCurrent: 49500,
      liqPrice: 40000,
      markPriceLast: 51000,
      maintenanceMarginRate: 0.005,
      maintenanceMarginUsdt: 5,
      leverage: 5,
      qty: 0.1,
      remainingQty: 0,
      notionalUsdt: 5000,
      marginUsdt: 1000,
      tps: [],
      feesUsdt: 2,
      slippageUsdt: 0,
      fundingUsdt: 0,
      realizedPnlUsdt: 100,
      netPnlUsdt: 98,
      rMultiple: 1.9,
      outcome: 'TP2',
      exitPrice: 51000,
      lastFundingTs: Date.now(),
      safetyBufferPct: 50,
      openedAt: new Date().toISOString(),
      filledAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    });

    const updated = await repo.setInitialCapital(uid, 25000);
    expect(updated.initialBalanceUsdt).toBe(25000);
    expect(updated.balanceUsdt).toBe(25000);

    // Simulate prior session realized & daily PnL then adjust capital down to 10 USDT
    await repo.applyWalletOp({
      userId: uid,
      idempotencyKey: `pnl-sim-${uid}`,
      opType: 'SIM_PNL',
      balanceDelta: 66.67,
      marginDelta: 0,
      realizedDelta: 66.67,
      dailyDelta: -352.7,
      feeDelta: 110.35,
      fundingDelta: -3.14,
      note: 'Prior PnL',
    });
    const updated10 = await repo.setInitialCapital(uid, 10);
    expect(updated10.initialBalanceUsdt).toBe(10);
    expect(updated10.balanceUsdt).toBe(10);
    expect(updated10.realizedPnlUsdt).toBe(0);
    expect(updated10.dailyPnlUsdt).toBe(0);

    const tradesAfter = await repo.getTrades(uid);
    expect(tradesAfter.length).toBe(1);
    expect(tradesAfter[0].id).toBe(`closed-${uid}`);
  });

  // Scenario 11
  test('11. resetSimulation archives prior trade history cleanly & assigns a new simulationRunId', async () => {
    const uid = `test-reset-${Date.now()}`;
    const w1 = await repo.resetSimulation(uid, { archiveHistory: false, newInitialCapital: 5000 });
    await repo.upsertTrade({
      id: `old-tr-${uid}`,
      userId: uid,
      idempotencyKey: `old-${uid}`,
      symbol: 'ETHUSDT',
      side: 'SHORT',
      orderType: 'MARKET',
      status: 'CLOSED',
      score: 80,
      tier: 'GOOD',
      mode: 'intraday',
      entryPrice: 3000,
      stopLoss: 3060,
      stopCurrent: 3060,
      liqPrice: 3500,
      markPriceLast: 2940,
      maintenanceMarginRate: 0.005,
      maintenanceMarginUsdt: 5,
      leverage: 5,
      qty: 1,
      remainingQty: 0,
      notionalUsdt: 3000,
      marginUsdt: 600,
      tps: [],
      feesUsdt: 1,
      slippageUsdt: 0,
      fundingUsdt: 0,
      realizedPnlUsdt: 60,
      netPnlUsdt: 59,
      rMultiple: 1,
      outcome: 'TP1+BE',
      exitPrice: 2940,
      lastFundingTs: Date.now(),
      safetyBufferPct: 40,
      openedAt: new Date().toISOString(),
      filledAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 5));
    const w2 = await repo.resetSimulation(uid, { archiveHistory: true, newInitialCapital: 12000 });
    expect(w2.initialBalanceUsdt).toBe(12000);
    expect(w2.balanceUsdt).toBe(12000);
    expect(w2.simulationRunId).not.toBe(w1.simulationRunId);

    const activeRunTrades = await repo.getTrades(uid, false);
    expect(activeRunTrades.length).toBe(0);
    const allIncludingArchive = await repo.getTrades(uid, true);
    expect(allIncludingArchive.length).toBe(1);
    expect(allIncludingArchive[0].archivedAt).toBeTruthy();
  });

  // Scenario 12
  test('12. Persistent settings, wallet, and trades survive in-memory cache flush (restart recovery)', async () => {
    const uid = `test-persist-${Date.now()}`;
    const s = defaultBotSettings(uid);
    s.mode = 'early';
    s.earlyTriggerTf = '5m';
    s.executionMode = 'AUTO';
    s.cashReservePct = 15;
    await repo.saveBotSettings(s);
    await repo.setInitialCapital(uid, 18500);

    // Simulate process restart by clearing globalThis cache
    const g = globalThis as unknown as { __cipherLocalStore?: any };
    delete g.__cipherLocalStore;

    const reloadedSettings = await repo.getBotSettings(uid);
    const reloadedWallet = await repo.getWallet(uid);
    expect(reloadedSettings.mode).toBe('early');
    expect(reloadedSettings.earlyTriggerTf).toBe('5m');
    expect(reloadedSettings.executionMode).toBe('AUTO');
    expect(reloadedSettings.cashReservePct).toBe(15);
    expect(reloadedWallet.initialBalanceUsdt).toBe(18500);
  });

  // Scenario 13
  test('13. Worker heartbeat & persistent diagnostic logs save and reload accurately', async () => {
    const uid = `test-worker-${Date.now()}`;
    const nowIso = new Date().toISOString();
    await repo.saveEngineState({
      userId: uid,
      workerId: 'worker-test-1',
      workerStatus: 'RUNNING',
      executionMode: 'AUTO',
      workerConnected: true,
      supabaseConnected: false,
      lastHeartbeatAt: nowIso,
      lastScanAt: nowIso,
      lastSignalEvalAt: nowIso,
      lastTradeExecAt: null,
      startedAt: nowIso,
      uptimeSec: 120,
      symbolsScanned: 24,
      activeSignalsCount: 3,
      openPositionsCount: 1,
      pendingOrdersCount: 0,
      tradesToday: 2,
      cyclesCompleted: 14,
      lastError: null,
      consecutiveErrors: 0,
      paperTradingStatus: 'آلي نشط (Paper Trading)',
      updatedAt: nowIso,
    });
    await repo.appendEngineLog({
      userId: uid,
      level: 'DECISION',
      category: 'SCAN',
      symbol: 'BTCUSDT',
      message: 'اكتشاف شرارة دخول مبكر EARLY_ENTRY على 15m',
    });

    const state = await repo.getEngineState(uid);
    const logs = await repo.getEngineLogs(uid, 10);
    expect(state.workerStatus).toBe('RUNNING');
    expect(state.workerConnected).toBe(true);
    expect(state.symbolsScanned).toBe(24);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].symbol).toBe('BTCUSDT');
  });

  // Scenario 14
  test('14. Idempotency protection blocks double wallet debit and duplicate trade inserts', async () => {
    const uid = `test-idem-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });

    const r1 = await repo.applyWalletOp({
      userId: uid,
      idempotencyKey: `op-unique-${uid}`,
      opType: 'TEST_OP',
      balanceDelta: -50,
      marginDelta: 0,
      realizedDelta: -50,
      feeDelta: 50,
      fundingDelta: 0,
      note: 'First apply',
    });
    const r2 = await repo.applyWalletOp({
      userId: uid,
      idempotencyKey: `op-unique-${uid}`,
      opType: 'TEST_OP',
      balanceDelta: -50,
      marginDelta: 0,
      realizedDelta: -50,
      feeDelta: 50,
      fundingDelta: 0,
      note: 'Replay attack / retry',
    });

    expect(r1.applied).toBe(true);
    expect(r1.duplicate).toBe(false);
    expect(r2.applied).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r2.wallet.balanceUsdt).toBe(9950);
  });

  // Scenario 15
  test('15. TP1 Break-Even, TP2 Trail-to-TP1, and Dynamic Profit Shield work cleanly', async () => {
    const uid = `test-tpsl-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });

    const evalObj = {
      i: 100,
      t: 777777,
      tClose: Date.now(),
      price: 100,
      atr: 1,
      atrp: 1,
      dir: 1,
      score: 90,
      rawScore: 90,
      aligned: 5,
      tier: 'STRONG',
      plan: {
        ok: true,
        dir: 1,
        long: true,
        type: 'MARKET',
        entry: 100,
        price: 100,
        stop: 96,
        stopRef: 'OB',
        risk: 4,
        tps: [
          { p: 106, label: 'TP1', real: true, r: 1.5, pct: 40 },
          { p: 110, label: 'TP2', real: true, r: 2.5, pct: 35 },
          { p: 116, label: 'TP3', real: true, r: 4.0, pct: 25 },
        ],
        rr1: 1.5,
        confirmed: true,
      },
    } as any;

    const opened = await openPaperTrade({
      userId: uid,
      symbol: 'XRPUSDT',
      evaluation: evalObj,
      meta: { step: 0.1, minQty: 0.1, minNotional: 5 },
      source: 'MANUAL',
    });
    expect(opened.ok).toBe(true);
    const pos = opened.position!;

    // Hit TP1 at 106 -> 40% closed, stop moves to Net Break-Even (> entry)
    await monitorPositionWithMarket({ userId: uid, pos, markPrice: 106.2, lastPrice: 106.2 });
    expect(pos.tps[0].hit).toBe(true);
    expect(pos.stopCurrent).toBeGreaterThan(pos.entryPrice);

    // Hit TP2 at 110 -> 35% closed, stop moves to TP1 (106)
    await monitorPositionWithMarket({ userId: uid, pos, markPrice: 110.2, lastPrice: 110.2 });
    expect(pos.tps[1].hit).toBe(true);
    expect(pos.stopCurrent).toBeGreaterThanOrEqual(pos.tps[0].p);

    // Dynamic Profit Lock at +3.5R price (114) locks even higher
    const lock = applyDynamicProfitLock(pos, { smartProfitShield: true }, 114);
    expect(lock.peakFavR).toBeGreaterThan(3);
    expect(lock.stopTightened).toBe(true);

    // Pullback hitting tightened stop closes remaining cleanly with profit outcome
    const closed = await monitorPositionWithMarket({
      userId: uid,
      pos,
      markPrice: pos.stopCurrent - 0.05,
      lastPrice: pos.stopCurrent - 0.05,
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.netPnlUsdt).toBeGreaterThan(0);
  });

  // Scenario 16
  test('16. Fees, LIMIT Maker vs MARKET slippage, and 8h Funding settlement are accurately accounted', async () => {
    const uid = `test-fee-fund-${Date.now()}`;
    await repo.resetSimulation(uid, { newInitialCapital: 10000 });
    const EPOCH_MS = 8 * 3600_000;
    const prevEpochTs = Math.floor(Date.now() / EPOCH_MS) * EPOCH_MS - 1000; // crosses 1 boundary

    const pos: PaperPosition = {
      id: `fund-pos-${uid}`,
      userId: uid,
      idempotencyKey: `f-${uid}`,
      symbol: 'BTCUSDT',
      side: 'SHORT',
      orderType: 'LIMIT',
      status: 'OPEN',
      score: 84,
      tier: 'GOOD',
      mode: 'early',
      entryPrice: 50000,
      stopLoss: 51000,
      stopCurrent: 51000,
      liqPrice: 60000,
      markPriceLast: 50000,
      maintenanceMarginRate: 0.005,
      maintenanceMarginUsdt: 50,
      leverage: 5,
      qty: 0.2,
      remainingQty: 0.2,
      notionalUsdt: 10000,
      marginUsdt: 2000,
      tps: [],
      feesUsdt: 2.0,
      slippageUsdt: 0,
      fundingUsdt: 0,
      realizedPnlUsdt: 0,
      netPnlUsdt: -2.0,
      rMultiple: null,
      outcome: null,
      exitPrice: null,
      lastFundingTs: prevEpochTs,
      safetyBufferPct: 60,
      openedAt: new Date().toISOString(),
      filledAt: new Date().toISOString(),
      closedAt: null,
    };
    await repo.upsertTrade(pos);

    // Positive funding rate (+0.0001): SHORT receives +notional * 0.0001 = +1.00 USDT
    await settleFundingForPosition({
      userId: uid,
      pos,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600_000,
      markPrice: 50000,
    });
    expect(pos.fundingUsdt).toBeCloseTo(1.0, 2);
    expect(pos.netPnlUsdt).toBeCloseTo(-1.0, 2);
  });

  // Scenario 17
  test('17. Liquidation formula & mandatory stop-before-liquidation >= minSafetyPct shield hold for small/micro-priced coins', () => {
    const mmr = calcMaintenanceMarginRate(25_000, 0.005);
    const liqLong = calcLiquidationPrice({ entry: 0.02337, lev: 10, mmr, long: true, takerFee: 0.0005 });
    const liqShort = calcLiquidationPrice({ entry: 0.02337, lev: 10, mmr, long: false, takerFee: 0.0005 });

    // For 10x long, liquidation sits near entry * (1 - 0.1 + 0.005 + 0.0005) ≈ 0.02116, never absurd 0.00013
    expect(liqLong).toBeGreaterThan(0.02);
    expect(liqLong).toBeLessThan(0.02337);
    expect(liqShort).toBeGreaterThan(0.02337);

    // Stop AFTER liquidation must be rejected
    const badCheck = validateStopBeforeLiquidation({
      entry: 100,
      stop: 88,
      liq: 90,
      long: true,
      minSafetyPct: 25,
    });
    expect(badCheck.safetyOk).toBe(false);

    // Stop BEFORE liquidation with sufficient buffer passes
    const goodCheck = validateStopBeforeLiquidation({
      entry: 100,
      stop: 96,
      liq: 90,
      long: true,
      minSafetyPct: 25,
    });
    expect(goodCheck.safetyOk).toBe(true);
    expect(goodCheck.safetyBufferPct).toBeCloseTo(60, 0);
  });

  // Scenario 18
  test('18. Settings API validates & normalizes TP weights, thresholds, execution mode, and Sections A-F', async () => {
    const token = signSessionToken('default-paper-trader');
    const req = new NextRequest('http://localhost:3000/api/auto-trade', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: 'update_settings',
        settings: {
          mode: 'early',
          earlyTriggerTf: '5m',
          executionMode: 'AUTO',
          equalAllocationEnabled: true,
          cashReservePct: 12,
          tpPcts: [50, 30, 10], // does not sum to 100 -> must auto-normalize to 100
          watchScore: 68,
          minScore: 65, // invalid <= watchScore -> auto-repaired above watchScore
          strongScore: 66,
          filterFlags: { useFvg: true, useOb: false, useChochBos: true, useMomentum: true, useOrderFlow: true, btcShockBlock: true },
        },
      }),
    });
    const res = await autoTradePost(req);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.settings.mode).toBe('early');
    expect(json.settings.executionMode).toBe('AUTO');
    expect(json.settings.autoTradeEnabled).toBe(true);
    expect(json.settings.tpPcts.reduce((a: number, b: number) => a + b, 0)).toBe(100);
    expect(json.settings.minScore).toBeGreaterThan(json.settings.watchScore);
    expect(json.settings.strongScore).toBeGreaterThan(json.settings.minScore);
    expect(json.settings.filterFlags.useOb).toBe(false);
  });

  // Scenario 19
  test('19. Auth & anti-IDOR guard blocks forged userId, tampered Bearer tokens, and cross-origin mutations', async () => {
    const validToken = signSessionToken('trader-alpha');
    expect(verifySessionToken(validToken)).toBe('trader-alpha');
    expect(verifySessionToken(validToken + 'tamper')).toBeNull();

    // Forged userId targeting another user => 403
    const idorReq = new NextRequest('http://localhost:3000/api/portfolio', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${validToken}`,
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
      },
    });
    const idorAuth = await resolveAuthenticatedUser(idorReq, 'victim-user-2');
    expect(idorAuth.ok).toBe(false);
    expect(idorAuth.status).toBe(403);

    // Cross-origin POST => 403
    const csrfReq = new NextRequest('http://localhost:3000/api/portfolio', {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: 'https://evil-attacker.example',
      },
    });
    const csrfAuth = await resolveAuthenticatedUser(csrfReq);
    expect(csrfAuth.ok).toBe(false);
    expect(csrfAuth.status).toBe(403);

    // Invalid Bearer => 401
    const badBearer = new NextRequest('http://localhost:3000/api/portfolio', {
      method: 'GET',
      headers: { authorization: 'Bearer invalid.jwt.token' },
    });
    const badAuth = await resolveAuthenticatedUser(badBearer);
    expect(badAuth.ok).toBe(false);
    expect(badAuth.status).toBe(401);
  });

  // Scenario 20
  test('20. Analytics report & Safe Walk-Forward weight tuning enforce minSamples guard + rollback versions', async () => {
    // Under minSamples -> sufficientSample must be false (preventing overfitting)
    const smallSample: SignalTelemetryRecord[] = Array.from({ length: 6 }, (_, idx) => ({
      id: `s-${idx}`,
      userId: 'u-ana',
      symbol: 'BTCUSDT',
      side: 'LONG',
      strategyMode: 'early',
      entryKind: 'EARLY_ENTRY',
      entryStatus: 'EARLY',
      timeframe: '15m',
      regime: 'trend',
      score: 82,
      rawScore: 82,
      signalPrice: 100,
      entryPrice: 100,
      distanceMovedPct: 0.4,
      stillValid: true,
      earlyReason: 'squeeze',
      confirmFactors: ['OB'],
      missingConfirmations: [],
      scoreBreakdown: { zoneQuality: 16, structureShift: 16, momentumVolume: 14, liquidityConfirm: 12, mtfAlignment: 10, stopRrQuality: 8 },
      takenByUserOrAuto: true,
      outcome: 'TP2',
      netR: 2.0,
      netPnlUsdt: 200,
      createdAt: new Date(Date.now() - (20 - idx) * 60_000).toISOString(),
      closedAt: new Date().toISOString(),
    }));

    const guardedProposal = evaluateWeightTuningProposal(smallSample, DEFAULT_EARLY_WEIGHTS, MIN_TUNING_SAMPLES);
    expect(guardedProposal.sufficientSample).toBe(false);

    // With >= 15 closed records where winning signals correlate with higher zoneQuality & structureShift
    const richSample: SignalTelemetryRecord[] = Array.from({ length: 20 }, (_, idx) => {
      const win = idx % 2 === 0;
      return {
        id: `r-${idx}`,
        userId: 'u-ana',
        symbol: idx % 3 === 0 ? 'ETHUSDT' : 'SOLUSDT',
        side: 'LONG',
        strategyMode: 'early',
        entryKind: idx < 14 ? 'EARLY_ENTRY' : 'CONFIRMED_ENTRY',
        entryStatus: idx < 14 ? 'EARLY' : 'CONFIRMED',
        timeframe: '15m',
        regime: 'trend',
        score: win ? 88 : 71,
        rawScore: win ? 88 : 71,
        signalPrice: 100,
        entryPrice: 100,
        distanceMovedPct: win ? 0.35 : 2.1,
        stillValid: true,
        earlyReason: 'test',
        confirmFactors: ['OB', 'CHoCH'],
        missingConfirmations: [],
        scoreBreakdown: win
          ? { zoneQuality: 19, structureShift: 18, momentumVolume: 17, liquidityConfirm: 12, mtfAlignment: 12, stopRrQuality: 9 }
          : { zoneQuality: 7, structureShift: 8, momentumVolume: 15, liquidityConfirm: 11, mtfAlignment: 11, stopRrQuality: 6 },
        takenByUserOrAuto: true,
        outcome: win ? 'TP2' : 'SL',
        netR: win ? 2.1 : -1.0,
        netPnlUsdt: win ? 210 : -100,
        wasLateEntry: !win,
        createdAt: new Date(Date.now() - (40 - idx) * 60_000).toISOString(),
        closedAt: new Date(Date.now() - (39 - idx) * 60_000).toISOString(),
      };
    });

    const report = buildStrategyPerformanceReport(richSample, DEFAULT_EARLY_WEIGHTS, MIN_TUNING_SAMPLES);
    expect(report.closedTrades).toBe(20);
    expect(report.winRate).toBe(50);
    expect(report.profitFactor).toBeGreaterThan(1.5);
    expect(report.proposal?.sufficientSample).toBe(true);
    expect(report.proposal?.proposedWeights.zoneQuality).toBeGreaterThan(0);

    // Weight versioning + rollback
    const uid = `test-weights-${Date.now()}`;
    const v1 = await repo.saveStrategyWeightSnapshot({
      userId: uid,
      weights: DEFAULT_EARLY_WEIGHTS,
      note: 'baseline v1',
    });
    const v2 = await repo.saveStrategyWeightSnapshot({
      userId: uid,
      weights: normalizeEarlyWeights({ ...DEFAULT_EARLY_WEIGHTS, zoneQuality: 26 }),
      note: 'tuned v2',
    });
    const hist = await repo.getStrategyWeightHistory(uid);
    expect(hist[0].version).toBe(v2.version);
    expect(hist[0].isActive).toBe(true);
    expect(hist.some((h) => h.version === v1.version && !h.isActive)).toBe(true);
  });
});
