/* ============================================================
   CIPHER X PRO — ENGINE A : المؤشرات الفنية المتقدمة (Indicators v2)
   دوال نقية بدون DOM — تعمل في المتصفح وفي Node
   ============================================================ */
import type { Candle, IndicatorBundle } from './types';

export const TF_MS: Record<string, number> = {
  '1m': 60e3,
  '3m': 180e3,
  '5m': 300e3,
  '15m': 900e3,
  '30m': 1800e3,
  '1h': 3600e3,
  '2h': 7200e3,
  '4h': 14400e3,
  '6h': 21600e3,
  '8h': 28800e3,
  '12h': 43200e3,
  '1d': 86400e3,
  '1w': 604800e3,
};

export const isN = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export const mk = (n: number): Float64Array => {
  const a = new Float64Array(n);
  a.fill(NaN);
  return a;
};

export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

export const util = {
  isN,
  mk,
  clamp,
  fmtP(p: number, tick?: number): string {
    if (!isN(p)) return '—';
    let d = 2;
    if (tick && tick > 0) {
      d = Math.max(0, Math.min(10, Math.round(-Math.log10(tick))));
    } else {
      d = p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : p >= 0.1 ? 5 : 6;
    }
    return p.toFixed(d);
  },
  roundTick(p: number, tick: number, mode: 'down' | 'up' | 'near'): number {
    if (!(tick > 0)) return p;
    const q = p / tick;
    const r =
      mode === 'down'
        ? Math.floor(q + 1e-9)
        : mode === 'up'
          ? Math.ceil(q - 1e-9)
          : Math.round(q);
    const d = Math.max(0, Math.min(10, Math.round(-Math.log10(tick))));
    return +(r * tick).toFixed(d);
  },
};

const smooth = (s: ArrayLike<number>, n: number, alpha: number): Float64Array => {
  const o = mk(s.length);
  let first = -1;
  for (let i = 0; i < s.length; i++) {
    if (isN(s[i])) {
      first = i;
      break;
    }
  }
  if (first < 0 || first + n > s.length) return o;
  let sum = 0;
  for (let i = first; i < first + n; i++) sum += s[i];
  let prev = sum / n;
  o[first + n - 1] = prev;
  for (let i = first + n; i < s.length; i++) {
    if (!isN(s[i])) {
      o[i] = prev;
      continue;
    }
    prev = prev + alpha * (s[i] - prev);
    o[i] = prev;
  }
  return o;
};

