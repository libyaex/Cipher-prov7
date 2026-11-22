/* ============================================================
   CIPHER X PRO — ENGINE C4 : استراتيجية الدخول المبكر (EARLY ENTRY — Smart Momentum Capture)
   اكتشاف الفرص في بداية الحركة السعرية قبل التمدد + منع مطاردة السعر
   ============================================================ */
import { f2, jOf, PreparedContext, tfState } from './analyzer';
import { clamp, ind, isN, util } from './indicators';
import { computeOrderFlowSnapshot } from './orderflow';
import { sizePosition } from './planner';
import { smc } from './smc';
import type {
  BtcContext,
  Candle,
  DerivData,
  EarlyEntryDetails,
  EarlyEntryStatus,
  EarlyEntryWeights,
  EntryKind,
  MtfMatrixRow,
  OrderBookAnalysis,
  OrderFlowSnapshot,
  SignalEvaluation,
  TradePlan,
} from './types';

export const DEFAULT_EARLY_WEIGHTS: EarlyEntryWeights = {
  zoneQuality: 20,
  structureShift: 20,
  momentumVolume: 20,
  liquidityConfirm: 15,
  mtfAlignment: 15,
  stopRrQuality: 10,
};

export function normalizeEarlyWeights(w?: Partial<EarlyEntryWeights> | null): EarlyEntryWeights {
  const merged: EarlyEntryWeights = {
    zoneQuality: Math.max(5, Number(w?.zoneQuality ?? DEFAULT_EARLY_WEIGHTS.zoneQuality)),
    structureShift: Math.max(5, Number(w?.structureShift ?? DEFAULT_EARLY_WEIGHTS.structureShift)),
    momentumVolume: Math.max(5, Number(w?.momentumVolume ?? DEFAULT_EARLY_WEIGHTS.momentumVolume)),
    liquidityConfirm: Math.max(3, Number(w?.liquidityConfirm ?? DEFAULT_EARLY_WEIGHTS.liquidityConfirm)),
    mtfAlignment: Math.max(3, Number(w?.mtfAlignment ?? DEFAULT_EARLY_WEIGHTS.mtfAlignment)),
    stopRrQuality: Math.max(3, Number(w?.stopRrQuality ?? DEFAULT_EARLY_WEIGHTS.stopRrQuality)),
  };
  const sum =
    merged.zoneQuality +
    merged.structureShift +
    merged.momentumVolume +
    merged.liquidityConfirm +
    merged.mtfAlignment +
    merged.stopRrQuality;
  if (Math.abs(sum - 100) < 0.01) return merged;
  const k = 100 / sum;
  return {
    zoneQuality: +(merged.zoneQuality * k).toFixed(2),
    structureShift: +(merged.structureShift * k).toFixed(2),
    momentumVolume: +(merged.momentumVolume * k).toFixed(2),
    liquidityConfirm: +(merged.liquidityConfirm * k).toFixed(2),
    mtfAlignment: +(merged.mtfAlignment * k).toFixed(2),
    stopRrQuality: +(merged.stopRrQuality * k).toFixed(2),
  };
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export function evaluateEarlyEntry(
  ctx: PreparedContext,
  i: number,
  opt?: {
    price?: number;
    deriv?: DerivData | null;
    book?: OrderBookAnalysis | null;
    btcContext?: BtcContext | null;
    microCandles?: Record<string, Candle[]>;
    vol24h?: number | null;
    minVolumeUsdt?: number;
    maxSpreadBps?: number;
    now?: number;
  }
): SignalEvaluation | null {
  opt = opt || {};
  const T = ctx.B.trigger;
  const cfg = ctx.cfg;
  if (!T || i < 60) return null;

  const tClose = T.t[i] + T.ms;
  const refNow = isN(opt.now) ? opt.now : tClose;
  const Su = ctx.B.setup;
  const Tr = ctx.B.trend;
  const Hf = ctx.B.htf;
  const iS = Su ? jOf(Su, tClose) : -1;
  const iT = Tr ? jOf(Tr, tClose) : -1;
  const iH = Hf ? jOf(Hf, tClose) : -1;
  const price = isN(opt.price) ? opt.price : T.c[i];
  const atr = T.atr[i];
  if (!isN(atr) || atr <= 0 || !(price > 0)) return null;

  const D = opt.deriv || null;
  const BK = opt.book || null;
  const BTC = opt.btcContext || null;
  const hasMicro = Boolean(
    opt.microCandles &&
      ((opt.microCandles['1m']?.length || 0) >= 12 || (opt.microCandles['5m']?.length || 0) >= 12)
  );
  const effMinVol = opt.minVolumeUsdt ?? cfg.minVolumeUsdt ?? 25_000_000;
  const effMaxSpread = opt.maxSpreadBps ?? cfg.maxSpreadBps ?? 8;
  const cancelChasedAtr = cfg.cancelChasedAtr ?? 2.4;
  const weights = normalizeEarlyWeights(cfg.earlyWeights);
  const useFvg = cfg.useFvgFilter !== false;
  const useOb = cfg.useObFilter !== false;
  const useChochBos = cfg.useChochBosFilter !== false;
  const useMomentum = cfg.useMomentumFilter !== false;

  const stH = Hf && iH >= 30 ? tfState(Hf, iH) : null;
  const stT = tfState(Tr, iT);
  const stS = tfState(Su, iS);
  const stG = tfState(T, i);
  const regime = smc.regime(T, i);
  const rg = Tr && iT > 50 ? smc.regime(Tr, iT) : regime;

  const zT = smc.zonesAt(T, i);
  const zS = Su && iS > 30 ? smc.zonesAt(Su, iS) : { ob: [], fvg: [], brk: [] };
  const sw = smc.sweeps(T, i, 4);
  const swS = Su && iS > 30 ? smc.sweeps(Su, iS, 2) : [];
  const pools = smc.pools(T, i);
  const rangeT = smc.range(T, i);
  const rangeS = Su && iS > 30 ? smc.range(Su, iS) : null;
  const vp = smc.volumeProfile(Su || T, Su ? iS : i, 200, 48);
  const lvLists: any[][] = [smc.levels(T, i, 1)];
  if (Su && iS > 40) lvLists.push(smc.levels(Su, iS, 2));
  if (Tr && iT > 40) lvLists.push(smc.levels(Tr, iT, 3));
  if (Hf && iH > 10) lvLists.push(smc.refLevels(Hf, iH));
  const levels = smc.mergeLevels(lvLists, Math.max(0.35 * atr, price * 0.0012));
  const patterns = smc.patterns(T, i);
  const divs = smc.divergence(T, i).filter((d) => d.ago <= 10);
  const setupDivs = Su && iS > 30 ? smc.divergence(Su, iS).filter((d) => d.ago <= 6) : [];

  const lastEv = (S: typeof T, j: number, maxAge: number) => {
    const ev = S.struct.events;
    for (let m = ev.length - 1; m >= 0; m--) {
      if (ev[m].j > j) continue;
      return j - ev[m].j <= maxAge ? { ...ev[m], ago: j - ev[m].j } : null;
    }
    return null;
  };
  const evT = lastEv(T, i, 12);
  const evS = Su && iS > 30 ? lastEv(Su, iS, 8) : null;

  const bars1h = Math.max(1, Math.round(3600e3 / T.ms));
  const bars4h = bars1h * 4;
  const pChg1h = i - bars1h >= 0 ? (100 * (T.c[i] - T.c[i - bars1h])) / T.c[i - bars1h] : NaN;
  const pChg4h = i - bars4h >= 0 ? (100 * (T.c[i] - T.c[i - bars4h])) / T.c[i - bars4h] : NaN;
  const vwapStd = isN(T.vwapUp1[i]) && isN(T.vwap[i]) ? Math.max(1e-12, T.vwapUp1[i] - T.vwap[i]) : atr;
  const vwapZ = isN(T.vwap[i]) ? (price - T.vwap[i]) / vwapStd : 0;
  const zScore = isN(T.zScore[i]) ? T.zScore[i] : 0;
  const sessionLabel = smc.sessionContext(T.t[i]);

  // 1) Detect directional candidate via early inception clues (without requiring lagging EMAs to stack first)
  let bullScoreHint = 0;
  let bearScoreHint = 0;

  if (evT) {
    const w = (evT.kind === 'CHoCH' ? 2.4 : 1.7) * Math.max(0.35, 1 - evT.ago / 14);
    if (evT.dir > 0) bullScoreHint += w;
    else bearScoreHint += w;
  }
  if (evS) {
    const w = (evS.kind === 'CHoCH' ? 1.8 : 1.2) * Math.max(0.35, 1 - evS.ago / 10);
    if (evS.dir > 0) bullScoreHint += w;
    else bearScoreHint += w;
  }
  for (const s of sw) {
    const w = 1.6 * Math.max(0.4, 1 - s.ago / 5);
    if (s.dir > 0) bullScoreHint += w;
    else bearScoreHint += w;
  }
  const mh = T.macdH[i];
  const mhp = T.macdH[i - 1];
  if (mh > mhp && mh >= -0.05 * atr) bullScoreHint += 1.0;
  if (mh < mhp && mh <= 0.05 * atr) bearScoreHint += 1.0;

  // Compression box over last 10 closed bars (excluding signal bar if breaking out)
  let boxHi = -Infinity;
  let boxLo = Infinity;
  for (let b = Math.max(0, i - 10); b < i; b++) {
    if (T.h[b] > boxHi) boxHi = T.h[b];
    if (T.l[b] < boxLo) boxLo = T.l[b];
  }
  const boxSpanAtr = boxHi > boxLo ? (boxHi - boxLo) / atr : 99;
  const bbRankPrev = ind.percentRank(T.bbW, Math.max(20, i - 1), 60);
  const wasCompressed =
    regime.squeeze ||
    regime.ttmSqueeze ||
    regime.squeezeFired ||
    (isN(bbRankPrev) && bbRankPrev <= 0.35) ||
    boxSpanAtr <= 2.6;

  if (price > boxHi && T.c[i] > T.o[i]) bullScoreHint += wasCompressed ? 2.1 : 1.0;
  if (price < boxLo && T.c[i] < T.o[i]) bearScoreHint += wasCompressed ? 2.1 : 1.0;

  // Proximity to fresh OB / FVG / Breaker
  const proxZones = [...zT.ob, ...zT.fvg, ...zT.brk, ...zS.ob, ...zS.fvg];
  for (const z of proxZones) {
    if (price >= z.bot - 0.8 * atr && price <= z.top + 0.8 * atr && (z.touches ?? 0) <= 1) {
      if (z.dir > 0) bullScoreHint += 1.2;
      else bearScoreHint += 1.2;
    }
  }
  if (stS) {
    if (stS.score > 0.2) bullScoreHint += 0.8 * stS.score;
    if (stS.score < -0.2) bearScoreHint += 0.8 * Math.abs(stS.score);
  }
  if (stT) {
    if (stT.score > 0.25) bullScoreHint += 0.7 * stT.score;
    if (stT.score < -0.25) bearScoreHint += 0.7 * Math.abs(stT.score);
  }

  let preOrderFlow: OrderFlowSnapshot | null = null;
  if (hasMicro || BK || isN(opt.vol24h)) {
    const fallbackCandles: Candle[] = [];
    if (!hasMicro) {
      for (let b = Math.max(0, i - 30); b <= i; b++) {
        fallbackCandles.push({
          t: T.t[b],
          o: T.o[b],
          h: T.h[b],
          l: T.l[b],
          c: T.c[b],
          v: T.v[b],
          q: T.q[b],
          V: T.tb[b],
        });
      }
    }
    preOrderFlow = computeOrderFlowSnapshot({
      microCandles: hasMicro ? opt.microCandles : undefined,
      triggerCandles: fallbackCandles,
      triggerTf: T.tf,
      book: BK,
      vol24h: opt.vol24h,
      minVolumeUsdt: effMinVol,
      maxSpreadBps: effMaxSpread,
      dirHint: bullScoreHint >= bearScoreHint ? 1 : -1,
    });
    if (preOrderFlow.netBias > 0.18) bullScoreHint += 1.1 * preOrderFlow.netBias;
    if (preOrderFlow.netBias < -0.18) bearScoreHint += 1.1 * Math.abs(preOrderFlow.netBias);
  }

  const dir =
    bullScoreHint >= 1.8 && bullScoreHint > bearScoreHint + 0.45
      ? 1
      : bearScoreHint >= 1.8 && bearScoreHint > bullScoreHint + 0.45
        ? -1
        : 0;

  if (!dir) {
    // Return minimal neutral evaluation when no early setup is present
    return {
      i,
      t: T.t[i],
      tClose,
      price,
      atr,
      atrp: T.atrp[i],
      dir: 0,
      net: 0,
      score: 38,
      rawScore: 38,
      aligned: 0,
      parts: [],
      gates: ['لا توجد إشارة دخول مبكر (لا انضغاط أو تحول هيكلي حديث)'],
      warns: [],
      cap: 100,
      regime,
      regimeHTF: rg,
      tf: { trigger: T.tf, setup: Su?.tf || null, trend: Tr?.tf || null, htf: Hf?.tf || null },
      state: { trigger: stG, setup: stS, trend: stT, htf: stH },
      idx: { i, iS, iT, iH },
      zones: { T: zT, S: zS },
      breakers: [...(zT.brk || []), ...(zS.brk || [])],
      sweeps: sw,
      pools,
      range: { T: rangeT, S: rangeS },
      vp,
      levels,
      sup: null,
      res: null,
      patterns,
      divs,
      setupDivs,
      evT,
      evS,
      pChg1h,
      pChg4h,
      vwapZ,
      zScore,
      sessionLabel,
      btcContext: BTC,
      deriv: D,
      book: BK,
      orderFlow: preOrderFlow,
      tier: 'NONE',
      grade: '—',
      plan: null,
      strategyMode: 'early',
      earlyEntry: {
        entryKind: 'EARLY_ENTRY',
        entryStatus: 'CANCELLED',
        distanceMovedPct: 0,
        remainingRR1: 0,
        stillValid: false,
        fomoChasing: false,
        earlyReason: 'السوق بلا محفّز دخول مبكر واضح حالياً',
        confirmFactors: [],
        missingConfirmations: ['انضغاط + كسر هيكلي أولي'],
        breakdown: {
          zoneQuality: 0,
          structureShift: 0,
          momentumVolume: 0,
          liquidityConfirm: 0,
          mtfAlignment: 0,
          stopRrQuality: 0,
        },
      },
    };
  }

  const long = dir > 0;
  const confirmFactors: string[] = [];
  const missingConfirmations: string[] = [];

  // 2) Evaluate the 6 Early Entry Rubric Dimensions (0..1 each, multiplied by weights)
  // A. Zone Quality (OB + FVG + Breaker + Level + VWAP)
  let zoneNorm = 0;
  const zoneNotes: string[] = [];
  const allObs = [...(useOb ? zT.ob : []), ...(useOb ? zS.ob : [])].filter((z) => z.dir === dir && (z.touches ?? 0) <= 1);
  const allFvgs = [...(useFvg ? zT.fvg : []), ...(useFvg ? zS.fvg : [])].filter((z) => z.dir === dir && (z.fill ?? 0) < 0.78);
  const allBrks = [...zT.brk, ...zS.brk].filter((z) => z.dir === dir && (z.touches ?? 0) <= 1);

  const nearOrInside = (z: { bot: number; top: number }, tolAtr = 0.85) =>
    price >= z.bot - tolAtr * atr && price <= z.top + tolAtr * atr;

  const freshOb = allObs.find((z) => nearOrInside(z, 1.0));
  const freshFvg = allFvgs.find((z) => nearOrInside(z, 1.1));
  const freshBrk = allBrks.find((z) => nearOrInside(z, 0.9));

  if (freshOb) {
    zoneNorm += freshOb.touches === 0 ? 0.45 : 0.3;
    zoneNotes.push(`Order Block ${freshOb.touches === 0 ? 'طازج' : 'مُختبر'} [${f2(freshOb.bot)}–${f2(freshOb.top)}]`);
  }
  if (freshFvg) {
    zoneNorm += 0.35;
    zoneNotes.push(`فجوة FVG غير مملوءة (${Math.round((1 - (freshFvg.fill || 0)) * 100)}%)`);
  }
  if (freshBrk) {
    zoneNorm += 0.25;
    zoneNotes.push('Breaker Block متوافق');
  }
  const vwapAligned = isN(T.vwap[i]) && (long ? price >= T.vwap[i] - 0.3 * atr : price <= T.vwap[i] + 0.3 * atr);
  if (vwapAligned) {
    zoneNorm += 0.15;
    zoneNotes.push('محاذاة VWAP');
  }
  if (rangeT && ((long && rangeT.pos <= 0.55) || (!long && rangeT.pos >= 0.45))) {
    zoneNorm += 0.12;
    zoneNotes.push(long ? 'منطقة خصم' : 'منطقة علاوة');
  }
  zoneNorm = clamp(zoneNorm, 0, 1);
  if (zoneNotes.length) confirmFactors.push(zoneNotes[0]);
  else missingConfirmations.push('ارتكاز على OB/FVG طازج');

  // B. Structure Shift & Compression Breakout (CHoCH / BOS / Sweep / Compression)
  let structNorm = 0;
  const structNotes: string[] = [];
  if (useChochBos && evT && evT.dir === dir) {
    const recency = Math.max(0.35, 1 - evT.ago / 10);
    structNorm += (evT.kind === 'CHoCH' ? 0.52 : 0.4) * recency;
    structNotes.push(`${evT.kind} مبكر (${T.tf}) منذ ${evT.ago} شمعة`);
  }
  if (useChochBos && evS && evS.dir === dir) {
    structNorm += 0.25;
    structNotes.push(`${evS.kind} داعم على ${Su?.tf}`);
  }
  const activeSweep = sw.find((s) => s.dir === dir && s.ago <= 3) || swS.find((s) => s.dir === dir && s.ago <= 2);
  if (activeSweep) {
    structNorm += 0.32;
    structNotes.push(`كنس سيولة عند ${f2(activeSweep.level)}`);
  }
  const brokeCompression =
    wasCompressed && ((long && price > boxHi - 0.15 * atr) || (!long && price < boxLo + 0.15 * atr));
  if (brokeCompression) {
    structNorm += 0.35;
    structNotes.push(regime.squeezeFired ? 'انفجار TTM Squeeze' : `خروج مبكر من تجميع (${boxSpanAtr.toFixed(1)} ATR)`);
  }
  structNorm = clamp(structNorm, 0, 1);
  if (structNotes.length) confirmFactors.push(structNotes[0]);
  else missingConfirmations.push('تحول هيكلي CHoCH/BOS حديث');

  // C. Momentum & Volume Kick
  let momNorm = 0;
  const momNotes: string[] = [];
  const rv = isN(T.rvol[i]) ? T.rvol[i] : 1;
  if (useMomentum) {
    if (rv >= 1.2) {
      momNorm += clamp((rv - 1) / 1.4, 0.15, 0.42);
      momNotes.push(`انفجار حجم ${rv.toFixed(2)}x`);
    } else {
      missingConfirmations.push(`حجم نسبي ≥ 1.2x (الحالي ${rv.toFixed(2)}x)`);
    }
    let sd = 0;
    let sv = 0;
    for (let b = Math.max(0, i - 2); b <= i; b++) {
      sd += T.delta[b];
      sv += T.v[b];
    }
    const deltaPct = sv > 0 ? sd / sv : 0;
    if (dir * deltaPct >= 0.04) {
      momNorm += clamp((dir * deltaPct) * 2.5, 0.15, 0.35);
      momNotes.push(`دلتا لحظية ${deltaPct >= 0 ? '+' : ''}${(deltaPct * 100).toFixed(1)}%`);
    }
    const macdAccel = dir * (mh - mhp) > 0;
    if (macdAccel || (regime.squeezeFired && Math.sign(mh) === dir)) {
      momNorm += 0.25;
      momNotes.push('تسارع زخم MACD');
    }
    const candleAligned = dir * (T.c[i] - T.o[i]) > 0;
    if (candleAligned) {
      const body = Math.abs(T.c[i] - T.o[i]);
      const range = Math.max(1e-12, T.h[i] - T.l[i]);
      if (body / range >= 0.42) momNorm += 0.16;
    }
  } else {
    momNorm = 0.55;
  }
  momNorm = clamp(momNorm, 0, 1);
  if (momNotes.length) confirmFactors.push(momNotes[0]);

  // D. Liquidity & Micro OrderFlow Confirmation
  let liqNorm = 0;
  const liqNotes: string[] = [];
  if (preOrderFlow) {
    const dirFlow = dir * preOrderFlow.netBias;
    if (preOrderFlow.absorption === (long ? 'BULL' : 'BEAR')) {
      liqNorm += 0.55;
      liqNotes.push(`امتصاص سيولة ${preOrderFlow.primaryTf}`);
    } else if (dirFlow >= 0.16) {
      liqNorm += clamp(dirFlow * 1.4, 0.2, 0.55);
      liqNotes.push(`رادار ${preOrderFlow.primaryTf} (+${(dirFlow * 100).toFixed(0)}%)`);
    } else if (dirFlow <= -0.24 && preOrderFlow.confidence >= 0.4) {
      liqNorm -= 0.25;
      missingConfirmations.push('تأكيد تدفق الأوامر الصغرى');
    } else {
      liqNorm += 0.18;
    }
    if (preOrderFlow.liquidity.liquidityPass) liqNorm += 0.22;
  } else {
    liqNorm += 0.35;
  }
  if (D && isN(D.takerRatio)) {
    const tBias = long ? D.takerRatio - 1 : 1 - D.takerRatio;
    if (tBias > 0.04) {
      liqNorm += clamp(tBias * 2, 0.1, 0.28);
      liqNotes.push(`Taker ${D.takerRatio.toFixed(2)}`);
    }
  }
  if (BK && isN(BK.imb05) && dir * BK.imb05 >= 0.1) {
    liqNorm += 0.2;
    liqNotes.push(`دفتر الأوامر ${(BK.imb05 * 100).toFixed(0)}%`);
  }
  liqNorm = clamp(liqNorm, 0, 1);
  if (liqNotes.length) confirmFactors.push(liqNotes[0]);

  // E. MTF Alignment & Non-Blind BTC Context (doesn't require lagging EMA cascade, rewards setup/trend support)
  let mtfNorm = 0.25;
  if (stS && sgn(stS.score) === dir) mtfNorm += 0.3 * clamp(Math.abs(stS.score) * 1.4, 0.4, 1);
  else if (stS && sgn(stS.score) === -dir && Math.abs(stS.score) >= 0.65) mtfNorm -= 0.12;

  if (stT && sgn(stT.score) === dir) mtfNorm += 0.28 * clamp(Math.abs(stT.score) * 1.4, 0.4, 1);
  else if (stT && sgn(stT.score) === -dir && Math.abs(stT.score) >= 0.7) {
    missingConfirmations.push(`توافق اتجاه ${Tr?.tf}`);
    mtfNorm -= 0.1;
  }

  if (stH && sgn(stH.score) === dir) mtfNorm += 0.15;
  if (BTC) {
    if (BTC.dir === dir) {
      mtfNorm += 0.15;
      confirmFactors.push('دعم اتجاه BTC');
    } else if (BTC.shock && BTC.dir !== dir) {
      mtfNorm -= 0.3;
    } else if (Math.abs(BTC.score) >= 0.5 && BTC.dir !== dir) {
      mtfNorm -= 0.08;
    }
  }
  mtfNorm = clamp(mtfNorm, 0, 1);

  // 3) Identify Origin Price & Anti-FOMO Chase / Remaining R:R
  const originCandidates: number[] = [];
  if (freshOb) originCandidates.push(long ? freshOb.top : freshOb.bot);
  if (freshFvg) originCandidates.push(long ? freshFvg.top : freshFvg.bot);
  if (evT && evT.dir === dir) originCandidates.push(evT.level);
  if (wasCompressed && isN(boxHi) && isN(boxLo)) originCandidates.push(long ? boxHi : boxLo);
  if (isN(T.ema21[i])) originCandidates.push(T.ema21[i]);

  const originPrice =
    originCandidates.length > 0
      ? long
        ? Math.min(...originCandidates)
        : Math.max(...originCandidates)
      : T.ema21[i];

  const distanceMovedPct = originPrice > 0 ? Math.max(0, (dir * (price - originPrice)) / originPrice * 100) : 0;
  const extFromOriginAtr = originPrice > 0 ? Math.max(0, (dir * (price - originPrice)) / atr) : 0;
  const extFromEmaAtr = isN(T.ema21[i]) ? (dir * (price - T.ema21[i])) / atr : 0;

  // Build consistent Entry / Stop / TP1..TP3 Plan
  const tick = ctx.meta.tick || price * 1e-5;
  const rt = (p: number, m: 'down' | 'up' | 'near') => util.roundTick(p, tick, m);
  const zoneLo = freshOb?.bot ?? freshFvg?.bot ?? freshBrk?.bot ?? (isN(boxLo) ? boxLo : price - 0.6 * atr);
  const zoneHi = freshOb?.top ?? freshFvg?.top ?? freshBrk?.top ?? (isN(boxHi) ? boxHi : price + 0.6 * atr);
  const bestLo = Math.min(zoneLo, zoneHi);
  const bestHi = Math.max(zoneLo, zoneHi);

  const fomoChasing =
    extFromOriginAtr > cancelChasedAtr || extFromEmaAtr > Math.max(cancelChasedAtr + 0.4, 3.0);

  let stopRefPrice = long ? bestLo : bestHi;
  let stopRefLabel = freshOb ? 'Order Block' : freshFvg ? 'FVG' : 'نطاق التجميع';
  if (activeSweep) {
    const swLvl = long ? activeSweep.level : activeSweep.level;
    if (long ? swLvl < stopRefPrice : swLvl > stopRefPrice) {
      stopRefPrice = swLvl;
      stopRefLabel = 'ذيل كنس السيولة';
    }
  }
  const structSwing = long ? T.struct.slP[i] : T.struct.shP[i];
  if (isN(structSwing) && (long ? structSwing < stopRefPrice && stopRefPrice - structSwing <= 1.2 * atr : structSwing > stopRefPrice && structSwing - stopRefPrice <= 1.2 * atr)) {
    stopRefPrice = structSwing;
    stopRefLabel = long ? 'القاع الهيكلي' : 'القمة الهيكلية';
  }

  const buf = Math.max(0.28 * atr, 2 * tick);
  let stop = long ? stopRefPrice - buf : stopRefPrice + buf;
  const minStopD = cfg.minStopATR * atr;

  // Decide MARKET vs LIMIT pullback vs CANCELLED
  const inZoneOrNearOrigin = extFromOriginAtr <= 1.15;
  const orderType: 'MARKET' | 'LIMIT' = inZoneOrNearOrigin ? 'MARKET' : 'LIMIT';
  let entry =
    orderType === 'MARKET'
      ? rt(price, 'near')
      : rt(
          long
            ? Math.min(price, bestHi - 0.2 * (bestHi - bestLo))
            : Math.max(price, bestLo + 0.2 * (bestHi - bestLo)),
          'near'
        );

  if (long ? entry - stop < minStopD : stop - entry < minStopD) {
    stop = long ? entry - minStopD : entry + minStopD;
  }
  stop = rt(stop, long ? 'down' : 'up');
  const risk = Math.abs(entry - stop);

  // Build structural targets
  const R = (p: number) => (risk > 0 ? Math.abs(p - entry) / risk : 0);
  const cands: { p: number; label: string; w: number }[] = [];
  for (const L of levels) {
    if (L.strength >= 1.2 && (long ? L.p > entry + 0.5 * risk : L.p < entry - 0.5 * risk)) {
      cands.push({ p: L.p, label: (long ? 'مقاومة ' : 'دعم ') + f2(L.p), w: L.strength });
    }
  }
  for (const pl of pools) {
    if (pl.swept < 0 && pl.side === (long ? 'high' : 'low') && (long ? pl.level > entry : pl.level < entry)) {
      cands.push({ p: pl.level, label: `سيولة ${long ? 'Highs' : 'Lows'}`, w: 3 });
    }
  }
  cands.sort((a, b) => (long ? a.p - b.p : b.p - a.p));
  const near = (p: number) => rt(long ? p - 0.08 * atr : p + 0.08 * atr, long ? 'down' : 'up');
  const pick = (lo: number, hi: number, synth: number) => {
    const c = cands.find((x) => R(near(x.p)) >= lo && R(near(x.p)) <= hi);
    return c
      ? { p: near(c.p), label: c.label, real: true }
      : {
          p: rt(long ? entry + synth * risk : entry - synth * risk, long ? 'up' : 'down'),
          label: `${synth.toFixed(1)}R`,
          real: false,
        };
  };
  const tpPcts = cfg.tpPcts || [40, 35, 25];
  const t1 = pick(1.25, 2.3, 1.6);
  const t2 = pick(Math.max(2.2, R(t1.p) + 0.5), 4.5, Math.max(2.8, R(t1.p) + 1.1));
  const t3 = pick(Math.max(3.6, R(t2.p) + 0.8), 8.5, Math.max(4.4, R(t2.p) + 1.6));
  const tps = [t1, t2, t3].map((t, k) => ({ ...t, r: R(t.p), pct: tpPcts[k] ?? [40, 35, 25][k] }));
  for (let k = 1; k < 3; k++) {
    if (long ? tps[k].p <= tps[k - 1].p : tps[k].p >= tps[k - 1].p) {
      tps[k].p = rt(long ? tps[k - 1].p + risk : tps[k - 1].p - risk, 'near');
      tps[k].r = R(tps[k].p);
      tps[k].real = false;
      tps[k].label = `${tps[k].r.toFixed(1)}R`;
    }
  }

  const remainingRisk = Math.abs(price - stop);
  const remainingRR1 = remainingRisk > 0 ? (long ? tps[0].p - price : price - tps[0].p) / remainingRisk : 0;

  const feeIn = orderType === 'MARKET' ? cfg.takerFee : cfg.makerFee;
  const slipIn = orderType === 'MARKET' ? cfg.slip : 0;
  const feeR = risk > 0 ? (entry * (feeIn + slipIn + cfg.takerFee + cfg.slip)) / risk : 9;

  // F. Stop / R:R Quality
  let stopRrNorm = 0;
  const stopAtr = risk / atr;
  if (risk > 0 && stopAtr <= cfg.maxStopATR && remainingRR1 >= 1.15 && feeR <= (cfg.maxFeeR || 0.3)) {
    stopRrNorm = clamp(0.45 + 0.35 * clamp((remainingRR1 - 1.1) / 1.2, 0, 1) + (stopAtr <= 2.0 ? 0.2 : 0), 0, 1);
  } else if (risk > 0 && stopAtr <= cfg.maxStopATR && tps[0].r >= cfg.minRR1) {
    stopRrNorm = 0.45;
  }

  // Compute Weighted Score (0-100)
  const breakdown = {
    zoneQuality: Math.round(zoneNorm * weights.zoneQuality * 10) / 10,
    structureShift: Math.round(structNorm * weights.structureShift * 10) / 10,
    momentumVolume: Math.round(momNorm * weights.momentumVolume * 10) / 10,
    liquidityConfirm: Math.round(liqNorm * weights.liquidityConfirm * 10) / 10,
    mtfAlignment: Math.round(mtfNorm * weights.mtfAlignment * 10) / 10,
    stopRrQuality: Math.round(stopRrNorm * weights.stopRrQuality * 10) / 10,
  };

  let rawScore = Math.round(
    breakdown.zoneQuality +
      breakdown.structureShift +
      breakdown.momentumVolume +
      breakdown.liquidityConfirm +
      breakdown.mtfAlignment +
      breakdown.stopRrQuality
  );
  rawScore = clamp(rawScore, 0, 100);

  // Hard Gates / Caps
  const gates: string[] = [];
  const warns: string[] = [];
  let cap = 100;
  const capTo = (v: number, msg: string) => {
    if (v < cap) cap = v;
    gates.push(msg);
  };

  if (fomoChasing) {
    capTo(54, `رفض مطاردة السعر: تحرك ${extFromOriginAtr.toFixed(1)}×ATR (${distanceMovedPct.toFixed(2)}%) من بداية الانطلاقة`);
  }
  if (orderType === 'MARKET' && remainingRR1 < (cfg.minRR1 || 1.0) * 0.85) {
    capTo(58, `العائد المتبقي إلى TP1 (${remainingRR1.toFixed(2)}R) لا يبرر الدخول الآن`);
  }
  if (stopAtr > cfg.maxStopATR) {
    capTo(60, `مسافة الوقف (${stopAtr.toFixed(1)}×ATR) تتجاوز الحد (${cfg.maxStopATR})`);
  }
  if (feeR > (cfg.maxFeeR || 0.3)) {
    capTo(62, `الرسوم تستهلك ${feeR.toFixed(2)}R من الصفقة`);
  }
  if (BK && BK.spreadBps > effMaxSpread) {
    capTo(60, `سبريد واسع (${BK.spreadBps.toFixed(1)} bps)`);
  }
  if (isN(opt.vol24h) && effMinVol > 0 && opt.vol24h < effMinVol) {
    capTo(58, `سيولة 24h منخفضة (${(opt.vol24h / 1e6).toFixed(1)}M$)`);
  }
  if (BTC && BTC.shock && BTC.dir && BTC.dir !== dir) {
    capTo(64, `صدمة BTC الماكرو تعاكس الصفقة (${BTC.detail})`);
  } else if (BTC && BTC.dir && BTC.dir !== dir && Math.abs(BTC.score) >= 0.5) {
    warns.push(`سياق BTC معاكس (${BTC.detail}) — يُنصح بإدارة مخاطرة حذرة`);
  }

  const score = Math.min(rawScore, cap);

  // Distinguish EARLY_ENTRY vs CONFIRMED_ENTRY and status
  const htfConfirmed =
    (stS && sgn(stS.score) === dir && Math.abs(stS.score) >= 0.35) &&
    (!stT || (sgn(stT.score) === dir && Math.abs(stT.score) >= 0.3));

  const entryKind: EntryKind = htfConfirmed && (evT?.ago ?? 0) >= 2 ? 'CONFIRMED_ENTRY' : 'EARLY_ENTRY';

  let entryStatus: EarlyEntryStatus;
  let stillValid = true;
  if (fomoChasing || (orderType === 'MARKET' && remainingRR1 < 0.85) || stopAtr > cfg.maxStopATR || cap <= 60) {
    entryStatus = 'CANCELLED';
    stillValid = false;
  } else if (orderType === 'LIMIT') {
    entryStatus = 'WAIT_RETEST';
  } else if (entryKind === 'CONFIRMED_ENTRY') {
    entryStatus = 'CONFIRMED';
  } else {
    entryStatus = 'EARLY';
  }

  const size = sizePosition({
    entry,
    stop,
    equity: cfg.equity,
    riskPct: cfg.riskPct,
    maxLev: cfg.maxLev,
    mmr: cfg.mmr,
    takerFee: cfg.takerFee,
    minSafetyPct: cfg.minLiqSafetyPct ?? 25,
    step: ctx.meta.step,
    minQty: ctx.meta.minQty,
    minNotional: ctx.meta.minNotional,
    long,
  });

  if (!size.safetyOk) {
    warns.push(size.note);
  }

  const expireBars = cfg.limitExpireBars ?? (orderType === 'LIMIT' ? 8 : 10);
  const planOk = stillValid && risk > 0 && stopAtr <= cfg.maxStopATR && feeR <= (cfg.maxFeeR || 0.3) && tps[0].r - feeR >= cfg.minRR1 * 0.85;

  const earlyReasonParts = [...structNotes, ...zoneNotes, ...momNotes, ...liqNotes].slice(0, 3);
  const earlyReason =
    earlyReasonParts.join(' · ') ||
    (stillValid ? 'تشكل موجة مبكرة متوافقة مع السيولة والمناطق' : gates[0] || 'فرصة غير صالحة حالياً');

  const checks: { ok: boolean | null; label: string; detail: string }[] = [
    {
      ok: !fomoChasing,
      label: 'فحص مطاردة السعر (Anti-FOMO)',
      detail: `البعد عن بداية الحركة ${extFromOriginAtr.toFixed(2)}×ATR (${distanceMovedPct.toFixed(2)}%) — العائد المتبقي إلى TP1 = ${remainingRR1.toFixed(2)}R`,
    },
    {
      ok: structNorm >= 0.3,
      label: 'شرارة البداية (CHoCH / تجميع)',
      detail: structNotes.join(' + ') || 'بداية تحول هيكلي قيد التشكّل',
    },
    {
      ok: zoneNorm >= 0.25,
      label: 'منطقة القيمة (OB / FVG / VWAP)',
      detail: zoneNotes.join(' + ') || `نطاق [${f2(bestLo)} – ${f2(bestHi)}]`,
    },
    {
      ok: momNorm >= 0.25,
      label: 'تأكيد الزخم والحجم',
      detail: momNotes.join(' + ') || `RVOL ${rv.toFixed(2)}x`,
    },
    {
      ok: size.safetyOk,
      label: 'حماية التصفية والوقف',
      detail: size.safetyOk
        ? `الوقف ${f2(stop)} يسبق التصفية ${f2(size.liq)} بهامش ${size.safetyBufferPct.toFixed(1)}%`
        : size.note,
    },
  ];

  const plan: TradePlan = planOk
    ? {
        ok: true,
        dir,
        long,
        type: orderType,
        entry,
        price,
        fillDist: Math.abs(price - entry) / atr,
        zone: {
          lo: bestLo,
          hi: bestHi,
          labels: [...zoneNotes, ...structNotes].slice(0, 4),
          kinds: [freshOb ? 'OB' : '', freshFvg ? 'FVG' : '', freshBrk ? 'BRK' : ''].filter(Boolean),
          n: Math.max(1, zoneNotes.length),
        },
        stop,
        stopRef: stopRefLabel,
        risk,
        riskATR: stopAtr,
        riskPct: (100 * risk) / entry,
        tps,
        rr1: tps[0].r,
        rr2: tps[1].r,
        rr3: tps[2].r,
        feeR,
        checks,
        warnings: [...warns, ...(entryKind === 'EARLY_ENTRY' ? ['دخول مبكر: التزم بالوقف المحسوب وحجم المركز القياسي'] : [])],
        confirmed: confirmFactors.length >= 2,
        confirmBits: confirmFactors,
        ext: extFromOriginAtr,
        expireBars,
        size,
        barrier: null,
      }
    : {
        ok: false,
        why: gates[0] || 'لم تستوفِ الخطة شروط الدخول المبكر والمخاطرة',
        dir,
        long,
        type: orderType,
        entry,
        price,
        stop,
        tps,
        rr1: tps[0].r,
        checks,
        warnings: warns,
      };

  const parts = [
    {
      key: 'zone',
      label: 'جودة المنطقة (OB/FVG)',
      w: weights.zoneQuality,
      wEff: weights.zoneQuality,
      raw: dir * zoneNorm,
      detail: zoneNotes.join(' · ') || 'قرب منطقة ارتداد',
    },
    {
      key: 'struct',
      label: 'تحول الهيكل والانضغاط',
      w: weights.structureShift,
      wEff: weights.structureShift,
      raw: dir * structNorm,
      detail: structNotes.join(' · ') || 'بداية اختراق',
    },
    {
      key: 'mom',
      label: 'تسارع الزخم والحجم',
      w: weights.momentumVolume,
      wEff: weights.momentumVolume,
      raw: dir * momNorm,
      detail: momNotes.join(' · ') || `RVOL ${rv.toFixed(2)}x`,
    },
    {
      key: 'flow',
      label: 'تأكيد السيولة والأوامر',
      w: weights.liquidityConfirm,
      wEff: weights.liquidityConfirm,
      raw: dir * liqNorm,
      detail: liqNotes.join(' · ') || 'سيولة متزنة',
    },
    {
      key: 'mtf',
      label: 'توافق الأطر وسياق BTC',
      w: weights.mtfAlignment,
      wEff: weights.mtfAlignment,
      raw: dir * mtfNorm,
      detail: `Setup ${(stS?.score ?? 0).toFixed(2)} · Trend ${(stT?.score ?? 0).toFixed(2)}`,
    },
    {
      key: 'rr',
      label: 'جودة الوقف والعائد',
      w: weights.stopRrQuality,
      wEff: weights.stopRrQuality,
      raw: dir * stopRrNorm,
      detail: `TP1 ${tps[0].r.toFixed(2)}R · متبقي ${remainingRR1.toFixed(2)}R`,
    },
  ];

  const aligned = parts.filter((p) => Math.abs(p.raw) >= 0.4).length;

  let tier: SignalEvaluation['tier'] = 'NONE';
  if (plan.ok && stillValid) {
    if (score >= cfg.strongScore && aligned >= 4) tier = 'STRONG';
    else if (score >= cfg.minScore && aligned >= 3) tier = 'GOOD';
    else if (score >= cfg.watchScore) tier = 'WATCH';
  } else if (score >= cfg.watchScore && stillValid) {
    tier = 'WATCH';
  }

  const grade = score >= 85 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 62 ? 'C' : '—';

  const mtfMatrix: MtfMatrixRow[] = [];
  if (stH && Hf) mtfMatrix.push({ ...stH, role: 'htf', tf: Hf.tf });
  if (stT && Tr) mtfMatrix.push({ ...stT, role: 'trend', tf: Tr.tf });
  if (stS && Su) mtfMatrix.push({ ...stS, role: 'setup', tf: Su.tf });
  if (stG) mtfMatrix.push({ ...stG, role: 'trigger', tf: T.tf });

  const earlyEntry: EarlyEntryDetails = {
    entryKind,
    entryStatus,
    distanceMovedPct: +distanceMovedPct.toFixed(3),
    remainingRR1: +remainingRR1.toFixed(2),
    stillValid,
    fomoChasing,
    earlyReason,
    confirmFactors,
    missingConfirmations,
    breakdown,
  };

  return {
    i,
    t: T.t[i],
    tClose,
    price,
    atr,
    atrp: T.atrp[i],
    dir,
    net: dir * (score / 100),
    score,
    rawScore,
    aligned,
    parts,
    gates,
    warns,
    cap,
    regime,
    regimeHTF: rg,
    tf: { trigger: T.tf, setup: Su && Su.tf, trend: Tr && Tr.tf, htf: Hf && Hf.tf },
    state: { trigger: stG, setup: stS, trend: stT, htf: stH },
    mtfMatrix,
    idx: { i, iS, iT, iH },
    zones: { T: zT, S: zS },
    breakers: [...(zT.brk || []), ...(zS.brk || [])],
    sweeps: sw,
    pools,
    range: { T: rangeT, S: rangeS },
    vp,
    levels,
    sup: null,
    res: null,
    patterns,
    divs,
    setupDivs,
    evT,
    evS,
    pChg1h,
    pChg4h,
    vwapZ,
    zScore,
    sessionLabel,
    btcContext: BTC,
    deriv: D,
    book: BK,
    orderFlow: preOrderFlow,
    tier,
    grade,
    plan,
    earlyEntry,
    strategyMode: 'early',
  };
}
