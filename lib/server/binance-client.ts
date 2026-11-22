import type { Candle, OrderBookAnalysis, SymbolMeta } from '../cx-engine/types';

const BASE_URL = 'https://fapi.binance.com';

interface RateState {
  used: number;
  win: number;
  offset: number;
  banUntil: number;
  ok: number;
  fail: number;
  lastErr: string;
}

const state: RateState = {
  used: 0,
  win: Date.now(),
  offset: 0,
  banUntil: 0,
  ok: 0,
  fail: 0,
  lastErr: '',
};

const cache = new Map<string, { t: number; d: any }>();
const inflight = new Map<string, Promise<any>>();

function resetWindowIfNeeded() {
  const now = Date.now();
  if (now - state.win > 60_000) {
    state.win = now;
    state.used = 0;
  }
}

async function fetchJson(
  path: string,
  params?: Record<string, string | number | undefined | null>,
  opts?: { ttl?: number; weight?: number }
) {
  const ttl = opts?.ttl ?? 0;
  const weight = opts?.weight ?? 1;
  const qs = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const key = `${path}?${qs}`;

  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.d;
  }
  if (inflight.has(key)) return inflight.get(key)!;

  const work = (async () => {
    if (Date.now() < state.banUntil) {
      throw new Error(`Binance rate-limit active until ${new Date(state.banUntil).toISOString()}`);
    }
    resetWindowIfNeeded();
    if (state.used + weight > 1800) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    state.used += weight;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12_000);
      try {
        const res = await fetch(`${BASE_URL}${key}`, {
          signal: ctl.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const uw = res.headers.get('x-mbx-used-weight-1m');
        if (uw && +uw > state.used) state.used = +uw;

        if (res.status === 429 || res.status === 418) {
          const ra = (+(res.headers.get('retry-after') || 30)) * 1000;
          state.banUntil = Date.now() + ra;
          throw new Error(`RATE_LIMIT_${res.status}`);
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`HTTP_${res.status}: ${txt.slice(0, 120)}`);
        }
        const data = await res.json();
        state.ok++;
        state.lastErr = '';
        if (ttl > 0) cache.set(key, { t: Date.now(), d: data });
        return data;
      } catch (err: any) {
        lastErr = err;
        state.fail++;
        state.lastErr = String(err?.message || err);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Binance fetch failed');
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, work);
  return work;
}

const mapKline = (a: any[]): Candle => ({
  t: Number(a[0]),
  o: Number(a[1]),
  h: Number(a[2]),
  l: Number(a[3]),
  c: Number(a[4]),
  v: Number(a[5]),
  T: Number(a[6]),
  q: Number(a[7]),
  n: Number(a[8]),
  V: Number(a[9]),
  Q: Number(a[10]),
  x: Number(a[6]) < Date.now() + state.offset,
});

export const binanceServer = {
  state,
  now: () => Date.now() + state.offset,

  async syncTime() {
    try {
      const r = await fetchJson('/fapi/v1/time', undefined, { weight: 1 });
      state.offset = Number(r.serverTime) - Date.now();
    } catch {
      // keep local offset
    }
  },

  async klines(
    sym: string,
    tf: string,
    limit = 499,
    endTime?: number,
    startTime?: number
  ): Promise<Candle[]> {
    const raw = await fetchJson(
      '/fapi/v1/klines',
      { symbol: sym, interval: tf, limit, endTime, startTime },
      { weight: limit >= 500 ? 5 : limit >= 100 ? 2 : 1, ttl: 4000 }
    );
    return (raw as any[]).map(mapKline);
  },

  async depth(sym: string, limit = 100): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const r = await fetchJson('/fapi/v1/depth', { symbol: sym, limit }, { weight: 5, ttl: 4000 });
    return {
      bids: (r.bids || []).map((x: any) => [Number(x[0]), Number(x[1])] as [number, number]),
      asks: (r.asks || []).map((x: any) => [Number(x[0]), Number(x[1])] as [number, number]),
    };
  },

  bookAnalysis(dp: { bids: [number, number][]; asks: [number, number][] } | null): OrderBookAnalysis | null {
    if (!dp || !dp.bids.length || !dp.asks.length) return null;
    const mid = (dp.bids[0][0] + dp.asks[0][0]) / 2;
    const spreadBps = ((dp.asks[0][0] - dp.bids[0][0]) / mid) * 1e4;
    const maxP = dp.bids[dp.bids.length - 1][0];
    const minP = dp.asks[dp.asks.length - 1][0];
    const band = Math.min(0.005, ((mid - maxP) / mid + (minP - mid) / mid) / 2);
    const bandLo = mid * (1 - band);
    const bandHi = mid * (1 + band);
    let bid05 = 0;
    let ask05 = 0;
    let maxBid = { p: 0, usd: 0 };
    let maxAsk = { p: 0, usd: 0 };
    for (const [p, q] of dp.bids) {
      const usd = p * q;
      if (p >= bandLo) bid05 += usd;
      if (usd > maxBid.usd) maxBid = { p, usd };
    }
    for (const [p, q] of dp.asks) {
      const usd = p * q;
      if (p <= bandHi) ask05 += usd;
      if (usd > maxAsk.usd) maxAsk = { p, usd };
    }
    const imb05 = bid05 + ask05 > 0 ? (bid05 - ask05) / (bid05 + ask05) : 0;
    return {
      imb05,
      bandPct: band * 100,
      spreadBps,
      bid05,
      ask05,
      bidWall: maxBid.usd > 5e4 ? maxBid : null,
      askWall: maxAsk.usd > 5e4 ? maxAsk : null,
      bids: dp.bids,
      asks: dp.asks,
      mid,
      t: Date.now(),
    };
  },

  async fundingHistory(
    sym: string,
    startTime?: number,
    endTime?: number,
    limit = 200
  ): Promise<{ t: number; r: number }[]> {
    const raw = await fetchJson(
      '/fapi/v1/fundingRate',
      { symbol: sym, startTime, endTime, limit },
      { weight: 1, ttl: 60_000 }
    );
    return Array.isArray(raw)
      ? raw.map((x: any) => ({ t: Number(x.fundingTime), r: Number(x.fundingRate) }))
      : [];
  },

  async exchangeInfo(): Promise<Record<string, SymbolMeta>> {
    const r = await fetchJson('/fapi/v1/exchangeInfo', undefined, { ttl: 3600_000, weight: 1 });
    const m: Record<string, SymbolMeta> = {};
    for (const s of r.symbols || []) {
      if (
        s.contractType !== 'PERPETUAL' ||
        s.quoteAsset !== 'USDT' ||
        s.status !== 'TRADING' ||
        !/^[A-Z0-9]+USDT$/.test(s.symbol)
      ) {
        continue;
      }
      const f: Record<string, any> = {};
      for (const x of s.filters || []) f[x.filterType] = x;
      m[s.symbol] = {
        sym: s.symbol,
        base: s.baseAsset,
        tick: Number(f.PRICE_FILTER?.tickSize || 0),
        step: Number(f.LOT_SIZE?.stepSize || 0),
        minQty: Number(f.LOT_SIZE?.minQty || 0),
        minNotional: Number(f.MIN_NOTIONAL?.notional || f.MIN_NOTIONAL?.minNotional || 5),
        onboard: s.onboardDate || 0,
        pp: s.pricePrecision,
        qp: s.quantityPrecision,
      };
    }
    return m;
  },

  async tickers(): Promise<
    Record<string, { price: number; chg: number; vol: number; hi: number; lo: number }>
  > {
    const r = await fetchJson('/fapi/v1/ticker/24hr', undefined, { ttl: 20_000, weight: 40 });
    const m: Record<string, { price: number; chg: number; vol: number; hi: number; lo: number }> = {};
    for (const x of r || []) {
      m[x.symbol] = {
        price: Number(x.lastPrice),
        chg: Number(x.priceChangePercent),
        vol: Number(x.quoteVolume),
        hi: Number(x.highPrice),
        lo: Number(x.lowPrice),
      };
    }
    return m;
  },

  async premium(): Promise<
    Record<string, { mark: number; index: number; funding: number; next: number }>
  > {
    const r = await fetchJson('/fapi/v1/premiumIndex', undefined, { ttl: 3500, weight: 10 });
    const m: Record<string, { mark: number; index: number; funding: number; next: number }> = {};
    for (const x of r || []) {
      m[x.symbol] = {
        mark: Number(x.markPrice),
        index: Number(x.indexPrice),
        funding: Number(x.lastFundingRate),
        next: Number(x.nextFundingTime),
      };
    }
    return m;
  },

  async tickerPrice(sym: string): Promise<number> {
    const r = await fetchJson('/fapi/v1/ticker/price', { symbol: sym }, { weight: 1, ttl: 1500 });
    return Number(r.price);
  },

  async oiHist(sym: string, period = '15m', limit = 20) {
    return fetchJson('/futures/data/openInterestHist', { symbol: sym, period, limit }, { ttl: 60_000 });
  },

  async lsGlobal(sym: string, period = '15m', limit = 1) {
    return fetchJson(
      '/futures/data/globalLongShortAccountRatio',
      { symbol: sym, period, limit },
      { ttl: 60_000 }
    );
  },

  async lsTop(sym: string, period = '15m', limit = 1) {
    return fetchJson(
      '/futures/data/topLongShortPositionRatio',
      { symbol: sym, period, limit },
      { ttl: 60_000 }
    );
  },

  async taker(sym: string, period = '15m', limit = 4) {
    return fetchJson(
      '/futures/data/takerlongshortRatio',
      { symbol: sym, period, limit },
      { ttl: 60_000 }
    );
  },
};
