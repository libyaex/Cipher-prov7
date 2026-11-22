/* ============================================================
   CIPHER X PRO — ENGINE C3 : تحليل تدفق السيولة والأوامر (Order Flow Radar)
   دوال نقية بدون DOM — تعمل في المتصفح وفي الخادم على الأطر الزمنية الصغرى
   ============================================================ */
import { clamp, ind, isN, TF_MS } from './indicators';
import type {
  Candle,
  LiquidityFilterSummary,
  MicroBarFlow,
  MicroTimeframeFlow,
  OrderBookAnalysis,
  OrderFlowSnapshot,
} from './types';

function barQuoteAmounts(c: Candle): { totalUsd: number; buyUsd: number; sellUsd: number; trades: number } {
  const px = c.c > 0 ? c.c : c.o > 0 ? c.o : 1;
  const totalUsd = isN(c.q) && c.q > 0 ? c.q : Math.max(0, (c.v || 0) * px);
  let buyUsd: number;
  if (isN(c.Q) && c.Q >= 0) {
    buyUsd = Math.min(totalUsd, c.Q);
  } else if (isN(c.V) && c.V >= 0 && isN(c.v) && c.v > 0) {
    buyUsd = totalUsd * clamp(c.V / c.v, 0, 1);
  } else {
    const bodyRatio = c.h > c.l ? clamp((c.c - c.o) / (c.h - c.l), -1, 1) : 0;
    buyUsd = totalUsd * (0.5 + 0.18 * bodyRatio);
  }
  const sellUsd = Math.max(0, totalUsd - buyUsd);
  const trades = isN(c.n) && c.n > 0 ? c.n : 0;
  return { totalUsd, buyUsd, sellUsd, trades };
}

