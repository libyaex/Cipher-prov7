/* ============================================================
   CIPHER X PRO — ENGINE C4 : استراتيجية جني الأرباح الذكي (Smart Take Profit)
   رصد ضعف الزخم وانعكاس الشموع وتدفق السيولة على الأطر الصغرى لتأمين الأرباح مبكراً
   ============================================================ */
import { clamp, ind, isN } from './indicators';
import type { Candle, OrderFlowSnapshot, SmartTpSensitivity } from './types';

export interface SmartTpEvaluation {
  action: 'NONE' | 'PARTIAL' | 'FULL';
  strength: number; // 0..100
  reasons: string[];
  summary: string;
}

const THRESHOLDS: Record<SmartTpSensitivity, { partial: number; full: number }> = {
  aggressive: { partial: 42, full: 68 },
  balanced: { partial: 52, full: 76 },
  conservative: { partial: 62, full: 84 },
};

function candleBuyRatio(c: Candle): number | null {
  if (isN(c.q) && c.q > 0 && isN(c.Q) && c.Q >= 0) {
    return clamp(c.Q / c.q, 0, 1);
  }
  if (isN(c.v) && c.v > 0 && isN(c.V) && c.V >= 0) {
    return clamp(c.V / c.v, 0, 1);
  }
  return null;
}

function candleQuoteVol(c: Candle): number {
  if (isN(c.q) && c.q > 0) return c.q;
  return Math.max(0, (c.v || 0) * (c.c || c.o || 1));
}

