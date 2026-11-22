/* ============================================================
   CIPHER X PRO — ENGINE C1 : التجهيز + نظام التقييم متعدد العوامل (v2)
   ============================================================ */
import { clamp, ind, isN } from './indicators';
import { computeOrderFlowSnapshot } from './orderflow';
import { smc } from './smc';
import type {
  BtcContext,
  Candle,
  DerivData,
  EngineConfig,
  IndicatorBundle,
  ModeConfig,
  MtfMatrixRow,
  OrderBookAnalysis,
  OrderFlowSnapshot,
  SymbolMeta,
  TradingModeKey,
} from './types';

export const MODES: Record<TradingModeKey, ModeConfig> = {
  scalp: { trigger: '5m', setup: '15m', trend: '1h', htf: '4h', label: 'سكالبينج' },
  intraday: { trigger: '15m', setup: '1h', trend: '4h', htf: '1d', label: 'يومي' },
  swing: { trigger: '1h', setup: '4h', trend: '1d', htf: null, label: 'سوينج' },
  early: { trigger: '15m', setup: '1h', trend: '4h', htf: '1d', label: 'EARLY ENTRY — اقتناص المبكر' },
};

export function resolveModeConfig(mode: TradingModeKey, earlyTriggerTf?: string): ModeConfig {
  if (mode !== 'early') return MODES[mode] || MODES.intraday;
  if (earlyTriggerTf === '5m') {
    return { trigger: '5m', setup: '15m', trend: '1h', htf: '4h', label: MODES.early.label };
  }
  if (earlyTriggerTf === '1h') {
    return { trigger: '1h', setup: '4h', trend: '1d', htf: null, label: MODES.early.label };
  }
  return { ...MODES.early };
}

export const DEFAULTS: EngineConfig = {
  mode: 'intraday',
  earlyTriggerTf: '15m',
  minScore: 70,
  strongScore: 80,
  watchScore: 62,
  equity: 10000,
  riskPct: 1,
  maxLev: 20,
  mmr: 0.005,
  takerFee: 0.0005,
  makerFee: 0.0002,
  slip: 0.0002,
  minRR1: 1.0,
  maxStopATR: 3.5,
  minStopATR: 0.6,
  maxFeeR: 0.3,
  amp: 1.6,
  cooldownBars: 6,
  minLiqSafetyPct: 25,
  smartProfitShield: true,
  smartTakeProfitEnabled: true,
  smartTakeProfitMinR: 0.6,
  smartTakeProfitPartialPct: 50,
  smartTakeProfitSensitivity: 'balanced',
  tpPcts: [40, 35, 25],
  limitExpireBars: 8,
  cancelChasedAtr: 2.4,
  trailingStopEnabled: true,
  useFvgFilter: true,
  useObFilter: true,
  useChochBosFilter: true,
  useMomentumFilter: true,
};

export interface PreparedContext {
  tfs: ModeConfig;
  B: {
    trigger: IndicatorBundle | null;
    setup: IndicatorBundle | null;
    trend: IndicatorBundle | null;
    htf: IndicatorBundle | null;
  };
  meta: Partial<SymbolMeta>;
  cfg: EngineConfig;
}

