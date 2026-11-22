/* ============================================================
   CIPHER X PRO — ENGINE B : هيكل السوق + SMC + السيولة + المستويات
   ============================================================ */
import { clamp, ind, isN, mk } from './indicators';
import type { IndicatorBundle } from './types';

export const smc = {
  structure(S: IndicatorBundle) {
    const n = S.n;
    const k = S.k;
    const c = S.c;
    const H = S.piv.highs;
    const L = S.piv.lows;
    const events: { j: number; dir: number; kind: 'BOS' | 'CHoCH'; level: number; pi: number }[] = [];
    const trend = new Int8Array(n);
    const shP = mk(n);
    const slP = mk(n);
    const shI = new Int32Array(n).fill(-1);
    const slI = new Int32Array(n).fill(-1);
    let pi = 0;
    let pj = 0;
    let hi: { p: number; i: number; x: boolean } | null = null;
    let lo: { p: number; i: number; x: boolean } | null = null;
    let tr = 0;
    let lastH = NaN;
    let lastHI = -1;
    let lastL = NaN;
    let lastLI = -1;

    for (let j = 0; j < n; j++) {
      while (pi < H.length && H[pi].i + k <= j) {
        hi = { p: H[pi].p, i: H[pi].i, x: false };
        lastH = hi.p;
        lastHI = hi.i;
        pi++;
      }
      while (pj < L.length && L[pj].i + k <= j) {
        lo = { p: L[pj].p, i: L[pj].i, x: false };
        lastL = lo.p;
        lastLI = lo.i;
        pj++;
      }
      if (hi && !hi.x && c[j] > hi.p) {
        events.push({ j, dir: 1, kind: tr === -1 ? 'CHoCH' : 'BOS', level: hi.p, pi: hi.i });
        hi.x = true;
        tr = 1;
      } else if (lo && !lo.x && c[j] < lo.p) {
        events.push({ j, dir: -1, kind: tr === 1 ? 'CHoCH' : 'BOS', level: lo.p, pi: lo.i });
        lo.x = true;
        tr = -1;
      }
      trend[j] = tr;
      shP[j] = lastH;
      shI[j] = lastHI;
      slP[j] = lastL;
      slI[j] = lastLI;
    }
    return (S.struct = { events, trend, shP, shI, slP, slI });
  },

  buildZones(S: IndicatorBundle) {
    const n = S.n;
    const { o, h, l, c, atr } = S;
    const st = S.struct || smc.structure(S);
    const obs: any[] = [];
    const fvgs: any[] = [];
    const breakers: any[] = [];

    for (const e of st.events) {
      const j = e.j;
      const a = atr[j];
      if (!isN(a)) continue;
      if (e.dir === 1) {
        const pl = st.slI[j];
        if (pl < 0 || j - pl > 90) continue;
        let ob = pl;
        for (let b = pl; b < j; b++) if (l[b] < l[ob]) ob = b;
        let cand = -1;
        for (let b = ob; b >= Math.max(0, ob - 3); b--) {
          if (c[b] < o[b]) {
            cand = b;
            break;
          }
        }
        if (cand < 0) cand = ob;
        const top = h[cand];
        const bot = l[cand];
        let mv = -Infinity;
        for (let b = cand; b <= j; b++) if (h[b] > mv) mv = h[b];
        if (mv - bot < 1.5 * a) continue;
        let end = Infinity;
        let inZ = false;
        const tb: number[] = [];
        for (let b = j + 1; b < n; b++) {
          if (c[b] < bot) {
            end = b;
            break;
          }
          const t = l[b] <= top;
          if (t && !inZ) tb.push(b);
          inZ = t;
        }
        obs.push({ dir: 1, kind: 'OB', top, bot, mid: (top + bot) / 2, idx: cand, form: j, end, tb, bos: e.kind });

        // Broken Bullish OB flips into Bearish Breaker Block
        if (end < Infinity && end < n - 1) {
          let brkEnd = Infinity;
          let inBrk = false;
          const brkTb: number[] = [];
          for (let b = end + 1; b < n; b++) {
            if (c[b] > top) {
              brkEnd = b;
              break;
            }
            const t = h[b] >= bot;
            if (t && !inBrk) brkTb.push(b);
            inBrk = t;
          }
          breakers.push({
            dir: -1,
            kind: 'BRK',
            top,
            bot,
            mid: (top + bot) / 2,
            idx: cand,
            origForm: j,
            form: end,
            end: brkEnd,
            tb: brkTb,
            tf: S.tf,
          });
        }
      } else {
        const ph = st.shI[j];
        if (ph < 0 || j - ph > 90) continue;
        let ob = ph;
        for (let b = ph; b < j; b++) if (h[b] > h[ob]) ob = b;
        let cand = -1;
        for (let b = ob; b >= Math.max(0, ob - 3); b--) {
          if (c[b] > o[b]) {
            cand = b;
            break;
          }
        }
        if (cand < 0) cand = ob;
        const top = h[cand];
        const bot = l[cand];
        let mv = Infinity;
        for (let b = cand; b <= j; b++) if (l[b] < mv) mv = l[b];
        if (top - mv < 1.5 * a) continue;
        let end = Infinity;
        let inZ = false;
        const tb: number[] = [];
        for (let b = j + 1; b < n; b++) {
          if (c[b] > top) {
            end = b;
            break;
          }
          const t = h[b] >= bot;
          if (t && !inZ) tb.push(b);
          inZ = t;
        }
        obs.push({ dir: -1, kind: 'OB', top, bot, mid: (top + bot) / 2, idx: cand, form: j, end, tb, bos: e.kind });

        // Broken Bearish OB flips into Bullish Breaker Block
        if (end < Infinity && end < n - 1) {
          let brkEnd = Infinity;
          let inBrk = false;
          const brkTb: number[] = [];
          for (let b = end + 1; b < n; b++) {
            if (c[b] < bot) {
              brkEnd = b;
              break;
            }
            const t = l[b] <= top;
            if (t && !inBrk) brkTb.push(b);
            inBrk = t;
          }
          breakers.push({
            dir: 1,
            kind: 'BRK',
            top,
            bot,
            mid: (top + bot) / 2,
            idx: cand,
            origForm: j,
            form: end,
            end: brkEnd,
            tb: brkTb,
            tf: S.tf,
          });
        }
      }
    }

    for (let i = 2; i < n; i++) {
      const a = atr[i];
      if (!isN(a)) continue;
      if (l[i] > h[i - 2] && l[i] - h[i - 2] >= 0.12 * a) {
        const bot = h[i - 2];
        const top = l[i];
        let end = Infinity;
        for (let b = i + 1; b < n; b++) {
          if (c[b] < bot) {
            end = b;
            break;
          }
        }
        fvgs.push({ dir: 1, kind: 'FVG', top, bot, mid: (top + bot) / 2, idx: i - 1, form: i, end });
      } else if (h[i] < l[i - 2] && l[i - 2] - h[i] >= 0.12 * a) {
        const top = l[i - 2];
        const bot = h[i];
        let end = Infinity;
        for (let b = i + 1; b < n; b++) {
          if (c[b] > top) {
            end = b;
            break;
          }
        }
        fvgs.push({ dir: -1, kind: 'FVG', top, bot, mid: (top + bot) / 2, idx: i - 1, form: i, end });
      }
    }
    return (S.zones = { obs, fvgs, breakers });
  },

  zonesAt(S: IndicatorBundle, i: number) {
    const Z = S.zones || smc.buildZones(S);
    const ob: any[] = [];
    const fvg: any[] = [];
    const brk: any[] = [];
    for (let m = Z.obs.length - 1; m >= 0; m--) {
      const z = Z.obs[m];
      if (z.form > i) continue;
      if (i - z.form > 250) break;
      if (z.end > i) {
        let t = 0;
        for (const b of z.tb) if (b <= i) t++;
        ob.push({ ...z, touches: t, age: i - z.form });
      }
    }
    for (let m = Z.fvgs.length - 1; m >= 0; m--) {
      const z = Z.fvgs[m];
      if (z.form > i) continue;
      if (i - z.form > 120) break;
      if (z.end <= i) continue;
      let fill = 0;
      if (z.dir === 1) {
        let mn = Infinity;
        for (let b = z.form + 1; b <= i; b++) if (S.l[b] < mn) mn = S.l[b];
        fill = mn >= z.top ? 0 : clamp((z.top - mn) / (z.top - z.bot), 0, 1);
      } else {
        let mx = -Infinity;
        for (let b = z.form + 1; b <= i; b++) if (S.h[b] > mx) mx = S.h[b];
        fill = mx <= z.bot ? 0 : clamp((mx - z.bot) / (z.top - z.bot), 0, 1);
      }
      if (fill < 0.9) fvg.push({ ...z, fill, age: i - z.form });
    }
    for (let m = (Z.breakers || []).length - 1; m >= 0; m--) {
      const z = Z.breakers[m];
      if (z.form > i) continue;
      if (i - z.form > 180) continue;
      if (z.end > i) {
        let t = 0;
        for (const b of z.tb) if (b <= i) t++;
        if (t <= 2) brk.push({ ...z, touches: t, age: i - z.form });
      }
    }
    return { ob, fvg, brk };
  },

  pools(S: IndicatorBundle, i: number) {
    const a = S.atr[i];
    const tol = Math.max(0.15 * a, S.c[i] * 0.0004);
    const out: any[] = [];
    for (const side of ['high', 'low'] as const) {
      const arr = (side === 'high' ? S.piv.highs : S.piv.lows).filter(
        (p) => p.i + S.k <= i && i - p.i <= 150
      );
      const used = new Array(arr.length).fill(false);
      for (let x = 0; x < arr.length; x++) {
        if (used[x]) continue;
        const grp = [arr[x]];
        used[x] = true;
        for (let y = x + 1; y < arr.length; y++) {
          if (!used[y] && Math.abs(arr[y].p - arr[x].p) <= tol) {
            grp.push(arr[y]);
            used[y] = true;
          }
        }
        if (grp.length < 2) continue;
        const level = side === 'high' ? Math.max(...grp.map((g) => g.p)) : Math.min(...grp.map((g) => g.p));
        const last = Math.max(...grp.map((g) => g.i));
        let swept = -1;
        for (let b = last + 1; b <= i; b++) {
          if (side === 'high' ? S.h[b] > level : S.l[b] < level) {
            swept = b;
            break;
          }
        }
        out.push({ side, level, n: grp.length, last, swept });
      }
    }
    return out;
  },

  sweeps(S: IndicatorBundle, i: number, lookback = 3) {
    const { h, l, c, o, k } = S;
    const H = S.piv.highs;
    const L = S.piv.lows;
    const out: any[] = [];
    const scan = (arr: { i: number; p: number }[], isHigh: boolean, b: number) => {
      for (let m = arr.length - 1; m >= 0; m--) {
        const p = arr[m];
        if (p.i + k > b - 1) continue;
        if (b - p.i > 120) break;
        let clean = true;
        for (let x = p.i + 1; x < b; x++) {
          if (isHigh ? h[x] > p.p : l[x] < p.p) {
            clean = false;
            break;
          }
        }
        if (!clean) continue;
        const pierce = isHigh ? h[b] > p.p && c[b] < p.p : l[b] < p.p && c[b] > p.p;
        if (pierce) {
          const rng = h[b] - l[b] || 1;
          return {
            dir: isHigh ? -1 : 1,
            side: isHigh ? 'buy' : 'sell',
            level: p.p,
            bar: b,
            ago: i - b,
            depth: isHigh ? h[b] - p.p : p.p - l[b],
            wick: isHigh
              ? (h[b] - Math.max(o[b], c[b])) / rng
              : (Math.min(o[b], c[b]) - l[b]) / rng,
          };
        }
      }
      return null;
    };
    for (let b = i; b > i - lookback && b > 6; b--) {
      const a = scan(H, true, b);
      const d = scan(L, false, b);
      if (a) out.push(a);
      if (d) out.push(d);
    }
    return out.sort((x, y) => x.ago - y.ago);
  },

  levels(S: IndicatorBundle, i: number, tfWeight = 1) {
    const a = S.atr[i];
    const tol = Math.max(0.35 * a, S.c[i] * 0.0015);
    const W = tfWeight || 1;
    const pts: { p: number; i: number; w: number }[] = [];
    for (const arr of [S.piv.highs, S.piv.lows]) {
      for (const p of arr) {
        if (p.i + S.k > i || i - p.i > 400) continue;
        pts.push({ p: p.p, i: p.i, w: 0.5 + 0.5 * Math.exp(-(i - p.i) / 150) });
      }
    }
    pts.sort((x, y) => x.p - y.p);
    const cl: { sw: number; sp: number; n: number; last: number; mean: number }[] = [];
    let cur: { sw: number; sp: number; n: number; last: number; mean: number } | null = null;
    for (const q of pts) {
      if (cur && Math.abs(q.p - cur.mean) <= tol) {
        cur.sw += q.w;
        cur.sp += q.p * q.w;
        cur.n++;
        cur.last = Math.max(cur.last, q.i);
        cur.mean = cur.sp / cur.sw;
      } else {
        cur = { sw: q.w, sp: q.p * q.w, n: 1, last: q.i, mean: q.p };
        cl.push(cur);
      }
    }
    return cl
      .filter((x) => x.n >= 2 || i - x.last <= 60)
      .map((x) => ({
        p: x.mean,
        n: x.n,
        strength: x.sw * W,
        fresh: i - x.last <= 60,
        last: x.last,
        tf: S.tf,
        kind: 'swing',
      }));
  },

  refLevels(D: IndicatorBundle | null, j: number) {
    if (!D || j < 7) return [];
    let h7 = -Infinity;
    let l7 = Infinity;
    for (let b = j - 6; b <= j; b++) {
      if (D.h[b] > h7) h7 = D.h[b];
      if (D.l[b] < l7) l7 = D.l[b];
    }
    return [
      { p: D.h[j], kind: 'PDH', n: 3, strength: 3 },
      { p: D.l[j], kind: 'PDL', n: 3, strength: 3 },
      { p: h7, kind: 'W-H', n: 3, strength: 3.5 },
      { p: l7, kind: 'W-L', n: 3, strength: 3.5 },
    ];
  },

  mergeLevels(lists: any[][], tol: number) {
    const all = ([] as any[])
      .concat(...lists)
      .filter((x) => isN(x.p))
      .sort((a, b) => a.p - b.p);
    const out: any[] = [];
    for (const x of all) {
      const last = out[out.length - 1];
      if (last && Math.abs(x.p - last.p) <= tol) {
        const w = last.strength + x.strength;
        last.p = (last.p * last.strength + x.p * x.strength) / w;
        last.strength = w;
        last.n += x.n;
        if (x.kind !== 'swing' && last.kind === 'swing') last.kind = x.kind;
        if (!last.tfs) last.tfs = [last.tf];
        if (x.tf && !last.tfs.includes(x.tf)) last.tfs.push(x.tf);
      } else {
        out.push({ ...x, tfs: x.tf ? [x.tf] : [] });
      }
    }
    return out;
  },

  volumeProfile(S: IndicatorBundle, i: number, len = 200, bins = 48) {
    const st = Math.max(0, i - len + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = st; b <= i; b++) {
      if (S.l[b] < lo) lo = S.l[b];
      if (S.h[b] > hi) hi = S.h[b];
    }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins;
    const vol = new Float64Array(bins);
    for (let b = st; b <= i; b++) {
      const a = Math.min(bins - 1, Math.floor((S.l[b] - lo) / step));
      const z = Math.min(bins - 1, Math.floor((S.h[b] - lo) / step));
      const cnt = z - a + 1;
      for (let x = a; x <= z; x++) vol[x] += S.v[b] / cnt;
    }
    let poc = 0;
    let tot = 0;
    for (let x = 0; x < bins; x++) {
      tot += vol[x];
      if (vol[x] > vol[poc]) poc = x;
    }
    let lw = poc;
    let up = poc;
    let acc = vol[poc];
    while (acc < 0.7 * tot && (lw > 0 || up < bins - 1)) {
      const dn = lw > 0 ? vol[lw - 1] : -1;
      const upv = up < bins - 1 ? vol[up + 1] : -1;
      if (upv >= dn) {
        up++;
        acc += vol[up];
      } else {
        lw--;
        acc += vol[lw];
      }
    }
    const mean = tot / bins;
    const hvn: number[] = [];
    for (let x = 1; x < bins - 1; x++) {
      if (vol[x] > vol[x - 1] && vol[x] >= vol[x + 1] && vol[x] >= 1.3 * mean) {
        hvn.push(lo + (x + 0.5) * step);
      }
    }
    return { poc: lo + (poc + 0.5) * step, vah: lo + (up + 1) * step, val: lo + lw * step, hvn, lo, hi };
  },

  range(S: IndicatorBundle, i: number) {
    const st = S.struct;
    const hP = st.shP[i];
    const lP = st.slP[i];
    const hI = st.shI[i];
    const lI = st.slI[i];
    if (!isN(hP) || !isN(lP) || hI < 0 || lI < 0 || hP <= lP) return null;
    const R = hP - lP;
    const c = S.c[i];
    const leg = hI > lI ? 1 : -1;
    const fib = (r: number) => (leg === 1 ? hP - r * R : lP + r * R);
    return {
      hi: hP,
      lo: lP,
      hiIdx: hI,
      loIdx: lI,
      leg,
      R,
      eq: (hP + lP) / 2,
      pos: (c - lP) / R,
      ote: [Math.min(fib(0.62), fib(0.79)), Math.max(fib(0.62), fib(0.79))],
      fib618: fib(0.618),
      fib5: fib(0.5),
      fib382: fib(0.382),
    };
  },

  patterns(S: IndicatorBundle, i: number) {
    const { o, h, l, c, atr } = S;
    const out: { id: string; dir: number; w: number; ar: string }[] = [];
    const a = atr[i];
    if (i < 4 || !isN(a)) return out;
    const R = (b: number) => h[b] - l[b] || 1e-12;
    const B = (b: number) => Math.abs(c[b] - o[b]);
    const up = (b: number) => h[b] - Math.max(o[b], c[b]);
    const lw = (b: number) => Math.min(o[b], c[b]) - l[b];
    const r = R(i);
    const body = B(i);
    const bull = c[i] > o[i];
    const bear = c[i] < o[i];
    const down5 = c[i - 4] > c[i - 1];
    const up5 = c[i - 4] < c[i - 1];

    if (lw(i) >= 2 * body && up(i) <= 0.3 * r && body <= 0.4 * r && r > 0.6 * a) {
      out.push({ id: 'hammer', dir: 1, w: down5 ? 0.8 : 0.5, ar: 'مطرقة (رفض هبوط)' });
    }
    if (up(i) >= 2 * body && lw(i) <= 0.3 * r && body <= 0.4 * r && r > 0.6 * a) {
      out.push({ id: 'star', dir: -1, w: up5 ? 0.8 : 0.5, ar: 'شهاب (رفض صعود)' });
    }
    if (bull && c[i - 1] < o[i - 1] && o[i] <= c[i - 1] && c[i] >= o[i - 1] && body > B(i - 1)) {
      out.push({ id: 'bullEng', dir: 1, w: 0.85, ar: 'ابتلاع صاعد' });
    }
    if (bear && c[i - 1] > o[i - 1] && o[i] >= c[i - 1] && c[i] <= o[i - 1] && body > B(i - 1)) {
      out.push({ id: 'bearEng', dir: -1, w: 0.85, ar: 'ابتلاع هابط' });
    }
    if (
      c[i - 2] < o[i - 2] &&
      B(i - 2) > 0.6 * a &&
      B(i - 1) < 0.35 * B(i - 2) &&
      bull &&
      c[i] > (o[i - 2] + c[i - 2]) / 2
    ) {
      out.push({ id: 'morning', dir: 1, w: 0.9, ar: 'نجمة الصباح' });
    }
    if (
      c[i - 2] > o[i - 2] &&
      B(i - 2) > 0.6 * a &&
      B(i - 1) < 0.35 * B(i - 2) &&
      bear &&
      c[i] < (o[i - 2] + c[i - 2]) / 2
    ) {
      out.push({ id: 'evening', dir: -1, w: 0.9, ar: 'نجمة المساء' });
    }
    if (body >= 0.75 * r && r >= 1.5 * a) {
      out.push({
        id: bull ? 'dispUp' : 'dispDn',
        dir: bull ? 1 : -1,
        w: 0.7,
        ar: bull ? 'شمعة اندفاع صاعدة' : 'شمعة اندفاع هابطة',
      });
    }
    if (body <= 0.1 * r && r > 0.5 * a) {
      out.push({ id: 'doji', dir: 0, w: 0.3, ar: 'دوجي (تردد)' });
    }
    return out;
  },

  divergence(S: IndicatorBundle, i: number) {
    const res: any[] = [];
    const k = S.k;
    const lowsP = S.piv.lows.filter((p) => p.i + k <= i && i - p.i <= 70);
    const highsP = S.piv.highs.filter((p) => p.i + k <= i && i - p.i <= 70);
    const chk = (
      arr: { i: number; p: number }[],
      src: Float64Array,
      name: string,
      bull: boolean
    ) => {
      if (arr.length < 2) return;
      const b = arr[arr.length - 1];
      const a = arr[arr.length - 2];
      if (b.i - a.i < 5 || !isN(src[a.i]) || !isN(src[b.i])) return;
      const thr = name === 'RSI' ? 2 : Math.abs(src[a.i]) * 0.02 + 1e-9;
      if (bull && b.p < a.p && src[b.i] > src[a.i] + thr) {
        res.push({ type: 'bull', src: name, a, b, ago: i - b.i, ar: 'دايفرجنس صاعد على ' + name });
      }
      if (!bull && b.p > a.p && src[b.i] < src[a.i] - thr) {
        res.push({ type: 'bear', src: name, a, b, ago: i - b.i, ar: 'دايفرجنس هابط على ' + name });
      }
    };
    chk(lowsP, S.rsi, 'RSI', true);
    chk(highsP, S.rsi, 'RSI', false);
    chk(lowsP, S.cvd, 'CVD', true);
    chk(highsP, S.cvd, 'CVD', false);
    return res;
  },

  regime(S: IndicatorBundle, i: number) {
    const adx = S.adx[i];
    const bwR = ind.percentRank(S.bbW, i, 120);
    const atrR = ind.percentRank(S.atrp, i, 120);
    let type = 'range';
    if (adx >= 23) type = 'trend';
    else if (adx < 17) type = 'range';
    else type = 'mixed';

    const ttmSqueeze =
      isN(S.bbUp[i]) &&
      isN(S.kcUp[i]) &&
      isN(S.bbLo[i]) &&
      isN(S.kcLo[i]) &&
      S.bbUp[i] < S.kcUp[i] &&
      S.bbLo[i] > S.kcLo[i];

    const prevTtm =
      i > 0 &&
      isN(S.bbUp[i - 1]) &&
      isN(S.kcUp[i - 1]) &&
      isN(S.bbLo[i - 1]) &&
      isN(S.kcLo[i - 1]) &&
      S.bbUp[i - 1] < S.kcUp[i - 1] &&
      S.bbLo[i - 1] > S.kcLo[i - 1];

    const squeezeFired =
      prevTtm &&
      !ttmSqueeze &&
      isN(S.macdH[i]) &&
      isN(S.macdH[i - 1]) &&
      Math.abs(S.macdH[i]) > Math.abs(S.macdH[i - 1]);

    const squeeze = bwR <= 0.15 || ttmSqueeze;
    const expansion = atrR >= 0.9 || squeezeFired;
    return { type, adx, bwPct: bwR, atrPct: atrR, squeeze, ttmSqueeze, squeezeFired, expansion };
  },

  sessionContext(tMs: number): string {
    const h = new Date(tMs).getUTCHours();
    if (h >= 12 && h < 16) return 'تداخل لندن-نيويورك';
    if (h >= 7 && h < 12) return 'جلسة لندن';
    if (h >= 16 && h < 21) return 'جلسة نيويورك';
    if (h >= 21) return 'إغلاق يومي';
    return 'جلسة آسيا';
  },
};
