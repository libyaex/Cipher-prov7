/* ============================================================
   CIPHER X PRO — ENGINE D : محاكاة الصفقات + الباكتيست + Walk-Forward OOS
   ============================================================ */
import { buildBtcContext, DEFAULTS, prepare } from './analyzer';
import { isN } from './indicators';
import { evaluate } from './planner';
import { detectMomentumReversalSignal } from './smart-tp';
import type {
  Candle,
  EngineConfig,
  ModeConfig,
  SimulatedTrade,
  SmartTpSensitivity,
  SymbolMeta,
  TradePlan,
} from './types';

export function newTrade(
  plan: TradePlan,
  o: {
    id?: string;
    sym: string;
    t: number;
    tier: string;
    score: number;
    tfMs?: number;
    meta?: Record<string, any>;
    actualEntry?: number;
    isOos?: boolean;
  }
): SimulatedTrade {
  const entry = isN(o.actualEntry) ? o.actualEntry : (plan.entry as number);
  const stop = plan.stop as number;
  const risk = Math.abs(entry - stop) || (plan.risk as number);
  return {
    id: o.id || `${o.sym}-${o.t}`,
    sym: o.sym,
    dir: plan.dir as number,
    type: plan.type || 'MARKET',
    tier: o.tier,
    score: o.score,
    entry,
    stop,
    stopCur: stop,
    risk,
    feeR: plan.feeR || 0,
    tps: (plan.tps || []).map((t) => ({ p: t.p, pct: t.pct, hit: false })),
    status: plan.type === 'MARKET' ? 'OPEN' : 'PENDING',
    t0: o.t,
    tFill: plan.type === 'MARKET' ? o.t : null,
    tEnd: null,
    expireAt: o.t + (plan.expireBars || 8) * (o.tfMs || 900e3),
    lastT: o.t,
    realized: 0,
    remaining: 1,
    maxFav: 0,
    maxAdv: 0,
    outcome: null,
    exitPrice: null,
    R: null,
    bars: 0,
    fundingR: 0,
    isOos: !!o.isOos,
    meta: o.meta || {},
  };
}

const rOf = (tr: SimulatedTrade, p: number): number => (tr.dir * (p - tr.entry)) / tr.risk;

function findHistoricalFundingRate(
  rates: { t: number; r: number }[] | undefined,
  boundaryMs: number,
  fallback: number
): number {
  if (!rates || !rates.length) return fallback;
  let lo = 0;
  let hi = rates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rates[mid].t <= boundaryMs + 120e3) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0 && Math.abs(rates[best].t - boundaryMs) <= 8 * 3600e3) {
    return rates[best].r;
  }
  return fallback;
}

