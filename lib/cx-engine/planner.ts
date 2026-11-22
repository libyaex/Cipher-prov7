/* ============================================================
   CIPHER X PRO — ENGINE C2 : خطة الصفقة + حماية المحفظة وحساب التصفية
   ============================================================ */
import { analyzeAt, DEFAULTS, f2, PreparedContext } from './analyzer';
import { evaluateEarlyEntry } from './early-entry';
import { clamp, isN, util } from './indicators';
import type {
  BtcContext,
  Candle,
  DerivData,
  OrderBookAnalysis,
  PositionSizeResult,
  SignalEvaluation,
  TradePlan,
} from './types';

export function calcMaintenanceMarginRate(notional: number, fallbackMmr = 0.005): number {
  if (!isN(notional) || notional <= 0) return fallbackMmr;
  if (notional <= 50_000) return Math.max(0.004, fallbackMmr);
  if (notional <= 250_000) return Math.max(0.005, fallbackMmr);
  if (notional <= 1_000_000) return 0.01;
  if (notional <= 5_000_000) return 0.025;
  return 0.05;
}

export function calcLiquidationPrice(params: {
  entry: number;
  lev: number;
  mmr: number;
  long: boolean;
  takerFee?: number;
}): number {
  const { entry, lev, mmr, long, takerFee = 0.0005 } = params;
  if (!(entry > 0) || !(lev >= 1)) return 0;
  // Isolated margin liquidation formula including maintenance margin & closing taker fee reserve
  const liq = long
    ? entry * (1 - 1 / lev + mmr + takerFee)
    : entry * (1 + 1 / lev - mmr - takerFee);
  return Math.max(0, liq);
}

export function validateStopBeforeLiquidation(params: {
  entry: number;
  stop: number;
  liq: number;
  long: boolean;
  minSafetyPct?: number;
}): { safetyOk: boolean; safetyBufferPct: number; reason?: string } {
  const { entry, stop, liq, long, minSafetyPct = 25 } = params;
  const liqDist = long ? entry - liq : liq - entry;
  const stopDist = long ? entry - stop : stop - entry;
  if (liqDist <= 0) {
    return {
      safetyOk: false,
      safetyBufferPct: 0,
      reason: 'الرافعة عالية جداً: سعر التصفية يقع قبل أو عند سعر الدخول',
    };
  }
  const precedesLiq = long ? stop > liq : stop < liq;
  if (!precedesLiq) {
    return {
      safetyOk: false,
      safetyBufferPct: 0,
      reason: 'تم رفض الصفقة: وقف الخسارة يقع بعد سعر التصفية',
    };
  }
  const marginLeft = long ? stop - liq : liq - stop;
  const safetyBufferPct = (marginLeft / liqDist) * 100;
  if (safetyBufferPct < minSafetyPct || liqDist < stopDist * 1.25) {
    return {
      safetyOk: false,
      safetyBufferPct,
      reason: `تم رفض الصفقة: مسافة الأمان بين وقف الخسارة والتصفية (${safetyBufferPct.toFixed(1)}%) أقل من الحد الآمن (${minSafetyPct}%)`,
    };
  }
  return { safetyOk: true, safetyBufferPct };
}

