'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { isN } from '@/lib/cx-engine/indicators';
import type { Candle, IndicatorBundle } from '@/lib/cx-engine/types';
import { fmtDt, fmtP, fmtUsd } from '@/lib/client/formatters';

export interface ChartOverlayData {
  key: string;
  candles: Candle[];
  S: IndicatorBundle | null;
  tick?: number;
  ms: number;
  zones: { top: number; bot: number; dir: number; kind: string; label?: string; t0?: number }[];
  levels: { p: number; label: string; kind: string }[];
  plan: {
    entry: number;
    stop: number;
    type?: string;
    tps: { p: number; r: number }[];
    liqPrice?: number;
  } | null;
}

export interface ChartOptions {
  ema: boolean;
  bb: boolean;
  vwap: boolean;
  vwapBands: boolean;
  zones: boolean;
  levels: boolean;
  plan: boolean;
  rsi: boolean;
  st: boolean;
}

const CHART_OPT_LABELS: [keyof ChartOptions, string][] = [
  ['ema', 'EMA 21/50/200'],
  ['bb', 'BB / TTM Squeeze'],
  ['vwap', 'VWAP'],
  ['vwapBands', 'VWAP ±1σ'],
  ['zones', 'OB / FVG / BRK'],
  ['levels', 'المستويات'],
  ['plan', 'خطة الصفقة'],
  ['rsi', 'RSI'],
  ['st', 'Supertrend'],
];