export function jOf(S: IndicatorBundle, tClose: number): number {
  let lo = 0;
  let hi = S.n - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (S.t[m] + S.ms <= tClose + 1) {
      ans = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return ans;
}

export function prepare(
  candles: Record<string, Candle[]>,
  tfs: ModeConfig,
  meta?: Partial<SymbolMeta>,
  cfg?: Partial<EngineConfig>
): PreparedContext {
  const B: PreparedContext['B'] = { trigger: null, setup: null, trend: null, htf: null };
  for (const role of ['trigger', 'setup', 'trend', 'htf'] as const) {
    const tf = tfs[role];
    if (!tf || !candles[tf] || candles[tf].length < (role === 'htf' ? 12 : 80)) {
      B[role] = null;
      continue;
    }
    const S = ind.bundle(candles[tf], tf);
    smc.structure(S);
    smc.buildZones(S);
    B[role] = S;
  }
  return { tfs, B, meta: meta || {}, cfg: { ...DEFAULTS, ...(cfg || {}) } };
}

export function tfState(S: IndicatorBundle | null, j: number) {
  if (!S || j < 30) return null;
  const c = S.c[j];
  const e21 = S.ema21[j];
  const e50 = S.ema50[j];
  const e200 = S.ema200[j];
  const adx = S.adx[j];
  let ema = 0;
  if (isN(e200)) {
    if (c > e21 && e21 > e50 && e50 > e200) ema = 1;
    else if (c > e50 && e50 > e200) ema = 0.6;
    else if (c > e200 && e21 > e50) ema = 0.35;
    else if (c > e200) ema = 0.15;
    else if (c < e21 && e21 < e50 && e50 < e200) ema = -1;
    else if (c < e50 && e50 < e200) ema = -0.6;
    else if (c < e200 && e21 < e50) ema = -0.35;
    else if (c < e200) ema = -0.15;
  } else if (isN(e50)) {
    ema = c > e21 && e21 > e50 ? 0.6 : c < e21 && e21 < e50 ? -0.6 : 0;
  } else if (isN(e21)) {
    ema = c > e21 ? 0.45 : -0.45;
  }
  const st = S.stDir[j] || 0;
  const stc = S.struct.trend[j] || 0;
  const mod = 0.6 + 0.4 * clamp(((isN(adx) ? adx : 15) - 15) / 20, 0, 1);
  const raw = (0.45 * ema + 0.25 * st + 0.3 * stc) * mod;
  return { score: clamp(raw, -1, 1), ema, st, struct: stc, adx, rsi: S.rsi[j], c, e21, e50, e200, tf: S.tf };
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export const f2 = (x: number): string =>
  isN(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4)) : '—';

/**
 * Computes macro BTC context at a given closed-candle time `tClose` (or latest closed bar).
 * Identical logic is used on both client and server for parity.
 */
export function buildBtcContext(ctxBTC: PreparedContext | null, tClose?: number): BtcContext | null {
  if (!ctxBTC?.B.trigger) return null;
  const T = ctxBTC.B.trigger;
  const i = isN(tClose) ? jOf(T, tClose) : T.n - 2;
  if (i < 35) return null;
  const curClose = T.t[i] + T.ms;
  const Tr = ctxBTC.B.trend;
  const Su = ctxBTC.B.setup;
  const iS = Su ? jOf(Su, curClose) : -1;
  const iT = Tr ? jOf(Tr, curClose) : -1;

  const stG = tfState(T, i);
  const stS = tfState(Su, iS);
  const stT = tfState(Tr, iT);
  const score =
    stT && stS && stG
      ? 0.45 * stT.score + 0.35 * stS.score + 0.2 * stG.score
      : stS && stG
        ? 0.6 * stS.score + 0.4 * stG.score
        : stG?.score ?? 0;

  const bars1h = Math.max(1, Math.round(3600e3 / T.ms));
  const bars4h = bars1h * 4;
  const chg1h = i - bars1h >= 0 ? (100 * (T.c[i] - T.c[i - bars1h])) / T.c[i - bars1h] : 0;
  const chg4h = i - bars4h >= 0 ? (100 * (T.c[i] - T.c[i - bars4h])) / T.c[i - bars4h] : 0;

  const rg = Tr && iT > 50 ? smc.regime(Tr, iT) : smc.regime(T, i);
  const shock = Math.abs(chg1h) >= 2.2 || Math.abs(chg4h) >= 4.0;
  const dir = shock
    ? sgn(Math.abs(chg1h) >= 2.2 ? chg1h : chg4h)
    : score > 0.15
      ? 1
      : score < -0.15
        ? -1
        : 0;

  const dirTxt = dir > 0 ? 'صاعد' : dir < 0 ? 'هابط' : 'محايد';
  const detail = shock
    ? `صدمة BTC ${chg1h >= 0 ? '+' : ''}${chg1h.toFixed(2)}%/1h · ${chg4h >= 0 ? '+' : ''}${chg4h.toFixed(2)}%/4h`
    : `BTC ${dirTxt} (${(score * 100).toFixed(0)}%) · 4h ${chg4h >= 0 ? '+' : ''}${chg4h.toFixed(2)}%`;

  return {
    dir,
    score: clamp(score, -1, 1),
    chg1h,
    chg4h,
    regime: rg.type,
    shock,
    detail,
    updatedAt: curClose,
  };
}

export function analyzeAt(
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
) {
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
  if (!isN(atr) || atr <= 0) return null;
  const D = opt.deriv || null;
  const BK = opt.book || null;
  const BTC = opt.btcContext || null;
  const hasMicro = Boolean(
    opt.microCandles &&
      ((opt.microCandles['1m']?.length || 0) >= 12 || (opt.microCandles['5m']?.length || 0) >= 12)
  );
  const effMinVol = opt.minVolumeUsdt ?? cfg.minVolumeUsdt ?? 25_000_000;
  const effMaxSpread = opt.maxSpreadBps ?? cfg.maxSpreadBps ?? 8;

  const stH = Hf && iH >= 30 ? tfState(Hf, iH) : null;
  const stT = tfState(Tr, iT);
  const stS = tfState(Su, iS);
  const stG = tfState(T, i);
  const regime = smc.regime(T, i);
  const rg = Tr && iT > 50 ? smc.regime(Tr, iT) : regime;

  const zT = smc.zonesAt(T, i);
  const zS = Su && iS > 30 ? smc.zonesAt(Su, iS) : { ob: [], fvg: [], brk: [] };
  const sw = smc.sweeps(T, i, 3);
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
  const divs = smc.divergence(T, i).filter((d) => d.ago <= 12);
  const setupDivs = Su && iS > 30 ? smc.divergence(Su, iS).filter((d) => d.ago <= 6) : [];

  const lastEv = (S: IndicatorBundle, j: number, maxAge: number) => {
    const ev = S.struct.events;
    for (let m = ev.length - 1; m >= 0; m--) {
      if (ev[m].j > j) continue;
      return j - ev[m].j <= maxAge ? { ...ev[m], ago: j - ev[m].j } : null;
    }
    return null;
  };
  const evT = lastEv(T, i, 18);
  const evS = Su && iS > 30 ? lastEv(Su, iS, 12) : null;

  const bars1h = Math.max(1, Math.round(3600e3 / T.ms));
  const bars4h = bars1h * 4;
  const pChg = (n: number) => (i - n >= 0 ? (100 * (T.c[i] - T.c[i - n])) / T.c[i - n] : NaN);
  const pChg1h = pChg(bars1h);
  const pChg4h = pChg(bars4h);

  const vwapStd = isN(T.vwapUp1[i]) && isN(T.vwap[i]) ? Math.max(1e-12, T.vwapUp1[i] - T.vwap[i]) : atr;
  const vwapZ = isN(T.vwap[i]) ? (price - T.vwap[i]) / vwapStd : 0;
  const zScore = isN(T.zScore[i]) ? T.zScore[i] : 0;
  const sessionLabel = smc.sessionContext(T.t[i]);

  const parts: { key: string; label: string; w: number; wEff: number; raw: number; detail: string }[] = [];
  const add = (key: string, label: string, w: number, raw: number, detail: string) =>
    parts.push({ key, label, w, wEff: w, raw: clamp(raw, -1, 1), detail });

  if (stH && Hf) {
    add(
      'htf',
      'الإطار الأعلى ' + Hf.tf,
      10,
      stH.score,
      `EMA ${stH.ema > 0 ? 'صاعد' : stH.ema < 0 ? 'هابط' : 'متشابك'} · Supertrend ${stH.st > 0 ? '↑' : '↓'} · هيكل ${stH.struct > 0 ? 'صاعد' : stH.struct < 0 ? 'هابط' : 'عرضي'}`
    );
  }
  if (stT && Tr) {
    add(
      'trend',
      'اتجاه ' + Tr.tf,
      18,
      stT.score,
      `EMA ${stT.ema > 0 ? 'صاعد' : stT.ema < 0 ? 'هابط' : 'متشابك'} · Supertrend ${stT.st > 0 ? '↑' : '↓'} · هيكل ${stT.struct > 0 ? 'HH/HL' : stT.struct < 0 ? 'LH/LL' : 'عرضي'} · ADX ${f2(stT.adx)}`
    );
  }
  if (stS && Su) {
    add(
      'setup',
      'اتجاه ' + Su.tf,
      14,
      stS.score,
      `EMA ${stS.ema > 0 ? 'صاعد' : stS.ema < 0 ? 'هابط' : 'متشابك'} · Supertrend ${stS.st > 0 ? '↑' : '↓'} · هيكل ${stS.struct > 0 ? 'صاعد' : stS.struct < 0 ? 'هابط' : 'عرضي'} · RSI ${f2(stS.rsi)}`
    );
  }

  {
    const mh = T.macdH[i];
    const mhp = T.macdH[i - 1];
    const rsi = T.rsi[i];
    let v = clamp((mh / atr) * 8, -1, 1) * 0.4 + sgn(mh - mhp) * 0.2 + clamp((rsi - 50) / 30, -1, 1) * 0.3;
    const k = T.stK[i];
    const d = T.stD[i];
    const kp = T.stK[i - 1];
    const dp = T.stD[i - 1];
    let sx = '';
    if (isN(k) && isN(kp)) {
      if (kp <= dp && k > d && k < 40) {
        v += 0.3;
        sx = ' · تقاطع StochRSI صاعد من تشبع بيعي';
      } else if (kp >= dp && k < d && k > 60) {
        v -= 0.3;
        sx = ' · تقاطع StochRSI هابط من تشبع شرائي';
      }
    }
    if (regime.squeezeFired && mh !== 0) {
      const sqDir = sgn(mh);
      v += sqDir * 0.45;
      sx += ` · انفجار TTM Squeeze ${sqDir > 0 ? 'صاعد' : 'هابط'}`;
    }
    add(
      'mom',
      'الزخم ' + T.tf,
      10,
      v,
      `MACD ${mh > 0 ? 'موجب' : 'سالب'} ${mh > mhp ? '(يتصاعد)' : '(يتراجع)'} · RSI ${f2(rsi)}${sx}`
    );
  }

  {
    let v = 0;
    const tx: string[] = [];
    if (evT) {
      const x = evT.dir * (evT.kind === 'CHoCH' ? 0.8 : 0.55) * (1 - evT.ago / 22);
      v += x * 0.45;
      tx.push(`${evT.kind} ${evT.dir > 0 ? 'صاعد' : 'هابط'} على ${T.tf} منذ ${evT.ago} شمعة`);
    }
    if (evS && Su) {
      const x = evS.dir * (evS.kind === 'CHoCH' ? 0.8 : 0.55) * (1 - evS.ago / 16);
      v += x * 0.3;
      tx.push(`${evS.kind} ${evS.dir > 0 ? 'صاعد' : 'هابط'} على ${Su.tf}`);
    }
    let zv = 0;
    const inZ = (z: any) => price >= z.bot - 0.05 * atr && price <= z.top + 0.05 * atr;
    for (const z of zT.ob) {
      if (inZ(z) && z.touches <= 1) {
        zv += z.dir * 0.7;
        tx.push(`داخل Order Block ${z.dir > 0 ? 'طلب' : 'عرض'} ${T.tf}`);
        break;
      }
    }
    for (const z of zS.ob) {
      if (inZ(z) && z.touches <= 1 && Su) {
        zv += z.dir * 0.85;
        tx.push(`داخل Order Block ${z.dir > 0 ? 'طلب' : 'عرض'} ${Su.tf}`);
        break;
      }
    }
    for (const z of zT.brk.concat(zS.brk)) {
      if (inZ(z) && z.touches <= 1) {
        zv += z.dir * 0.75;
        tx.push(`داخل Breaker Block ${z.dir > 0 ? 'صاعد' : 'هابط'} ${z.tf || T.tf}`);
        break;
      }
    }
    for (const z of zT.fvg.concat(zS.fvg)) {
      if (inZ(z)) {
        zv += z.dir * 0.4;
        tx.push(`داخل FVG ${z.dir > 0 ? 'صاعد' : 'هابط'}`);
        break;
      }
    }
    v += clamp(zv, -1, 1) * 0.45;
    const R = rangeS || rangeT;
    if (R) {
      const pdv = clamp((0.5 - R.pos) * 1.2, -0.6, 0.6);
      v += pdv * 0.25;
      tx.push(
        R.pos < 0.45
          ? `خصم (${(R.pos * 100).toFixed(0)}% من النطاق)`
          : R.pos > 0.55
            ? `علاوة (${(R.pos * 100).toFixed(0)}% من النطاق)`
            : 'عند التوازن'
      );
    }
    const s0 = sw[0] || (swS[0] ? { ...swS[0], wick: 0.4 } : null);
    if (s0) {
      v += s0.dir * (0.5 + 0.4 * clamp(s0.wick, 0, 1)) * 0.5;
      tx.push(`كنس سيولة ${s0.side === 'sell' ? 'القيعان' : 'القمم'} عند ${f2(s0.level)} ثم إغلاق عكسي`);
    }
    add('smc', 'الهيكل و SMC', 20, v, tx.join(' · ') || 'لا حدث هيكلي حديث');
  }

  let sup: any = null;
  let res: any = null;
  {
    for (const L of levels) {
      if (L.p < price - 0.05 * atr && (!sup || L.p > sup.p) && L.strength >= 1.2) sup = L;
      if (L.p > price + 0.05 * atr && (!res || L.p < res.p) && L.strength >= 1.2) res = L;
    }
    const dS = sup ? (price - sup.p) / atr : 6;
    const dR = res ? (res.p - price) / atr : 6;
    const favor = clamp((Math.min(dR, 4) - Math.min(dS, 4)) / 4, -1, 1);
    const vw = isN(T.vwap[i]) ? (price > T.vwap[i] ? 0.2 : -0.2) : 0;
    const zExt = Math.abs(vwapZ) >= 2 ? -sgn(vwapZ) * 0.15 : 0;
    add(
      'loc',
      'الموقع والمساحة',
      10,
      favor * 0.72 + vw + zExt,
      `دعم ${sup ? f2(sup.p) + ' (' + dS.toFixed(1) + ' ATR)' : '—'} · مقاومة ${res ? f2(res.p) + ' (' + dR.toFixed(1) + ' ATR)' : '—'} · VWAP Z ${vwapZ >= 0 ? '+' : ''}${vwapZ.toFixed(2)}σ`
    );
  }

  {
    let v = 0;
    const tx: string[] = [];
    const bd = T.c[i] > T.o[i] ? 1 : -1;
    const rv = T.rvol[i];
    if (isN(rv)) {
      v += bd * clamp((rv - 1) / 1.5, 0, 1) * 0.5;
      tx.push(`RVOL ${rv.toFixed(2)}x`);
    }
    let sd = 0;
    let sv = 0;
    for (let b = i - 2; b <= i; b++) {
      sd += T.delta[b];
      sv += T.v[b];
    }
    const dp = sv > 0 ? sd / sv : 0;
    v += clamp(dp * 4, -1, 1) * 0.35;
    tx.push(`دلتا ${dp >= 0 ? '+' : ''}${(dp * 100).toFixed(1)}%`);
    const cs = ind.slope(T.cvd, i, 20);
    const obvSlope = ind.slope(T.obv, i, 20);
    let mvSum = 0;
    for (let b = i - 19; b <= i; b++) mvSum += T.v[b];
    const mv = mvSum / 20;
    if (isN(cs) && mv > 0) {
      v += clamp((cs / mv) * 5, -1, 1) * 0.28;
      tx.push(`CVD ${cs > 0 ? 'يصعد' : 'يهبط'}`);
    }
    if (isN(obvSlope) && mv > 0) {
      v += clamp((obvSlope / mv) * 2.5, -0.5, 0.5) * 0.2;
      if (Math.abs(obvSlope) > 0.25 * mv) tx.push(`OBV ${obvSlope > 0 ? 'تجميع' : 'تصريف'}`);
    }
    for (const d of divs) {
      v += d.type === 'bull' ? 0.45 : -0.45;
      tx.push(d.ar);
    }
    for (const d of setupDivs) {
      v += d.type === 'bull' ? 0.35 : -0.35;
      tx.push(`${d.ar} (${Su?.tf})`);
    }
    let pv = 0;
    for (const p of patterns) pv += p.dir * p.w;
    if (pv) {
      v += clamp(pv, -1, 1) * 0.35;
      tx.push(
        patterns
          .filter((p) => p.dir)
          .map((p) => p.ar)
          .join('، ')
      );
    }
    if (hasMicro && opt.microCandles) {
      const preFlow = computeOrderFlowSnapshot({
        microCandles: opt.microCandles,
        book: BK,
        vol24h: opt.vol24h,
        minVolumeUsdt: effMinVol,
        maxSpreadBps: effMaxSpread,
        dirHint: 0,
      });
      v = clamp(v * 0.78 + preFlow.netBias * 0.32, -1, 1);
      const primary = preFlow.frames[preFlow.primaryTf];
      if (primary) {
        tx.push(`رادار ${primary.tf} ${preFlow.netBias >= 0 ? '+' : ''}${(preFlow.netBias * 100).toFixed(0)}%`);
      }
      if (preFlow.absorption !== 'NONE') {
        tx.push(preFlow.absorption === 'BULL' ? 'امتصاص شرائي صغرى' : 'امتصاص بيعي صغرى');
      }
    }
    add('flow', 'الحجم والتدفق', 14, v, tx.join(' · '));
  }

  if (D) {
    let v = 0;
    const tx: string[] = [];
    const pd = isN(pChg4h) && Math.abs(pChg4h) >= 0.25 ? sgn(pChg4h) : 0;
    const od = isN(D.oiChg4h) && Math.abs(D.oiChg4h) >= 0.5 ? sgn(D.oiChg4h) : 0;
    if (isN(D.oiChg4h)) {
      let oi = 0;
      let t = 'OI مستقر';
      if (pd > 0 && od > 0) {
        oi = 0.7;
        t = 'سعر↑ + OI↑ = مراكز شراء جديدة';
      } else if (pd > 0 && od < 0) {
        oi = 0.1;
        t = 'سعر↑ + OI↓ = تغطية شورت (ضعيف)';
      } else if (pd < 0 && od > 0) {
        oi = -0.7;
        t = 'سعر↓ + OI↑ = مراكز بيع جديدة';
      } else if (pd < 0 && od < 0) {
        oi = -0.1;
        t = 'سعر↓ + OI↓ = تصفية لونج';
      }
      v += oi * 0.4;
      tx.push(`${t} (OI ${D.oiChg4h >= 0 ? '+' : ''}${D.oiChg4h.toFixed(2)}%/4h)`);
    }
    if (isN(D.funding)) {
      const f = D.funding * 100;
      let fv = 0;
      if (f >= 0.08) fv = -0.6;
      else if (f >= 0.04) fv = -0.3;
      else if (f <= -0.08) fv = 0.6;
      else if (f <= -0.04) fv = 0.3;
      v += fv * 0.25;
      tx.push(`Funding ${f.toFixed(4)}%${fv < 0 ? ' (ازدحام لونج)' : fv > 0 ? ' (ازدحام شورت)' : ''}`);
    }
    if (isN(D.lsRatio)) {
      let lv = 0;
      if (D.lsRatio >= 2) lv = -0.4;
      else if (D.lsRatio >= 1.5) lv = -0.15;
      else if (D.lsRatio <= 0.7) lv = 0.4;
      else if (D.lsRatio <= 0.9) lv = 0.15;
      v += lv * 0.15;
      tx.push(`L/S عام ${D.lsRatio.toFixed(2)}`);
    }
    if (isN(D.topLongPct)) {
      v += clamp((D.topLongPct - 50) / 10, -0.4, 0.4) * 0.1 * 2.5;
      tx.push(`كبار المتداولين ${D.topLongPct.toFixed(0)}% لونج`);
    }
    if (isN(D.takerRatio)) {
      v += clamp((D.takerRatio - 1) * 3, -0.5, 0.5) * 0.1 * 2;
      tx.push(`Taker ${D.takerRatio.toFixed(2)}`);
    }
    add('deriv', 'المشتقات', 14, v, tx.join(' · '));
  }

  if (BK && isN(BK.imb05)) {
    let v = BK.imb05 * 0.6;
    const tx = [`اختلال ±${(BK.bandPct || 0.5).toFixed(2)}%: ${(BK.imb05 * 100).toFixed(0)}%`];
    if (BK.bidWall && (price - BK.bidWall.p) / atr < 1.2) {
      v += 0.3;
      tx.push(`جدار شراء ${f2(BK.bidWall.p)}`);
    }
    if (BK.askWall && (BK.askWall.p - price) / atr < 1.2) {
      v -= 0.3;
      tx.push(`جدار بيع ${f2(BK.askWall.p)}`);
    }
    add('book', 'دفتر الأوامر', 4, v, tx.join(' · '));
  }

  const mult: Record<string, number> = {
    htf: 1,
    trend: 1,
    setup: 1,
    mom: 1,
    smc: 1,
    loc: 1,
    flow: 1,
    deriv: 1,
    book: 1,
  };
  if (rg.type === 'range') {
    mult.htf = 0.75;
    mult.trend = 0.5;
    mult.setup = 0.6;
    mult.loc = 1.6;
    mult.smc = 1.2;
  } else if (rg.type === 'trend') {
    mult.htf = 1.15;
    mult.trend = 1.2;
    mult.setup = 1.1;
  }

  let sw_ = 0;
  let sr = 0;
  for (const p of parts) {
    const w = p.w * (mult[p.key] || 1);
    p.wEff = w;
    sw_ += w;
    sr += w * p.raw;
  }
  const net = sw_ ? sr / sw_ : 0;
  const dir = net > 0.02 ? 1 : net < -0.02 ? -1 : 0;
  let score = Math.round(50 + 50 * clamp(Math.abs(net) * cfg.amp, 0, 1));
  const aligned = parts.filter((p) => dir && sgn(p.raw) === dir && Math.abs(p.raw) >= 0.25).length;
  const opposed = parts.filter((p) => dir && sgn(p.raw) === -dir && Math.abs(p.raw) >= 0.5);

  const gates: string[] = [];
  const warns: string[] = [];
  let cap = 100;
  const capTo = (v: number, msg: string) => {
    if (v < cap) cap = v;
    gates.push(msg);
  };

  if (dir) {
    const ext = (dir * (price - T.ema21[i])) / atr;
    const against = (x: any) => x && sgn(x.score) === -dir && Math.abs(x.score) >= 0.35;
    const choch =
      (evT && evT.kind === 'CHoCH' && evT.dir === dir) || (evS && evS.kind === 'CHoCH' && evS.dir === dir);
    if (against(stT) && against(stS) && !choch && Tr && Su) {
      capTo(66, `عكس الاتجاه الأكبر (${Tr.tf} و ${Su.tf}) بدون CHoCH تأكيدي`);
    } else if (against(stT) && !choch && Tr) {
      capTo(72, `عكس اتجاه ${Tr.tf} بدون CHoCH تأكيدي`);
    }
    if (against(stH) && Hf) {
      warns.push(`عكس الإطار الأعلى ${Hf.tf}`);
    }
    if (ext > 3.5) capTo(64, `السعر متمدد ${ext.toFixed(1)}×ATR عن EMA21 (مطاردة)`);
    else if (ext > 2.4) capTo(74, `السعر متمدد ${ext.toFixed(1)}×ATR عن EMA21`);
    const rsi = T.rsi[i];
    if (dir > 0 && rsi >= 80) capTo(68, `RSI ${rsi.toFixed(0)} تشبع شرائي شديد`);
    if (dir < 0 && rsi <= 20) capTo(68, `RSI ${rsi.toFixed(0)} تشبع بيعي شديد`);
    if (T.atrp[i] < 0.06) capTo(55, 'تقلب ميت (ATR% < 0.06)');
    if (regime.squeeze && !regime.squeezeFired && !(evT && evT.dir === dir && evT.ago <= 3)) {
      capTo(72, regime.ttmSqueeze ? 'انضغاط TTM Squeeze — انتظر الانفجار' : 'انضغاط بولينجر — انتظر الاختراق');
    }
    if (BK && BK.spreadBps > effMaxSpread) capTo(60, `فلتر السيولة: سبريد واسع ${BK.spreadBps.toFixed(1)}bps > ${effMaxSpread}bps`);
    if (isN(opt.vol24h) && effMinVol > 0 && opt.vol24h < effMinVol) {
      capTo(58, `فلتر السيولة: حجم 24h (${(opt.vol24h / 1e6).toFixed(1)}M$) دون ${(effMinVol / 1e6).toFixed(1)}M$`);
    }
    if (opposed.length >= 2) capTo(70, `تعارض قوي: ${opposed.map((p) => p.label).join(' و ')}`);
    if (BTC && BTC.shock && BTC.dir && BTC.dir !== dir) {
      capTo(66, `حماية BTC: ${BTC.detail} تعاكس اتجاه الإشارة`);
    } else if (BTC && Math.abs(BTC.score) >= 0.45 && BTC.dir && BTC.dir !== dir) {
      capTo(74, `مخالفة لاتجاه BTC الماكرو (${BTC.detail})`);
      warns.push(`اتجاه BTC الماكرو معاكس: ${BTC.detail}`);
    }
    if (setupDivs.some((d) => (d.type === 'bull' ? 1 : -1) === -dir)) {
      warns.push(`دايفرجنس معاكس حديث على إطار ${Su?.tf}`);
    }
    if (
      D &&
      D.fundingMs &&
      D.fundingMs - refNow < 10 * 60e3 &&
      D.fundingMs > refNow &&
      D.funding !== undefined &&
      dir * D.funding > 0.0005
    ) {
      warns.push(
        `تسوية التمويل خلال ${Math.max(1, Math.round((D.fundingMs - refNow) / 60e3))} دقيقة وأنت ستدفع ${(D.funding * 100).toFixed(3)}%`
      );
    }
  }

  let orderFlow: OrderFlowSnapshot | null = null;
  if (hasMicro || BK || isN(opt.vol24h)) {
    const fallbackCandles: Candle[] = [];
    if (!hasMicro) {
      const startB = Math.max(0, i - 30);
      for (let b = startB; b <= i; b++) {
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
    orderFlow = computeOrderFlowSnapshot({
      microCandles: hasMicro ? opt.microCandles : undefined,
      triggerCandles: fallbackCandles,
      triggerTf: T.tf,
      book: BK,
      vol24h: opt.vol24h,
      minVolumeUsdt: effMinVol,
      maxSpreadBps: effMaxSpread,
      dirHint: dir,
    });
    if (dir && hasMicro && orderFlow.verdict === 'COUNTER_FLOW') {
      capTo(69, `رادار السيولة (${orderFlow.primaryTf}): تدفق السيولة اللحظي يعاكس الإشارة`);
    } else if (dir && hasMicro && orderFlow.verdict === 'ABSORPTION') {
      warns.push(orderFlow.verdictLabel);
    }
  }

  const rawScore = score;
  score = Math.min(score, cap);

  const mtfMatrix: MtfMatrixRow[] = [];
  if (stH && Hf) mtfMatrix.push({ ...stH, role: 'htf', tf: Hf.tf });
  if (stT && Tr) mtfMatrix.push({ ...stT, role: 'trend', tf: Tr.tf });
  if (stS && Su) mtfMatrix.push({ ...stS, role: 'setup', tf: Su.tf });
  if (stG) mtfMatrix.push({ ...stG, role: 'trigger', tf: T.tf });

  const allBreakers = [...(zT.brk || []), ...(zS.brk || [])];

  return {
    i,
    t: T.t[i],
    tClose,
    price,
    atr,
    atrp: T.atrp[i],
    dir,
    net,
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
    breakers: allBreakers,
    sweeps: sw,
    pools,
    range: { T: rangeT, S: rangeS },
    vp,
    levels,
    sup,
    res,
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
    orderFlow,
  };
}