export function analyzeMicroTimeframe(
  candles: Candle[],
  tf: string,
  windowBars = 24
): MicroTimeframeFlow | null {
  if (!candles || candles.length < 12) return null;
  const slice = candles.slice(-Math.max(windowBars + 20, 36));
  const n = slice.length;
  const tfMs = TF_MS[tf] || 60_000;
  const tfMins = Math.max(1, tfMs / 60_000);

  const deltas = new Float64Array(n);
  const vols = new Float64Array(n);
  const closes = new Float64Array(n);
  const cvd = new Float64Array(n);

  let accCvd = 0;
  const barFlows: MicroBarFlow[] = [];

  for (let i = 0; i < n; i++) {
    const c = slice[i];
    const { totalUsd, buyUsd, sellUsd } = barQuoteAmounts(c);
    const deltaUsd = buyUsd - sellUsd;
    accCvd += deltaUsd;
    deltas[i] = deltaUsd;
    vols[i] = totalUsd;
    closes[i] = c.c;
    cvd[i] = accCvd;
    barFlows.push({
      t: c.t,
      deltaUsd,
      volUsd: totalUsd,
      buyRatio: totalUsd > 0 ? buyUsd / totalUsd : 0.5,
      close: c.c,
    });
  }

  const winStart = Math.max(0, n - windowBars);
  let buyVolUsd = 0;
  let sellVolUsd = 0;
  let totalVolUsd = 0;
  let totalTrades = 0;
  let barCount = 0;

  for (let i = winStart; i < n; i++) {
    const c = slice[i];
    const { totalUsd, buyUsd, sellUsd, trades } = barQuoteAmounts(c);
    buyVolUsd += buyUsd;
    sellVolUsd += sellUsd;
    totalVolUsd += totalUsd;
    totalTrades += trades;
    barCount++;
  }

  const netDeltaUsd = buyVolUsd - sellVolUsd;
  const deltaPct = totalVolUsd > 0 ? clamp(netDeltaUsd / totalVolUsd, -1, 1) : 0;
  const buyRatio = totalVolUsd > 0 ? clamp(buyVolUsd / totalVolUsd, 0, 1) : 0.5;

  // Compute baseline mean USD volume over previous 20 bars for RVOL & CVD normalization
  const baseIdx = Math.max(0, n - 2);
  let baseSum = 0;
  let baseCnt = 0;
  for (let i = Math.max(0, baseIdx - 20); i < baseIdx; i++) {
    baseSum += vols[i];
    baseCnt++;
  }
  const meanBarUsd = baseCnt > 0 ? baseSum / baseCnt : totalVolUsd / Math.max(1, barCount);
  const latestClosedVol = vols[Math.max(0, n - 2)] || vols[n - 1] || 0;
  const rvol = meanBarUsd > 0 ? latestClosedVol / meanBarUsd : 1;

  // Normalized CVD slope over recent window
  const slopeLen = Math.min(18, n);
  const rawSlope = ind.slope(cvd, n - 1, slopeLen);
  const cvdSlope =
    isN(rawSlope) && meanBarUsd > 0 ? clamp((rawSlope / meanBarUsd) * 4.5, -1, 1) : 0;

  // Price vs CVD Absorption detection across the two halves of the recent micro window
  let absorption: 'BULL' | 'BEAR' | 'NONE' = 'NONE';
  let absorptionDetail = 'لا امتصاص شاذ حالياً';
  const half = Math.floor(Math.min(20, n) / 2);
  if (half >= 5) {
    const mid = n - half;
    const prevStart = Math.max(0, mid - half);
    let prevLow = Infinity;
    let prevHigh = -Infinity;
    let curLow = Infinity;
    let curHigh = -Infinity;
    let prevDelta = 0;
    let curDelta = 0;
    let curVol = 0;

    for (let i = prevStart; i < mid; i++) {
      if (slice[i].l < prevLow) prevLow = slice[i].l;
      if (slice[i].h > prevHigh) prevHigh = slice[i].h;
      prevDelta += deltas[i];
    }
    for (let i = mid; i < n; i++) {
      if (slice[i].l < curLow) curLow = slice[i].l;
      if (slice[i].h > curHigh) curHigh = slice[i].h;
      curDelta += deltas[i];
      curVol += vols[i];
    }

    const curDeltaPct = curVol > 0 ? curDelta / curVol : 0;
    const closeChgPct =
      slice[mid].o > 0 ? ((slice[n - 1].c - slice[mid].o) / slice[mid].o) * 100 : 0;

    if (
      curLow <= prevLow * 1.0005 &&
      cvdSlope > 0.18 &&
      curDeltaPct > 0.05 &&
      curDelta > prevDelta &&
      closeChgPct >= -0.25
    ) {
      absorption = 'BULL';
      absorptionDetail = `امتصاص شرائي على ${tf}: ضغط بيعي قُوبل بتجميع +${(curDeltaPct * 100).toFixed(1)}%`;
    } else if (
      curHigh >= prevHigh * 0.9995 &&
      cvdSlope < -0.18 &&
      curDeltaPct < -0.05 &&
      curDelta < prevDelta &&
      closeChgPct <= 0.25
    ) {
      absorption = 'BEAR';
      absorptionDetail = `امتصاص بيعي على ${tf}: اندفاع شرائي قُوبل بتصريف ${(curDeltaPct * 100).toFixed(1)}%`;
    }
  }

  // Recent 5-bar momentum acceleration bonus
  let recent5Delta = 0;
  let recent5Vol = 0;
  for (let i = Math.max(0, n - 5); i < n; i++) {
    recent5Delta += deltas[i];
    recent5Vol += vols[i];
  }
  const recent5Pct = recent5Vol > 0 ? clamp(recent5Delta / recent5Vol, -1, 1) : 0;

  const rvolWeight = clamp(0.7 + 0.3 * clamp(rvol / 1.5, 0, 1.5), 0.65, 1.15);
  const absBoost = absorption === 'BULL' ? 0.22 : absorption === 'BEAR' ? -0.22 : 0;
  const score = clamp(
    (clamp(deltaPct * 2.8, -1, 1) * 0.4 +
      cvdSlope * 0.35 +
      clamp(recent5Pct * 2.5, -1, 1) * 0.25) *
      rvolWeight +
      absBoost,
    -1,
    1
  );

  const avgTradeUsd = totalTrades > 0 ? totalVolUsd / totalTrades : 0;
  const usdPerMin = barCount > 0 ? totalVolUsd / (barCount * tfMins) : 0;

  return {
    tf,
    bars: barCount,
    buyVolUsd,
    sellVolUsd,
    totalVolUsd,
    netDeltaUsd,
    deltaPct,
    buyRatio,
    cvdSlope,
    rvol,
    avgTradeUsd,
    usdPerMin,
    absorption,
    absorptionDetail,
    score,
    recentBars: barFlows.slice(-18),
  };
}