export function sizePosition(p: {
  entry: number;
  stop: number;
  equity: number;
  riskPct: number;
  maxLev: number;
  mmr?: number;
  takerFee?: number;
  minSafetyPct?: number;
  step?: number;
  minQty?: number;
  minNotional?: number;
  long: boolean;
}): PositionSizeResult {
  const {
    entry,
    stop,
    equity,
    riskPct,
    maxLev,
    mmr = 0.005,
    takerFee = 0.0005,
    minSafetyPct = 25,
    step = 0,
    minQty = 0,
    minNotional = 5,
    long,
  } = p;

  const dist = Math.abs(entry - stop);
  const out: PositionSizeResult = {
    ok: false,
    note: '',
    qty: 0,
    notional: 0,
    lev: 1,
    safeMax: 1,
    riskUsd: 0,
    effRiskUsd: 0,
    effRiskPct: 0,
    margin: 0,
    limited: false,
    liq: 0,
    mmr,
    maintenanceMarginUsd: 0,
    safetyBufferPct: 0,
    safetyOk: false,
  };

  if (!(dist > 0) || !(equity > 0) || !(entry > 0)) {
    out.note = 'مدخلات غير صالحة';
    return out;
  }

  const riskUsd = (equity * riskPct) / 100;
  let qty = riskUsd / dist;

  // Iteratively refine safeMax using tiered MMR on estimated notional
  const safetyMultiplier = 1 / Math.max(0.2, 1 - minSafetyPct / 100);
  const effectiveMult = Math.max(1.5, safetyMultiplier);
  let tierMmr = calcMaintenanceMarginRate(qty * entry, mmr);
  let safeMax = Math.max(1, Math.floor(1 / ((effectiveMult * dist) / entry + tierMmr + takerFee)));
  for (let pass = 0; pass < 2; pass++) {
    const capLev = Math.min(maxLev || 20, safeMax);
    const estNotional = Math.min(qty * entry, equity * capLev);
    tierMmr = calcMaintenanceMarginRate(estNotional, mmr);
    safeMax = Math.max(1, Math.floor(1 / ((effectiveMult * dist) / entry + tierMmr + takerFee)));
  }

  const levCap = Math.min(maxLev || 20, safeMax);
  // Target allocating at most ~12% of equity as initial margin per trade and avoid 1x (-99.45% liq) when safeMax allows >=2x
  const targetMargin = Math.max(1, equity * 0.12);
  const levNeeded = (qty * entry) / targetMargin;
  const minSensibleLev = levCap >= 2 ? 2 : 1;
  const lev = clamp(Math.ceil(levNeeded), minSensibleLev, levCap);

  let limited = false;
  if (qty * entry > equity * lev) {
    qty = (equity * lev) / entry;
    limited = true;
  }
  if (step > 0) {
    const d = Math.max(0, Math.round(-Math.log10(step)));
    qty = +(Math.floor(qty / step + 1e-9) * step).toFixed(d);
  }

  const notional = qty * entry;
  const effMmr = calcMaintenanceMarginRate(notional, mmr);
  const liq = calcLiquidationPrice({ entry, lev, mmr: effMmr, long, takerFee });
  const safetyCheck = validateStopBeforeLiquidation({
    entry,
    stop,
    liq,
    long,
    minSafetyPct,
  });

  out.qty = qty;
  out.notional = notional;
  out.lev = lev;
  out.safeMax = safeMax;
  out.riskUsd = riskUsd;
  out.effRiskUsd = qty * dist;
  out.effRiskPct = (100 * qty * dist) / equity;
  out.margin = notional / lev;
  out.limited = limited;
  out.liq = liq;
  out.mmr = effMmr;
  out.maintenanceMarginUsd = notional * effMmr;
  out.safetyBufferPct = safetyCheck.safetyBufferPct;
  out.safetyOk = safetyCheck.safetyOk;

  if (minQty > 0 && qty < minQty) {
    out.note = `الكمية ${qty} أقل من الحد الأدنى ${minQty} — ارفع رأس المال أو نسبة المخاطرة`;
    return out;
  }
  if (minNotional > 0 && notional < minNotional) {
    out.note = `قيمة الصفقة ${notional.toFixed(2)}$ أقل من الحد الأدنى ${minNotional}$`;
    return out;
  }
  if (!safetyCheck.safetyOk) {
    out.note = safetyCheck.reason || 'مسافة الأمان قبل التصفية غير كافية';
    return out;
  }
  if (limited) {
    out.note = `تم تقليص الحجم لأن الرافعة الآمنة القصوى ${levCap}x (المخاطرة الفعلية ${out.effRiskPct.toFixed(2)}%)`;
  }
  out.ok = qty > 0 && safetyCheck.safetyOk;
  return out;
}

