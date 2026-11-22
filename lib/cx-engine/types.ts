export interface Candle {
  t: number; // openTime ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  T?: number; // closeTime ms
  q?: number; // quoteVolume
  n?: number; // trades count
  V?: number; // taker buy base volume
  Q?: number; // taker buy quote volume
  x?: boolean; // isClosed
}

export type TradingModeKey = 'scalp' | 'intraday' | 'swing' | 'early';
export type SmartTpSensitivity = 'conservative' | 'balanced' | 'aggressive';
export type ExecutionMode = 'MANUAL' | 'AUTO';
export type EntryKind = 'EARLY_ENTRY' | 'CONFIRMED_ENTRY';
export type EarlyEntryStatus = 'EARLY' | 'CONFIRMED' | 'WAIT_RETEST' | 'CANCELLED';

export interface EarlyEntryWeights {
  zoneQuality: number;      // 0-20
  structureShift: number;   // 0-20
  momentumVolume: number;   // 0-20
  liquidityConfirm: number; // 0-15
  mtfAlignment: number;     // 0-15
  stopRrQuality: number;    // 0-10
}

export interface EarlyEntryDetails {
  entryKind: EntryKind;
  entryStatus: EarlyEntryStatus;
  distanceMovedPct: number;
  remainingRR1: number;
  stillValid: boolean;
  fomoChasing: boolean;
  earlyReason: string;
  confirmFactors: string[];
  missingConfirmations: string[];
  breakdown: {
    zoneQuality: number;
    structureShift: number;
    momentumVolume: number;
    liquidityConfirm: number;
    mtfAlignment: number;
    stopRrQuality: number;
  };
}

export interface ModeConfig {
  trigger: string;
  setup: string;
  trend: string;
  htf: string | null;
  label: string;
}

export interface EngineConfig {
  mode: TradingModeKey;
  earlyTriggerTf?: string;
  minScore: number;
  strongScore: number;
  watchScore: number;
  equity: number;
  riskPct: number;
  maxLev: number;
  mmr: number;
  takerFee: number;
  makerFee: number;
  slip: number;
  minRR1: number;
  maxStopATR: number;
  minStopATR: number;
  maxFeeR: number;
  amp: number;
  cooldownBars: number;
  minLiqSafetyPct?: number;
  minVolumeUsdt?: number;
  maxSpreadBps?: number;
  smartProfitShield?: boolean;
  smartTakeProfitEnabled?: boolean;
  smartTakeProfitMinR?: number;
  smartTakeProfitPartialPct?: number;
  smartTakeProfitSensitivity?: SmartTpSensitivity;
  tpPcts?: [number, number, number];
  limitExpireBars?: number;
  cancelChasedAtr?: number;
  trailingStopEnabled?: boolean;
  useFvgFilter?: boolean;
  useObFilter?: boolean;
  useChochBosFilter?: boolean;
  useMomentumFilter?: boolean;
  earlyWeights?: EarlyEntryWeights;
}

export interface MicroBarFlow {
  t: number;
  deltaUsd: number;
  volUsd: number;
  buyRatio: number;
  close: number;
}

export interface MicroTimeframeFlow {
  tf: string;
  bars: number;
  buyVolUsd: number;
  sellVolUsd: number;
  totalVolUsd: number;
  netDeltaUsd: number;
  deltaPct: number;
  buyRatio: number;
  cvdSlope: number;
  rvol: number;
  avgTradeUsd: number;
  usdPerMin: number;
  absorption: 'BULL' | 'BEAR' | 'NONE';
  absorptionDetail: string;
  score: number;
  recentBars: MicroBarFlow[];
}

export interface LiquidityFilterSummary {
  vol24hUsd: number | null;
  minVolumeUsdt: number;
  volPass: boolean;
  spreadBps: number | null;
  maxSpreadBps: number;
  spreadPass: boolean;
  bookImb05: number | null;
  depthBidUsd: number | null;
  depthAskUsd: number | null;
  bidWall: { p: number; usd: number } | null;
  askWall: { p: number; usd: number } | null;
  liquidityPass: boolean;
  reasons: string[];
}

