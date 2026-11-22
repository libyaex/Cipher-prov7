'use client';

import { buildBtcContext, DEFAULTS, MODES, prepare, resolveModeConfig, type PreparedContext } from '../cx-engine/analyzer';
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from '../cx-engine/early-entry';
import { isN, TF_MS } from '../cx-engine/indicators';
import { evaluate, headline } from '../cx-engine/planner';
import { newTrade, runBacktest, step as btStep } from '../cx-engine/backtest';
import type {
  BotSettings,
  BtcContext,
  Candle,
  DerivData,
  EarlyEntryDetails,
  EarlyEntryWeights,
  EngineConfig,
  ExecutionMode,
  ModeConfig,
  OrderBookAnalysis,
  SignalEvaluation,
  SignalTelemetryRecord,
  SimulatedTrade,
  SymbolMeta,
  TradingModeKey,
} from '../cx-engine/types';

export interface ClientSettings {
  mode: TradingModeKey;
  earlyTriggerTf: string;
  executionMode: ExecutionMode;
  minScore: number;
  strongScore: number;
  watchScore: number;
  equity: number;
  riskPct: number;
  maxLev: number;
  maxOpenPositions: number;
  equalAllocationEnabled: boolean;
  cashReservePct: number;
  maxPortfolioHeatPct: number;
  maxSameSidePositions: number;
  dailyLossLimitUsdt: number;
  dailyLossLimitPct: number;
  btcFilterEnabled: boolean;
  mmr: number;
  takerFee: number;
  makerFee: number;
  slip: number;
  minLiqSafetyPct: number;
  tpPcts: [number, number, number];
  limitExpireBars: number;
  cancelChasedAtr: number;
  allowReentry: boolean;
  reentryCooldownBars: number;
  trailingStopEnabled: boolean;
  filterFlags: {
    useFvg: boolean;
    useOb: boolean;
    useChochBos: boolean;
    useMomentum: boolean;
    useOrderFlow: boolean;
    btcShockBlock: boolean;
  };
  notifyPrefs: {
    browser: boolean;
    push: boolean;
    sound: boolean;
    onOpen: boolean;
    onClose: boolean;
    onRisk: boolean;
    onError: boolean;
  };
  earlyWeights: EarlyEntryWeights;
  universe: number;
  minVolM: number;
  maxSpreadBps: number;
  liquidityRadarGate: boolean;
  smartProfitShield: boolean;
  smartTakeProfitEnabled: boolean;
  smartTakeProfitMinR: number;
  smartTakeProfitPartialPct: number;
  smartTakeProfitSensitivity: 'conservative' | 'balanced' | 'aggressive';
  favorites: string[];
  tgToken: string;
  tgChat: string;
  tgOn: boolean;
  notifyOn: boolean;
  soundOn: boolean;
  vibrateOn: boolean;
  wakeLock: boolean;
  minTier: 'GOOD' | 'STRONG';
  apiBase: string;
  wsBase: string;
  autoScan: boolean;
}

export interface TrackedSignal extends SimulatedTrade {
  headline: string;
  grade: string;
  aligned: number;
  mode: TradingModeKey;
  strategyMode?: TradingModeKey;
  earlyEntry?: EarlyEntryDetails | null;
  tfs: ModeConfig;
  price0: number;
  atr: number;
  riskATR: number;
  rr: [number, number, number];
  zone: { lo: number; hi: number; labels: string[]; kinds: string[]; n: number };
  stopRef: string;
  checks: { ok: boolean | null; label: string; detail: string }[];
  warnings: string[];
  size: any;
  confirmBits: string[];
  reasons: { label: string; raw: number; detail: string }[];
  against: { label: string; detail: string }[];
  gates: string[];
  regime: string;
  tick: number;
  equity: number;
  riskPct: number;
  hasDeriv: boolean;
  evalSnapshot?: SignalEvaluation;
}

export interface SymbolRecord {
  sym: string;
  meta: Partial<SymbolMeta>;
  price: number;
  priceT: number;
  mark: number;
  markT?: number;
  index: number;
  funding: number;
  next: number;
  chg: number;
  vol: number;
  hi: number;
  lo: number;
  candles: Record<string, Candle[]>;
  micro: Record<string, Candle[]>;
  microAt: number;
  ready: boolean;
  loading: boolean;
  err: string;
  report: SignalEvaluation | null;
  ctx: PreparedContext | null;
  ctxKey: string;
  deriv: DerivData | null;
  derivAt: number;
  book: OrderBookAnalysis | null;
  bookAt: number;
  bbo: { bid: number; ask: number; bidQ: number; askQ: number; spreadBps: number; t: number } | null;
  depthLive: { b: [number, number][]; a: [number, number][] } | null;
  lastAn: number;
}

export interface LiqEvent {
  t: number;
  sym: string;
  side: string;
  usd: number;
  price: number;
  qty: number;
}

export interface ToastItem {
  id: string;
  kind: 'long' | 'short' | 'bad' | 'info';
  title: string;
  sig?: TrackedSignal;
}

const RANK: Record<string, number> = { NONE: 0, WATCH: 1, GOOD: 2, STRONG: 3 };
const isLive = (s: { status: string }) => s.status === 'OPEN' || s.status === 'PENDING';

const fmtP = (p: number, tick?: number) => {
  if (!isN(p)) return '—';
  let d = 2;
  if (tick && tick > 0) d = Math.max(0, Math.min(10, Math.round(-Math.log10(tick))));
  else d = p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : p >= 0.1 ? 5 : 6;
  return p.toFixed(d);
};

class EventBus {
  private map = new Map<string, Set<(payload: any) => void>>();
  on(ev: string, fn: (payload: any) => void) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(fn);
    return () => {
      this.map.get(ev)?.delete(fn);
    };
  }
  emit(ev: string, payload?: any) {
    this.map.get(ev)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error('[CX bus]', ev, e);
      }
    });
  }
}

const lsGet = <T>(k: string, def: T): T => {
  try {
    if (typeof localStorage === 'undefined') return def;
    const v = localStorage.getItem(k);
    return v == null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
};
const lsSet = (k: string, v: any) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // ignore
  }
};

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  mode: 'intraday',
  earlyTriggerTf: '15m',
  executionMode: 'MANUAL',
  minScore: DEFAULTS.minScore,
  strongScore: DEFAULTS.strongScore,
  watchScore: DEFAULTS.watchScore,
  equity: 10000,
  riskPct: DEFAULTS.riskPct,
  maxLev: DEFAULTS.maxLev,
  maxOpenPositions: 4,
  equalAllocationEnabled: true,
  cashReservePct: 10,
  maxPortfolioHeatPct: 6,
  maxSameSidePositions: 3,
  dailyLossLimitUsdt: 500,
  dailyLossLimitPct: 5,
  btcFilterEnabled: true,
  mmr: DEFAULTS.mmr,
  takerFee: DEFAULTS.takerFee,
  makerFee: DEFAULTS.makerFee,
  slip: DEFAULTS.slip,
  minLiqSafetyPct: 25,
  tpPcts: [40, 35, 25],
  limitExpireBars: 8,
  cancelChasedAtr: 2.4,
  allowReentry: true,
  reentryCooldownBars: 6,
  trailingStopEnabled: true,
  filterFlags: {
    useFvg: true,
    useOb: true,
    useChochBos: true,
    useMomentum: true,
    useOrderFlow: true,
    btcShockBlock: true,
  },
  notifyPrefs: {
    browser: true,
    push: true,
    sound: true,
    onOpen: true,
    onClose: true,
    onRisk: true,
    onError: true,
  },
  earlyWeights: { ...DEFAULT_EARLY_WEIGHTS },
  universe: 24,
  minVolM: 60,
  maxSpreadBps: 8,
  liquidityRadarGate: true,
  smartProfitShield: true,
  smartTakeProfitEnabled: true,
  smartTakeProfitMinR: 0.6,
  smartTakeProfitPartialPct: 50,
  smartTakeProfitSensitivity: 'balanced',
  favorites: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  tgToken: '',
  tgChat: '',
  tgOn: false,
  notifyOn: true,
  soundOn: true,
  vibrateOn: true,
  wakeLock: false,
  minTier: 'GOOD',
  apiBase: 'https://fapi.binance.com',
  wsBase: 'wss://fstream.binance.com',
  autoScan: true,
};

class WsConn {
  public ws: WebSocket | null = null;
  public want = new Set<string>();
  public have = new Set<string>();
  public state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  public fails = 0;
  public last = 0;
  public openedAt = 0;
  public msgs = 0;
  private rt: ReturnType<typeof setTimeout> | null = null;

  constructor(private name: 'market' | 'public', private engine: CipherClientEngine) {}

  private url() {
    return (
      this.engine.getSettings().wsBase.replace(/\/+$/, '') +
      '/' +
      this.name +
      '/stream?streams=' +
      [...this.want].slice(0, 100).join('/')
    );
  }

  private emit() {
    this.engine.bus.emit('ws-state', { name: this.name, state: this.state });
  }

  sync(list: string[]) {
    this.want = new Set(list);
    if (!this.want.size) {
      this.close();
      return;
    }
    if (!this.ws || this.ws.readyState > 1) {
      if (this.state !== 'connecting') this.connect();
      return;
    }
    if (this.ws.readyState === 1) this.flush();
  }