export function step(
  tr: SimulatedTrade,
  bar: { t: number; o: number; h: number; l: number; c: number; v?: number; q?: number; Q?: number; V?: number },
  opt?: {
    fundingRate?: number;
    fundingIntervalMs?: number;
    fundingRates?: { t: number; r: number }[];
    smartProfitShield?: boolean;
    smartTakeProfitEnabled?: boolean;
    smartTakeProfitMinR?: number;
    smartTakeProfitPartialPct?: number;
    smartTakeProfitSensitivity?: SmartTpSensitivity;
    candlesWindow?: Candle[];
    meanBarVol?: number;
  }
): SimulatedTrade {
  if (tr.status === 'CLOSED' || tr.status === 'CANCELLED') return tr;
  const long = tr.dir > 0;
  const prevT = tr.lastT;
  tr.lastT = bar.t;

  let filledByGap = false;
  if (tr.status === 'PENDING') {
    if (bar.t >= tr.expireAt) {
      tr.status = 'CANCELLED';
      tr.outcome = 'EXPIRED';
      tr.tEnd = bar.t;
      return tr;
    }
    const gappedThroughEntry = long ? bar.o <= tr.entry : bar.o >= tr.entry;
    const touchedEntry = long ? bar.l <= tr.entry : bar.h >= tr.entry;
    if (!touchedEntry && !gappedThroughEntry) {
      if (long ? bar.h >= tr.entry + 4 * tr.risk : bar.l <= tr.entry - 4 * tr.risk) {
        tr.status = 'CANCELLED';
        tr.outcome = 'MISSED';
        tr.tEnd = bar.t;
      }
      return tr;
    }
    if (gappedThroughEntry) {
      const gappedPastStop = long ? bar.o <= tr.stopCur : bar.o >= tr.stopCur;
      if (gappedPastStop) {
        tr.status = 'CANCELLED';
        tr.outcome = 'MISSED';
        tr.tEnd = bar.t;
        return tr;
      }
      tr.entry = bar.o;
      tr.risk = Math.abs(tr.entry - tr.stop);
      filledByGap = true;
    }
    tr.status = 'OPEN';
    tr.tFill = bar.t;
    tr.justFilled = true;
  } else {
    tr.justFilled = false;
  }

  tr.bars++;

  // Settle all crossed 8h funding boundaries (supports historical Binance funding series + fallback rate)
  const fallbackRate = opt?.fundingRate ?? 0;
  const fInt = opt?.fundingIntervalMs ?? 8 * 3600e3;
  if (prevT > 0) {
    const startP = Math.floor(prevT / fInt);
    const endP = Math.floor(bar.t / fInt);
    if (endP > startP) {
      const riskPctOfEntry = tr.risk / tr.entry;
      if (riskPctOfEntry > 0) {
        for (let p = startP + 1; p <= endP; p++) {
          const rate = findHistoricalFundingRate(opt?.fundingRates, p * fInt, fallbackRate);
          if (rate !== 0) {
            const fR = (tr.dir * tr.remaining * rate) / riskPctOfEntry;
            tr.fundingR += fR;
          }
        }
      }
    }
  }

  const fav = long ? rOf(tr, bar.h) : rOf(tr, bar.l);
  const adv = long ? rOf(tr, bar.l) : rOf(tr, bar.h);
  if (fav > tr.maxFav) tr.maxFav = fav;
  if (adv < tr.maxAdv) tr.maxAdv = adv;

  const stopEnteringBar = tr.stopCur;
  const hitStop = (b: { l: number; h: number }, stopLevel: number) =>
    long ? b.l <= stopLevel : b.h >= stopLevel;

  const closeAt = (price: number, tag?: string) => {
    tr.realized += tr.remaining * rOf(tr, price);
    tr.remaining = 0;
    tr.exitPrice = price;
    tr.status = 'CLOSED';
    tr.tEnd = bar.t;
    tr.R = tr.realized - tr.feeR - tr.fundingR;
    const n = tr.tps.filter((t) => t.hit).length;
    tr.outcome = tag || (n ? 'TP' + n : 'SL');
  };

  if (hitStop(bar, stopEnteringBar)) {
    const fillPx = long ? Math.min(stopEnteringBar, bar.o) : Math.max(stopEnteringBar, bar.o);
    const hits = tr.tps.filter((t) => t.hit).length;
    const lockedMoveR = rOf(tr, stopEnteringBar);
    const tp1MoveR = tr.tps[0] ? rOf(tr, tr.tps[0].p) : 1.5;
    const wasShieldStop =
      lockedMoveR >= 0.45 && (hits <= 1 || lockedMoveR > tp1MoveR + 0.05);
    const smartPartialTag =
      hits === 0 && tr.meta?.smartTpPartialDone && lockedMoveR >= -0.05 ? 'SMART_PARTIAL_TP' : null;
    closeAt(fillPx, smartPartialTag || (wasShieldStop ? 'TRAIL_PROFIT' : hits ? `TP${hits}+BE` : 'SL'));
    return tr;
  }

  if (tr.justFilled && !filledByGap) {
    return tr;
  }

  // Baseline: TP1 moves stop to Net Break-Even ONLY; TP2 moves stop to TP1.
  let nextStopCur = stopEnteringBar;
  for (let k = 0; k < tr.tps.length; k++) {
    const t = tr.tps[k];
    if (t.hit) continue;
    if (long ? bar.h >= t.p : bar.l <= t.p) {
      t.hit = true;
      const part = Math.min(tr.remaining, t.pct / 100);
      tr.realized += part * rOf(tr, t.p);
      tr.remaining -= part;
      if (k === 0) {
        const beStop = tr.entry + tr.dir * (tr.feeR + tr.fundingR) * tr.risk;
        nextStopCur = long ? Math.max(nextStopCur, beStop) : Math.min(nextStopCur, beStop);
      }
      if (k === 1 && tr.tps[0]) {
        nextStopCur = long
          ? Math.max(nextStopCur, tr.tps[0].p)
          : Math.min(nextStopCur, tr.tps[0].p);
      }
    } else {
      break;
    }
  }
  tr.stopCur = nextStopCur;

  if (tr.remaining <= 1e-9) {
    tr.remaining = 0;
    tr.status = 'CLOSED';
    tr.exitPrice = tr.tps[2]?.p ?? tr.tps[tr.tps.length - 1]?.p ?? bar.c;
    tr.tEnd = bar.t;
    tr.R = tr.realized - tr.feeR - tr.fundingR;
    tr.outcome = 'TP3';
    return tr;
  }

  // Smart Profit Shield (Layer A: Dynamic Peak-R Trailing Lock, Layer B: Reversal Bar Exit)
  if (opt?.smartProfitShield && tr.status === 'OPEN' && tr.risk > 0) {
    const tp1Hit = Boolean(tr.tps[0]?.hit);
    if ((tp1Hit && tr.maxFav >= 1.65) || tr.maxFav >= 1.85) {
      const lockRatio = tr.maxFav >= 3.2 ? 0.72 : tr.maxFav >= 2.2 ? 0.65 : 0.50;
      const lockMoveR = tr.maxFav * lockRatio;
      const shieldStop = tr.entry + tr.dir * lockMoveR * tr.risk;
      if (long ? shieldStop > tr.stopCur : shieldStop < tr.stopCur) {
        tr.stopCur = shieldStop;
      }
    }

    const curFavR = rOf(tr, bar.c);
    if ((tp1Hit && curFavR >= 0.65) || (tr.maxFav >= 1.6 && curFavR >= 0.80)) {
      const isCounterCandle = long ? bar.c < bar.o : bar.c > bar.o;
      const range = Math.max(1e-12, bar.h - bar.l);
      const body = Math.abs(bar.c - bar.o);
      const strongBody = body / range >= 0.55;
      const meaningfulDrop = body >= 0.45 * tr.risk;

      let flowConfirm = true;
      if (isN(bar.q) && (bar.q as number) > 0 && isN(bar.Q)) {
        const buyRatio = (bar.Q as number) / (bar.q as number);
        flowConfirm = long ? buyRatio <= 0.45 : buyRatio >= 0.55;
      } else if (isN(bar.v) && (bar.v as number) > 0 && isN(bar.V)) {
        const buyRatio = (bar.V as number) / (bar.v as number);
        flowConfirm = long ? buyRatio <= 0.45 : buyRatio >= 0.55;
      }

      const volNow = isN(bar.q) ? (bar.q as number) : isN(bar.v) ? (bar.v as number) : 0;
      const rvolConfirm =
        opt.meanBarVol && opt.meanBarVol > 0 && volNow > 0 ? volNow / opt.meanBarVol >= 1.2 : true;
      const sharpGiveback = tr.maxFav - curFavR >= 0.75;

      if (isCounterCandle && strongBody && meaningfulDrop && ((flowConfirm && rvolConfirm) || sharpGiveback)) {
        closeAt(bar.c, 'SMART_EXIT');
        return tr;
      }
    }
  }

  // Smart Take Profit (Early Partial/Full Exit before TP targets on lower-TF momentum & candle reversal)
  if (opt?.smartTakeProfitEnabled && tr.status === 'OPEN' && tr.risk > 0 && tr.remaining > 1e-9) {
    const curFavR = rOf(tr, bar.c);
    const windowCandles = opt.candlesWindow && opt.candlesWindow.length >= 4 ? opt.candlesWindow : [];
    if (windowCandles.length >= 4) {
      const smartSig = detectMomentumReversalSignal({
        dir: tr.dir,
        candlesPrimary: windowCandles,
        riskDist: tr.risk,
        curFavR,
        peakFavR: tr.maxFav,
        minR: opt.smartTakeProfitMinR ?? 0.6,
        sensitivity: opt.smartTakeProfitSensitivity ?? 'balanced',
        partialAlreadyDone: Boolean(tr.meta?.smartTpPartialDone),
      });
      if (smartSig.action === 'FULL') {
        closeAt(bar.c, 'SMART_EXIT');
        return tr;
      }
      if (smartSig.action === 'PARTIAL' && !tr.meta?.smartTpPartialDone) {
        const pct = Math.max(10, Math.min(100, opt.smartTakeProfitPartialPct ?? 50));
        if (pct >= 95) {
          closeAt(bar.c, 'SMART_EXIT');
          return tr;
        }
        const closeFrac = Math.min(tr.remaining, tr.remaining * (pct / 100));
        tr.realized += closeFrac * curFavR;
        tr.remaining = Math.max(0, tr.remaining - closeFrac);
        tr.meta = tr.meta || {};
        tr.meta.smartTpPartialDone = true;
        tr.meta.smartTpPartialR = +curFavR.toFixed(2);
        if (curFavR >= 0.45) {
          const protStop = tr.entry + tr.dir * Math.min(curFavR * 0.25, tr.feeR + tr.fundingR) * tr.risk;
          if (long ? protStop > tr.stopCur : protStop < tr.stopCur) {
            tr.stopCur = protStop;
          }
        }
        if (tr.remaining <= 1e-9) {
          closeAt(bar.c, 'SMART_PARTIAL_TP');
          return tr;
        }
      }
    }
  }

  return tr;
}