export function buildPlan(
  ctx: PreparedContext,
  A: NonNullable<ReturnType<typeof analyzeAt>>
): TradePlan {
  const fail = (why: string): TradePlan => ({ ok: false, why });
  const dir = A.dir;
  if (!dir) return fail('لا اتجاه واضح');

  const T = ctx.B.trigger!;
  const Su = ctx.B.setup;
  const Tr = ctx.B.trend;
  const i = A.i;
  const price = A.price;
  const atr = A.atr;
  const cfg = ctx.cfg;
  const tick = ctx.meta.tick || price * 1e-5;
  const long = dir > 0;
  const rt = (p: number, m: 'down' | 'up' | 'near') => util.roundTick(p, tick, m);
  const iS = A.idx.iS;
  const iT = A.idx.iT;

  const an: { kind: string; lo: number; hi: number; w: number; label: string }[] = [];
  const push = (kind: string, lo: number, hi: number, w: number, label: string) => {
    if (!isN(lo) || !isN(hi)) return;
    if (lo > hi) {
      const x = lo;
      lo = hi;
      hi = x;
    }
    an.push({ kind, lo, hi, w, label });
  };

  for (const z of A.zones.T.ob) {
    if (z.dir === dir) push('OB', z.bot, z.top, 3 + (z.touches === 0 ? 0.5 : 0), `Order Block ${T.tf}`);
  }
  if (Su) {
    for (const z of A.zones.S.ob) {
      if (z.dir === dir) push('OB', z.bot, z.top, 3.5 + (z.touches === 0 ? 0.5 : 0), `Order Block ${Su.tf}`);
    }
  }
  for (const z of A.breakers || []) {
    if (z.dir === dir) {
      push('BRK', z.bot, z.top, 2.8 + (z.touches === 0 ? 0.4 : 0), `Breaker Block ${z.tf || T.tf}`);
    }
  }
  for (const z of A.zones.T.fvg) if (z.dir === dir) push('FVG', z.bot, z.top, 2, `FVG ${T.tf}`);
  if (Su) for (const z of A.zones.S.fvg) if (z.dir === dir) push('FVG', z.bot, z.top, 2.2, `FVG ${Su.tf}`);

  push('EMA', T.ema21[i] - 0.12 * atr, T.ema21[i] + 0.12 * atr, 1.5, `EMA21 ${T.tf}`);
  if (Su && isN(Su.ema50[iS])) {
    push('EMA', Su.ema50[iS] - 0.15 * atr, Su.ema50[iS] + 0.15 * atr, 2, `EMA50 ${Su.tf}`);
  }
  if (Tr && isN(Tr.ema200[iT])) {
    push('EMA', Tr.ema200[iT] - 0.2 * atr, Tr.ema200[iT] + 0.2 * atr, 2.5, `EMA200 ${Tr.tf}`);
  }
  if (isN(T.vwap[i])) push('VWAP', T.vwap[i] - 0.1 * atr, T.vwap[i] + 0.1 * atr, 1.5, 'VWAP');

  const R0 = A.range.S || A.range.T;
  if (R0 && R0.leg === dir) push('OTE', R0.ote[0], R0.ote[1], 2.5, 'فيبوناتشي 0.62–0.79');
  for (const ev of [A.evT, A.evS]) {
    if (ev && ev.dir === dir) {
      push(
        'RETEST',
        long ? ev.level - 0.25 * atr : ev.level - 0.15 * atr,
        long ? ev.level + 0.15 * atr : ev.level + 0.25 * atr,
        2.5,
        `إعادة اختبار كسر ${ev.kind}`
      );
    }
  }
  for (const L of A.levels) {
    if (long ? L.p > price + 0.2 * atr : L.p < price - 0.2 * atr) continue;
    push(
      'SR',
      L.p - 0.2 * atr,
      L.p + 0.2 * atr,
      Math.min(3, 1 + L.strength / 2),
      (long ? 'دعم ' : 'مقاومة ') + f2(L.p)
    );
  }
  if (A.vp) {
    push('VP', A.vp.poc - 0.1 * atr, A.vp.poc + 0.1 * atr, 1.5, 'POC');
    push(
      'VP',
      long ? A.vp.val - 0.1 * atr : A.vp.vah - 0.1 * atr,
      long ? A.vp.val + 0.1 * atr : A.vp.vah + 0.1 * atr,
      1.2,
      long ? 'VAL' : 'VAH'
    );
  }

  const usable = an
    .filter((z) => (long ? price >= z.lo - 0.05 * atr : price <= z.hi + 0.05 * atr))
    .map((z) => ({
      ...z,
      dist: long ? Math.max(0, price - z.hi) / atr : Math.max(0, z.lo - price) / atr,
    }))
    .filter((z) => z.dist <= 3.5)
    .sort((a, b) => a.lo - b.lo);

  const groups: { lo: number; hi: number; items: typeof usable }[] = [];
  const maxZoneSpan = 2.2 * atr;
  for (const z of usable) {
    const g = groups[groups.length - 1];
    const nextLo = g ? Math.min(g.lo, z.lo) : z.lo;
    const nextHi = g ? Math.max(g.hi, z.hi) : z.hi;
    if (g && z.lo <= g.hi + 0.25 * atr && nextHi - nextLo <= maxZoneSpan) {
      g.hi = nextHi;
      g.lo = nextLo;
      g.items.push(z);
    } else {
      groups.push({ lo: z.lo, hi: z.hi, items: [z] });
    }
  }

  let best: {
    lo: number;
    hi: number;
    w: number;
    nK: number;
    dist: number;
    sc: number;
    kinds: string[];
    labels: string[];
  } | null = null;

  for (const g of groups) {
    const kinds: Record<string, number> = {};
    for (const it of g.items) kinds[it.kind] = Math.max(kinds[it.kind] || 0, it.w);
    const w = Object.values(kinds).reduce((a, b) => a + b, 0);
    const nK = Object.keys(kinds).length;
    const dist = long ? Math.max(0, price - g.hi) / atr : Math.max(0, g.lo - price) / atr;
    const sc = (w / (1 + 0.6 * dist)) * (nK >= 2 ? 1.15 : 1);
    if (!best || sc > best.sc) {
      best = {
        lo: g.lo,
        hi: g.hi,
        w,
        nK,
        dist,
        sc,
        kinds: Object.keys(kinds),
        labels: [...new Set(g.items.map((x) => x.label))],
      };
    }
  }

  if (!best) return fail('لا توجد منطقة قيمة قريبة (≤3.5 ATR) تبرر الدخول — لا مطاردة للسعر');
  if (best.nK < 2 && best.w < 3) return fail('منطقة القيمة القريبة ضعيفة (عامل واحد فقط) — لا دخول');

  const confirmBits: string[] = [];
  if (dir * (T.c[i] - T.o[i]) > 0) confirmBits.push(`إغلاق ${T.tf} ${long ? 'صاعد' : 'هابط'}`);
  for (const p of A.patterns) if (p.dir === dir) confirmBits.push(p.ar);
  const sx = A.sweeps.find((s) => s.dir === dir && s.ago <= 2);
  if (sx) confirmBits.push('كنس سيولة + إغلاق عكسي');
  if (A.evT && A.evT.dir === dir && A.evT.ago <= 3) confirmBits.push(`${A.evT.kind} حديث`);
  if (A.regime.squeezeFired && Math.sign(T.macdH[i]) === dir) confirmBits.push('انفجار TTM Squeeze');
  if (isN(T.rvol[i]) && T.rvol[i] >= 1.3 && dir * (T.c[i] - T.o[i]) > 0) {
    confirmBits.push(`حجم ${T.rvol[i].toFixed(1)}x`);
  }
  if (A.orderFlow) {
    if (A.orderFlow.verdict === 'CONFIRMED' && A.orderFlow.liquidity.liquidityPass) {
      confirmBits.push(`توافق رادار السيولة (${A.orderFlow.primaryTf})`);
    } else if (
      (dir > 0 && A.orderFlow.absorption === 'BULL') ||
      (dir < 0 && A.orderFlow.absorption === 'BEAR')
    ) {
      confirmBits.push(`امتصاص سيولة ${A.orderFlow.primaryTf}`);
    }
  }
  const confirmed = confirmBits.length >= 1;
  const ext = (dir * (price - T.ema21[i])) / atr;
  const inside = best.dist === 0;
  let touched = false;
  for (let b = Math.max(0, i - 2); b <= i; b++) {
    if (T.l[b] <= best.hi && T.h[b] >= best.lo) touched = true;
  }
  const marketOk = (inside || (best.dist <= 0.5 && touched && confirmed)) && ext <= 2.4;

  let type: 'MARKET' | 'LIMIT';
  let entry: number;
  if (marketOk) {
    type = 'MARKET';
    entry = rt(price, 'near');
  } else {
    entry = long ? best.hi - 0.25 * (best.hi - best.lo) : best.lo + 0.25 * (best.hi - best.lo);
    entry = long ? Math.min(entry, price) : Math.max(entry, price);
    type = 'LIMIT';
    entry = rt(entry, 'near');
  }
  const fillDist = Math.abs(price - entry) / atr;

  let ref = long ? best.lo : best.hi;
  let refLabel = best.labels[0];
  const sw0 = A.sweeps.find((s) => s.dir === dir && s.ago <= 6);
  if (sw0) {
    const wx = long ? T.l[sw0.bar] : T.h[sw0.bar];
    if (long ? wx < ref : wx > ref) {
      ref = wx;
      refLabel = 'ذيل كنس السيولة';
    }
  }
  const buf = Math.max(0.25 * atr, 2 * tick);
  const sl = long ? T.struct.slP[i] : T.struct.shP[i];
  if (isN(sl) && (long ? sl < ref && ref - sl <= 1.0 * atr : sl > ref && sl - ref <= 1.0 * atr)) {
    const pulledStop = long ? sl - buf : sl + buf;
    if (Math.abs(entry - pulledStop) <= cfg.maxStopATR * atr) {
      ref = sl;
      refLabel = long ? 'آخر قاع هيكلي' : 'آخر قمة هيكلية';
    }
  }
  let stop = long ? ref - buf : ref + buf;
  const minD = cfg.minStopATR * atr;
  if (long ? entry - stop < minD : stop - entry < minD) {
    stop = long ? entry - minD : entry + minD;
    refLabel += ' (+حد أدنى للتذبذب)';
  }
  stop = rt(stop, long ? 'down' : 'up');
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return fail('وقف غير صالح');
  if (risk > cfg.maxStopATR * atr) {
    return fail(`الوقف الهيكلي بعيد (${(risk / atr).toFixed(1)}×ATR > ${cfg.maxStopATR}) — المخاطرة غير مبررة`);
  }

  const R = (p: number) => Math.abs(p - entry) / risk;
  const cands: { p: number; label: string; w: number }[] = [];
  const pt = (p: number, label: string, w: number) => {
    if (isN(p) && (long ? p > entry + 0.2 * risk : p < entry - 0.2 * risk)) cands.push({ p, label, w });
  };
  for (const L of A.levels) {
    if (L.strength >= 1.2) {
      pt(L.p, (L.kind === 'swing' ? (long ? 'مقاومة ' : 'دعم ') : L.kind + ' ') + f2(L.p), L.strength);
    }
  }
  for (const pl of A.pools) {
    if (pl.swept < 0 && pl.side === (long ? 'high' : 'low')) {
      pt(pl.level, 'سيولة Equal ' + (long ? 'Highs' : 'Lows'), 3);
    }
  }
  pt(long ? T.struct.shP[i] : T.struct.slP[i], long ? 'آخر قمة هيكلية' : 'آخر قاع هيكلي', 2);
  if (R0) pt(long ? R0.hi : R0.lo, long ? 'قمة النطاق' : 'قاع النطاق', 2);
  if (A.vp) {
    pt(A.vp.poc, 'POC', 1.5);
    pt(long ? A.vp.vah : A.vp.val, long ? 'VAH' : 'VAL', 1.5);
  }
  cands.sort((a, b) => (long ? a.p - b.p : b.p - a.p));
  const barrier = cands.find((x) => R(x.p) < 0.9 && x.w >= 3);
  if (barrier) return fail(`عائق قوي (${barrier.label}) على بعد ${R(barrier.p).toFixed(2)}R فقط — لا مساحة للهدف`);

  const near = (p: number) => rt(long ? p - 0.1 * atr : p + 0.1 * atr, long ? 'down' : 'up');
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
  const t1 = pick(1.0, 2.2, 1.5);
  const t2 = pick(Math.max(2.0, R(t1.p) + 0.4), 4.5, Math.max(2.5, R(t1.p) + 1));
  const t3 = pick(Math.max(3.5, R(t2.p) + 0.8), 8, Math.max(4, R(t2.p) + 1.5));
  const tpPcts = cfg.tpPcts || [40, 35, 25];
  const tps = [t1, t2, t3].map((t, k) => ({ ...t, r: R(t.p), pct: tpPcts[k] ?? [40, 35, 25][k] }));
  for (let k = 1; k < 3; k++) {
    if (long ? tps[k].p <= tps[k - 1].p : tps[k].p >= tps[k - 1].p) {
      tps[k].p = rt(long ? tps[k - 1].p + risk : tps[k - 1].p - risk, 'near');
      tps[k].r = R(tps[k].p);
      tps[k].real = false;
      tps[k].label = tps[k].r.toFixed(1) + 'R';
    }
  }

  // Accurate bidirectional fees & slippage accounting
  const feeIn = type === 'MARKET' ? cfg.takerFee : cfg.makerFee;
  const slipIn = type === 'MARKET' ? cfg.slip : 0;
  const feeOut = cfg.takerFee;
  const slipOut = cfg.slip;
  const feeR = (entry * (feeIn + slipIn + feeOut + slipOut)) / risk;
  if (feeR > (cfg.maxFeeR || 0.3)) {
    return fail(`الرسوم+الانزلاق تأكل ${feeR.toFixed(2)}R (الحد ${(cfg.maxFeeR || 0.3).toFixed(2)}R) — وقف ضيق جداً لهذا الإطار`);
  }
  if (tps[0].r - feeR < cfg.minRR1 * 0.85) {
    return fail(`العائد الصافي إلى TP1 (${(tps[0].r - feeR).toFixed(2)}R) أقل من الحد بعد الرسوم`);
  }

  const zoneTxt = `[${f2(best.lo)} – ${f2(best.hi)}]`;
  const checks: { ok: boolean | null; label: string; detail: string }[] = [];
  const nowRisk = Math.abs(price - stop);
  const rNow = Math.abs(tps[0].p - price) / (nowRisk || 1);

  if (type === 'MARKET') {
    checks.push({
      ok: true,
      label: 'السعر داخل منطقة القيمة',
      detail: `السعر الحالي ${f2(price)} ${inside ? 'داخل' : 'خرج للتو (' + best.dist.toFixed(2) + '×ATR) بعد لمس ورفض من'} ${zoneTxt} — التقاء ${best.nK} عوامل: ${best.labels.slice(0, 4).join(' + ')}`,
    });
    checks.push({
      ok: ext <= 2.4,
      label: 'غير مُطارَد',
      detail: `البعد عن EMA21 = ${ext.toFixed(2)}×ATR (الحد 2.4) — الدخول ليس بعد اندفاع`,
    });
    checks.push({
      ok: true,
      label: 'وقف هيكلي',
      detail: `الوقف ${f2(stop)} خلف ${refLabel} — مسافة ${(risk / atr).toFixed(2)}×ATR (${((100 * risk) / entry).toFixed(2)}%)`,
    });
    checks.push({
      ok: tps[0].r >= 1,
      label: 'مساحة للهدف',
      detail: `TP1 = ${tps[0].r.toFixed(2)}R (${tps[0].label}) · TP2 = ${tps[1].r.toFixed(2)}R · رسوم+انزلاق ≈ ${feeR.toFixed(2)}R`,
    });
    checks.push({
      ok: confirmed,
      label: 'تأكيد الشمعة',
      detail: confirmed
        ? confirmBits.join(' + ')
        : 'لا تأكيد صريح على الشمعة الأخيرة — خفّض الحجم أو انتظر إغلاق شمعة تأكيد',
    });
    const mid = (best.lo + best.hi) / 2;
    const altOk = long ? mid < price - 0.1 * atr : mid > price + 0.1 * atr;
    if (altOk) {
      const rAlt = Math.abs(tps[0].p - mid) / (Math.abs(mid - stop) || 1);
      checks.push({
        ok: null,
        label: 'لماذا لا ننتظر ارتداداً؟',
        detail: `الانتظار حتى ${f2(mid)} يعطي TP1 = ${rAlt.toFixed(2)}R لكن لا ضمان للتنفيذ؛ السعر الحالي داخل المنطقة أصلاً والزخم/التدفق متوافقان`,
      });
    }
  } else {
    checks.push({
      ok: false,
      label: 'السعر الحالي ليس سعر دخول مناسب',
      detail: `السعر ${f2(price)} يبعد ${fillDist.toFixed(2)}×ATR عن منطقة القيمة ${zoneTxt}${ext > 2.4 ? ` وهو ممدد ${ext.toFixed(1)}×ATR عن EMA21` : ''} — الدخول الآن يجعل الوقف ${(nowRisk / atr).toFixed(2)}×ATR ويخفض TP1 إلى ${rNow.toFixed(2)}R مقابل ${tps[0].r.toFixed(2)}R من السعر المعلّق`,
    });
    checks.push({
      ok: true,
      label: 'أمر معلّق عند التقاء عوامل',
      detail: `Limit عند ${f2(entry)} داخل ${zoneTxt}: ${best.labels.slice(0, 4).join(' + ')}`,
    });
    checks.push({
      ok: true,
      label: 'وقف هيكلي',
      detail: `الوقف ${f2(stop)} خلف ${refLabel} — ${(risk / atr).toFixed(2)}×ATR`,
    });
    checks.push({
      ok: true,
      label: 'شروط الإلغاء',
      detail: `يُلغى إذا أُغلقت شمعة ${T.tf} ${long ? 'تحت' : 'فوق'} ${f2(stop)} قبل التنفيذ، أو بعد 8 شموع بدون تنفيذ`,
    });
  }

  const warnings = [...A.warns];
  if (feeR > 0.25) warnings.push(`الرسوم+الانزلاق تساوي ${feeR.toFixed(2)}R — وقف ضيق نسبياً`);
  if (type === 'MARKET' && !confirmed) warnings.push('بدون تأكيد شمعة — الحجم المقترح أقل');

  const size = sizePosition({
    entry,
    stop,
    equity: cfg.equity,
    riskPct: cfg.riskPct * (type === 'MARKET' && !confirmed ? 0.5 : 1),
    maxLev: cfg.maxLev,
    mmr: cfg.mmr,
    takerFee: cfg.takerFee,
    minSafetyPct: cfg.minLiqSafetyPct ?? 25,
    step: ctx.meta.step,
    minQty: ctx.meta.minQty,
    minNotional: ctx.meta.minNotional,
    long,
  });

  if (size.safetyOk) {
    checks.push({
      ok: true,
      label: 'حماية التصفية',
      detail: `سعر التصفية ${f2(size.liq)} يسبق الوقف بمسافة أمان ${size.safetyBufferPct.toFixed(1)}% (رافعة ${size.lev}x · MMR ${(size.mmr * 100).toFixed(2)}%)`,
    });
  } else {
    warnings.push(size.note);
  }

  if (A.orderFlow) {
    const okFlow =
      A.orderFlow.liquidity.liquidityPass && A.orderFlow.verdict !== 'COUNTER_FLOW';
    checks.push({
      ok: A.orderFlow.verdict === 'NEUTRAL' && A.orderFlow.liquidity.liquidityPass ? null : okFlow,
      label: 'رادار السيولة وتدفق الأوامر',
      detail: A.orderFlow.verdictLabel,
    });
  }

  return {
    ok: true,
    dir,
    long,
    type,
    entry,
    price,
    fillDist,
    zone: { lo: best.lo, hi: best.hi, labels: best.labels, kinds: best.kinds, n: best.nK },
    stop,
    stopRef: refLabel,
    risk,
    riskATR: risk / atr,
    riskPct: (100 * risk) / entry,
    tps,
    rr1: tps[0].r,
    rr2: tps[1].r,
    rr3: tps[2].r,
    feeR,
    checks,
    warnings,
    confirmed,
    confirmBits,
    ext,
    expireBars: type === 'LIMIT' ? (cfg.limitExpireBars ?? 8) : 12,
    size,
    barrier: null,
  };
}