export interface OrderFlowSnapshot {
  t: number;
  primaryTf: string;
  frames: Record<string, MicroTimeframeFlow>;
  netBias: number;
  confidence: number;
  verdict: 'CONFIRMED' | 'ABSORPTION' | 'NEUTRAL' | 'COUNTER_FLOW' | 'ILLIQUID';
  verdictLabel: string;
  absorption: 'BULL' | 'BEAR' | 'NONE';
  liquidity: LiquidityFilterSummary;
}

export interface SymbolMeta {
  sym: string;
  base?: string;
  tick: number;
  step: number;
  minQty: number;
  minNotional: number;
  onboard?: number;
  pp?: number;
  qp?: number;
}

export interface DerivData {
  t?: number;
  oiChg1h?: number;
  oiChg4h?: number;
  oiUsd?: number;
  lsRatio?: number;
  lsLongPct?: number;
  topLongPct?: number;
  takerRatio?: number;
  funding?: number;
  fundingMs?: number;
  basisBps?: number;
  liqLong15?: number;
  liqShort15?: number;
}

export interface BookLevel {
  0: number;
  1: number;
}

export interface OrderBookAnalysis {
  imb05: number;
  bandPct: number;
  spreadBps: number;
  bid05: number;
  ask05: number;
  bidWall: { p: number; usd: number } | null;
  askWall: { p: number; usd: number } | null;
  bids: [number, number][];
  asks: [number, number][];
  mid: number;
  t: number;
}

export interface BtcContext {
  dir: number;
  score: number;
  chg1h: number;
  chg4h: number;
  regime: string;
  shock: boolean;
  detail: string;
  updatedAt?: number;
}

export interface MtfMatrixRow {
  role: 'htf' | 'trend' | 'setup' | 'trigger';
  tf: string;
  score: number;
  ema: number;
  st: number;
  struct: number;
  adx: number;
  rsi: number;
}

export interface IndicatorBundle {
  tf: string;
  ms: number;
  n: number;
  k: number;
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  q: Float64Array;
  tb: Float64Array;
  ema9: Float64Array;
  ema21: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  rsi: Float64Array;
  macd: Float64Array;
  macdSig: Float64Array;
  macdH: Float64Array;
  atr: Float64Array;
  atrp: Float64Array;
  adx: Float64Array;
  pdi: Float64Array;
  mdi: Float64Array;
  bbMid: Float64Array;
  bbUp: Float64Array;
  bbLo: Float64Array;
  bbW: Float64Array;
  bbPb: Float64Array;
  kcMid: Float64Array;
  kcUp: Float64Array;
  kcLo: Float64Array;
  stK: Float64Array;
  stD: Float64Array;
  st: Float64Array;
  stDir: Int8Array;
  vwap: Float64Array;
  vwapUp1: Float64Array;
  vwapLo1: Float64Array;
  vwapUp2: Float64Array;
  vwapLo2: Float64Array;
  delta: Float64Array;
  cvd: Float64Array;
  obv: Float64Array;
  rvol: Float64Array;
  zScore: Float64Array;
  piv: { highs: { i: number; p: number }[]; lows: { i: number; p: number }[] };
  struct?: any;
  zones?: any;
}

export interface PositionSizeResult {
  ok: boolean;
  note: string;
  qty: number;
  notional: number;
  lev: number;
  safeMax: number;
  riskUsd: number;
  effRiskUsd: number;
  effRiskPct: number;
  margin: number;
  limited: boolean;
  liq: number;
  mmr: number;
  maintenanceMarginUsd: number;
  safetyBufferPct: number;
  safetyOk: boolean;
}