export const ind = {
  sma(s: ArrayLike<number>, n: number): Float64Array {
    const o = mk(s.length);
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < s.length; i++) {
      if (isN(s[i])) {
        sum += s[i];
        cnt++;
      }
      if (i >= n && isN(s[i - n])) {
        sum -= s[i - n];
        cnt--;
      }
      if (cnt === n) o[i] = sum / n;
    }
    return o;
  },

  ema(s: ArrayLike<number>, n: number): Float64Array {
    return smooth(s, n, 2 / (n + 1));
  },

  rma(s: ArrayLike<number>, n: number): Float64Array {
    return smooth(s, n, 1 / n);
  },

  rsi(c: ArrayLike<number>, n = 14): Float64Array {
    const o = mk(c.length);
    if (c.length <= n) return o;
    let g = 0;
    let l = 0;
    for (let i = 1; i <= n; i++) {
      const d = c[i] - c[i - 1];
      if (d > 0) g += d;
      else l -= d;
    }
    g /= n;
    l /= n;
    const val = () => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
    o[n] = val();
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
      l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
      o[i] = val();
    }
    return o;
  },

  macd(c: ArrayLike<number>, f = 12, s = 26, sg = 9) {
    const ef = ind.ema(c, f);
    const es = ind.ema(c, s);
    const m = mk(c.length);
    for (let i = 0; i < c.length; i++) if (isN(ef[i]) && isN(es[i])) m[i] = ef[i] - es[i];
    const sig = ind.ema(m, sg);
    const h = mk(c.length);
    for (let i = 0; i < c.length; i++) if (isN(m[i]) && isN(sig[i])) h[i] = m[i] - sig[i];
    return { macd: m, signal: sig, hist: h };
  },

  tr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>): Float64Array {
    const o = mk(h.length);
    for (let i = 0; i < h.length; i++) {
      o[i] =
        i === 0
          ? h[i] - l[i]
          : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    return o;
  },

  atr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 14): Float64Array {
    return ind.rma(ind.tr(h, l, c), n);
  },

  adx(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 14) {
    const N = h.length;
    const pdi = mk(N);
    const mdi = mk(N);
    const adx = mk(N);
    if (N <= 2 * n + 1) return { adx, pdi, mdi };
    let trS = 0;
    let pS = 0;
    let mS = 0;
    const parts = (i: number): [number, number, number] => {
      const up = h[i] - h[i - 1];
      const dn = l[i - 1] - l[i];
      return [
        Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])),
        up > dn && up > 0 ? up : 0,
        dn > up && dn > 0 ? dn : 0,
      ];
    };
    for (let i = 1; i <= n; i++) {
      const [t, p, m] = parts(i);
      trS += t;
      pS += p;
      mS += m;
    }
    const dx = mk(N);
    const calc = (i: number) => {
      pdi[i] = trS > 0 ? (100 * pS) / trS : 0;
      mdi[i] = trS > 0 ? (100 * mS) / trS : 0;
      const s = pdi[i] + mdi[i];
      dx[i] = s === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / s;
    };
    calc(n);
    for (let i = n + 1; i < N; i++) {
      const [t, p, m] = parts(i);
      trS = trS - trS / n + t;
      pS = pS - pS / n + p;
      mS = mS - mS / n + m;
      calc(i);
    }
    let sum = 0;
    for (let i = n; i < 2 * n; i++) sum += dx[i];
    let a = sum / n;
    adx[2 * n - 1] = a;
    for (let i = 2 * n; i < N; i++) {
      a = (a * (n - 1) + dx[i]) / n;
      adx[i] = a;
    }
    return { adx, pdi, mdi };
  },

  bb(c: ArrayLike<number>, n = 20, k = 2) {
    const N = c.length;
    const mid = mk(N);
    const up = mk(N);
    const lo = mk(N);
    const bw = mk(N);
    const pb = mk(N);
    for (let i = n - 1; i < N; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += c[j];
      const m = s / n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) * (c[j] - m);
      const sd = Math.sqrt(v / n);
      mid[i] = m;
      up[i] = m + k * sd;
      lo[i] = m - k * sd;
      bw[i] = m ? (up[i] - lo[i]) / m : NaN;
      pb[i] = up[i] === lo[i] ? 0.5 : (c[i] - lo[i]) / (up[i] - lo[i]);
    }
    return { mid, up, lo, bw, pb };
  },

  keltner(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 20, mult = 1.5) {
    const N = c.length;
    const mid = ind.ema(c, n);
    const atr = ind.atr(h, l, c, n);
    const up = mk(N);
    const lo = mk(N);
    for (let i = 0; i < N; i++) {
      if (isN(mid[i]) && isN(atr[i])) {
        up[i] = mid[i] + mult * atr[i];
        lo[i] = mid[i] - mult * atr[i];
      }
    }
    return { mid, up, lo };
  },

  zScore(c: ArrayLike<number>, n = 20): Float64Array {
    const N = c.length;
    const out = mk(N);
    for (let i = n - 1; i < N; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += c[j];
      const m = s / n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) * (c[j] - m);
      const sd = Math.sqrt(v / n);
      out[i] = sd > 0 ? (c[i] - m) / sd : 0;
    }
    return out;
  },

  obv(c: ArrayLike<number>, v: ArrayLike<number>): Float64Array {
    const N = c.length;
    const out = mk(N);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      if (i > 0) {
        if (c[i] > c[i - 1]) acc += v[i];
        else if (c[i] < c[i - 1]) acc -= v[i];
      }
      out[i] = acc;
    }
    return out;
  },

  stochRsi(c: ArrayLike<number>, rn = 14, sn = 14, kn = 3, dn = 3) {
    const N = c.length;
    const r = ind.rsi(c, rn);
    const raw = mk(N);
    for (let i = rn + sn - 1; i < N; i++) {
      let mn = Infinity;
      let mx = -Infinity;
      let ok = true;
      for (let j = i - sn + 1; j <= i; j++) {
        const v = r[j];
        if (!isN(v)) {
          ok = false;
          break;
        }
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (ok) raw[i] = mx === mn ? 50 : (100 * (r[i] - mn)) / (mx - mn);
    }
    const k = ind.sma(raw, kn);
    return { k, d: ind.sma(k, dn) };
  },

  supertrend(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, n = 10, m = 3) {
    const N = h.length;
    const atr = ind.atr(h, l, c, n);
    const line = mk(N);
    const dir = new Int8Array(N);
    let fu = NaN;
    let fl = NaN;
    let d = 1;
    for (let i = 0; i < N; i++) {
      if (!isN(atr[i])) continue;
      const hl2 = (h[i] + l[i]) / 2;
      const bu = hl2 + m * atr[i];
      const bl = hl2 - m * atr[i];
      if (!isN(fu)) {
        fu = bu;
        fl = bl;
        d = c[i] >= hl2 ? 1 : -1;
      } else {
        fu = bu < fu || c[i - 1] > fu ? bu : fu;
        fl = bl > fl || c[i - 1] < fl ? bl : fl;
        if (d === 1 && c[i] < fl) d = -1;
        else if (d === -1 && c[i] > fu) d = 1;
      }
      line[i] = d === 1 ? fl : fu;
      dir[i] = d;
    }
    return { line, dir };
  },

  vwapBands(
    t: ArrayLike<number>,
    h: ArrayLike<number>,
    l: ArrayLike<number>,
    c: ArrayLike<number>,
    v: ArrayLike<number>,
    mode: 'day' | 'week' | 'roll'
  ) {
    const N = c.length;
    const vwap = mk(N);
    const up1 = mk(N);
    const lo1 = mk(N);
    const up2 = mk(N);
    const lo2 = mk(N);

    if (mode === 'roll') {
      for (let i = 29; i < N; i++) {
        let pv = 0;
        let vv = 0;
        let p2v = 0;
        for (let j = i - 29; j <= i; j++) {
          const tp = (h[j] + l[j] + c[j]) / 3;
          pv += tp * v[j];
          p2v += tp * tp * v[j];
          vv += v[j];
        }
        if (vv > 0) {
          const m = pv / vv;
          const sd = Math.sqrt(Math.max(0, p2v / vv - m * m));
          vwap[i] = m;
          up1[i] = m + sd;
          lo1[i] = m - sd;
          up2[i] = m + 2 * sd;
          lo2[i] = m - 2 * sd;
        }
      }
      return { vwap, up1, lo1, up2, lo2 };
    }

    const anchor =
      mode === 'week'
        ? (x: number) => Math.floor((x - 4 * 86400e3) / (7 * 86400e3))
        : (x: number) => Math.floor(x / 86400e3);
    let pv = 0;
    let p2v = 0;
    let vv = 0;
    let cur: number | null = null;
    for (let i = 0; i < N; i++) {
      const a = anchor(t[i]);
      if (a !== cur) {
        cur = a;
        pv = 0;
        p2v = 0;
        vv = 0;
      }
      const tp = (h[i] + l[i] + c[i]) / 3;
      pv += tp * v[i];
      p2v += tp * tp * v[i];
      vv += v[i];
      if (vv > 0) {
        const m = pv / vv;
        const sd = Math.sqrt(Math.max(0, p2v / vv - m * m));
        vwap[i] = m;
        up1[i] = m + sd;
        lo1[i] = m - sd;
        up2[i] = m + 2 * sd;
        lo2[i] = m - 2 * sd;
      }
    }
    return { vwap, up1, lo1, up2, lo2 };
  },

  vwap(
    t: ArrayLike<number>,
    h: ArrayLike<number>,
    l: ArrayLike<number>,
    c: ArrayLike<number>,
    v: ArrayLike<number>,
    mode: 'day' | 'week' | 'roll'
  ): Float64Array {
    return ind.vwapBands(t, h, l, c, v, mode).vwap;
  },

  delta(v: ArrayLike<number>, tb: ArrayLike<number>): Float64Array {
    const o = mk(v.length);
    for (let i = 0; i < v.length; i++) o[i] = 2 * tb[i] - v[i];
    return o;
  },

  cumsum(s: ArrayLike<number>): Float64Array {
    const o = mk(s.length);
    let a = 0;
    for (let i = 0; i < s.length; i++) {
      a += s[i];
      o[i] = a;
    }
    return o;
  },

  rvol(v: ArrayLike<number>, n = 20): Float64Array {
    const o = mk(v.length);
    for (let i = n; i < v.length; i++) {
      let s = 0;
      for (let j = i - n; j < i; j++) s += v[j];
      const m = s / n;
      o[i] = m > 0 ? v[i] / m : NaN;
    }
    return o;
  },

  slope(s: ArrayLike<number>, end: number, len: number): number {
    const st = end - len + 1;
    if (st < 0) return NaN;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let j = 0; j < len; j++) {
      const y = s[st + j];
      if (!isN(y)) return NaN;
      sx += j;
      sy += y;
      sxy += j * y;
      sxx += j * j;
    }
    const d = len * sxx - sx * sx;
    return d === 0 ? 0 : (len * sxy - sx * sy) / d;
  },

  highest(s: ArrayLike<number>, end: number, len: number): number {
    let m = -Infinity;
    for (let j = Math.max(0, end - len + 1); j <= end; j++) if (s[j] > m) m = s[j];
    return m;
  },

  lowest(s: ArrayLike<number>, end: number, len: number): number {
    let m = Infinity;
    for (let j = Math.max(0, end - len + 1); j <= end; j++) if (s[j] < m) m = s[j];
    return m;
  },

  percentRank(s: ArrayLike<number>, i: number, len: number): number {
    let lo = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - len + 1); j <= i; j++) {
      if (!isN(s[j])) continue;
      cnt++;
      if (s[j] <= s[i]) lo++;
    }
    return cnt ? lo / cnt : NaN;
  },

  pivots(h: ArrayLike<number>, l: ArrayLike<number>, left: number, right: number) {
    const highs: { i: number; p: number }[] = [];
    const lows: { i: number; p: number }[] = [];
    for (let i = left; i < h.length - right; i++) {
      let ph = true;
      let pl = true;
      for (let j = 1; j <= left && (ph || pl); j++) {
        if (h[i - j] >= h[i]) ph = false;
        if (l[i - j] <= l[i]) pl = false;
      }
      for (let j = 1; j <= right && (ph || pl); j++) {
        if (h[i + j] > h[i]) ph = false;
        if (l[i + j] < l[i]) pl = false;
      }
      if (ph) highs.push({ i, p: h[i] });
      if (pl) lows.push({ i, p: l[i] });
    }
    return { highs, lows };
  },

  bundle(cs: Candle[], tf: string, opts?: { k?: number }): IndicatorBundle {
    opts = opts || {};
    const n = cs.length;
    const ms = TF_MS[tf] || 900e3;
    const k = opts.k || (ms >= 4 * 3600e3 ? 3 : 4);
    const t = new Float64Array(n);
    const o = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    const c = new Float64Array(n);
    const v = new Float64Array(n);
    const q = new Float64Array(n);
    const tb = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = cs[i];
      t[i] = x.t;
      o[i] = x.o;
      h[i] = x.h;
      l[i] = x.l;
      c[i] = x.c;
      v[i] = x.v;
      q[i] = x.q || 0;
      tb[i] = x.V != null ? x.V : x.v / 2;
    }
    const ema9 = ind.ema(c, 9);
    const ema21 = ind.ema(c, 21);
    const ema50 = ind.ema(c, 50);
    const ema200 = ind.ema(c, 200);
    const rsi = ind.rsi(c, 14);
    const m = ind.macd(c);
    const atr = ind.atr(h, l, c, 14);
    const atrp = mk(n);
    for (let i = 0; i < n; i++) if (isN(atr[i]) && c[i] > 0) atrp[i] = (100 * atr[i]) / c[i];
    const a = ind.adx(h, l, c, 14);
    const b = ind.bb(c, 20, 2);
    const kc = ind.keltner(h, l, c, 20, 1.5);
    const s = ind.stochRsi(c);
    const st = ind.supertrend(h, l, c, 10, 3);
    const vw = ind.vwapBands(
      t,
      h,
      l,
      c,
      v,
      ms <= 3600e3 ? 'day' : ms <= 4 * 3600e3 ? 'week' : 'roll'
    );
    const delta = ind.delta(v, tb);
    const cvd = ind.cumsum(delta);
    const obv = ind.obv(c, v);
    const rvol = ind.rvol(v, 20);
    const zScore = ind.zScore(c, 20);
    const piv = ind.pivots(h, l, k, k);

    return {
      tf,
      ms,
      n,
      k,
      t,
      o,
      h,
      l,
      c,
      v,
      q,
      tb,
      ema9,
      ema21,
      ema50,
      ema200,
      rsi,
      macd: m.macd,
      macdSig: m.signal,
      macdH: m.hist,
      atr,
      atrp,
      adx: a.adx,
      pdi: a.pdi,
      mdi: a.mdi,
      bbMid: b.mid,
      bbUp: b.up,
      bbLo: b.lo,
      bbW: b.bw,
      bbPb: b.pb,
      kcMid: kc.mid,
      kcUp: kc.up,
      kcLo: kc.lo,
      stK: s.k,
      stD: s.d,
      st: st.line,
      stDir: st.dir,
      vwap: vw.vwap,
      vwapUp1: vw.up1,
      vwapLo1: vw.lo1,
      vwapUp2: vw.up2,
      vwapLo2: vw.lo2,
      delta,
      cvd,
      obv,
      rvol,
      zScore,
      piv,
    };
  },
};