export function computeOrderFlowSnapshot(params: {
  microCandles?: Record<string, Candle[]>;
  triggerCandles?: Candle[];
  triggerTf?: string;
  book?: OrderBookAnalysis | null;
  vol24h?: number | null;
  minVolumeUsdt?: number;
  maxSpreadBps?: number;
  dirHint?: number;
}): OrderFlowSnapshot {
  const {
    microCandles = {},
    triggerCandles,
    triggerTf = '15m',
    book = null,
    vol24h = null,
    minVolumeUsdt = 25_000_000,
    maxSpreadBps = 8,
    dirHint = 0,
  } = params;

  const frames: Record<string, MicroTimeframeFlow> = {};
  const f1m = microCandles['1m'] ? analyzeMicroTimeframe(microCandles['1m'], '1m', 24) : null;
  const f5m = microCandles['5m'] ? analyzeMicroTimeframe(microCandles['5m'], '5m', 20) : null;

  if (f1m) frames['1m'] = f1m;
  if (f5m) frames['5m'] = f5m;

  // Fallback to trigger candles if 1m/5m haven't been loaded yet
  if (!f1m && !f5m && triggerCandles && triggerCandles.length >= 12) {
    const fTr = analyzeMicroTimeframe(triggerCandles, triggerTf, 18);
    if (fTr) frames[triggerTf] = fTr;
  }

  const availableFrames = Object.values(frames);
  const primaryTf = f1m ? '1m' : f5m ? '5m' : availableFrames[0]?.tf || '1m';

  // Liquidity Filter integration
  const volPass = !isN(vol24h) || minVolumeUsdt <= 0 || vol24h >= minVolumeUsdt;
  const spreadBps = book && isN(book.spreadBps) ? book.spreadBps : null;
  const spreadPass = spreadBps == null || maxSpreadBps <= 0 || spreadBps <= maxSpreadBps;

  const reasons: string[] = [];
  if (!volPass && isN(vol24h)) {
    reasons.push(
      `حجم 24h منخفض (${(vol24h / 1e6).toFixed(1)}M$ < ${(minVolumeUsdt / 1e6).toFixed(1)}M$)`
    );
  }
  if (!spreadPass && spreadBps != null) {
    reasons.push(`سبريد دفتر الأوامر مرتفع (${spreadBps.toFixed(1)} > ${maxSpreadBps} bps)`);
  }

  const liquidityPass = volPass && spreadPass;

  // Composite netBias across lower TFs + live order book imbalance
  let wSum = 0;
  let biasSum = 0;
  if (f1m) {
    wSum += 0.45;
    biasSum += 0.45 * f1m.score;
  }
  if (f5m) {
    wSum += 0.35;
    biasSum += 0.35 * f5m.score;
  }
  if (!f1m && !f5m && availableFrames[0]) {
    wSum += 0.7;
    biasSum += 0.7 * availableFrames[0].score;
  }
  if (book && isN(book.imb05)) {
    wSum += 0.2;
    biasSum += 0.2 * clamp(book.imb05 * 1.4, -1, 1);
  }

  const netBias = wSum > 0 ? clamp(biasSum / wSum, -1, 1) : 0;

  // Confidence scales up when real 1m + 5m + book are present and active
  const frameCoverage = (f1m ? 0.45 : 0) + (f5m ? 0.35 : 0) + (book ? 0.2 : 0) || (availableFrames.length ? 0.4 : 0);
  const confidence = clamp(frameCoverage * (0.4 + 0.6 * Math.min(1, Math.abs(netBias) * 1.6)), 0, 1);

  const absFrame = f1m?.absorption !== 'NONE' ? f1m : f5m?.absorption !== 'NONE' ? f5m : availableFrames.find((x) => x.absorption !== 'NONE');
  const absorption = absFrame?.absorption || 'NONE';

  let verdict: OrderFlowSnapshot['verdict'] = 'NEUTRAL';
  let verdictLabel = 'تدفق متوازن — قيد المراقبة';

  if (!liquidityPass) {
    verdict = 'ILLIQUID';
    verdictLabel = reasons[0] || 'لم يجتز فلتر السيولة';
  } else if (dirHint !== 0) {
    const alignedDir = dirHint * netBias;
    const matchingAbs =
      (dirHint > 0 && absorption === 'BULL') || (dirHint < 0 && absorption === 'BEAR');

    if (matchingAbs) {
      verdict = 'ABSORPTION';
      verdictLabel = absFrame?.absorptionDetail || 'امتصاص سيولة مؤسسي مؤيد للإشارة';
    } else if (alignedDir >= 0.24) {
      verdict = 'CONFIRMED';
      verdictLabel = `تدفق السيولة (${f1m && f5m ? '1m+5m' : primaryTf}) يؤكد ${dirHint > 0 ? 'الشراء' : 'البيع'} (+${(Math.abs(netBias) * 100).toFixed(0)}%)`;
    } else if (alignedDir <= -0.22 && confidence >= 0.35) {
      verdict = 'COUNTER_FLOW';
      verdictLabel = `تحذير: تدفق الأوامر الصغرى يعاكس ${dirHint > 0 ? 'الشراء' : 'البيع'} (${(netBias * 100).toFixed(0)}%)`;
    } else {
      verdict = 'NEUTRAL';
      verdictLabel = `تدفق سيولة متعادل على ${f1m && f5m ? '1m/5m' : primaryTf}`;
    }
  } else {
    if (absorption !== 'NONE') {
      verdict = 'ABSORPTION';
      verdictLabel = absFrame?.absorptionDetail || 'رصد امتصاص سيولة';
    } else if (netBias >= 0.3) {
      verdict = 'CONFIRMED';
      verdictLabel = `ضغط سيولة شرائي صغرى (+${(netBias * 100).toFixed(0)}%)`;
    } else if (netBias <= -0.3) {
      verdict = 'CONFIRMED';
      verdictLabel = `ضغط سيولة بيعي صغرى (${(netBias * 100).toFixed(0)}%)`;
    }
  }

  return {
    t: Date.now(),
    primaryTf,
    frames,
    netBias,
    confidence,
    verdict,
    verdictLabel,
    absorption,
    liquidity: {
      vol24hUsd: isN(vol24h) ? vol24h : null,
      minVolumeUsdt,
      volPass,
      spreadBps,
      maxSpreadBps,
      spreadPass,
      bookImb05: book && isN(book.imb05) ? book.imb05 : null,
      depthBidUsd: book && isN(book.bid05) ? book.bid05 : null,
      depthAskUsd: book && isN(book.ask05) ? book.ask05 : null,
      bidWall: book?.bidWall || null,
      askWall: book?.askWall || null,
      liquidityPass,
      reasons,
    },
  };
}