export function detectMomentumReversalSignal(params: {
  dir: number; // +1 LONG | -1 SHORT
  candlesPrimary: Candle[]; // 5m on live engine, trigger TF in backtest
  candlesMicro?: Candle[]; // optional 1m candles for extra precision
  orderFlow?: OrderFlowSnapshot | null;
  riskDist: number;
  curFavR: number;
  peakFavR: number;
  minR?: number;
  sensitivity?: SmartTpSensitivity;
  partialAlreadyDone?: boolean;
}): SmartTpEvaluation {
  const {
    dir,
    candlesPrimary,
    candlesMicro,
    orderFlow = null,
    riskDist,
    curFavR,
    peakFavR,
    minR = 0.6,
    sensitivity = 'balanced',
    partialAlreadyDone = false,
  } = params;

  const empty: SmartTpEvaluation = { action: 'NONE', strength: 0, reasons: [], summary: '' };
  if (!(riskDist > 0) || !dir) return empty;

  const effMinR = Math.max(0.2, minR);
  if (curFavR < effMinR && !(peakFavR >= 1.5 && curFavR >= 0.45)) {
    return empty;
  }

  const closedPrimary = (candlesPrimary || []).filter((c) => c.x !== false);
  const closedMicro = (candlesMicro || []).filter((c) => c.x !== false);
  const series = closedPrimary.length >= 6 ? closedPrimary : closedMicro;
  if (series.length < 4) return empty;

  const long = dir > 0;
  let candlePts = 0;
  let momentumPts = 0;
  let flowPts = 0;
  let givebackPts = 0;
  const reasons: string[] = [];

  // 1. Candle Direction, Engulfing & Rejection Wick Analysis
  const n = series.length;
  const b = series[n - 1];
  const p1 = series[n - 2];
  const bRange = Math.max(1e-12, b.h - b.l);
  const bBody = Math.abs(b.c - b.o);
  const p1Body = Math.abs(p1.c - p1.o);
  const bCounter = long ? b.c < b.o : b.c > b.o;
  const p1Counter = long ? p1.c < p1.o : p1.c > p1.o;
  const bFavorablePrev = long ? p1.c >= p1.o : p1.c <= p1.o;

  const upperWick = b.h - Math.max(b.o, b.c);
  const lowerWick = Math.min(b.o, b.c) - b.l;
  const rejectionWick = long ? upperWick : lowerWick;
  const isRejectionPin =
    rejectionWick / bRange >= 0.48 && rejectionWick >= 1.9 * Math.max(bBody, bRange * 0.08);

  const isEngulfing =
    bCounter &&
    bFavorablePrev &&
    bBody >= p1Body * 1.05 &&
    (long ? b.c <= p1.o : b.c >= p1.o);

  if (bCounter && bBody / bRange >= 0.5) {
    candlePts += isEngulfing ? 30 : 22;
    reasons.push(isEngulfing ? 'شمعة ابتلاعية معاكسة على الإطار الأصغر' : 'شمعة زخم معاكسة قوية');
  }

  if (bCounter && p1Counter) {
    const twoSpan = long ? p1.o - b.c : b.c - p1.o;
    if (twoSpan >= 0.22 * riskDist) {
      candlePts = Math.max(candlePts, 24);
      if (bBody / bRange >= 0.48) candlePts += 6;
      if (!reasons.some((r) => r.includes('شمعتين'))) {
        reasons.push('شمعتين متتاليتين باتجاه معاكس');
      }
    }
  }

  if (isRejectionPin) {
    candlePts = Math.max(candlePts, 20);
    reasons.push(long ? 'ذيل رفض علوي (تصريف)' : 'ذيل رفض سفلي (ارتداد شرائي)');
  }
  candlePts = Math.min(34, candlePts);

  // Also inspect ultra-fast 1m burst if micro candles are separate
  if (closedMicro.length >= 6 && series !== closedMicro) {
    const mn = closedMicro.length;
    const m0 = closedMicro[mn - 3];
    const m2 = closedMicro[mn - 1];
    const mCounter =
      (long ? m2.c < m2.o : m2.c > m2.o) && (long ? closedMicro[mn - 2].c < closedMicro[mn - 2].o : closedMicro[mn - 2].c > closedMicro[mn - 2].o);
    const mSpan = long ? m0.o - m2.c : m2.c - m0.o;
    if (mCounter && mSpan >= 0.28 * riskDist) {
      candlePts = Math.min(36, candlePts + 8);
      if (!reasons.some((r) => r.includes('1m'))) {
        reasons.push('انعكاس سريع متسارع على 1m');
      }
    }
  }

  // 2. Lower-Timeframe Momentum Indicators (EMA9/21, MACD Histogram, RSI)
  if (n >= 16) {
    const closes = new Float64Array(n);
    for (let i = 0; i < n; i++) closes[i] = series[i].c;

    const ema9 = ind.ema(closes, 9);
    const ema21 = ind.ema(closes, Math.min(21, n - 2));
    const idx = n - 1;
    const e9 = ema9[idx];
    const e21 = ema21[idx];
    const closePx = closes[idx];

    if (isN(e9) && isN(e21)) {
      const lostE9 = long ? closePx < e9 : closePx > e9;
      const lostE21 = long ? closePx < e21 : closePx > e21;
      const emaCrossed = long ? e9 < e21 : e9 > e21;
      if (lostE21 || (lostE9 && emaCrossed)) {
        momentumPts += 18;
        reasons.push('كسر متوسط الزخم EMA9/EMA21');
      } else if (lostE9 && bCounter) {
        momentumPts += 10;
        reasons.push('فقدان متوسط EMA9');
      }
    }

    const macd = ind.macd(closes, 8, 17, 6);
    const h0 = macd.hist[idx];
    const h1 = macd.hist[idx - 1];
    const h2 = macd.hist[idx - 2];
    if (isN(h0) && isN(h1) && isN(h2)) {
      const flipped = dir * h0 < 0 && dir * h1 >= -Math.abs(h0) * 0.25;
      const contracting =
        dir * h0 < dir * h1 &&
        dir * h1 < dir * h2 &&
        Math.abs(h0) < Math.abs(h2) * 0.72;
      if (flipped) {
        momentumPts += 16;
        reasons.push('انقلاب هستوغرام MACD بالاتجاه المعاكس');
      } else if (contracting) {
        momentumPts += 10;
        reasons.push('تباطؤ واضح في زخم MACD');
      }
    }

    const rsi = ind.rsi(closes, Math.min(14, n - 2));
    const rNow = rsi[idx];
    if (isN(rNow)) {
      let peakRsi = rNow;
      let troughRsi = rNow;
      for (let k = Math.max(0, idx - 6); k < idx; k++) {
        if (isN(rsi[k])) {
          if (rsi[k] > peakRsi) peakRsi = rsi[k];
          if (rsi[k] < troughRsi) troughRsi = rsi[k];
        }
      }
      if (long && peakRsi >= 66 && peakRsi - rNow >= 6 && rNow < 62) {
        momentumPts += 14;
        reasons.push(`ارتداد RSI من تشبع شرائي (${peakRsi.toFixed(0)}→${rNow.toFixed(0)})`);
      } else if (!long && troughRsi <= 34 && rNow - troughRsi >= 6 && rNow > 38) {
        momentumPts += 14;
        reasons.push(`ارتداد RSI من تشبع بيعي (${troughRsi.toFixed(0)}→${rNow.toFixed(0)})`);
      }
    }
  }
  momentumPts = Math.min(34, momentumPts);

  // 3. Volume Spike & Taker / Order Flow Flip
  const volSlice = series.slice(Math.max(0, n - 17), n - 1);
  const avgVol =
    volSlice.length > 0
      ? volSlice.reduce((s, x) => s + candleQuoteVol(x), 0) / volSlice.length
      : 0;
  const curVol = candleQuoteVol(b);
  const rvol = avgVol > 0 ? curVol / avgVol : 1;
  const buyRatio = candleBuyRatio(b);
  const takerAgainst =
    buyRatio != null && (long ? buyRatio <= 0.44 : buyRatio >= 0.56);

  if (bCounter && (rvol >= 1.25 || takerAgainst)) {
    flowPts += rvol >= 1.35 && takerAgainst ? 16 : 11;
    reasons.push(`ضغط ${long ? 'بيع' : 'شراء'} مضاد (RVOL ${rvol.toFixed(1)}x)`);
  }

  if (orderFlow) {
    const flowCounter =
      orderFlow.verdict === 'COUNTER_FLOW' ||
      (orderFlow.confidence >= 0.36 && dir * orderFlow.netBias <= -0.26);
    const absCounter =
      (long && orderFlow.absorption === 'BEAR') || (!long && orderFlow.absorption === 'BULL');
    if (flowCounter || absCounter) {
      flowPts += 20;
      reasons.push(
        absCounter
          ? 'رصد امتصاص سيولة معاكس على 1m/5m'
          : `انقلاب تدفق الأوامر الصغرى (${(orderFlow.netBias * 100).toFixed(0)}%)`
      );
    }
  }
  flowPts = Math.min(24, flowPts);

  // 4. Peak Profit Giveback Confirmation
  if (peakFavR >= 1.2 && peakFavR - curFavR >= 0.45 && (bCounter || momentumPts >= 10)) {
    givebackPts = 12;
    reasons.push(`تراجع ${(peakFavR - curFavR).toFixed(2)}R عن القمة`);
  }

  const strength = clamp(Math.round(candlePts + momentumPts + flowPts + givebackPts), 0, 100);
  const { partial, full } = THRESHOLDS[sensitivity];

  // Require at least two independent signal families for a FULL exit
  const signalFamilies =
    (candlePts > 0 ? 1 : 0) + (momentumPts > 0 ? 1 : 0) + (flowPts > 0 ? 1 : 0);

  let action: SmartTpEvaluation['action'] = 'NONE';
  if (strength >= full && signalFamilies >= 2) {
    action = 'FULL';
  } else if (!partialAlreadyDone && strength >= partial && (candlePts > 0 || flowPts > 0)) {
    action = 'PARTIAL';
  }

  const summary = reasons.slice(0, 3).join(' + ');
  return { action, strength, reasons, summary };
}