  private flush() {
    const add = [...this.want].filter((s) => !this.have.has(s));
    const rem = [...this.have].filter((s) => !this.want.has(s));
    const send = (method: string, arr: string[]) => {
      for (let i = 0; i < arr.length; i += 40) {
        const part = arr.slice(i, i + 40);
        setTimeout(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ method, params: part, id: Math.floor(Math.random() * 1e9) }));
          }
        }, (i / 40) * 200);
      }
    };
    if (add.length) {
      send('SUBSCRIBE', add);
      add.forEach((s) => this.have.add(s));
    }
    if (rem.length) {
      send('UNSUBSCRIBE', rem);
      rem.forEach((s) => this.have.delete(s));
    }
  }

  private connect() {
    if (typeof WebSocket === 'undefined') return;
    if (this.rt) clearTimeout(this.rt);
    this.state = 'connecting';
    this.emit();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    this.have = new Set([...this.want].slice(0, 100));
    ws.onopen = () => {
      this.state = 'open';
      this.fails = 0;
      this.openedAt = Date.now();
      this.last = Date.now();
      this.emit();
      this.flush();
    };
    ws.onmessage = (ev) => {
      this.last = Date.now();
      this.msgs++;
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = m.data !== undefined ? m.data : m;
      if (Array.isArray(d)) d.forEach((x) => x && x.e && this.engine.bus.emit('ws-msg', x));
      else if (d && d.e) this.engine.bus.emit('ws-msg', d);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.state = 'closed';
      this.emit();
      this.retry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  private retry() {
    if (!this.want.size) return;
    this.fails++;
    const d = Math.min(30000, 1000 * Math.pow(2, Math.min(this.fails, 5))) + Math.random() * 500;
    if (this.rt) clearTimeout(this.rt);
    this.rt = setTimeout(() => this.connect(), d);
  }

  close() {
    if (this.rt) clearTimeout(this.rt);
    const w = this.ws;
    this.ws = null;
    this.have = new Set();
    this.state = 'idle';
    if (w) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.emit();
  }

  watchdog() {
    if (this.state !== 'open' || !this.want.size) return;
    if (Date.now() - this.last > 40000 || Date.now() - this.openedAt > 23 * 3600e3) {
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
    }
  }
}

export class CipherClientEngine {
  public bus = new EventBus();
  private settingsData: ClientSettings;
  private signalsList: TrackedSignal[] = [];

  public apiState = {
    used: 0,
    win: Date.now(),
    fd: [] as number[],
    q: [] as any[],
    active: 0,
    maxActive: 5,
    banUntil: 0,
    geo: false,
    lastErr: '',
    ok: 0,
    fail: 0,
    cache: new Map<string, { t: number; d: any }>(),
    inflight: new Map<string, Promise<any>>(),
    offset: 0,
  };

  public storeState = {
    recs: {} as Record<string, SymbolRecord>,
    meta: {} as Record<string, SymbolMeta>,
    universe: [] as string[],
    active: null as string | null,
    liq: [] as LiqEvent[],
    booted: false,
  };

  public scanState = {
    phase: 'idle' as 'idle' | 'boot' | 'ready' | 'error',
    msg: '',
    progress: 0,
    lastCycle: 0,
    cycles: 0,
    errors: 0,
    busy: false,
    cycleOpen: 0,
    started: false,
    geo: false,
  };

  public marketConn: WsConn;
  public pubConn: WsConn;
  private timers: ReturnType<typeof setInterval>[] = [];
  private actx: AudioContext | null = null;
  private wakeLockRef: any = null;
  private initialized = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private btcCtxCache: { key: string; ctx: BtcContext | null } = { key: '', ctx: null };

  constructor() {
    this.settingsData = { ...DEFAULT_CLIENT_SETTINGS };
    this.signalsList = [];
    this.marketConn = new WsConn('market', this);
    this.pubConn = new WsConn('public', this);

    this.bus.on('ws-msg', (d: any) => {
      if (d.e === 'kline') this.applyKline(d);
      else if (d.e === 'markPriceUpdate') {
        const r = this.storeState.recs[d.s];
        if (r) {
          r.mark = +d.p;
          r.index = +d.i;
          r.funding = +d.r;
          r.next = d.T;
          r.markT = Date.now();
        }
      } else if (d.e === 'forceOrder' && d.o) {
        const o = d.o;
        const px = +o.ap || +o.p;
        const qty = +o.z || +o.q;
        this.storeState.liq.push({ t: o.T || d.E, sym: o.s, side: o.S, usd: px * qty, price: px, qty });
        if (this.storeState.liq.length > 600) this.storeState.liq.splice(0, 100);
        this.bus.emit('liq', this.storeState.liq[this.storeState.liq.length - 1]);
      } else if (d.e === 'depthUpdate') {
        const r = this.storeState.recs[d.s];
        if (!r || !d.b?.length || !d.a?.length) return;
        const bid = +d.b[0][0];
        const ask = +d.a[0][0];
        r.bbo = {
          bid,
          ask,
          bidQ: +d.b[0][1],
          askQ: +d.a[0][1],
          spreadBps: (1e4 * (ask - bid)) / ((ask + bid) / 2),
          t: Date.now(),
        };
        r.depthLive = { b: d.b.map((x: any) => [+x[0], +x[1]]), a: d.a.map((x: any) => [+x[0], +x[1]]) };
        this.bus.emit('depth', d.s);
      }
    });

    this.bus.on('bar-close', ({ sym }: { sym: string }) => {
      if (this.scanState.phase === 'ready' && sym === this.storeState.active) {
        setTimeout(() => this.analyze(sym, false), 300);
      }
    });
  }

  initOnce() {
    if (this.initialized || typeof window === 'undefined') return;
    this.initialized = true;
    fetch('/api/auth/session', { cache: 'no-store' }).catch(() => undefined);
    const savedSettings = lsGet<Partial<ClientSettings>>('cxp.settings.v1', {});
    if (savedSettings && typeof savedSettings === 'object' && Object.keys(savedSettings).length > 0) {
      this.settingsData = {
        ...DEFAULT_CLIENT_SETTINGS,
        ...savedSettings,
        filterFlags: {
          ...DEFAULT_CLIENT_SETTINGS.filterFlags,
          ...(savedSettings.filterFlags || {}),
        },
        notifyPrefs: {
          ...DEFAULT_CLIENT_SETTINGS.notifyPrefs,
          ...(savedSettings.notifyPrefs || {}),
        },
        earlyWeights: savedSettings.earlyWeights
          ? normalizeEarlyWeights(savedSettings.earlyWeights)
          : { ...DEFAULT_EARLY_WEIGHTS },
      };
      this.bus.emit('settings', this.settingsData);
    }
    const savedSignals = lsGet<TrackedSignal[]>('cxp.signals.v1', []);
    if (Array.isArray(savedSignals) && savedSignals.length > 0) {
      this.signalsList = savedSignals;
      this.bus.emit('signals-changed', this.signalsList);
    }
    setInterval(() => {
      this.marketConn.watchdog();
      this.pubConn.watchdog();
    }, 8000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.updateWakeLock();
        this.marketConn.watchdog();
        this.pubConn.watchdog();
        if (this.scanState.phase === 'ready') {
          this.trackAll();
          this.cycle();
        }
      }
    });
    this.boot();
    this.updateWakeLock();
  }

  getSettings(): ClientSettings {
    return this.settingsData;
  }

  setSettings(patch: Partial<ClientSettings>) {
    this.settingsData = { ...this.settingsData, ...patch };
    lsSet('cxp.settings.v1', this.settingsData);
    this.bus.emit('settings', this.settingsData);
  }

  normalizeScores() {
    const next = { ...this.settingsData };
    next.watchScore = Math.max(40, Math.min(85, Math.round(next.watchScore || 62)));
    next.minScore = Math.max(next.watchScore + 2, Math.min(92, Math.round(next.minScore || 70)));
    next.strongScore = Math.max(next.minScore + 2, Math.min(98, Math.round(next.strongScore || 80)));
    this.settingsData = next;
    lsSet('cxp.settings.v1', this.settingsData);
    this.bus.emit('settings', this.settingsData);
    return this.settingsData;
  }

  applyServerBotSettings(bot?: Partial<BotSettings> | null, walletBalance?: number) {
    if (!bot && !isN(walletBalance)) return;
    const next: Partial<ClientSettings> = {};
    if (bot) {
      if (bot.mode) next.mode = bot.mode;
      if (bot.earlyTriggerTf) next.earlyTriggerTf = bot.earlyTriggerTf;
      if (bot.executionMode) next.executionMode = bot.executionMode;
      else if (bot.autoTradeEnabled !== undefined) next.executionMode = bot.autoTradeEnabled ? 'AUTO' : 'MANUAL';
      if (isN(bot.riskPct)) next.riskPct = bot.riskPct;
      if (isN(bot.maxLeverage)) next.maxLev = bot.maxLeverage;
      if (isN(bot.maxOpenPositions)) next.maxOpenPositions = bot.maxOpenPositions;
      if (bot.equalAllocationEnabled !== undefined) next.equalAllocationEnabled = Boolean(bot.equalAllocationEnabled);
      if (isN(bot.cashReservePct)) next.cashReservePct = bot.cashReservePct;
      if (isN(bot.maxPortfolioHeatPct)) next.maxPortfolioHeatPct = bot.maxPortfolioHeatPct;
      if (isN(bot.maxSameSidePositions)) next.maxSameSidePositions = bot.maxSameSidePositions;
      if (isN(bot.dailyLossLimitUsdt)) next.dailyLossLimitUsdt = bot.dailyLossLimitUsdt;
      if (isN(bot.dailyLossLimitPct)) next.dailyLossLimitPct = bot.dailyLossLimitPct;
      if (bot.btcFilterEnabled !== undefined) next.btcFilterEnabled = Boolean(bot.btcFilterEnabled);
      if (isN(bot.minLiqSafetyPct)) next.minLiqSafetyPct = bot.minLiqSafetyPct;
      if (isN(bot.minVolumeUsdt)) next.minVolM = Math.max(0, Math.round((bot.minVolumeUsdt as number) / 1_000_000));
      if (isN(bot.maxSpreadBps)) next.maxSpreadBps = bot.maxSpreadBps;
      if (bot.minTier) next.minTier = bot.minTier;
      if (isN(bot.minScore)) next.minScore = bot.minScore;
      if (isN(bot.strongScore)) next.strongScore = bot.strongScore;
      if (isN(bot.watchScore)) next.watchScore = bot.watchScore;
      if (isN(bot.takerFee)) next.takerFee = bot.takerFee;
      if (isN(bot.makerFee)) next.makerFee = bot.makerFee;
      if (isN(bot.slippage)) next.slip = bot.slippage;
      if (Array.isArray(bot.tpPcts) && bot.tpPcts.length === 3) next.tpPcts = [bot.tpPcts[0], bot.tpPcts[1], bot.tpPcts[2]];
      if (isN(bot.limitExpireBars)) next.limitExpireBars = bot.limitExpireBars;
      if (isN(bot.cancelChasedAtr)) next.cancelChasedAtr = bot.cancelChasedAtr;
      if (bot.allowReentry !== undefined) next.allowReentry = Boolean(bot.allowReentry);
      if (isN(bot.reentryCooldownBars)) next.reentryCooldownBars = bot.reentryCooldownBars;
      if (bot.trailingStopEnabled !== undefined) next.trailingStopEnabled = Boolean(bot.trailingStopEnabled);
      if (bot.filterFlags) {
        next.filterFlags = { ...this.settingsData.filterFlags, ...bot.filterFlags };
      }
      if (bot.notifyPrefs) {
        next.notifyPrefs = { ...this.settingsData.notifyPrefs, ...bot.notifyPrefs };
      }
      if (bot.earlyWeights) {
        next.earlyWeights = normalizeEarlyWeights(bot.earlyWeights);
      }
      if (bot.smartProfitShield !== undefined) next.smartProfitShield = Boolean(bot.smartProfitShield);
      if (bot.smartTakeProfitEnabled !== undefined) next.smartTakeProfitEnabled = Boolean(bot.smartTakeProfitEnabled);
      if (isN(bot.smartTakeProfitMinR)) next.smartTakeProfitMinR = Number(bot.smartTakeProfitMinR);
      if (isN(bot.smartTakeProfitPartialPct)) next.smartTakeProfitPartialPct = Number(bot.smartTakeProfitPartialPct);
      if (bot.smartTakeProfitSensitivity) next.smartTakeProfitSensitivity = bot.smartTakeProfitSensitivity;
    }
    if (isN(walletBalance) && (walletBalance as number) > 0) {
      next.equity = +(walletBalance as number).toFixed(2);
    }
    if (!Object.keys(next).length) return;
    this.settingsData = { ...this.settingsData, ...next };
    lsSet('cxp.settings.v1', this.settingsData);
    this.bus.emit('settings', this.settingsData);
  }

  resetSettings() {
    this.settingsData = {
      ...DEFAULT_CLIENT_SETTINGS,
      filterFlags: { ...DEFAULT_CLIENT_SETTINGS.filterFlags },
      notifyPrefs: { ...DEFAULT_CLIENT_SETTINGS.notifyPrefs },
      earlyWeights: { ...DEFAULT_EARLY_WEIGHTS },
    };
    lsSet('cxp.settings.v1', this.settingsData);
    this.bus.emit('settings', this.settingsData);
  }

  tfs(): ModeConfig {
    return resolveModeConfig(this.settingsData.mode, this.settingsData.earlyTriggerTf);
  }

  engineCfg(): Partial<EngineConfig> {
    const d = this.settingsData;
    const watchScore = Math.max(40, Math.min(85, Math.round(d.watchScore || 62)));
    const minScore = Math.max(watchScore + 2, Math.min(92, Math.round(d.minScore || 70)));
    const strongScore = Math.max(minScore + 2, Math.min(98, Math.round(d.strongScore || 80)));
    return {
      mode: d.mode,
      earlyTriggerTf: d.earlyTriggerTf || '15m',
      minScore,
      strongScore,
      watchScore,
      equity: +d.equity,
      riskPct: +d.riskPct,
      maxLev: +d.maxLev,
      mmr: d.mmr,
      takerFee: d.takerFee,
      makerFee: d.makerFee,
      slip: d.slip,
      minLiqSafetyPct: d.minLiqSafetyPct,
      tpPcts: d.tpPcts || [40, 35, 25],
      limitExpireBars: d.limitExpireBars ?? 8,
      cancelChasedAtr: d.cancelChasedAtr ?? 2.4,
      trailingStopEnabled: d.trailingStopEnabled !== false,
      cooldownBars: d.reentryCooldownBars ?? DEFAULTS.cooldownBars,
      useFvgFilter: d.filterFlags?.useFvg !== false,
      useObFilter: d.filterFlags?.useOb !== false,
      useChochBosFilter: d.filterFlags?.useChochBos !== false,
      useMomentumFilter: d.filterFlags?.useMomentum !== false,
      earlyWeights: d.earlyWeights || DEFAULT_EARLY_WEIGHTS,
      smartProfitShield: d.smartProfitShield !== false,
      smartTakeProfitEnabled: d.smartTakeProfitEnabled !== false,
      smartTakeProfitMinR: d.smartTakeProfitMinR ?? 0.6,
      smartTakeProfitPartialPct: d.smartTakeProfitPartialPct ?? 50,
      smartTakeProfitSensitivity: d.smartTakeProfitSensitivity || 'balanced',
    };
  }

  roles(): string[] {
    const t = this.tfs();
    return [...new Set([t.trigger, t.setup, t.trend, t.htf].filter(Boolean) as string[])];
  }

  rec(sym: string): SymbolRecord {
    if (!this.storeState.recs[sym]) {
      this.storeState.recs[sym] = {
        sym,
        meta: this.storeState.meta[sym] || {},
        price: NaN,
        priceT: 0,
        mark: NaN,
        index: NaN,
        funding: NaN,
        next: 0,
        chg: NaN,
        vol: 0,
        hi: NaN,
        lo: NaN,
        candles: {},
        micro: {},
        microAt: 0,
        ready: false,
        loading: false,
        err: '',
        report: null,
        ctx: null,
        ctxKey: '',
        deriv: null,
        derivAt: 0,
        book: null,
        bookAt: 0,
        bbo: null,
        depthLive: null,
        lastAn: 0,
      };
    }
    return this.storeState.recs[sym];
  }

  closed(sym: string, tf: string): Candle[] {
    const r = this.storeState.recs[sym];
    const a = r && r.candles[tf];
    if (!a || !a.length) return [];
    const l = a[a.length - 1];
    return l.x === false ? a.slice(0, -1) : a;
  }

  now(): number {
    return Date.now() + this.apiState.offset;
  }

  private usedNow() {
    const n = Date.now();
    if (n - this.apiState.win > 60000) {
      this.apiState.win = n;
      this.apiState.used = 0;
    }
    return this.apiState.used;
  }

  private fdOk() {
    const n = Date.now();
    this.apiState.fd = this.apiState.fd.filter((t) => n - t < 300000);
    return this.apiState.fd.length < 850;
  }

  private pump() {
    while (this.apiState.active < this.apiState.maxActive && this.apiState.q.length) {
      const n = Date.now();
      if (n < this.apiState.banUntil) {
        setTimeout(() => this.pump(), this.apiState.banUntil - n + 50);
        return;
      }
      this.apiState.q.sort((a, b) => a.pr - b.pr);
      const j = this.apiState.q[0];
      if (this.usedNow() + j.w > 1700) {
        setTimeout(() => this.pump(), 2000);
        return;
      }
      if (j.fd && !this.fdOk()) {
        setTimeout(() => this.pump(), 3000);
        return;
      }
      this.apiState.q.shift();
      this.runJob(j);
    }
  }

  private async runJob(j: any) {
    this.apiState.active++;
    this.apiState.used += j.w;
    if (j.fd) this.apiState.fd.push(Date.now());
    try {
      const qs = Object.entries(j.params || {})
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      const url = this.settingsData.apiBase.replace(/\/+$/, '') + j.path + (qs ? '?' + qs : '');
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      let r: Response;
      try {
        r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      } finally {
        clearTimeout(to);
      }
      const uw = r.headers.get('x-mbx-used-weight-1m');
      if (uw && +uw > this.apiState.used) this.apiState.used = +uw;
      if (r.status === 429 || r.status === 418) {
        const ra = (Number(r.headers.get('retry-after')) || 30) * 1000;
        this.apiState.banUntil = Date.now() + ra;
        this.apiState.lastErr = 'تجاوز حد الطلبات — انتظار ' + Math.round(ra / 1000) + 'ث';
        if (++j.tries <= 3) this.apiState.q.unshift(j);
        else j.rej(new Error('RATE_LIMIT'));
        return;
      }
      if (r.status === 451 || r.status === 403) {
        this.apiState.geo = true;
        throw new Error('GEO_BLOCK');
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100));
      }
      const data = await r.json();
      this.apiState.ok++;
      this.apiState.geo = false;
      j.res(data);
    } catch (e: any) {
      this.apiState.fail++;
      this.apiState.lastErr = String(e?.message || e);
      const retriable = e?.name === 'AbortError' || e instanceof TypeError || /HTTP 5\d\d/.test(this.apiState.lastErr);
      if (retriable && ++j.tries <= 2) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, j.tries)));
        this.apiState.q.unshift(j);
      } else {
        j.rej(e);
      }
    } finally {
      this.apiState.active--;
      this.pump();
    }
  }

  apiGet<T = any>(path: string, params?: Record<string, any> | null, o?: { weight?: number; ttl?: number; fd?: boolean; pr?: number }): Promise<T> {
    const opts = o || {};
    const key = path + JSON.stringify(params || {});
    if (opts.ttl) {
      const c = this.apiState.cache.get(key);
      if (c && Date.now() - c.t < opts.ttl) return Promise.resolve(c.d);
    }
    if (this.apiState.inflight.has(key)) return this.apiState.inflight.get(key)!;
    const p = new Promise<T>((res, rej) => {
      this.apiState.q.push({ path, params, w: opts.weight || 1, fd: !!opts.fd, pr: opts.pr || 5, res, rej, tries: 0 });
      this.pump();
    })
      .then((d) => {
        if (opts.ttl) this.apiState.cache.set(key, { t: Date.now(), d });
        return d;
      })
      .finally(() => this.apiState.inflight.delete(key));
    this.apiState.inflight.set(key, p);
    return p;
  }

  K = (a: any[]): Candle => ({
    t: a[0],
    o: +a[1],
    h: +a[2],
    l: +a[3],
    c: +a[4],
    v: +a[5],
    T: a[6],
    q: +a[7],
    n: a[8],
    V: +a[9],
    Q: +a[10],
    x: a[6] < Date.now() + this.apiState.offset,
  });

  async syncTime() {
    try {
      const r = await this.apiGet('/fapi/v1/time', null, { pr: 1 });
      this.apiState.offset = r.serverTime - Date.now();
    } catch {
      // ignore
    }
  }

  async klines(sym: string, tf: string, limit = 499, endTime?: number | null, pr = 5): Promise<Candle[]> {
    const raw = await this.apiGet(
      '/fapi/v1/klines',
      { symbol: sym, interval: tf, limit, endTime },
      { weight: limit >= 500 ? 5 : limit >= 100 ? 2 : 1, pr }
    );
    return raw.map(this.K);
  }

  async klinesLong(sym: string, tf: string, want: number, onProg?: (p: number) => void): Promise<Candle[]> {
    let out: Candle[] = [];
    let end: number | null = null;
    while (out.length < want) {
      const need = Math.min(1000, want - out.length);
      const part = await this.klines(sym, tf, Math.max(need, 500), end, 8);
      if (!part.length) break;
      out = part.concat(out);
      end = part[0].t - 1;
      onProg?.(Math.min(1, out.length / want));
      if (part.length < 500) break;
    }
    const seen = new Set<number>();
    out = out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)));
    return out.slice(-want);
  }

  async exchangeInfo(): Promise<Record<string, SymbolMeta>> {
    const r = await this.apiGet('/fapi/v1/exchangeInfo', null, { ttl: 3600e3, pr: 1 });
    const m: Record<string, SymbolMeta> = {};
    for (const s of r.symbols) {
      if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT' || s.status !== 'TRADING' || !/^[A-Z0-9]+USDT$/.test(s.symbol)) continue;
      const f: Record<string, any> = {};
      for (const x of s.filters) f[x.filterType] = x;
      m[s.symbol] = {
        sym: s.symbol,
        base: s.baseAsset,
        tick: +(f.PRICE_FILTER && f.PRICE_FILTER.tickSize) || 0,
        step: +(f.LOT_SIZE && f.LOT_SIZE.stepSize) || 0,
        minQty: +(f.LOT_SIZE && f.LOT_SIZE.minQty) || 0,
        minNotional: +(f.MIN_NOTIONAL && (f.MIN_NOTIONAL.notional || f.MIN_NOTIONAL.minNotional)) || 5,
        onboard: s.onboardDate || 0,
        pp: s.pricePrecision,
        qp: s.quantityPrecision,
      };
    }
    return m;
  }

  async tickers() {
    const r = await this.apiGet('/fapi/v1/ticker/24hr', null, { weight: 40, ttl: 20000, pr: 3 });
    const m: Record<string, { price: number; chg: number; vol: number; hi: number; lo: number }> = {};
    for (const x of r) {
      m[x.symbol] = { price: +x.lastPrice, chg: +x.priceChangePercent, vol: +x.quoteVolume, hi: +x.highPrice, lo: +x.lowPrice };
    }
    return m;
  }

  async premium() {
    const r = await this.apiGet('/fapi/v1/premiumIndex', null, { weight: 10, ttl: 8000, pr: 3 });
    const m: Record<string, { mark: number; index: number; funding: number; next: number }> = {};
    for (const x of r) {
      m[x.symbol] = { mark: +x.markPrice, index: +x.indexPrice, funding: +x.lastFundingRate, next: x.nextFundingTime };
    }
    return m;
  }

  async depth(sym: string, limit = 500) {
    const r = await this.apiGet('/fapi/v1/depth', { symbol: sym, limit }, { weight: 5, ttl: 3000, pr: 4 });
    return {
      bids: r.bids.map((a: any) => [+a[0], +a[1]] as [number, number]),
      asks: r.asks.map((a: any) => [+a[0], +a[1]] as [number, number]),
    };
  }

  async fundingHistory(sym: string, startTime: number, endTime?: number): Promise<{ t: number; r: number }[]> {
    try {
      const params: Record<string, any> = { symbol: sym, startTime, limit: 1000 };
      if (endTime) params.endTime = endTime;
      const arr = await this.apiGet('/fapi/v1/fundingRate', params, { weight: 1, ttl: 60000, pr: 8 });
      if (!Array.isArray(arr)) return [];
      return arr.map((x: any) => ({ t: Number(x.fundingTime), r: Number(x.fundingRate) })).filter((x) => isN(x.t) && isN(x.r));
    } catch {
      return [];
    }
  }

  async fetchDeriv(sym: string): Promise<DerivData | null> {
    const [oi, ls, top, tk] = await Promise.allSettled([
      this.apiGet('/futures/data/openInterestHist', { symbol: sym, period: '15m', limit: 20 }, { fd: true, ttl: 60000, pr: 6 }),
      this.apiGet('/futures/data/globalLongShortAccountRatio', { symbol: sym, period: '15m', limit: 1 }, { fd: true, ttl: 60000, pr: 6 }),
      this.apiGet('/futures/data/topLongShortPositionRatio', { symbol: sym, period: '15m', limit: 1 }, { fd: true, ttl: 60000, pr: 6 }),
      this.apiGet('/futures/data/takerlongshortRatio', { symbol: sym, period: '15m', limit: 4 }, { fd: true, ttl: 60000, pr: 6 }),
    ]);
    const D: DerivData = { t: Date.now() };
    let any = false;
    if (oi.status === 'fulfilled' && oi.value.length >= 17) {
      const a = oi.value.map((x: any) => +x.sumOpenInterestValue || +x.sumOpenInterest);
      const n = a.length;
      D.oiChg1h = 100 * (a[n - 1] / a[n - 5] - 1);
      D.oiChg4h = 100 * (a[n - 1] / a[n - 17] - 1);
      D.oiUsd = a[n - 1];
      any = true;
    }
    if (ls.status === 'fulfilled' && ls.value.length) {
      D.lsRatio = +ls.value[0].longShortRatio;
      D.lsLongPct = +ls.value[0].longAccount * 100;
      any = true;
    }
    if (top.status === 'fulfilled' && top.value.length) {
      D.topLongPct = +top.value[0].longAccount * 100;
      any = true;
    }
    if (tk.status === 'fulfilled' && tk.value.length) {
      let b = 0;
      let s = 0;
      for (const x of tk.value) {
        b += +x.buyVol;
        s += +x.sellVol;
      }
      if (s > 0) {
        D.takerRatio = b / s;
        any = true;
      }
    }
    return any ? D : null;
  }

  liq15(sym: string) {
    const cut = Date.now() - 15 * 60e3;
    let l = 0;
    let s = 0;
    for (const x of this.storeState.liq) {
      if (x.sym === sym && x.t >= cut) {
        if (x.side === 'SELL') l += x.usd;
        else s += x.usd;
      }
    }
    return { liqLong15: l, liqShort15: s };
  }

  bookCalc(dp: { bids: [number, number][]; asks: [number, number][] }): OrderBookAnalysis | null {
    if (!dp.bids.length || !dp.asks.length) return null;
    const bb = dp.bids[0][0];
    const ba = dp.asks[0][0];
    const mid = (bb + ba) / 2;
    const cover = Math.min(mid - dp.bids[dp.bids.length - 1][0], dp.asks[dp.asks.length - 1][0] - mid);
    const band = Math.min(0.005 * mid, cover);
    let bid = 0;
    let ask = 0;
    for (const [p, q] of dp.bids) {
      if (p < mid - band) break;
      bid += p * q;
    }
    for (const [p, q] of dp.asks) {
      if (p > mid + band) break;
      ask += p * q;
    }
    const wall = (side: [number, number][]) => {
      const lv = side.filter(([p]) => Math.abs(p - mid) <= cover).map(([p, q]) => [p, p * q]);
      if (lv.length < 10) return null;
      const mean = lv.reduce((s, x) => s + x[1], 0) / lv.length;
      let best: { p: number; usd: number } | null = null;
      for (const x of lv) {
        if (x[1] >= 5 * mean && (!best || x[1] > best.usd)) best = { p: x[0], usd: x[1] };
      }
      return best;
    };
    return {
      imb05: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0,
      bandPct: (100 * band) / mid,
      spreadBps: (1e4 * (ba - bb)) / mid,
      bid05: bid,
      ask05: ask,
      bidWall: wall(dp.bids),
      askWall: wall(dp.asks),
      bids: dp.bids.slice(0, 60),
      asks: dp.asks.slice(0, 60),
      mid,
      t: Date.now(),
    };
  }

  private mergeCandles(r: SymbolRecord, tf: string, arr: Candle[]) {
    const a = r.candles[tf];
    if (!a) {
      r.candles[tf] = arr.slice();
      return;
    }
    for (const c of arr) {
      const l = a[a.length - 1];
      if (!l || c.t > l.t) {
        if (l && l.x === false && c.t > l.t) l.x = true;
        a.push(c);
      } else if (c.t === l.t) {
        a[a.length - 1] = c;
      } else {
        for (let k = a.length - 2; k >= 0 && a[k].t >= c.t; k--) {
          if (a[k].t === c.t) {
            a[k] = c;
            break;
          }
        }
      }
    }
    if (a.length > 1100) a.splice(0, a.length - 1000);
  }

  private applyKline(d: any) {
    const r = this.storeState.recs[d.s];
    if (!r) return;
    const k = d.k;
    const cd: Candle = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, q: +k.q, V: +k.V, Q: +k.Q, n: k.n, x: !!k.x, T: k.T };

    if (k.i === '1m' || k.i === '5m') {
      const mArr = r.micro[k.i];
      if (mArr && mArr.length) {
        const ml = mArr[mArr.length - 1];
        if (cd.t === ml.t) mArr[mArr.length - 1] = cd;
        else if (cd.t > ml.t) {
          ml.x = true;
          mArr.push(cd);
          if (mArr.length > 150) mArr.splice(0, 30);
        }
        r.microAt = Date.now();
        if (d.s === this.storeState.active && k.i === '1m') {
          r.price = cd.c;
          r.priceT = Date.now();
          this.bus.emit('tick', d.s);
        }
      }
    }

    const a = r.candles[k.i];
    if (!a || !a.length) return;
    const l = a[a.length - 1];
    if (cd.t === l.t) a[a.length - 1] = cd;
    else if (cd.t > l.t) {
      l.x = true;
      a.push(cd);
      if (a.length > 1100) a.splice(0, 100);
    } else return;

    if (k.i === this.tfs().trigger) {
      r.price = cd.c;
      r.priceT = Date.now();
      this.bus.emit('tick', d.s);
    }
    if (cd.x) this.bus.emit('bar-close', { sym: d.s, tf: k.i, t: cd.t });
  }

  async loadSymbol(sym: string, pr = 5) {
    const r = this.rec(sym);
    if (r.loading) return r.ready;
    r.loading = true;
    r.err = '';
    const tfs = this.tfs();
    try {
      const list = this.roles();
      const res = await Promise.all(list.map((tf) => this.klines(sym, tf, tf === tfs.htf ? 120 : 499, null, pr)));
      list.forEach((tf, k) => {
        r.candles[tf] = res[k];
      });
      const tr = r.candles[tfs.trigger];
      if (tr && tr.length && !isN(r.price)) r.price = tr[tr.length - 1].c;
      r.ready = true;
    } catch (e: any) {
      r.err = String(e?.message || e);
      r.ready = false;
    }
    r.loading = false;
    this.bus.emit('loaded', sym);
    return r.ready;
  }

  async ensureFresh(sym: string) {
    const r = this.storeState.recs[sym];
    if (!r || !r.ready) return;
    const now = this.now();
    for (const tf of this.roles()) {
      const ms = TF_MS[tf];
      const a = r.candles[tf];
      if (!a || !a.length) continue;
      const expected = Math.floor(now / ms) * ms;
      const last = a[a.length - 1];
      if (last.t < expected || last.x === false) {
        const miss = Math.ceil((expected - last.t) / ms) + 2;
        if (miss > 480) {
          r.ready = false;
          r.loading = false;
          await this.loadSymbol(sym, 4);
          return;
        }
        try {
          this.mergeCandles(r, tf, await this.klines(sym, tf, Math.max(3, miss), null, 4));
        } catch {
          // ignore transient fetch errors
        }
      }
    }
  }

  private effDeriv(r: SymbolRecord): DerivData | null {
    let D = r.deriv && Date.now() - r.derivAt < 15 * 60e3 ? { ...r.deriv } : null;
    if (isN(r.funding)) {
      D = D || {};
      D.funding = r.funding;
      D.fundingMs = r.next;
      if (isN(r.mark) && isN(r.index) && r.index) D.basisBps = (1e4 * (r.mark - r.index)) / r.index;
    }
    if (D) Object.assign(D, this.liq15(r.sym));
    return D;
  }

  private effBook(r: SymbolRecord): OrderBookAnalysis | null {
    if (!r.book || Date.now() - r.bookAt > 90e3) return null;
    const b = { ...r.book };
    if (r.bbo && Date.now() - r.bbo.t < 10e3) b.spreadBps = r.bbo.spreadBps;
    return b;
  }

  getBtcContext(): BtcContext | null {
    const r = this.storeState.recs['BTCUSDT'];
    if (!r || !r.ready) return null;
    const tfs = this.tfs();
    const cs: Record<string, Candle[]> = {};
    let key = `${this.settingsData.mode}|${this.settingsData.earlyTriggerTf}|`;
    for (const tf of this.roles()) {
      const a = this.closed('BTCUSDT', tf);
      cs[tf] = a;
      key += `${tf}:${a.length ? a[a.length - 1].t : 0},`;
    }
    if (this.btcCtxCache.key === key && this.btcCtxCache.ctx) {
      return this.btcCtxCache.ctx;
    }
    if ((cs[tfs.trigger] || []).length < 120 || (cs[tfs.setup] || []).length < 90 || (cs[tfs.trend] || []).length < 90) {
      return null;
    }
    let ctx = r.ctx;
    const rawKey = key.split('|')[1] || '';
    if (!ctx || r.ctxKey !== rawKey) {
      ctx = prepare(cs, tfs, r.meta, this.engineCfg());
      r.ctx = ctx;
      r.ctxKey = rawKey;
    }
    const btcCtx = buildBtcContext(ctx, this.now());
    this.btcCtxCache = { key, ctx: btcCtx };
    return btcCtx;
  }

  analyze(sym: string, force = false): SignalEvaluation | null {
    const r = this.rec(sym);
    if (!r.ready) return null;
    const tfs = this.tfs();
    const cs: Record<string, Candle[]> = {};
    let key = '';
    for (const tf of this.roles()) {
      const a = this.closed(sym, tf);
      cs[tf] = a;
      key += `${tf}:${a.length ? a[a.length - 1].t : 0},`;
    }
    if ((cs[tfs.trigger] || []).length < 120 || (cs[tfs.setup] || []).length < 90 || (cs[tfs.trend] || []).length < 90) {
      r.err = 'تاريخ غير كافٍ';
      r.report = null;
      return null;
    }
    let ctx = r.ctx;
    if (force || !ctx || r.ctxKey !== key) {
      ctx = prepare(cs, tfs, r.meta, this.engineCfg());
      r.ctx = ctx;
      r.ctxKey = key;
    }
    ctx.cfg = { ...DEFAULTS, ...this.engineCfg() };
    const T = ctx.B.trigger;
    if (!T) return null;
    const price = isN(r.price) ? r.price : T.c[T.n - 1];
    const btcContext = sym === 'BTCUSDT' ? null : this.getBtcContext();
    const microCandles: Record<string, Candle[]> = {
      ...(r.micro || {}),
    };
    if (!microCandles['5m']?.length && r.candles['5m']?.length) {
      microCandles['5m'] = r.candles['5m'].slice(-90);
    }
    const R = evaluate(ctx, T.n - 1, {
      price,
      deriv: this.effDeriv(r),
      book: this.effBook(r),
      btcContext,
      microCandles,
      vol24h: isN(r.vol) && r.vol > 0 ? r.vol : null,
      minVolumeUsdt: this.settingsData.minVolM * 1e6,
      maxSpreadBps: this.settingsData.maxSpreadBps ?? 8,
      now: this.now(),
    });
    r.report = R;
    r.lastAn = Date.now();
    r.err = '';
    this.bus.emit('report', sym);
    return R;
  }

  async enrich(sym: string, withBook = true) {
    const r = this.rec(sym);
    const needMicro = !r.micro['1m']?.length || Date.now() - r.microAt > 45e3;
    const tasks: Promise<any>[] = [
      this.fetchDeriv(sym).then((D) => {
        if (D) {
          r.deriv = D;
          r.derivAt = Date.now();
        }
      }),
    ];
    if (withBook) {
      tasks.push(
        this.depth(sym, 500).then((dp) => {
          const b = this.bookCalc(dp);
          if (b) {
            r.book = b;
            r.bookAt = Date.now();
          }
        })
      );
    }
    if (needMicro) {
      tasks.push(
        this.klines(sym, '1m', 90, null, 4).then((arr) => {
          if (arr?.length) {
            r.micro['1m'] = arr;
            r.microAt = Date.now();
          }
        })
      );
      if (!r.candles['5m']?.length) {
        tasks.push(
          this.klines(sym, '5m', 90, null, 4).then((arr) => {
            if (arr?.length) {
              r.micro['5m'] = arr;
              r.microAt = Date.now();
            }
          })
        );
      } else {
        r.micro['5m'] = r.candles['5m'].slice(-90);
      }
    }
    await Promise.allSettled(tasks);
  }

  /* ---- Signals Storage ---- */
  getSignals(): TrackedSignal[] {
    return this.signalsList;
  }
  getLiveSignals(): TrackedSignal[] {
    return this.signalsList.filter(isLive);
  }
  saveSignals(syncRemote = true) {
    const live = this.signalsList.filter(isLive);
    const done = this.signalsList.filter((x) => !isLive(x)).slice(-300);
    this.signalsList = this.signalsList.filter((x) => live.includes(x) || done.includes(x));
    lsSet('cxp.signals.v1', this.signalsList);
    this.bus.emit('signals-changed', this.signalsList);
    if (syncRemote && typeof window !== 'undefined' && navigator.onLine) {
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        fetch('/api/signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sync', signals: this.signalsList.slice(-80) }),
        }).catch(() => undefined);
      }, 800);
    }
  }
  mergeRemoteSignals(remote: TrackedSignal[]) {
    if (!Array.isArray(remote) || !remote.length) return;
    const byId = new Map<string, TrackedSignal>();
    for (const s of this.signalsList) byId.set(s.id, s);
    let changed = false;
    for (const r of remote) {
      if (!r || !r.id) continue;
      const cur = byId.get(r.id);
      if (!cur) {
        byId.set(r.id, r);
        changed = true;
      } else {
        const rDone = !isLive(r) && isLive(cur);
        const rNewer = (r.lastT || 0) > (cur.lastT || 0);
        if (rDone || rNewer) {
          byId.set(r.id, r);
          changed = true;
        }
      }
    }
    if (changed) {
      this.signalsList = [...byId.values()]
        .sort((a, b) => (a.t0 || 0) - (b.t0 || 0))
        .slice(-300);
      this.saveSignals(false);
    }
  }
  clearSignals() {
    this.signalsList = [];
    this.saveSignals(false);
    if (typeof window !== 'undefined') {
      fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      }).catch(() => undefined);
    }
  }
  private pushSignalTelemetry(s: TrackedSignal, closed = false) {
    if (typeof window === 'undefined' || !navigator.onLine) return;
    const record: SignalTelemetryRecord = {
      id: `sig-tel-${s.id}`,
      userId: 'default',
      symbol: s.sym,
      side: s.dir > 0 ? 'LONG' : 'SHORT',
      strategyMode: s.strategyMode || s.mode || 'intraday',
      entryKind: s.earlyEntry?.entryKind || 'CONFIRMED_ENTRY',
      entryStatus: s.earlyEntry?.entryStatus || 'CONFIRMED',
      timeframe: s.tfs?.trigger || '15m',
      regime: s.regime || 'RANGING',
      score: s.score,
      rawScore: s.evalSnapshot?.rawScore ?? s.score,
      signalPrice: s.price0 || s.entry,
      entryPrice: s.entry,
      fillPrice: s.tFill ? s.entry : null,
      distanceMovedPct: s.earlyEntry?.distanceMovedPct ?? 0,
      delayMs: s.tFill ? Math.max(0, s.tFill - s.t0) : null,
      stillValid: s.earlyEntry?.stillValid ?? s.status !== 'CANCELLED',
      earlyReason: s.earlyEntry?.earlyReason || s.headline,
      confirmFactors: s.earlyEntry?.confirmFactors || s.confirmBits || [],
      missingConfirmations: s.earlyEntry?.missingConfirmations || [],
      scoreBreakdown: s.earlyEntry?.breakdown,
      takenByUserOrAuto: true,
      outcome: closed ? s.outcome || null : null,
      closeReason: closed ? s.outcome || null : null,
      netR: closed && isN(s.R) ? Number(s.R) : null,
      mfeR: closed && isN(s.maxFav) ? Number(s.maxFav) : null,
      maeR: closed && isN(s.maxAdv) ? Number(s.maxAdv) : null,
      tp1Hit: Boolean(s.tps?.[0]?.hit),
      tp2Hit: Boolean(s.tps?.[1]?.hit),
      tp3Hit: Boolean(s.tps?.[2]?.hit),
      wasLateEntry: Boolean(s.earlyEntry?.fomoChasing || (s.earlyEntry?.distanceMovedPct ?? 0) > 1.8),
      missedOpportunity: s.status === 'CANCELLED' && (s.outcome === 'EXPIRED' || s.outcome === 'MISSED'),
      createdAt: new Date(s.t0).toISOString(),
      closedAt: closed ? new Date(s.tEnd || Date.now()).toISOString() : null,
    };
    fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'record', record }),
    }).catch(() => undefined);
  }

  manualCloseSignal(s: TrackedSignal) {
    const price = this.rec(s.sym).price;
    if (s.status === 'PENDING') {
      s.status = 'CANCELLED';
      s.outcome = 'CANCELLED_MANUAL';
      s.tEnd = Date.now();
    } else if (s.status === 'OPEN' && isN(price)) {
      s.realized += (s.remaining * s.dir * (price - s.entry)) / s.risk;
      s.remaining = 0;
      s.exitPrice = price;
      s.status = 'CLOSED';
      s.outcome = 'MANUAL';
      s.tEnd = Date.now();
      s.R = s.realized - s.feeR - s.fundingR;
    }
    this.saveSignals();
    if (s.status === 'CLOSED' || s.status === 'CANCELLED') {
      this.pushSignalTelemetry(s, true);
    }
    this.refreshStreams();
  }

  /* ---- Notifications: Audio / Browser / Telegram ---- */
  signalText(s: TrackedSignal) {
    const L = s.dir > 0;
    const P = (p: number) => fmtP(p, s.tick);
    const pc = (x: number) => `${((100 * Math.abs(x - s.entry)) / s.entry).toFixed(2)}%`;
    const earlyTag = s.earlyEntry?.entryKind === 'EARLY_ENTRY' ? `⚡ EARLY ${L ? 'LONG' : 'SHORT'}` : `إشارة ${L ? 'LONG 🟢' : 'SHORT 🔴'}`;
    const lines = [
      `${L ? '🟢' : '🔴'} ${earlyTag} — ${s.sym}`,
      `الدرجة ${s.score}/100 · ${s.grade} · ${s.tier} · إطار ${s.tfs.trigger} (${MODES[s.mode]?.label || s.mode})`,
      ...(s.earlyEntry ? [`🎯 ${s.earlyEntry.entryStatus} · تحرك ${s.earlyEntry.distanceMovedPct.toFixed(2)}% · متبقي ${s.earlyEntry.remainingRR1.toFixed(2)}R · ${s.earlyEntry.earlyReason}`] : []),
      '',
      s.type === 'MARKET'
        ? `⚡ دخول سوقي الآن عند ${P(s.entry)} (= السعر الحالي)`
        : `⏳ أمر Limit عند ${P(s.entry)} (السعر الحالي ${P(s.price0)})`,
      `🛑 وقف الخسارة: ${P(s.stop)} (${pc(s.stop)}) — خلف ${s.stopRef}`,
      `🎯 TP1 ${P(s.tps[0].p)} (${s.rr[0].toFixed(1)}R) · TP2 ${P(s.tps[1].p)} (${s.rr[1].toFixed(1)}R) · TP3 ${P(s.tps[2].p)} (${s.rr[2].toFixed(1)}R)`,
      '',
      s.type === 'MARKET' ? '❓ لماذا السعر الحالي هو سعر الدخول؟' : '❓ لماذا ليس السعر الحالي؟',
      ...s.checks.slice(0, 4).map((c) => `${c.ok === true ? '✔' : c.ok === false ? '✘' : '•'} ${c.label}: ${c.detail}`),
      '',
      '📊 أقوى الأسباب:',
      ...s.reasons.slice(0, 3).map((r) => `• ${r.label}: ${r.detail}`),
    ];
    if (s.size && s.size.ok) {
      lines.push('', `💼 الحجم (رصيد ${s.equity}$ · مخاطرة ${s.riskPct}%): ${s.size.qty} · رافعة ${s.size.lev}x · هامش ≈ ${s.size.margin.toFixed(1)}$`);
    }
    if (s.warnings?.length) lines.push('', ...s.warnings.map((w) => '⚠ ' + w));
    lines.push('', 'تداول تجريبي/تحليلي — ليست نصيحة مالية.');
    return lines.join('\n');
  }

  eventText(s: TrackedSignal, ev: string) {
    const P = (p: number) => fmtP(p, s.tick);
    const m: Record<string, string> = {
      FILLED: `✅ تم تنفيذ أمر ${s.sym} ${s.dir > 0 ? 'LONG' : 'SHORT'} عند ${P(s.entry)}`,
      TP1: `🎯 ${s.sym}: تحقق TP1 (${P(s.tps[0].p)}) — انقل الوقف إلى نقطة التعادل`,
      TP2: `🎯🎯 ${s.sym}: تحقق TP2 (${P(s.tps[1].p)}) — ثبّت الوقف عند TP1`,
      TP3: `🏆 ${s.sym}: تحقق TP3 — أُغلقت الصفقة ${s.R != null ? `(${s.R.toFixed(2)}R)` : ''}`,
      SL: `🛑 ${s.sym}: ضُرب الوقف ${s.R != null ? `(${s.R.toFixed(2)}R)` : ''}`,
      BE: `⚖ ${s.sym}: أُغلقت عند التعادل/الوقف المتحرك ${s.R != null ? `(${s.R.toFixed(2)}R)` : ''}`,
      EXPIRED: `⌛ ${s.sym}: انتهت صلاحية الأمر المعلق دون تنفيذ`,
      MISSED: `↗ ${s.sym}: ابتعد السعر دون تنفيذ الأمر — أُلغيت الإشارة`,
    };
    return m[ev] || ev;
  }

  beep(kind: 'ok' | 'strong' | 'bad') {
    if (!this.settingsData.soundOn || typeof window === 'undefined') return;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.actx = this.actx || new AC();
      const t0 = this.actx.currentTime;
      const seq = kind === 'bad' ? [330, 247] : kind === 'strong' ? [660, 880, 1100] : [660, 880];
      seq.forEach((f, k) => {
        const o = this.actx!.createOscillator();
        const g = this.actx!.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + k * 0.16);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + k * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + k * 0.16 + 0.15);
        o.connect(g);
        g.connect(this.actx!.destination);
        o.start(t0 + k * 0.16);
        o.stop(t0 + k * 0.16 + 0.16);
      });
    } catch {
      // ignore
    }
  }

  async telegram(text: string): Promise<{ ok: boolean; err?: string }> {
    const c = this.settingsData;
    if (!c.tgOn || !c.tgToken || !c.tgChat) return { ok: false, err: 'تيليجرام غير مفعّل' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${c.tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: c.tgChat, text, disable_web_page_preview: true }),
      });
      const j = await r.json();
      return { ok: !!j.ok, err: j.description || '' };
    } catch (e: any) {
      return { ok: false, err: String(e?.message || e) };
    }
  }

  private async browserNotify(title: string, body: string) {
    if (!this.settingsData.notifyOn || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: title });
    } catch {
      // ignore
    }
  }

  private onSignalEmit(s: TrackedSignal) {
    this.bus.emit('toast', {
      id: `${s.id}-${Date.now()}`,
      kind: s.dir > 0 ? 'long' : 'short',
      title: `${s.sym} ${s.dir > 0 ? 'LONG' : 'SHORT'} · ${s.score} · ${s.type === 'MARKET' ? 'دخول سوقي ' : 'Limit '}${fmtP(s.entry, s.tick)}`,
      sig: s,
    } as ToastItem);
    this.beep(s.tier === 'STRONG' ? 'strong' : 'ok');
    if (this.settingsData.vibrateOn && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([120, 60, 120]);
    }
    this.browserNotify(
      `${s.sym} ${s.dir > 0 ? 'LONG' : 'SHORT'} (${s.score})`,
      `دخول ${fmtP(s.entry, s.tick)} · وقف ${fmtP(s.stop, s.tick)} · TP1 ${fmtP(s.tps[0].p, s.tick)}`
    );
    this.telegram(this.signalText(s));
  }

  private onEventEmit(s: TrackedSignal, ev: string) {
    const txt = this.eventText(s, ev);
    this.bus.emit('toast', {
      id: `${s.id}-${ev}-${Date.now()}`,
      kind: ev === 'SL' ? 'bad' : 'info',
      title: txt,
      sig: s,
    } as ToastItem);
    this.beep(ev === 'SL' ? 'bad' : 'ok');
    this.browserNotify(s.sym, txt);
    this.telegram(txt);
  }

  /* ---- Signal Generation & 1m Tracking ---- */
  async considerSignal(sym: string) {
    const cfg = this.settingsData;
    const r = this.rec(sym);
    let R = r.report;
    if (!R || !R.plan || !R.plan.ok || !(R.tier === 'GOOD' || R.tier === 'STRONG') || RANK[R.tier] < RANK[cfg.minTier]) return;

    const tfs = this.tfs();
    const ms = TF_MS[tfs.trigger];
    const mine = this.signalsList.filter((s) => s.sym === sym);
    if (mine.some(isLive)) return;
    const last = mine[mine.length - 1];
    const cooldownBars = cfg.allowReentry === false ? 99999 : (cfg.reentryCooldownBars ?? DEFAULTS.cooldownBars);
    if (last && Date.now() - last.t0 < cooldownBars * ms) return;
    if (this.now() - R.tClose > 2 * ms) return;
    if (this.getLiveSignals().length >= 6) return;

    let price = r.price;
    try {
      const p = await this.apiGet('/fapi/v1/ticker/price', { symbol: sym }, { weight: 1, pr: 2 });
      price = +p.price;
    } catch {
      // use existing price
    }
    if (isN(price) && Math.abs(price - R.price) / R.price > 0.0001) {
      r.price = price;
      r.priceT = Date.now();
      R = this.analyze(sym, false);
      if (!R || !R.plan || !R.plan.ok || RANK[R.tier] < RANK[cfg.minTier]) return;
    }
    if (cfg.liquidityRadarGate && R.orderFlow) {
      if (!R.orderFlow.liquidity.liquidityPass || R.orderFlow.verdict === 'COUNTER_FLOW') {
        return;
      }
    }
    if (this.signalsList.some((s) => s.sym === sym && isLive(s))) return;

    const plan = R.plan;
    const parts = R.parts
      .filter((p) => Math.sign(p.raw) === R!.dir)
      .sort((a, b) => Math.abs(b.raw * b.wEff) - Math.abs(a.raw * a.wEff));
    const baseTrade = newTrade(plan, {
      sym,
      t: Date.now(),
      tier: R.tier,
      score: R.score,
      tfMs: ms,
      id: `${sym}-${R.t}-${plan.long ? 'L' : 'S'}`,
    });
    baseTrade.lastT = Math.floor(Date.now() / 60000) * 60000;

    const sig: TrackedSignal = {
      ...baseTrade,
      headline: headline(R, sym),
      grade: R.grade,
      aligned: R.aligned,
      mode: cfg.mode,
      strategyMode: R.strategyMode || cfg.mode,
      earlyEntry: R.earlyEntry || null,
      tfs,
      price0: price,
      atr: R.atr,
      riskATR: plan.riskATR || 0,
      rr: [plan.rr1 || 0, plan.rr2 || 0, plan.rr3 || 0],
      zone: plan.zone!,
      stopRef: plan.stopRef || '',
      checks: plan.checks || [],
      warnings: plan.warnings || [],
      size: plan.size,
      confirmBits: plan.confirmBits || [],
      reasons: parts.slice(0, 5).map((p) => ({ label: p.label, raw: +p.raw.toFixed(2), detail: p.detail })),
      against: R.parts.filter((p) => Math.sign(p.raw) === -R!.dir && Math.abs(p.raw) >= 0.3).map((p) => ({ label: p.label, detail: p.detail })),
      gates: R.gates,
      regime: R.regime.type,
      tick: r.meta.tick || 0,
      equity: cfg.equity,
      riskPct: cfg.riskPct,
      hasDeriv: !!(R.deriv && isN(R.deriv.oiChg4h)),
      evalSnapshot: R,
    };

    this.signalsList.push(sig);
    this.saveSignals();
    this.pushSignalTelemetry(sig, false);
    this.bus.emit('signal', sig);
    this.onSignalEmit(sig);
    this.refreshStreams();
  }

  async trackAll() {
    for (const s of this.getLiveSignals()) {
      try {
        const beforeStatus = s.status;
        const beforeHits = s.tps.filter((t) => t.hit).length;
        const funding = this.rec(s.sym).funding;
        let more = true;
        let guard = 0;
        while (more && guard++ < 6 && isLive(s)) {
          const arr = await this.apiGet(
            '/fapi/v1/klines',
            { symbol: s.sym, interval: '1m', startTime: s.lastT + 60000, limit: 500 },
            { weight: 2, pr: 2 }
          );
          more = arr.length >= 500;
          for (const a of arr) {
            const k = this.K(a);
            if (!k.x) {
              more = false;
              break;
            }
            btStep(s, k, {
              fundingRate: isN(funding) ? funding : 0,
              smartProfitShield: this.settingsData.smartProfitShield !== false,
              smartTakeProfitEnabled: this.settingsData.smartTakeProfitEnabled !== false,
              smartTakeProfitMinR: this.settingsData.smartTakeProfitMinR ?? 0.6,
              smartTakeProfitPartialPct: this.settingsData.smartTakeProfitPartialPct ?? 50,
              smartTakeProfitSensitivity: this.settingsData.smartTakeProfitSensitivity || 'balanced',
            });
            if (!isLive(s)) break;
          }
        }
        const hits = s.tps.filter((t) => t.hit).length;
        if (beforeStatus === 'PENDING' && s.status !== 'PENDING' && s.status !== 'CANCELLED') {
          this.onEventEmit(s, 'FILLED');
        }
        for (let k = beforeHits + 1; k <= hits && k <= 3; k++) {
          if (!(k === 3 && s.status === 'CLOSED')) this.onEventEmit(s, 'TP' + k);
        }
        if (s.status === 'CLOSED' && beforeStatus !== 'CLOSED') {
          this.onEventEmit(s, s.outcome === 'TP3' ? 'TP3' : s.outcome === 'SL' ? 'SL' : 'BE');
          this.pushSignalTelemetry(s, true);
        }
        if (s.status === 'CANCELLED' && beforeStatus !== 'CANCELLED') {
          this.onEventEmit(s, s.outcome || 'EXPIRED');
          this.pushSignalTelemetry(s, true);
        }
        if (s.status !== beforeStatus || hits !== beforeHits) {
          this.saveSignals();
          this.bus.emit('signal-update', s);
          this.refreshStreams();
        }
      } catch {
        // ignore transient error
      }
    }
    this.saveSignals();
  }

  refreshStreams() {
    const t = this.tfs();
    const m = new Set<string>(['!forceOrder@arr']);
    const p: string[] = [];
    const focus = new Set(this.getLiveSignals().map((s) => s.sym));
    if (this.storeState.active) focus.add(this.storeState.active);
    for (const sym of focus) {
      const s = sym.toLowerCase();
      m.add(`${s}@kline_${t.trigger}`);
      m.add(`${s}@markPrice@1s`);
      if (sym === this.storeState.active) {
        for (const tf of [t.setup, t.trend]) if (tf) m.add(`${s}@kline_${tf}`);
        m.add(`${s}@kline_1m`);
        m.add(`${s}@kline_5m`);
        p.push(`${s}@depth20@500ms`);
      }
    }
    this.marketConn.sync([...m]);
    this.pubConn.sync(p);
  }

  async cycle() {
    if (this.scanState.busy || this.scanState.phase !== 'ready') return;
    this.scanState.busy = true;
    this.bus.emit('scan-state', { ...this.scanState });
    try {
      const uni = this.storeState.universe;
      await Promise.all(uni.map((sym) => this.ensureFresh(sym)));
      this.btcCtxCache = { key: '', ctx: null };
      if (uni.includes('BTCUSDT')) this.analyze('BTCUSDT', false);
      for (const sym of uni) {
        if (sym !== 'BTCUSDT') this.analyze(sym, false);
      }
      const cands = uni
        .map((s) => this.rec(s))
        .filter((r) => r.report && r.report.dir && r.report.rawScore >= 60)
        .sort((a, b) => (b.report?.score || 0) - (a.report?.score || 0))
        .slice(0, 8);
      for (const r of cands) {
        if (Date.now() - r.derivAt > 90e3) await this.enrich(r.sym, true);
        this.analyze(r.sym, false);
      }
      if (this.settingsData.autoScan) {
        for (const sym of uni) await this.considerSignal(sym);
      }
      this.scanState.lastCycle = Date.now();
      this.scanState.cycles++;
    } catch (e: any) {
      this.scanState.errors++;
      this.scanState.msg = String(e?.message || e);
    }
    this.scanState.busy = false;
    this.bus.emit('scan-state', { ...this.scanState });
    this.bus.emit('cycle');
  }

  async boot() {
    this.scanState.phase = 'boot';
    this.scanState.msg = 'مزامنة الوقت…';
    this.scanState.progress = 0.02;
    this.scanState.geo = false;
    this.bus.emit('scan-state', { ...this.scanState });

    try {
      await this.syncTime();
      this.scanState.msg = 'تحميل عقود Binance Futures…';
      this.bus.emit('scan-state', { ...this.scanState });

      this.storeState.meta = await this.exchangeInfo();
      const tk = await this.tickers();
      let pm: Record<string, { mark: number; index: number; funding: number; next: number }> = {};
      try {
        pm = await this.premium();
      } catch {
        // optional
      }

      const c = this.settingsData;
      const favs = c.favorites.filter((s) => this.storeState.meta[s]);
      const minVol = c.minVolM * 1e6;
      const old = Date.now() - 45 * 86400e3;
      const ranked = Object.keys(this.storeState.meta)
        .filter((s) => tk[s] && tk[s].vol >= minVol && (this.storeState.meta[s].onboard || 0) < old)
        .sort((a, b) => tk[b].vol - tk[a].vol);

      this.storeState.universe = [...new Set([...favs, ...ranked])].slice(0, Math.max(c.universe, favs.length));

      for (const sym of Object.keys(tk)) {
        if (!this.storeState.meta[sym]) continue;
        const r = this.rec(sym);
        r.meta = this.storeState.meta[sym];
        Object.assign(r, {
          price: tk[sym].price,
          priceT: Date.now(),
          chg: tk[sym].chg,
          vol: tk[sym].vol,
          hi: tk[sym].hi,
          lo: tk[sym].lo,
        });
        if (pm[sym]) {
          Object.assign(r, { mark: pm[sym].mark, index: pm[sym].index, funding: pm[sym].funding, next: pm[sym].next });
        }
      }

      let done = 0;
      this.scanState.msg = 'تحميل الشموع متعددة الأطر…';
      this.bus.emit('scan-state', { ...this.scanState });

      await Promise.all(
        this.storeState.universe.map(async (sym, k) => {
          await this.loadSymbol(sym, k < 4 ? 2 : 5);
          done++;
          this.scanState.progress = 0.1 + (0.8 * done) / this.storeState.universe.length;
          this.scanState.msg = `تحميل الشموع ${done}/${this.storeState.universe.length}`;
          this.bus.emit('scan-state', { ...this.scanState });
        })
      );

      const ok = this.storeState.universe.filter((s) => this.rec(s).ready);
      if (!ok.length) throw new Error(this.apiState.geo ? 'GEO_BLOCK' : this.apiState.lastErr || 'تعذر تحميل أي رمز');
      this.storeState.universe = ok;
      if (!this.storeState.active || !ok.includes(this.storeState.active)) this.storeState.active = ok[0];

      this.scanState.msg = 'تحليل أولي…';
      this.bus.emit('scan-state', { ...this.scanState });
      this.btcCtxCache = { key: '', ctx: null };
      if (this.storeState.universe.includes('BTCUSDT')) this.analyze('BTCUSDT', true);
      for (const sym of this.storeState.universe) {
        if (sym !== 'BTCUSDT') this.analyze(sym, true);
      }

      this.scanState.phase = 'ready';
      this.scanState.progress = 1;
      this.scanState.msg = '';
      this.scanState.cycleOpen = Math.floor(this.now() / TF_MS[this.tfs().trigger]);
      this.bus.emit('scan-state', { ...this.scanState });
      this.refreshStreams();
      this.bus.emit('boot-done');
      this.enrich(this.storeState.active, true).then(() => this.analyze(this.storeState.active!));
      this.startTimers();
    } catch (e: any) {
      this.scanState.phase = 'error';
      this.scanState.geo = /GEO_BLOCK/.test(String(e?.message)) || this.apiState.geo;
      this.scanState.msg = String(e?.message || e);
      this.bus.emit('scan-state', { ...this.scanState });
    }
  }

  private startTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const every = (f: () => void, ms: number) =>
      this.timers.push(
        setInterval(() => {
          try {
            f();
          } catch (e) {
            console.error(e);
          }
        }, ms)
      );

    every(() => {
      const cur = Math.floor(this.now() / TF_MS[this.tfs().trigger]);
      if (cur !== this.scanState.cycleOpen) {
        this.scanState.cycleOpen = cur;
        setTimeout(() => this.cycle(), 2500);
      }
    }, 1000);

    every(async () => {
      try {
        const pm = await this.premium();
        for (const sym of this.storeState.universe) {
          const r = this.rec(sym);
          const p = pm[sym];
          if (!p) continue;
          if (!r.markT || Date.now() - r.markT > 5000) {
            Object.assign(r, { mark: p.mark, index: p.index, funding: p.funding, next: p.next });
          }
          if (Date.now() - r.priceT > 12000) {
            r.price = p.mark;
            r.priceT = Date.now();
          }
        }
        this.bus.emit('prices');
      } catch {
        // ignore offline
      }
    }, 10000);

    every(async () => {
      try {
        const tk = await this.tickers();
        for (const sym of this.storeState.universe) {
          const r = this.rec(sym);
          const t = tk[sym];
          if (t) Object.assign(r, { chg: t.chg, vol: t.vol, hi: t.hi, lo: t.lo });
        }
      } catch {
        // ignore
      }
    }, 60000);

    every(() => {
      if (this.storeState.active) this.analyze(this.storeState.active, false);
    }, 4000);

    every(async () => {
      if (this.storeState.active) {
        await this.enrich(this.storeState.active, true);
        this.analyze(this.storeState.active, false);
      }
    }, 25000);

    every(() => this.trackAll(), 15000);
  }

  setActive(sym: string) {
    this.storeState.active = sym;
    this.refreshStreams();
    const r = this.rec(sym);
    if (!r.ready) this.loadSymbol(sym, 1).then(() => this.analyze(sym, true));
    else this.analyze(sym, false);
    this.enrich(sym, true).then(() => this.analyze(sym, false));
    this.bus.emit('active', sym);
  }

  async reboot() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const k of Object.keys(this.storeState.recs)) {
      const r = this.storeState.recs[k];
      r.candles = {};
      r.ready = false;
      r.report = null;
      r.ctx = null;
      r.ctxKey = '';
    }
    await this.boot();
  }

  async runSymbolBacktest(
    sym: string,
    days: number,
    onProg?: (p: number) => void,
    smartProfitShield?: boolean,
    smartTakeProfitEnabled?: boolean
  ) {
    const tfs = this.tfs();
    const cs: Record<string, Candle[]> = {};
    const roles: [keyof ModeConfig, number][] = [
      ['trigger', (days * 86400e3) / TF_MS[tfs.trigger]],
      ['setup', (days * 86400e3) / TF_MS[tfs.setup] + 260],
      ['trend', (days * 86400e3) / TF_MS[tfs.trend] + 260],
    ];
    if (tfs.htf) roles.push(['htf', (days * 86400e3) / TF_MS[tfs.htf] + 30]);

    let k = 0;
    const nn = roles.length;
    for (const [role, want] of roles) {
      const tf = tfs[role] as string;
      const bars = Math.min(20000, Math.ceil(want));
      const arr = await this.klinesLong(sym, tf, bars, (p) => onProg?.(((k + p) / nn) * 0.5));
      cs[tf] = arr.filter((c) => c.x !== false);
      k++;
    }

    const startTs = cs[tfs.trigger]?.[0]?.t || Date.now() - days * 86400e3;
    const endTs = cs[tfs.trigger]?.[cs[tfs.trigger].length - 1]?.t;
    const fundingRatesPromise = this.fundingHistory(sym, startTs, endTs);

    let btcCandles: Record<string, Candle[]> | undefined;
    if (sym !== 'BTCUSDT') {
      try {
        btcCandles = {};
        const btcRoles: [keyof ModeConfig, number][] = [
          ['trigger', Math.min(20000, Math.ceil((days * 86400e3) / TF_MS[tfs.trigger]))],
          ['setup', Math.min(20000, Math.ceil((days * 86400e3) / TF_MS[tfs.setup] + 260))],
          ['trend', Math.min(20000, Math.ceil((days * 86400e3) / TF_MS[tfs.trend] + 260))],
        ];
        if (tfs.htf) btcRoles.push(['htf', Math.min(20000, Math.ceil((days * 86400e3) / TF_MS[tfs.htf] + 30))]);
        let bk = 0;
        for (const [role, bars] of btcRoles) {
          const tf = tfs[role] as string;
          const arr = await this.klinesLong('BTCUSDT', tf, bars, (p) =>
            onProg?.(0.5 + ((bk + p) / btcRoles.length) * 0.2)
          );
          btcCandles[tf] = arr.filter((c) => c.x !== false);
          bk++;
        }
      } catch {
        btcCandles = undefined;
      }
    }

    const fundingRates = await fundingRatesPromise;
    const meta = this.rec(sym).meta || {};
    const funding = this.rec(sym).funding;
    return runBacktest(cs, tfs, meta, this.engineCfg(), {
      sym,
      fundingRate: isN(funding) ? funding : 0.0001,
      fundingRates,
      btcCandles,
      smartProfitShield: smartProfitShield ?? this.settingsData.smartProfitShield !== false,
      smartTakeProfitEnabled: smartTakeProfitEnabled ?? this.settingsData.smartTakeProfitEnabled !== false,
      smartTakeProfitMinR: this.settingsData.smartTakeProfitMinR ?? 0.6,
      smartTakeProfitPartialPct: this.settingsData.smartTakeProfitPartialPct ?? 50,
      smartTakeProfitSensitivity: this.settingsData.smartTakeProfitSensitivity || 'balanced',
      onProgress: (p) => onProg?.(0.7 + 0.3 * p),
    });
  }

  async updateWakeLock() {
    try {
      if (this.settingsData.wakeLock && 'wakeLock' in navigator && !this.wakeLockRef) {
        this.wakeLockRef = await (navigator as any).wakeLock.request('screen');
        this.wakeLockRef.addEventListener('release', () => {
          this.wakeLockRef = null;
        });
      } else if (!this.settingsData.wakeLock && this.wakeLockRef) {
        await this.wakeLockRef.release();
        this.wakeLockRef = null;
      }
    } catch {
      // ignore
    }
  }

  wsStatus() {
    return {
      market: this.marketConn.state,
      public: this.pubConn.state,
      last: Math.max(this.marketConn.last, this.pubConn.last),
      healthy: this.marketConn.state === 'open' && Date.now() - this.marketConn.last < 15000,
    };
  }
}

let singleton: CipherClientEngine | null = null;
export function getClientEngine(): CipherClientEngine {
  if (typeof window === 'undefined') {
    return new CipherClientEngine();
  }
  if (!singleton) {
    singleton = new CipherClientEngine();
  }
  return singleton;
}