export default function CandlestickChart({ data }: { data: ChartOverlayData | null }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef<ChartOverlayData | null>(data);
  const viewRef = useRef<{ n: number; off: number }>({ n: 90, off: 0 });
  const lastKeyRef = useRef<string>('');
  const crossRef = useRef<{ x: number; y: number } | null>(null);
  const ptrsRef = useRef<Map<number, { x: number; y: number; x0: number }>>(new Map());
  const movedRef = useRef(false);
  const pinchRef = useRef(0);
  const dimRef = useRef({ w: 300, h: 420, dpr: 1 });

  const [opt, setOpt] = useState<ChartOptions>({
    ema: true,
    bb: false,
    vwap: true,
    vwapBands: false,
    zones: true,
    levels: true,
    plan: true,
    st: false,
    rsi: true,
  });
  const optRef = useRef(opt);
  const lastHoverTimeRef = useRef<number | null>(null);
  const [hoverCandle, setHoverCandle] = useState<Candle | null>(null);

  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    const d = dataRef.current;
    const { w: W, h: H, dpr } = dimRef.current;
    const o = optRef.current;

    const c = {
      up: '#00ff88',
      dn: '#ff2d55',
      tx: '#7a9bbf',
      grid: 'rgba(122,155,191,.09)',
      cy: '#00f5ff',
      gold: '#ffd700',
      pu: '#bf00ff',
      bl: '#0080ff',
      or: '#ff6b00',
    };

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = '10.5px "IBM Plex Mono", monospace';
    g.textBaseline = 'middle';

    if (!d || !d.candles || d.candles.length < 5) {
      g.fillStyle = c.tx;
      g.textAlign = 'center';
      g.fillText('جارٍ تحميل الشموع…', W / 2, H / 2);
      return;
    }

    // Align indicators by timestamp with candles
    const C = d.candles;
    const len = C.length;
    const al: Record<string, Float64Array> = {};
    if (d.S) {
      const S = d.S;
      const idxMap = new Map<number, number>();
      for (let i = 0; i < S.n; i++) idxMap.set(S.t[i], i);
      const alignArr = (arr: Float64Array) => {
        const out = new Float64Array(len).fill(NaN);
        for (let i = 0; i < len; i++) {
          const j = idxMap.get(C[i].t);
          if (j != null) out[i] = arr[j];
        }
        return out;
      };
      al.ema21 = alignArr(S.ema21);
      al.ema50 = alignArr(S.ema50);
      al.ema200 = alignArr(S.ema200);
      al.bbUp = alignArr(S.bbUp);
      al.bbLo = alignArr(S.bbLo);
      al.kcUp = alignArr(S.kcUp);
      al.kcLo = alignArr(S.kcLo);
      al.vwap = alignArr(S.vwap);
      al.vwapUp1 = alignArr(S.vwapUp1);
      al.vwapLo1 = alignArr(S.vwapLo1);
      al.rsi = alignArr(S.rsi);
      al.st = alignArr(S.st);
    }

    const R = 68;
    const B = 18;
    const hm = Math.round((H - B) * (o.rsi ? 0.64 : 0.82));
    const hv = Math.round((H - B) * 0.12);
    const geo = {
      L: 4,
      R: W - R,
      W,
      H,
      B,
      main: [0, hm] as [number, number],
      vol: [hm, hm + hv] as [number, number],
      rsi: [hm + hv, H - B] as [number, number],
    };

    const n = viewRef.current.n;
    const minOff = -Math.floor(n / 4);
    const maxOff = Math.max(0, len - Math.min(len, 20));
    viewRef.current.off = Math.max(minOff, Math.min(maxOff, viewRef.current.off));
    const end = len - viewRef.current.off;
    const start = end - n;
    const bw = (geo.R - geo.L) / n;
    const xOf = (i: number) => geo.L + (i - start + 0.5) * bw;
    const i0 = Math.max(0, Math.min(len - 1, Math.floor(start)));
    const i1 = Math.max(i0, Math.min(len - 1, Math.ceil(end) - 1));

    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 0;
    for (let i = i0; i <= i1; i++) {
      if (C[i].l < lo) lo = C[i].l;
      if (C[i].h > hi) hi = C[i].h;
      if (C[i].v > vmax) vmax = C[i].v;
    }

    const pl = d.plan && o.plan ? d.plan : null;
    const ext = (hi - lo) * 0.4;
    if (pl) {
      for (const p of [pl.entry, pl.stop, pl.liqPrice, pl.tps?.[0]?.p, pl.tps?.[1]?.p]) {
        if (isN(p) && p! >= lo - ext && p! <= hi + ext) {
          lo = Math.min(lo, p!);
          hi = Math.max(hi, p!);
        }
      }
    }
    const pad = (hi - lo) * 0.05 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const [m0, m1] = geo.main;
    const yP = (p: number) => m0 + 5 + ((hi - p) / (hi - lo)) * (m1 - m0 - 10);
    const tick = d.tick;

    // Grid & price axis
    const raw = (hi - lo) / 6;
    const pw = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pw;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pw;
    g.textAlign = 'left';
    g.lineWidth = 1;
    for (let p = Math.ceil(lo / step) * step; p < hi; p += step) {
      const y = Math.round(yP(p)) + 0.5;
      g.strokeStyle = c.grid;
      g.beginPath();
      g.moveTo(geo.L, y);
      g.lineTo(geo.R, y);
      g.stroke();
      g.fillStyle = c.tx;
      g.fillText(fmtP(p, tick), geo.R + 4, y);
    }

    // SMC Zones
    const lastPx = C[len - 1].c;
    const zs =
      d.zones && o.zones
        ? d.zones
            .filter((z) => yP(z.bot) >= m0 && yP(z.top) <= m1)
            .sort((a, b) => Math.abs((a.top + a.bot) / 2 - lastPx) - Math.abs((b.top + b.bot) / 2 - lastPx))
            .slice(0, 6)
        : [];
    for (const z of zs) {
      const idxFound = z.t0 != null ? C.findIndex((k) => k.t >= z.t0!) : -1;
      const xi = idxFound >= 0 ? Math.max(geo.L, xOf(idxFound) - bw / 2) : geo.L;
      const y1 = yP(z.top);
      const y2 = yP(z.bot);
      if (y2 < m0 || y1 > m1) continue;
      g.fillStyle =
        z.kind === 'BRK'
          ? 'rgba(191,0,255,.15)'
          : z.kind === 'FVG'
            ? z.dir > 0
              ? 'rgba(0,128,255,.13)'
              : 'rgba(255,107,0,.13)'
            : z.dir > 0
              ? 'rgba(0,255,136,.14)'
              : 'rgba(255,45,85,.14)';
      g.fillRect(xi, y1, geo.R - xi, Math.max(2, y2 - y1));
      if (z.kind === 'BRK') {
        g.strokeStyle = 'rgba(191,0,255,.55)';
        g.setLineDash([4, 3]);
        g.strokeRect(xi, y1, geo.R - xi, Math.max(2, y2 - y1));
        g.setLineDash([]);
      }
      g.fillStyle =
        z.kind === 'BRK'
          ? 'rgba(218,128,255,.9)'
          : z.dir > 0
            ? 'rgba(0,255,136,.75)'
            : 'rgba(255,45,85,.75)';
      g.font = '9.5px "IBM Plex Mono"';
      g.fillText(z.label || z.kind, xi + 3, y1 + 7);
      g.font = '10.5px "IBM Plex Mono", monospace';
    }

    // Levels
    const lv6 =
      d.levels && o.levels
        ? d.levels
            .filter((L) => {
              const y = yP(L.p);
              return y >= m0 + 2 && y <= m1 - 2;
            })
            .sort((a, b) => Math.abs(a.p - lastPx) - Math.abs(b.p - lastPx))
            .slice(0, 6)
        : [];
    const planY = pl ? [pl.entry, pl.stop, pl.liqPrice, ...pl.tps.map((t) => t.p)].filter(isN).map((x) => yP(x!)) : [];
    for (const L of lv6) {
      const y = yP(L.p);
      g.strokeStyle =
        L.kind === 'poc' ? 'rgba(191,0,255,.6)' : L.kind === 'liq' ? 'rgba(255,215,0,.5)' : 'rgba(122,155,191,.35)';
      g.setLineDash(L.kind === 'poc' ? [2, 3] : [6, 4]);
      g.beginPath();
      g.moveTo(geo.L, y);
      g.lineTo(geo.R, y);
      g.stroke();
      g.setLineDash([]);
      if (!planY.some((py) => Math.abs(py - y) < 13)) {
        g.fillStyle = 'rgba(122,155,191,.85)';
        g.textAlign = 'right';
        g.fillText(L.label || '', geo.R - 4, y - 6);
        g.textAlign = 'left';
      }
    }

    // Volume
    const [v0, v1] = geo.vol;
    for (let i = i0; i <= i1; i++) {
      const k = C[i];
      const h = vmax ? (k.v / vmax) * (v1 - v0 - 3) : 0;
      g.fillStyle = k.c >= k.o ? 'rgba(0,255,136,.35)' : 'rgba(255,45,85,.35)';
      g.fillRect(xOf(i) - Math.max(1, bw * 0.38), v1 - h, Math.max(1, bw * 0.76), h);
    }

    // Candles + Indicators + Plan clipped to main chart
    g.save();
    g.beginPath();
    g.rect(geo.L, m0, geo.R - geo.L, m1 - m0);
    g.clip();

    for (let i = i0; i <= i1; i++) {
      const k = C[i];
      const x = xOf(i);
      const up = k.c >= k.o;
      const col = up ? c.up : c.dn;
      const bt = yP(Math.max(k.o, k.c));
      const bb = yP(Math.min(k.o, k.c));
      g.strokeStyle = col;
      g.fillStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, yP(k.h));
      g.lineTo(Math.round(x) + 0.5, yP(k.l));
      g.stroke();
      const w = Math.max(1, bw * 0.72);
      g.fillRect(x - w / 2, bt, w, Math.max(1, bb - bt));
    }

    const drawLine = (arr: Float64Array | undefined, col: string, lw = 1.2, dash: number[] = []) => {
      if (!arr) return;
      g.strokeStyle = col;
      g.lineWidth = lw;
      g.setLineDash(dash);
      g.beginPath();
      let on = false;
      for (let i = i0; i <= i1; i++) {
        const v = arr[i];
        if (!isN(v)) {
          on = false;
          continue;
        }
        const x = xOf(i);
        const y = yP(v);
        if (on) g.lineTo(x, y);
        else g.moveTo(x, y);
        on = true;
      }
      g.stroke();
      g.setLineDash([]);
    };

    if (o.bb && al.bbUp && al.bbLo && al.kcUp && al.kcLo) {
      g.fillStyle = 'rgba(255,215,0,.07)';
      for (let i = i0; i <= i1; i++) {
        if (
          isN(al.bbUp[i]) &&
          isN(al.kcUp[i]) &&
          al.bbUp[i] < al.kcUp[i] &&
          al.bbLo[i] > al.kcLo[i]
        ) {
          g.fillRect(xOf(i) - bw / 2, m0, bw, m1 - m0);
        }
      }
      drawLine(al.bbUp, 'rgba(0,128,255,.65)', 1.1, [4, 3]);
      drawLine(al.bbLo, 'rgba(0,128,255,.65)', 1.1, [4, 3]);
    }
    if (o.ema) {
      drawLine(al.ema21, c.cy, 1.2);
      drawLine(al.ema50, c.or, 1.2);
      drawLine(al.ema200, c.pu, 1.4);
    }
    if (o.vwap) drawLine(al.vwap, c.gold, 1.2, [4, 3]);
    if (o.vwapBands) {
      drawLine(al.vwapUp1, 'rgba(255,215,0,.38)', 1.0, [2, 4]);
      drawLine(al.vwapLo1, 'rgba(255,215,0,.38)', 1.0, [2, 4]);
    }
    if (o.st) drawLine(al.st, 'rgba(255,255,255,.55)', 1.2);

    if (pl) {
      const hl = (p: number | undefined, col: string, lab: string, dash: number[] = []) => {
        if (!isN(p)) return;
        const y = yP(p!);
        g.strokeStyle = col;
        g.lineWidth = 1.2;
        g.setLineDash(dash);
        g.beginPath();
        g.moveTo(geo.L, y);
        g.lineTo(geo.R, y);
        g.stroke();
        g.setLineDash([]);
        const tw = g.measureText(lab).width;
        g.fillStyle = 'rgba(4, 16, 28, 0.86)';
        g.fillRect(geo.L + 3, y - 14, tw + 8, 13);
        g.fillStyle = col;
        g.textAlign = 'left';
        g.fillText(lab, geo.L + 7, y - 7.5);
      };
      const ey = yP(pl.entry);
      const sy = yP(pl.stop);
      const ty = pl.tps[0] ? yP(pl.tps[0].p) : ey;
      g.fillStyle = 'rgba(255,45,85,.07)';
      g.fillRect(geo.L, Math.min(ey, sy), geo.R - geo.L, Math.abs(sy - ey));
      g.fillStyle = 'rgba(0,255,136,.06)';
      g.fillRect(geo.L, Math.min(ey, ty), geo.R - geo.L, Math.abs(ty - ey));
      hl(pl.entry, c.cy, pl.type === 'MARKET' ? 'ENTRY (سوقي)' : 'ENTRY (Limit)', [6, 3]);
      hl(pl.stop, c.dn, 'SL');
      if (isN(pl.liqPrice)) hl(pl.liqPrice, c.or, 'LIQ (التصفية)', [2, 3]);
      pl.tps.forEach((t, k) => hl(t.p, c.up, `TP${k + 1} · ${t.r.toFixed(1)}R`, [3, 3]));
    }
    g.restore();

    // Last price tag
    const last = C[len - 1];
    const ly = yP(last.c);
    if (ly > m0 && ly < m1) {
      g.strokeStyle = last.c >= last.o ? c.up : c.dn;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(geo.L, ly);
      g.lineTo(geo.R, ly);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = last.c >= last.o ? c.up : c.dn;
      g.fillRect(geo.R + 1, ly - 8, geo.W - geo.R - 1, 16);
      g.fillStyle = '#021';
      g.textAlign = 'left';
      g.fillText(fmtP(last.c, tick), geo.R + 4, ly);
    }

    if (pl) {
      const tags: [number, string][] = [
        [pl.entry, c.cy],
        [pl.stop, c.dn],
        ...(pl.tps[0] ? ([[pl.tps[0].p, c.up]] as [number, string][]) : []),
      ];
      for (const [p, col] of tags) {
        const y = yP(p);
        if (y > m0 && y < m1) {
          g.fillStyle = col;
          g.globalAlpha = 0.85;
          g.fillRect(geo.R + 1, y - 7, geo.W - geo.R - 1, 14);
          g.globalAlpha = 1;
          g.fillStyle = '#021';
          g.textAlign = 'left';
          g.fillText(fmtP(p, tick), geo.R + 4, y);
        }
      }
    }

    // RSI panel
    if (o.rsi && al.rsi) {
      const [r0, r1] = geo.rsi;
      const yR = (v: number) => r0 + 4 + ((100 - v) / 100) * (r1 - r0 - 8);
      g.strokeStyle = c.grid;
      for (const lv of [30, 50, 70]) {
        g.beginPath();
        g.moveTo(geo.L, yR(lv));
        g.lineTo(geo.R, yR(lv));
        g.stroke();
      }
      g.fillStyle = c.tx;
      g.textAlign = 'left';
      g.fillText('RSI', geo.L + 4, r0 + 9);
      g.fillText('70', geo.R + 4, yR(70));
      g.fillText('30', geo.R + 4, yR(30));
      g.strokeStyle = c.pu;
      g.lineWidth = 1.3;
      g.beginPath();
      let on = false;
      for (let i = i0; i <= i1; i++) {
        const v = al.rsi[i];
        if (!isN(v)) {
          on = false;
          continue;
        }
        if (on) g.lineTo(xOf(i), yR(v));
        else g.moveTo(xOf(i), yR(v));
        on = true;
      }
      g.stroke();
      const lv = al.rsi[Math.min(len - 1, i1)];
      if (isN(lv)) {
        g.fillStyle = lv > 70 ? c.dn : lv < 30 ? c.up : c.tx;
        g.fillText(lv.toFixed(0), geo.R + 4, yR(lv));
      }
    }

    // Time axis
    g.fillStyle = c.tx;
    g.textAlign = 'center';
    const STEPS = [5, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080].map((m) => m * 60e3);
    const want = (62 / bw) * d.ms;
    const stepMs = STEPS.find((x) => x >= want) || STEPS[STEPS.length - 1];
    const tzo = new Date((C[i0] || C[0]).t).getTimezoneOffset() * 60e3;
    const p2 = (x: number) => String(x).padStart(2, '0');
    let lastX = -1e9;
    for (let i = Math.max(1, i0); i <= i1; i++) {
      if (!C[i] || !C[i - 1]) continue;
      const a = Math.floor((C[i].t - tzo) / stepMs);
      const b = Math.floor((C[i - 1].t - tzo) / stepMs);
      if (a === b) continue;
      const x = xOf(i);
      if (x - lastX < 46 || x < geo.L + 14 || x > geo.R - 14) continue;
      lastX = x;
      const t = new Date(C[i].t);
      const midnight = t.getHours() === 0 && t.getMinutes() === 0;
      g.fillStyle = midnight && stepMs < 86400e3 ? c.cy : c.tx;
      g.fillText(
        stepMs >= 86400e3 || midnight
          ? `${t.getMonth() + 1}/${t.getDate()}`
          : `${p2(t.getHours())}:${p2(t.getMinutes())}`,
        x,
        geo.H - 8
      );
      g.strokeStyle = c.grid;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, geo.H - geo.B);
      g.lineTo(Math.round(x) + 0.5, geo.H - geo.B + 4);
      g.stroke();
    }

    // Crosshair
    let hov: Candle | null = null;
    if (crossRef.current) {
      const { x: cx, y: cy } = crossRef.current;
      const idx = Math.max(i0, Math.min(i1, Math.floor(start + (cx - geo.L) / bw)));
      hov = C[idx] ?? null;
      g.strokeStyle = 'rgba(232,244,255,.35)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(xOf(idx), 0);
      g.lineTo(xOf(idx), geo.H - geo.B);
      g.moveTo(geo.L, cy);
      g.lineTo(geo.R, cy);
      g.stroke();
      g.setLineDash([]);
      if (cy > m0 && cy < m1) {
        const p = hi - ((cy - m0 - 5) / (m1 - m0 - 10)) * (hi - lo);
        g.fillStyle = '#112240';
        g.fillRect(geo.R + 1, cy - 8, geo.W - geo.R - 1, 16);
        g.fillStyle = '#fff';
        g.textAlign = 'left';
        g.fillText(fmtP(p, tick), geo.R + 4, cy);
      }
    }
    const hovT = hov ? hov.t : null;
    if (hovT !== lastHoverTimeRef.current) {
      lastHoverTimeRef.current = hovT;
      setHoverCandle(hov);
    }
  };

  useEffect(() => {
    optRef.current = opt;
    dataRef.current = data;
    if (data && data.key !== lastKeyRef.current) {
      viewRef.current.off = 0;
      lastKeyRef.current = data.key;
    }
    draw();
  }, [data, opt]);

  useEffect(() => {
    const box = boxRef.current;
    const cv = canvasRef.current;
    if (!box || !cv) return;

    const resize = () => {
      const w = box.clientWidth || 300;
      const h = w < 520 ? 400 : 460;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      dimRef.current = { w, h, dpr };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = `${h}px`;
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const rel = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const dist = () => {
      const p = [...ptrsRef.current.values()];
      return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    };
    const zoom = (f: number) => {
      viewRef.current.n = Math.max(25, Math.min(320, Math.round(viewRef.current.n * f)));
      const len = dataRef.current ? dataRef.current.candles.length : 0;
      const minOff = -Math.floor(viewRef.current.n / 4);
      const maxOff = Math.max(0, len - Math.min(len, 20));
      viewRef.current.off = Math.max(minOff, Math.min(maxOff, viewRef.current.off));
      draw();
    };

    const onDown = (e: PointerEvent) => {
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      ptrsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX });
      movedRef.current = false;
      if (ptrsRef.current.size === 2) pinchRef.current = dist();
    };

    const onMove = (e: PointerEvent) => {
      const p = ptrsRef.current.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') {
          crossRef.current = rel(e);
          draw();
        }
        return;
      }
      if (ptrsRef.current.size === 2) {
        p.x = e.clientX;
        p.y = e.clientY;
        const d = dist();
        if (pinchRef.current) zoom(pinchRef.current / d);
        pinchRef.current = d;
        movedRef.current = true;
        return;
      }
      const dx = e.clientX - p.x;
      if (Math.abs(e.clientX - p.x0) > 5) movedRef.current = true;
      p.x = e.clientX;
      p.y = e.clientY;
      if (movedRef.current) {
        const bw = (dimRef.current.w - 72) / viewRef.current.n;
        const len = dataRef.current ? dataRef.current.candles.length : 0;
        const minOff = -Math.floor(viewRef.current.n / 4);
        const maxOff = Math.max(0, len - Math.min(len, 20));
        viewRef.current.off = Math.max(minOff, Math.min(maxOff, viewRef.current.off + dx / bw));
        draw();
      }
    };

    const onUp = (e: PointerEvent) => {
      const was = ptrsRef.current.get(e.pointerId);
      ptrsRef.current.delete(e.pointerId);
      pinchRef.current = 0;
      if (was && !movedRef.current) {
        const pt = rel(e);
        crossRef.current = crossRef.current && Math.abs(crossRef.current.x - pt.x) < 3 ? null : pt;
        draw();
      }
    };

    const onCancel = (e: PointerEvent) => {
      ptrsRef.current.delete(e.pointerId);
      pinchRef.current = 0;
    };

    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        crossRef.current = null;
        draw();
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.12 : 0.89);
    };

    const onDbl = () => {
      viewRef.current = { n: 90, off: 0 };
      draw();
    };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDbl);

    return () => {
      ro.disconnect();
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
      cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('dblclick', onDbl);
    };
  }, []);

  const adjustZoom = (factor: number) => {
    viewRef.current.n = Math.max(25, Math.min(320, Math.round(viewRef.current.n * factor)));
    const len = dataRef.current ? dataRef.current.candles.length : 0;
    const minOff = -Math.floor(viewRef.current.n / 4);
    const maxOff = Math.max(0, len - Math.min(len, 20));
    viewRef.current.off = Math.max(minOff, Math.min(maxOff, viewRef.current.off));
    draw();
  };

  const resetChartView = () => {
    viewRef.current = { n: 90, off: 0 };
    crossRef.current = null;
    draw();
  };

  const displayCandle =
    hoverCandle || (data && data.candles.length ? data.candles[data.candles.length - 1] : null);

  return (
    <>
      <div className="chartbox" ref={boxRef} style={{ direction: 'ltr' }}>
        <canvas ref={canvasRef} />
      </div>
      <div className="row sb wrap" style={{ margin: '6px 0', gap: 6 }}>
        <div className="hint num" style={{ minHeight: 18 }}>
          {displayCandle
            ? `${fmtDt(displayCandle.t)} · O ${fmtP(displayCandle.o, data?.tick)} · H ${fmtP(displayCandle.h, data?.tick)} · L ${fmtP(displayCandle.l, data?.tick)} · C `
            : ''}
          {displayCandle && (
            <b className={displayCandle.c >= displayCandle.o ? 'pos' : 'neg'}>
              {fmtP(displayCandle.c, data?.tick)}
            </b>
          )}
          {displayCandle && ` · Vol ${fmtUsd(displayCandle.q || displayCandle.v * displayCandle.c).replace('$', '')}`}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn sm"
            title="تكبير"
            onClick={() => adjustZoom(0.8)}
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            className="btn sm"
            title="تصغير"
            onClick={() => adjustZoom(1.25)}
          >
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            className="btn sm"
            title="إعادة ضبط الشارت"
            onClick={resetChartView}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>
      <div className="toggles">
        {CHART_OPT_LABELS.map(([k, label]) => (
          <button
            key={k}
            className={`chip ${opt[k] ? 'on' : ''}`}
            onClick={() => setOpt((prev) => ({ ...prev, [k]: !prev[k] }))}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