export const unrealizedR = (tr: SimulatedTrade, price: number): number =>
  tr.status === 'OPEN'
    ? tr.realized + tr.remaining * rOf(tr, price) - tr.feeR - tr.fundingR
    : tr.R ?? 0;

export function stats(trades: SimulatedTrade[]) {
  const done = trades.filter((t) => t.status === 'CLOSED' && isN(t.R));
  const n = done.length;
  const out = {
    n,
    wins: 0,
    losses: 0,
    be: 0,
    winRate: NaN,
    avgR: NaN,
    expectancy: NaN,
    pf: NaN,
    sumR: 0,
    maxDD: 0,
    sharpe: NaN,
    sortino: NaN,
    calmar: NaN,
    maxWinStreak: 0,
    maxLossStreak: 0,
    avgMfe: NaN,
    avgMae: NaN,
    avgWin: NaN,
    avgLoss: NaN,
    best: NaN,
    worst: NaN,
    avgBars: NaN,
    tp1Rate: NaN,
    totalFundingR: 0,
    curve: [] as { t: number | null; v: number }[],
    ddCurve: [] as { t: number | null; v: number }[],
    long: null as { n: number; winRate: number; avgR: number } | null,
    short: null as { n: number; winRate: number; avgR: number } | null,
    byRegime: {} as Record<string, { n: number; winRate: number; avgR: number; sumR: number }>,
    buckets: [] as { name: string; n: number; winRate: number; avgR: number }[],
    outcomes: {} as Record<string, number>,
  };
  if (!n) return out;

  let gw = 0;
  let gl = 0;
  let cum = 0;
  let peak = 0;
  let bars = 0;
  let tp1 = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let sumMfe = 0;
  let sumMae = 0;
  const rs: number[] = [];

  for (const t of done) {
    const r = t.R as number;
    rs.push(r);
    if (r > 0.05) {
      out.wins++;
      gw += r;
      winStreak++;
      lossStreak = 0;
      if (winStreak > out.maxWinStreak) out.maxWinStreak = winStreak;
    } else if (r < -0.05) {
      out.losses++;
      gl += -r;
      lossStreak++;
      winStreak = 0;
      if (lossStreak > out.maxLossStreak) out.maxLossStreak = lossStreak;
    } else {
      out.be++;
      winStreak = 0;
      lossStreak = 0;
    }
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > out.maxDD) out.maxDD = dd;
    out.curve.push({ t: t.tEnd, v: cum });
    out.ddCurve.push({ t: t.tEnd, v: -dd });
    bars += t.bars;
    sumMfe += t.maxFav || 0;
    sumMae += t.maxAdv || 0;
    out.totalFundingR += t.fundingR || 0;
    if (t.tps && t.tps[0]?.hit) tp1++;
    if (t.outcome) out.outcomes[t.outcome] = (out.outcomes[t.outcome] || 0) + 1;
  }

  out.sumR = cum;
  out.winRate = (100 * out.wins) / n;
  out.avgR = cum / n;
  out.pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN;
  out.avgWin = out.wins ? gw / out.wins : NaN;
  out.avgLoss = out.losses ? -gl / out.losses : NaN;
  out.best = Math.max(...rs);
  out.worst = Math.min(...rs);
  out.avgBars = bars / n;
  out.tp1Rate = (100 * tp1) / n;
  out.avgMfe = sumMfe / n;
  out.avgMae = sumMae / n;
  out.expectancy =
    (out.wins / n) * (isN(out.avgWin) ? out.avgWin : 0) -
    (out.losses / n) * (isN(out.avgLoss) ? Math.abs(out.avgLoss) : 0);

  if (n >= 2) {
    const mean = out.avgR;
    const variance = rs.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1);
    const std = Math.sqrt(variance);
    out.sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : NaN;
    const downs = rs.filter((r) => r < 0);
    const dVar = downs.length ? downs.reduce((s, r) => s + r * r, 0) / n : 0;
    const dStd = Math.sqrt(dVar);
    out.sortino = dStd > 0 ? (mean / dStd) * Math.sqrt(n) : NaN;
  }
  out.calmar = out.maxDD > 0 ? cum / out.maxDD : cum > 0 ? Infinity : NaN;

  const sub = (f: (t: SimulatedTrade) => boolean) => {
    const a = done.filter(f);
    if (!a.length) return null;
    const w = a.filter((t) => (t.R as number) > 0.05).length;
    const sumR = a.reduce((s, t) => s + (t.R as number), 0);
    return {
      n: a.length,
      winRate: (100 * w) / a.length,
      avgR: sumR / a.length,
      sumR,
    };
  };
  out.long = sub((t) => t.dir > 0);
  out.short = sub((t) => t.dir < 0);

  for (const reg of ['trend', 'range', 'mixed']) {
    const s = sub((t) => (t.regime || 'mixed') === reg);
    if (s) out.byRegime[reg] = s;
  }

  for (const [lo, hi, name] of [
    [62, 70, '62–69'],
    [70, 80, '70–79'],
    [80, 90, '80–89'],
    [90, 101, '90+'],
  ] as const) {
    const b = sub((t) => t.score >= lo && t.score < hi);
    if (b) out.buckets.push({ name, n: b.n, winRate: b.winRate, avgR: b.avgR });
  }
  return out;
}