export interface TradePlan {
  ok: boolean;
  why?: string;
  dir?: number;
  long?: boolean;
  type?: 'MARKET' | 'LIMIT';
  entry?: number;
  price?: number;
  fillDist?: number;
  zone?: { lo: number; hi: number; labels: string[]; kinds: string[]; n: number };
  stop?: number;
  stopRef?: string;
  risk?: number;
  riskATR?: number;
  riskPct?: number;
  tps?: { p: number; label: string; real: boolean; r: number; pct: number }[];
  rr1?: number;
  rr2?: number;
  rr3?: number;
  feeR?: number;
  checks?: { ok: boolean | null; label: string; detail: string }[];
  warnings?: string[];
  confirmed?: boolean;
  confirmBits?: string[];
  ext?: number;
  expireBars?: number;
  size?: PositionSizeResult;
  barrier?: null;
}

export interface SignalEvaluation {
  i: number;
  t: number;
  tClose: number;
  price: number;
  atr: number;
  atrp: number;
  dir: number;
  net: number;
  score: number;
  rawScore: number;
  aligned: number;
  parts: { key: string; label: string; w: number; wEff: number; raw: number; detail: string }[];
  gates: string[];
  warns: string[];
  cap: number;
  regime: {
    type: string;
    adx: number;
    bwPct: number;
    atrPct: number;
    squeeze: boolean;
    ttmSqueeze?: boolean;
    squeezeFired?: boolean;
    expansion: boolean;
  };
  regimeHTF: any;
  tf: { trigger: string; setup: string | null; trend: string | null; htf: string | null };
  state: { trigger: any; setup: any; trend: any; htf?: any };
  mtfMatrix?: MtfMatrixRow[];
  idx: { i: number; iS: number; iT: number; iH: number };
  zones: any;
  breakers?: any[];
  sweeps: any[];
  pools: any[];
  range: any;
  vp: any;
  levels: any[];
  sup: any;
  res: any;
  patterns: any[];
  divs: any[];
  setupDivs?: any[];
  evT: any;
  evS: any;
  pChg1h: number;
  pChg4h: number;
  vwapZ?: number;
  zScore?: number;
  sessionLabel?: string;
  btcContext?: BtcContext | null;
  deriv: DerivData | null;
  book: OrderBookAnalysis | null;
  orderFlow?: OrderFlowSnapshot | null;
  tier: 'NONE' | 'WATCH' | 'GOOD' | 'STRONG';
  grade: string;
  plan: TradePlan | null;
  earlyEntry?: EarlyEntryDetails | null;
  strategyMode?: TradingModeKey;
}

export interface SimulatedTrade {
  id: string;
  sym: string;
  dir: number;
  type: 'MARKET' | 'LIMIT';
  tier: string;
  score: number;
  entry: number;
  stop: number;
  stopCur: number;
  risk: number;
  feeR: number;
  tps: { p: number; pct: number; hit: boolean }[];
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  t0: number;
  tFill: number | null;
  tEnd: number | null;
  expireAt: number;
  lastT: number;
  realized: number;
  remaining: number;
  maxFav: number;
  maxAdv: number;
  outcome: string | null;
  exitPrice: number | null;
  R: number | null;
  bars: number;
  fundingR: number;
  fundingUsd?: number;
  pnlUsd?: number;
  regime?: string;
  signalBar?: number;
  justFilled?: boolean;
  isOos?: boolean;
  meta?: Record<string, any>;
}

export interface PaperWallet {
  userId: string;
  balanceUsdt: number;
  lockedMarginUsdt: number;
  realizedPnlUsdt: number;
  totalFeesUsdt: number;
  totalFundingUsdt: number;
  dailyPnlUsdt: number;
  dailyResetDate: string;
  initialBalanceUsdt: number;
  simulationRunId?: string;
  resetAt?: string | null;
  updatedAt: string;
}

export interface WalletLedgerEntry {
  id: string;
  userId: string;
  idempotencyKey: string;
  opType: string;
  symbol: string | null;
  positionId: string | null;
  amountUsdt: number;
  balanceAfterUsdt: number;
  note: string;
  createdAt: string;
}