export function evaluate(
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
  if (ctx.cfg.mode === 'early') {
    return evaluateEarlyEntry(ctx, i, opt);
  }
  const A = analyzeAt(ctx, i, opt);
  if (!A) return null;
  const cfg = ctx.cfg;
  let plan: TradePlan | null = null;
  let tier: SignalEvaluation['tier'] = 'NONE';
  let score = A.score;

  if (A.dir && score >= cfg.watchScore) {
    plan = buildPlan(ctx, A);
    if (plan.ok && plan.type === 'MARKET' && !plan.confirmed) {
      score = Math.max(cfg.watchScore - 1, score - 4);
    }
    if (plan.ok) {
      if (score >= cfg.strongScore && A.aligned >= 5) tier = 'STRONG';
      else if (score >= cfg.minScore && A.aligned >= 4) tier = 'GOOD';
      else if (score >= cfg.watchScore) tier = 'WATCH';
    } else if (score >= cfg.watchScore) {
      tier = 'WATCH';
    }
  }
  const grade = score >= 85 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 62 ? 'C' : '—';
  const extAtr = plan?.ext ?? 0;
  const distanceMovedPct = A.price > 0 ? Math.max(0, Math.abs(extAtr) * A.atr / A.price * 100) : 0;
  return {
    ...A,
    score,
    tier,
    grade,
    plan,
    strategyMode: cfg.mode,
    earlyEntry: {
      entryKind: 'CONFIRMED_ENTRY',
      entryStatus: plan?.ok ? (plan.type === 'LIMIT' ? 'WAIT_RETEST' : 'CONFIRMED') : 'CANCELLED',
      distanceMovedPct: +distanceMovedPct.toFixed(3),
      remainingRR1: +(plan?.rr1 ?? 0).toFixed(2),
      stillValid: Boolean(plan?.ok),
      fomoChasing: extAtr > (cfg.cancelChasedAtr ?? 2.4),
      earlyReason: plan?.ok ? `${plan.type === 'LIMIT' ? 'انتظار ارتداد لمناطق القيمة' : 'دخول مؤكد متعدد الأطر'}` : (plan?.why || 'غير مكتمل'),
      confirmFactors: plan?.confirmBits || [],
      missingConfirmations: A.gates || [],
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

export function headline(R: SignalEvaluation | null, sym?: string): string {
  if (!R || !R.dir) return 'لا اتجاه واضح';
  const side = R.dir > 0 ? 'شراء (LONG)' : 'بيع (SHORT)';
  const tag = R.earlyEntry?.entryKind === 'EARLY_ENTRY' ? '⚡ مبكر ' : '';
  const top = R.parts
    .filter((p) => Math.sign(p.raw) === R.dir)
    .sort((a, b) => Math.abs(b.raw * b.wEff) - Math.abs(a.raw * a.wEff))
    .slice(0, 2)
    .map((p) => p.label)
    .join(' + ');
  return `${tag}${side} ${sym || ''} — ${R.score}/100 · ${R.aligned} عوامل متوافقة${top ? ' (الأقوى: ' + top + ')' : ''}`;
}