export async function runBacktest(
  candles: Record<string, Candle[]>,
  tfs: ModeConfig,
  meta?: Partial<SymbolMeta>,
  cfg?: Partial<EngineConfig>,
  opt?: {
    sym?: string;
    warm?: number;
    fundingRate?: number;
    fundingRates?: { t: number; r: number }[];
    btcCandles?: Record<string, Candle[]>;
    smartProfitShield?: boolean;
    smartTakeProfitEnabled?: boolean;
    smartTakeProfitMinR?: number;
    smartTakeProfitPartialPct?: number;
    smartTakeProfitSensitivity?: SmartTpSensitivity;
    onProgress?: (p: number) => void;
  }
) {
  opt = opt || {};
  const ctx = prepare(candles, tfs, meta, cfg);
  const T = ctx.B.trigger;
  if (!T) throw new Error('بيانات غير كافية');

  const btcCtx = opt.btcCandles ? prepare(opt.btcCandles, tfs, { sym: 'BTCUSDT' }, cfg) : null;

  const n = T.n;
  const trades: SimulatedTrade[] = [];
  const cfgx = ctx.cfg;
  const slip = cfgx.slip ?? DEFAULTS.slip;
  const defaultFunding = opt.fundingRate ?? 0.0001;
  const useSmartShield = opt.smartProfitShield ?? cfgx.smartProfitShield ?? true;
  const useSmartTp = opt.smartTakeProfitEnabled ?? cfgx.smartTakeProfitEnabled ?? true;
  const smartTpMinR = opt.smartTakeProfitMinR ?? cfgx.smartTakeProfitMinR ?? 0.6;
  const smartTpPartialPct = opt.smartTakeProfitPartialPct ?? cfgx.smartTakeProfitPartialPct ?? 50;
  const smartTpSens = opt.smartTakeProfitSensitivity ?? cfgx.smartTakeProfitSensitivity ?? 'balanced';

  let warm = Math.max(220, opt.warm || 0);
  for (const S of [ctx.B.setup, ctx.B.trend]) {
    if (!S) continue;
    if (S.n < 215) throw new Error(`بيانات غير كافية على إطار ${S.tf} (${S.n} شمعة، المطلوب 215+)`);
    while (warm < n && T.t[warm] + T.ms < S.t[204] + S.ms) warm++;
  }
  if (n - warm < 50) throw new Error('الفترة المتاحة للاختبار قصيرة جداً بعد فترة التسخين');

  const oosSplitIdx = warm + Math.floor((n - warm) * 0.65);

  let active: SimulatedTrade | null = null;
  let cool = 0;
  let evals = 0;
  const t0 = Date.now();

  for (let i = warm; i < n; i++) {
    const bar = {
      t: T.t[i],
      o: T.o[i],
      h: T.h[i],
      l: T.l[i],
      c: T.c[i],
      v: T.v[i],
      q: T.q[i],
      V: T.tb[i],
    };
    if (active) {
      let volSum = 0;
      let volCnt = 0;
      for (let k = Math.max(0, i - 20); k < i; k++) {
        volSum += T.q[k] > 0 ? T.q[k] : T.v[k] * T.c[k];
        volCnt++;
      }
      const meanBarVol = volCnt > 0 ? volSum / volCnt : 0;
      let candlesWindow: Candle[] | undefined;
      if (useSmartTp) {
        candlesWindow = [];
        const startIdx = Math.max(0, i - 27);
        for (let w = startIdx; w <= i; w++) {
          candlesWindow.push({
            t: T.t[w],
            o: T.o[w],
            h: T.h[w],
            l: T.l[w],
            c: T.c[w],
            v: T.v[w],
            q: T.q[w],
            V: T.tb[w],
            x: true,
          });
        }
      }
      step(active, bar, {
        fundingRate: defaultFunding,
        fundingRates: opt.fundingRates,
        smartProfitShield: useSmartShield,
        smartTakeProfitEnabled: useSmartTp,
        smartTakeProfitMinR: smartTpMinR,
        smartTakeProfitPartialPct: smartTpPartialPct,
        smartTakeProfitSensitivity: smartTpSens,
        candlesWindow,
        meanBarVol,
      });
      if (active.status === 'CLOSED' || active.status === 'CANCELLED') {
        if (active.status === 'CLOSED') trades.push(active);
        cool = i + cfgx.cooldownBars;
        active = null;
      }
    }

    if (!active && i >= cool && i < n - 1) {
      const barClose = T.t[i] + T.ms;
      const btcContext =
        btcCtx && opt.sym !== 'BTCUSDT' ? buildBtcContext(btcCtx, barClose) : null;
      const R = evaluate(ctx, i, { price: T.c[i], now: barClose, btcContext });
      evals++;
      if (R && R.plan && R.plan.ok && (R.tier === 'GOOD' || R.tier === 'STRONG')) {
        const nextOpen = T.o[i + 1];
        const long = R.plan.dir! > 0;
        let actualEntry = R.plan.entry!;

        if (R.plan.type === 'MARKET') {
          actualEntry = long ? nextOpen * (1 + slip) : nextOpen * (1 - slip);
          if (long ? actualEntry <= R.plan.stop! : actualEntry >= R.plan.stop!) {
            continue;
          }
        }

        const tr = newTrade(R.plan, {
          sym: opt.sym || 'X',
          t: T.t[i + 1],
          tier: R.tier,
          score: R.score,
          tfMs: T.ms,
          id: `${opt.sym || 'X'}-${T.t[i]}`,
          actualEntry,
          isOos: i >= oosSplitIdx,
        });
        tr.regime = R.regime.type;
        tr.signalBar = i;
        active = tr;
      }
    }

    if (opt.onProgress && i % 100 === 0) {
      opt.onProgress((i - warm) / Math.max(1, n - 1 - warm));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const st = stats(trades);
  const inSample = stats(trades.filter((t) => !t.isOos));
  const outOfSample = stats(trades.filter((t) => t.isOos));
  const degraded =
    outOfSample.n >= 3 &&
    inSample.n >= 3 &&
    ((isN(outOfSample.avgR) && outOfSample.avgR < 0 && isN(inSample.avgR) && inSample.avgR > 0) ||
      (isN(outOfSample.winRate) && isN(inSample.winRate) && outOfSample.winRate + 15 < inSample.winRate));

  const walkForward = {
    splitTs: T.t[oosSplitIdx] || T.t[n - 1],
    inSample,
    outOfSample,
    degraded,
    note:
      outOfSample.n < 3
        ? 'عدد صفقات العينة الخارجية قليل للحكم الإحصائي الكامل'
        : degraded
          ? 'تحذير: الأداء خارج العينة (OOS) أضعف ملحوظاً من العينة الداخلية'
          : 'ثبات جيد للاستراتيجية في بيانات الاختبار الخارجة عن العينة (OOS)',
  };

  const lastPrice = T.c[n - 1];
  const openUnrealizedR = active && active.status === 'OPEN' ? unrealizedR(active, lastPrice) : 0;

  return {
    trades,
    stats: st,
    walkForward,
    bars: n - warm,
    from: T.t[warm],
    to: T.t[n - 1],
    evals,
    ms: Date.now() - t0,
    openTrade: active && active.status === 'OPEN' ? active : null,
    openUnrealizedR,
  };
}