export interface PaperPosition {
  id: string;
  userId: string;
  idempotencyKey: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  status: 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED' | 'LIQUIDATED';
  score: number;
  tier: string;
  mode: string;
  entryKind?: EntryKind;
  simulationRunId?: string;
  archivedAt?: string | null;
  entryPrice: number;
  stopLoss: number;
  stopCurrent: number;
  liqPrice: number;
  markPriceLast: number;
  maintenanceMarginRate: number;
  maintenanceMarginUsdt: number;
  leverage: number;
  qty: number;
  remainingQty: number;
  notionalUsdt: number;
  marginUsdt: number;
  tps: { p: number; pct: number; hit: boolean; r: number }[];
  feesUsdt: number;
  slippageUsdt: number;
  fundingUsdt: number;
  realizedPnlUsdt: number;
  netPnlUsdt: number;
  rMultiple: number | null;
  outcome: string | null;
  exitPrice: number | null;
  lastFundingTs: number;
  safetyBufferPct: number;
  openedAt: string;
  filledAt: string | null;
  closedAt: string | null;
  expiresAt?: string | null;
  liqWarningSent?: boolean;
  meta?: Record<string, any>;
}

export interface BotSettings {
  userId: string;
  autoTradeEnabled: boolean;
  executionMode?: ExecutionMode;
  emergencyStopped: boolean;
  emergencyReason: string | null;
  mode: TradingModeKey;
  earlyTriggerTf?: string;
  riskPct: number;
  maxLeverage: number;
  maxOpenPositions: number;
  equalAllocationEnabled?: boolean;
  cashReservePct?: number;
  maxPortfolioHeatPct: number;
  maxSameSidePositions: number;
  btcFilterEnabled: boolean;
  minVolumeUsdt: number;
  maxSpreadBps: number;
  dailyLossLimitUsdt: number;
  dailyLossLimitPct: number;
  minLiqSafetyPct: number;
  allowedSymbols: string[];
  minTier: 'GOOD' | 'STRONG';
  minScore: number;
  strongScore: number;
  watchScore: number;
  takerFee: number;
  makerFee: number;
  slippage: number;
  tpPcts?: [number, number, number];
  limitExpireBars?: number;
  cancelChasedAtr?: number;
  allowReentry?: boolean;
  reentryCooldownBars?: number;
  trailingStopEnabled?: boolean;
  filterFlags?: {
    useFvg: boolean;
    useOb: boolean;
    useChochBos: boolean;
    useMomentum: boolean;
    useOrderFlow: boolean;
    btcShockBlock: boolean;
  };
  notifyPrefs?: {
    browser: boolean;
    push: boolean;
    sound: boolean;
    onOpen: boolean;
    onClose: boolean;
    onRisk: boolean;
    onError: boolean;
  };
  earlyWeights?: EarlyEntryWeights;
  smartProfitShield?: boolean;
  smartTakeProfitEnabled?: boolean;
  smartTakeProfitMinR?: number;
  smartTakeProfitPartialPct?: number;
  smartTakeProfitSensitivity?: SmartTpSensitivity;
  updatedAt: string;
}

export interface AppNotification {
  id: string;
  userId: string;
  eventType:
    | 'TRADE_OPEN'
    | 'TRADE_CLOSE'
    | 'TP_HIT'
    | 'SL_HIT'
    | 'LIQ_WARNING'
    | 'LIQUIDATED'
    | 'ENGINE_ERROR'
    | 'TRADE_REJECTED'
    | 'EMERGENCY_STOP'
    | 'FUNDING'
    | 'INFO';
  severity: 'info' | 'success' | 'warning' | 'danger';
  symbol: string | null;
  title: string;
  body: string;
  isRead: boolean;
  meta?: Record<string, any>;
  createdAt: string;
}

export interface EqualAllocationPlan {
  equalAllocationEnabled: boolean;
  totalEquityUsdt: number;
  cashReservePct: number;
  reservedCashUsdt: number;
  allocatableUsdt: number;
  maxOpenPositions: number;
  perPositionSleeveUsdt: number;
  usedMarginUsdt: number;
  availableSleevesCount: number;
  openCount: number;
  maxPositionRiskUsd: number;
}

export interface SignalTelemetryRecord {
  id: string;
  userId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  strategyMode: TradingModeKey;
  entryKind: EntryKind;
  entryStatus: EarlyEntryStatus | 'CONFIRMED' | 'EXPIRED' | 'SKIPPED';
  timeframe: string;
  regime: string;
  score: number;
  rawScore: number;
  signalPrice: number;
  entryPrice: number;
  fillPrice?: number | null;
  distanceMovedPct: number;
  delayMs?: number | null;
  stillValid: boolean;
  earlyReason: string;
  confirmFactors: string[];
  missingConfirmations: string[];
  scoreBreakdown?: Record<string, number>;
  takenByUserOrAuto: boolean;
  positionId?: string | null;
  outcome?: string | null;
  closeReason?: string | null;
  netR?: number | null;
  netPnlUsdt?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp3Hit?: boolean;
  wasLateEntry?: boolean;
  missedOpportunity?: boolean;
  simulationRunId?: string | null;
  createdAt: string;
  closedAt?: string | null;
}

export interface PerformanceBucketStats {
  key: string;
  label: string;
  count: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  avgNetR: number;
  totalPnlUsdt: number;
  avgDistanceMovedPct: number;
  lateEntryRate: number;
}

export interface WeightTuningProposal {
  id: string;
  createdAt: string;
  sampleCount: number;
  minSampleRequired: number;
  sufficientSample: boolean;
  currentWeights: EarlyEntryWeights;
  proposedWeights: EarlyEntryWeights;
  reasons: string[];
  expectedImprovementNote: string;
  walkForwardBaselinePF?: number;
  walkForwardProposedPF?: number;
  walkForwardPassed?: boolean;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'ROLLED_BACK';
}

export interface StrategyWeightSnapshot {
  id: string;
  userId: string;
  version: number;
  strategyMode: 'early';
  weights: EarlyEntryWeights;
  note: string;
  proposalId?: string | null;
  metricsSummary?: Record<string, any>;
  isActive: boolean;
  createdAt: string;
}

export interface StrategyPerformanceReport {
  totalSignals: number;
  totalTaken: number;
  closedTrades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownPct: number;
  lateEntryPct: number;
  missedMoveRate: number;
  earlyVsConfirmed: {
    early: PerformanceBucketStats;
    confirmed: PerformanceBucketStats;
  };
  byStrategy: PerformanceBucketStats[];
  byTimeframe: PerformanceBucketStats[];
  byRegime: PerformanceBucketStats[];
  lossCauses: { reason: string; count: number; pct: number }[];
  scoreCalibration: { bucket: string; count: number; winRate: number; avgR: number }[];
  proposal: WeightTuningProposal | null;
}

export interface EngineLogEntry {
  id: string;
  userId: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DECISION';
  category: 'SCAN' | 'EVALUATE' | 'EXECUTE' | 'PROTECT' | 'CAPITAL' | 'WEIGHTS' | 'WORKER';
  symbol: string | null;
  message: string;
  details?: Record<string, any>;
  createdAt: string;
}

export interface WorkerStatusRecord {
  userId: string;
  workerId: string;
  workerStatus: 'RUNNING' | 'STOPPED' | 'ERROR';
  executionMode: ExecutionMode;
  workerConnected: boolean;
  supabaseConnected: boolean;
  lastHeartbeatAt: string | null;
  lastScanAt: string | null;
  lastSignalEvalAt: string | null;
  lastTradeExecAt: string | null;
  startedAt: string | null;
  uptimeSec: number;
  symbolsScanned: number;
  activeSignalsCount: number;
  openPositionsCount: number;
  pendingOrdersCount: number;
  tradesToday: number;
  cyclesCompleted: number;
  lastError: string | null;
  consecutiveErrors: number;
  paperTradingStatus: string;
  updatedAt: string;
}
