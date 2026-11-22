import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from '../cx-engine/early-entry';
import type {
  AppNotification,
  BotSettings,
  EarlyEntryWeights,
  EngineLogEntry,
  PaperPosition,
  PaperWallet,
  SignalTelemetryRecord,
  StrategyWeightSnapshot,
  WalletLedgerEntry,
  WorkerStatusRecord,
} from '../cx-engine/types';

export const DEFAULT_USER_ID = 'default-paper-trader';

const DATA_DIR = path.join(process.cwd(), '.data');
const STORE_FILE = path.join(DATA_DIR, 'cipher-state.json');

export interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

interface LocalStoreSchema {
  wallets: Record<string, PaperWallet>;
  ledger: WalletLedgerEntry[];
  trades: PaperPosition[];
  settings: Record<string, BotSettings>;
  notifications: AppNotification[];
  pushSubscriptions: PushSubscriptionRecord[];
  signals: Record<string, any>;
  engineState: Record<string, WorkerStatusRecord>;
  engineLogs: EngineLogEntry[];
  signalAnalytics: SignalTelemetryRecord[];
  strategyWeights: StrategyWeightSnapshot[];
}

const defaultWallet = (userId: string, initialUsdt = 10000): PaperWallet => ({
  userId,
  balanceUsdt: initialUsdt,
  lockedMarginUsdt: 0,
  realizedPnlUsdt: 0,
  totalFeesUsdt: 0,
  totalFundingUsdt: 0,
  dailyPnlUsdt: 0,
  dailyResetDate: new Date().toISOString().slice(0, 10),
  initialBalanceUsdt: initialUsdt,
  simulationRunId: 'run-1',
  resetAt: null,
  updatedAt: new Date().toISOString(),
});

export const defaultBotSettings = (userId: string): BotSettings => ({
  userId,
  autoTradeEnabled: false,
  executionMode: 'MANUAL',
  emergencyStopped: false,
  emergencyReason: null,
  mode: 'intraday',
  earlyTriggerTf: '15m',
  riskPct: 1,
  maxLeverage: 15,
  maxOpenPositions: 4,
  equalAllocationEnabled: true,
  cashReservePct: 10,
  maxPortfolioHeatPct: 6,
  maxSameSidePositions: 3,
  btcFilterEnabled: true,
  minVolumeUsdt: 25_000_000,
  maxSpreadBps: 8,
  dailyLossLimitUsdt: 500,
  dailyLossLimitPct: 5,
  minLiqSafetyPct: 25,
  allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  minTier: 'GOOD',
  minScore: 70,
  strongScore: 80,
  watchScore: 62,
  takerFee: 0.0005,
  makerFee: 0.0002,
  slippage: 0.0002,
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
  smartProfitShield: true,
  smartTakeProfitEnabled: true,
  smartTakeProfitMinR: 0.6,
  smartTakeProfitPartialPct: 50,
  smartTakeProfitSensitivity: 'balanced',
  updatedAt: new Date().toISOString(),
});

const defaultWorkerStatus = (userId: string): WorkerStatusRecord => ({
  userId,
  workerId: 'main-worker',
  workerStatus: 'STOPPED',
  executionMode: 'MANUAL',
  workerConnected: false,
  supabaseConnected: false,
  lastHeartbeatAt: null,
  lastScanAt: null,
  lastSignalEvalAt: null,
  lastTradeExecAt: null,
  startedAt: null,
  uptimeSec: 0,
  symbolsScanned: 0,
  activeSignalsCount: 0,
  openPositionsCount: 0,
  pendingOrdersCount: 0,
  tradesToday: 0,
  cyclesCompleted: 0,
  lastError: null,
  consecutiveErrors: 0,
  paperTradingStatus: 'جاهز (Paper Trading)',
  updatedAt: new Date().toISOString(),
});

function getSupabaseConfig() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const hasUrl = Boolean(url && !url.includes('YOUR_PROJECT_ID'));
  const hasServiceKey = Boolean(serviceKey && !serviceKey.includes('YOUR_SUPABASE_SERVICE_ROLE_KEY'));
  const hasAnonKey = Boolean(anonKey && !anonKey.includes('YOUR_SUPABASE_ANON_KEY'));
  return { url, serviceKey, hasUrl, hasServiceKey, hasAnonKey };
}

function getSupabaseAdmin(): SupabaseClient | null {
  const cfg = getSupabaseConfig();
  if (!cfg.hasUrl || !cfg.hasServiceKey) return null;
  return createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function loadLocalStore(): LocalStoreSchema {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        wallets: parsed.wallets || {},
        ledger: parsed.ledger || [],
        trades: parsed.trades || [],
        settings: parsed.settings || {},
        notifications: parsed.notifications || [],
        pushSubscriptions: parsed.pushSubscriptions || [],
        signals: parsed.signals || {},
        engineState: parsed.engineState || {},
        engineLogs: parsed.engineLogs || [],
        signalAnalytics: parsed.signalAnalytics || [],
        strategyWeights: parsed.strategyWeights || [],
      };
    }
  } catch {
    // fallback fresh store
  }
  return {
    wallets: {},
    ledger: [],
    trades: [],
    settings: {},
    notifications: [],
    pushSubscriptions: [],
    signals: {},
    engineState: {},
    engineLogs: [],
    signalAnalytics: [],
    strategyWeights: [],
  };
}

let writeQueue = Promise.resolve();
function saveLocalStore(store: LocalStoreSchema) {
  writeQueue = writeQueue.then(async () => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STORE_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      fs.renameSync(tmp, STORE_FILE);
    } catch (e) {
      console.error('[repo] saveLocalStore error:', e);
    }
  });
}

const g = globalThis as unknown as { __cipherLocalStore?: LocalStoreSchema };
function getLocal(): LocalStoreSchema {
  if (!g.__cipherLocalStore) {
    g.__cipherLocalStore = loadLocalStore();
  }
  return g.__cipherLocalStore;
}

const mapWalletRow = (r: any, localFallback?: PaperWallet): PaperWallet => ({
  userId: r.user_id,
  balanceUsdt: Number(r.balance_usdt),
  lockedMarginUsdt: Number(r.locked_margin_usdt),
  realizedPnlUsdt: Number(r.realized_pnl_usdt),
  totalFeesUsdt: Number(r.total_fees_usdt),
  totalFundingUsdt: Number(r.total_funding_usdt),
  dailyPnlUsdt: Number(r.daily_pnl_usdt),
  dailyResetDate: String(r.daily_reset_date),
  initialBalanceUsdt: Number(r.initial_balance_usdt),
  simulationRunId: r.simulation_run_id || localFallback?.simulationRunId || 'run-1',
  resetAt: r.reset_at ? String(r.reset_at) : (localFallback?.resetAt ?? null),
  updatedAt: String(r.updated_at),
});

const mapTradeRow = (r: any): PaperPosition => ({
  id: r.id,
  userId: r.user_id,
  idempotencyKey: r.idempotency_key,
  symbol: r.symbol,
  side: r.side,
  orderType: r.order_type,
  status: r.status,
  score: Number(r.score),
  tier: r.tier,
  mode: r.mode,
  entryKind: r.entry_kind || r.meta_json?.entryKind || 'CONFIRMED_ENTRY',
  simulationRunId: r.simulation_run_id || r.meta_json?.simulationRunId || 'run-1',
  archivedAt: r.archived_at ? String(r.archived_at) : (r.meta_json?.archivedAt ?? null),
  entryPrice: Number(r.entry_price),
  stopLoss: Number(r.stop_loss),
  stopCurrent: Number(r.stop_current),
  liqPrice: Number(r.liq_price),
  markPriceLast: Number(r.mark_price_last ?? r.entry_price),
  maintenanceMarginRate: Number(r.maintenance_margin_rate),
  maintenanceMarginUsdt: Number(r.maintenance_margin_usdt),
  leverage: Number(r.leverage),
  qty: Number(r.qty),
  remainingQty: Number(r.remaining_qty),
  notionalUsdt: Number(r.notional_usdt),
  marginUsdt: Number(r.margin_usdt),
  tps: Array.isArray(r.tps_json) ? r.tps_json : [],
  feesUsdt: Number(r.fees_usdt),
  slippageUsdt: Number(r.slippage_usdt),
  fundingUsdt: Number(r.funding_usdt),
  realizedPnlUsdt: Number(r.realized_pnl_usdt),
  netPnlUsdt: Number(r.net_pnl_usdt),
  rMultiple: r.r_multiple != null ? Number(r.r_multiple) : null,
  outcome: r.outcome ?? null,
  exitPrice: r.exit_price != null ? Number(r.exit_price) : null,
  lastFundingTs: Number(r.last_funding_ts || 0),
  safetyBufferPct: Number(r.safety_buffer_pct || 0),
  liqWarningSent: Boolean(r.liq_warning_sent ?? r.meta_json?.liqWarningSent),
  openedAt: String(r.opened_at),
  filledAt: r.filled_at ? String(r.filled_at) : null,
  closedAt: r.closed_at ? String(r.closed_at) : null,
  expiresAt: r.expires_at ? String(r.expires_at) : (r.meta_json?.expiresAt ?? null),
  meta: r.meta_json || {},
});

const mapSettingsRow = (r: any, localFallback?: BotSettings): BotSettings => {
  const autoTradeEnabled = Boolean(r.auto_trade_enabled);
  return {
    userId: r.user_id,
    autoTradeEnabled,
    executionMode:
      r.execution_mode === 'AUTO' || r.execution_mode === 'MANUAL'
        ? r.execution_mode
        : localFallback?.executionMode || (autoTradeEnabled ? 'AUTO' : 'MANUAL'),
    emergencyStopped: Boolean(r.emergency_stopped),
    emergencyReason: r.emergency_reason ?? null,
    mode: r.mode || localFallback?.mode || 'intraday',
    earlyTriggerTf: r.early_trigger_tf || localFallback?.earlyTriggerTf || '15m',
    riskPct: Number(r.risk_pct),
    maxLeverage: Number(r.max_leverage),
    maxOpenPositions: Number(r.max_open_positions),
    equalAllocationEnabled:
      r.equal_allocation_enabled != null
        ? Boolean(r.equal_allocation_enabled)
        : (localFallback?.equalAllocationEnabled ?? true),
    cashReservePct:
      r.cash_reserve_pct != null
        ? Number(r.cash_reserve_pct)
        : (localFallback?.cashReservePct ?? 10),
    maxPortfolioHeatPct:
      r.max_portfolio_heat_pct != null
        ? Number(r.max_portfolio_heat_pct)
        : (localFallback?.maxPortfolioHeatPct ?? 6),
    maxSameSidePositions:
      r.max_same_side_positions != null
        ? Number(r.max_same_side_positions)
        : (localFallback?.maxSameSidePositions ?? 3),
    btcFilterEnabled:
      r.btc_filter_enabled != null
        ? Boolean(r.btc_filter_enabled)
        : (localFallback?.btcFilterEnabled ?? true),
    minVolumeUsdt:
      r.min_volume_usdt != null
        ? Number(r.min_volume_usdt)
        : (localFallback?.minVolumeUsdt ?? 25_000_000),
    maxSpreadBps:
      r.max_spread_bps != null
        ? Number(r.max_spread_bps)
        : (localFallback?.maxSpreadBps ?? 8),
    dailyLossLimitUsdt: Number(r.daily_loss_limit_usdt),
    dailyLossLimitPct: Number(r.daily_loss_limit_pct),
    minLiqSafetyPct: Number(r.min_liq_safety_pct),
    allowedSymbols: Array.isArray(r.allowed_symbols) ? r.allowed_symbols : [],
    minTier: r.min_tier || 'GOOD',
    minScore: Number(r.min_score),
    strongScore: Number(r.strong_score),
    watchScore: Number(r.watch_score),
    takerFee: Number(r.taker_fee),
    makerFee: Number(r.maker_fee),
    slippage: Number(r.slippage),
    tpPcts: Array.isArray(r.tp_pcts_json) && r.tp_pcts_json.length === 3
      ? [Number(r.tp_pcts_json[0]), Number(r.tp_pcts_json[1]), Number(r.tp_pcts_json[2])]
      : (localFallback?.tpPcts ?? [40, 35, 25]),
    limitExpireBars:
      r.limit_expire_bars != null
        ? Number(r.limit_expire_bars)
        : (localFallback?.limitExpireBars ?? 8),
    cancelChasedAtr:
      r.cancel_chased_atr != null
        ? Number(r.cancel_chased_atr)
        : (localFallback?.cancelChasedAtr ?? 2.4),
    allowReentry:
      r.allow_reentry != null
        ? Boolean(r.allow_reentry)
        : (localFallback?.allowReentry ?? true),
    reentryCooldownBars:
      r.reentry_cooldown_bars != null
        ? Number(r.reentry_cooldown_bars)
        : (localFallback?.reentryCooldownBars ?? 6),
    trailingStopEnabled:
      r.trailing_stop_enabled != null
        ? Boolean(r.trailing_stop_enabled)
        : (localFallback?.trailingStopEnabled ?? true),
    filterFlags: r.filter_flags_json || localFallback?.filterFlags || defaultBotSettings(r.user_id).filterFlags,
    notifyPrefs: r.notify_prefs_json || localFallback?.notifyPrefs || defaultBotSettings(r.user_id).notifyPrefs,
    earlyWeights: normalizeEarlyWeights(r.early_weights_json || localFallback?.earlyWeights || DEFAULT_EARLY_WEIGHTS),
    smartProfitShield:
      r.smart_profit_shield != null
        ? Boolean(r.smart_profit_shield)
        : (localFallback?.smartProfitShield ?? true),
    smartTakeProfitEnabled:
      r.smart_tp_enabled != null
        ? Boolean(r.smart_tp_enabled)
        : (localFallback?.smartTakeProfitEnabled ?? true),
    smartTakeProfitMinR:
      r.smart_tp_min_r != null
        ? Number(r.smart_tp_min_r)
        : (localFallback?.smartTakeProfitMinR ?? 0.6),
    smartTakeProfitPartialPct:
      r.smart_tp_partial_pct != null
        ? Number(r.smart_tp_partial_pct)
        : (localFallback?.smartTakeProfitPartialPct ?? 50),
    smartTakeProfitSensitivity:
      r.smart_tp_sensitivity || localFallback?.smartTakeProfitSensitivity || 'balanced',
    updatedAt: String(r.updated_at),
  };
};

export const repo = {
  isSupabaseConfigured(): boolean {
    return getSupabaseAdmin() !== null;
  },

  async inspectSupabase() {
    const cfg = getSupabaseConfig();
    const sb = getSupabaseAdmin();
    if (!sb) {
      const missingServiceKey = cfg.hasUrl && !cfg.hasServiceKey;
      return {
        configured: false,
        serviceRoleConfigured: cfg.hasServiceKey,
        missingServiceKey,
        connected: false,
        schemaReady: false,
        mode: 'local-persistent-store',
        tables: {},
        pendingV3Schema: false,
        message: missingServiceKey
          ? 'تم إدخال رابط Supabase لكن مفتاح SUPABASE_SERVICE_ROLE_KEY مفقود — يلزم إضافته في بيئة الخادم لمنع تعارض RLS.'
          : 'لم يتم إدخال مفاتيح Supabase في متغيرات البيئة بعد — يعمل النظام حالياً بالتخزين المحلي الآمن.',
      };
    }

    const coreTables = [
      'cx_wallets',
      'cx_wallet_ledger',
      'cx_paper_trades',
      'cx_bot_settings',
      'cx_notifications',
      'cx_push_subscriptions',
      'cx_signals',
    ];
    const v3Tables = [
      'cx_engine_state',
      'cx_engine_logs',
      'cx_signal_analytics',
      'cx_strategy_weights',
    ];

    const tables: Record<string, { exists: boolean; error?: string }> = {};
    let coreOk = true;
    let v3Ok = true;

    for (const tbl of coreTables) {
      const { error } = await sb.from(tbl).select('*', { head: true, count: 'exact' });
      tables[tbl] = error ? { exists: false, error: error.message } : { exists: true };
      if (error) coreOk = false;
    }

    for (const tbl of v3Tables) {
      const { error } = await sb.from(tbl).select('*', { head: true, count: 'exact' });
      tables[tbl] = error ? { exists: false, error: error.message } : { exists: true };
      if (error) v3Ok = false;
    }

    let extraColsReady = true;
    if (tables.cx_bot_settings?.exists) {
      const { error: colErr } = await sb
        .from('cx_bot_settings')
        .select('user_id, execution_mode, equal_allocation_enabled, cash_reserve_pct, early_trigger_tf')
        .limit(1);
      if (colErr) {
        extraColsReady = false;
        v3Ok = false;
      }
    }

    const allOk = coreOk && v3Ok && extraColsReady;
    return {
      configured: true,
      serviceRoleConfigured: true,
      missingServiceKey: false,
      connected: coreOk,
      schemaReady: allOk,
      pendingV3Schema: !v3Ok || !extraColsReady,
      mode: allOk ? 'supabase' : coreOk ? 'supabase-v3-migration-pending' : 'supabase-schema-pending',
      tables,
      message: allOk
        ? 'متصل بـ Supabase عبر Service Role وجميع الجداول الـ 11 والأعمدة المحدّثة جاهزة.'
        : coreOk
          ? 'الجداول الأساسية متصلة وتعمل، وتوجد أعمدة/جداول v3 جديدة في supabase/schema.sql يُنصح بتنفيذها في SQL Editor.'
          : 'تم الاتصال بـ Supabase لكن بعض الجداول أو الأعمدة غير محدثة — نفّذ ملف supabase/schema.sql في SQL Editor.',
    };
  },

  async getWallet(userId = DEFAULT_USER_ID): Promise<PaperWallet> {
    const store = getLocal();
    const localFallback = store.wallets[userId];
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_wallets')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (!error && data) {
        const w = mapWalletRow(data, localFallback);
        const today = new Date().toISOString().slice(0, 10);
        if (w.dailyResetDate !== today) {
          await sb
            .from('cx_wallets')
            .update({ daily_pnl_usdt: 0, daily_reset_date: today })
            .eq('user_id', userId);
          w.dailyPnlUsdt = 0;
          w.dailyResetDate = today;
        }
        store.wallets[userId] = w;
        return w;
      }
      if (!error && !data) {
        const fresh = defaultWallet(userId);
        await sb.from('cx_wallets').upsert({ user_id: userId });
        store.wallets[userId] = fresh;
        saveLocalStore(store);
        return fresh;
      }
    }

    if (!store.wallets[userId]) {
      store.wallets[userId] = defaultWallet(userId);
      store.ledger.unshift({
        id: `init-${Date.now()}`,
        userId,
        idempotencyKey: `init:${userId}`,
        opType: 'INIT',
        symbol: null,
        positionId: null,
        amountUsdt: 10000,
        balanceAfterUsdt: 10000,
        note: 'تهيئة المحفظة التجريبية برصيد 10,000 USDT',
        createdAt: new Date().toISOString(),
      });
      saveLocalStore(store);
    }
    const w = store.wallets[userId];
    const today = new Date().toISOString().slice(0, 10);
    if (w.dailyResetDate !== today) {
      w.dailyPnlUsdt = 0;
      w.dailyResetDate = today;
      saveLocalStore(store);
    }
    return w;
  },

  async applyWalletOp(params: {
    userId: string;
    idempotencyKey: string;
    opType: string;
    symbol?: string | null;
    positionId?: string | null;
    balanceDelta: number;
    marginDelta: number;
    realizedDelta: number;
    feeDelta: number;
    fundingDelta: number;
    note: string;
  }): Promise<{ applied: boolean; duplicate: boolean; wallet: PaperWallet }> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb.rpc('cx_apply_wallet_op', {
        p_user_id: params.userId,
        p_idempotency_key: params.idempotencyKey,
        p_op_type: params.opType,
        p_symbol: params.symbol ?? null,
        p_position_id: params.positionId ?? null,
        p_balance_delta: params.balanceDelta,
        p_margin_delta: params.marginDelta,
        p_realized_delta: params.realizedDelta,
        p_fee_delta: params.feeDelta,
        p_funding_delta: params.fundingDelta,
        p_note: params.note,
      });
      if (!error && data) {
        const wallet = await this.getWallet(params.userId);
        return { applied: Boolean(data.applied), duplicate: Boolean(data.duplicate), wallet };
      }
    }

    const store = getLocal();
    const wallet = await this.getWallet(params.userId);
    const exists = store.ledger.some(
      (e) => e.userId === params.userId && e.idempotencyKey === params.idempotencyKey
    );
    if (exists) {
      return { applied: false, duplicate: true, wallet };
    }

    wallet.balanceUsdt = Math.max(0, +(wallet.balanceUsdt + params.balanceDelta).toFixed(6));
    wallet.lockedMarginUsdt = Math.max(0, +(wallet.lockedMarginUsdt + params.marginDelta).toFixed(6));
    wallet.realizedPnlUsdt = +(wallet.realizedPnlUsdt + params.realizedDelta).toFixed(6);
    wallet.dailyPnlUsdt = +(wallet.dailyPnlUsdt + params.realizedDelta).toFixed(6);
    wallet.totalFeesUsdt = +(wallet.totalFeesUsdt + params.feeDelta).toFixed(6);
    wallet.totalFundingUsdt = +(wallet.totalFundingUsdt + params.fundingDelta).toFixed(6);
    wallet.updatedAt = new Date().toISOString();

    store.ledger.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: params.userId,
      idempotencyKey: params.idempotencyKey,
      opType: params.opType,
      symbol: params.symbol ?? null,
      positionId: params.positionId ?? null,
      amountUsdt: params.balanceDelta,
      balanceAfterUsdt: wallet.balanceUsdt,
      note: params.note,
      createdAt: new Date().toISOString(),
    });
    if (store.ledger.length > 500) store.ledger.length = 500;
    saveLocalStore(store);

    return { applied: true, duplicate: false, wallet };
  },

  /**
   * Adjusts Paper Trading Capital safely WITHOUT erasing or corrupting closed trade history.
   */
  async setInitialCapital(
    userId = DEFAULT_USER_ID,
    newCapitalUsdt: number
  ): Promise<PaperWallet> {
    const cleanCap = Math.max(10, Math.min(100_000_000, Number(newCapitalUsdt) || 10000));
    const current = await this.getWallet(userId);
    const oldInitial = current.initialBalanceUsdt || 10000;
    const oldBalance = current.balanceUsdt ?? oldInitial;
    const capitalDelta = +(cleanCap - oldBalance).toFixed(6);
    // Set active wallet balance cleanly to the chosen capital (preserving any locked margin on live positions)
    // and reset session PnL/fee/funding/daily counters so daily loss limits & equity match the new capital
    // without deleting or archiving closed trade history.
    const nextBalance = Math.max(current.lockedMarginUsdt || 0, +cleanCap.toFixed(6));
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const idem = `setcap:${userId}:${cleanCap}:${Date.now()}`;

    const sb = getSupabaseAdmin();
    if (sb) {
      await sb
        .from('cx_wallets')
        .upsert(
          {
            user_id: userId,
            balance_usdt: nextBalance,
            initial_balance_usdt: cleanCap,
            realized_pnl_usdt: 0,
            total_fees_usdt: 0,
            total_funding_usdt: 0,
            daily_pnl_usdt: 0,
            daily_reset_date: today,
            updated_at: nowIso,
          },
          { onConflict: 'user_id' }
        );
      await sb.from('cx_wallet_ledger').insert({
        user_id: userId,
        idempotency_key: idem,
        op_type: 'SET_CAPITAL',
        symbol: null,
        position_id: null,
        amount_usdt: capitalDelta,
        balance_after_usdt: nextBalance,
        note: `ضبط رصيد المحفظة من ${oldBalance.toFixed(2)}$ إلى ${nextBalance.toFixed(2)}$ (رأس المال ${cleanCap.toFixed(2)}$، مع الحفاظ على سجل الصفقات)`,
      });
    }

    const store = getLocal();
    const w = await this.getWallet(userId);
    w.initialBalanceUsdt = cleanCap;
    w.balanceUsdt = nextBalance;
    w.realizedPnlUsdt = 0;
    w.totalFeesUsdt = 0;
    w.totalFundingUsdt = 0;
    w.dailyPnlUsdt = 0;
    w.dailyResetDate = today;
    w.updatedAt = nowIso;
    store.wallets[userId] = w;
    store.ledger.unshift({
      id: `cap-${Date.now()}`,
      userId,
      idempotencyKey: idem,
      opType: 'SET_CAPITAL',
      symbol: null,
      positionId: null,
      amountUsdt: capitalDelta,
      balanceAfterUsdt: nextBalance,
      note: `ضبط رصيد المحفظة من ${oldBalance.toFixed(2)}$ إلى ${nextBalance.toFixed(2)}$ (رأس المال ${cleanCap.toFixed(2)}$، مع الحفاظ على سجل الصفقات)`,
      createdAt: nowIso,
    });
    saveLocalStore(store);
    return w;
  },

  /**
   * Resets Paper Wallet cleanly for a fresh simulation run while archiving previous history.
   */
  async resetSimulation(
    userId = DEFAULT_USER_ID,
    opts?: { archiveHistory?: boolean; newInitialCapital?: number }
  ): Promise<PaperWallet> {
    const archiveHistory = opts?.archiveHistory !== false;
    const current = await this.getWallet(userId);
    const targetCapital = Math.max(
      10,
      Math.min(100_000_000, Number(opts?.newInitialCapital ?? current.initialBalanceUsdt ?? 10000))
    );
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const newRunId = `run-${Date.now().toString(36)}`;
    const sb = getSupabaseAdmin();

    if (sb) {
      // Cancel open/pending positions
      await sb
        .from('cx_paper_trades')
        .update({ status: 'CANCELLED', outcome: 'WALLET_RESET', closed_at: nowIso })
        .eq('user_id', userId)
        .in('status', ['OPEN', 'PENDING']);

      // Archive completed/previous trades if column exists
      if (archiveHistory) {
        const { error: archErr } = await sb
          .from('cx_paper_trades')
          .update({ archived_at: nowIso })
          .eq('user_id', userId)
          .is('archived_at', null);
        if (archErr && /archived_at|42703/i.test(archErr.message)) {
          // Schema v3 migration pending — ignore missing column safely
        }
      }

      const walletRow: Record<string, any> = {
        user_id: userId,
        balance_usdt: targetCapital,
        locked_margin_usdt: 0,
        realized_pnl_usdt: 0,
        total_fees_usdt: 0,
        total_funding_usdt: 0,
        daily_pnl_usdt: 0,
        daily_reset_date: today,
        initial_balance_usdt: targetCapital,
        simulation_run_id: newRunId,
        reset_at: nowIso,
        updated_at: nowIso,
      };
      let { error } = await sb.from('cx_wallets').upsert(walletRow);
      if (error && /simulation_run_id|reset_at|42703/i.test(error.message)) {
        delete walletRow.simulation_run_id;
        delete walletRow.reset_at;
        await sb.from('cx_wallets').upsert(walletRow);
      }

      await sb.from('cx_wallet_ledger').insert({
        user_id: userId,
        idempotency_key: `reset:${userId}:${Date.now()}`,
        op_type: 'RESET_SIMULATION',
        symbol: null,
        position_id: null,
        amount_usdt: targetCapital,
        balance_after_usdt: targetCapital,
        note: `بدء محاكاة جديدة برصيد ${targetCapital.toFixed(2)} USDT (${archiveHistory ? 'مع أرشفة السجل السابق' : 'دون أرشفة'})`,
      });
    }

    const store = getLocal();
    for (const tr of store.trades) {
      if (tr.userId !== userId) continue;
      if (tr.status === 'OPEN' || tr.status === 'PENDING') {
        tr.status = 'CANCELLED';
        tr.outcome = 'WALLET_RESET';
        tr.closedAt = nowIso;
      }
      if (archiveHistory && !tr.archivedAt) {
        tr.archivedAt = nowIso;
      }
    }
    const fresh = defaultWallet(userId, targetCapital);
    fresh.simulationRunId = newRunId;
    fresh.resetAt = nowIso;
    store.wallets[userId] = fresh;
    store.ledger.unshift({
      id: `reset-${Date.now()}`,
      userId,
      idempotencyKey: `reset:${userId}:${Date.now()}`,
      opType: 'RESET_SIMULATION',
      symbol: null,
      positionId: null,
      amountUsdt: targetCapital,
      balanceAfterUsdt: targetCapital,
      note: `بدء محاكاة جديدة برصيد ${targetCapital.toFixed(2)} USDT (${archiveHistory ? 'مع أرشفة السجل السابق' : 'دون أرشفة'})`,
      createdAt: nowIso,
    });
    saveLocalStore(store);
    return fresh;
  },

  async resetPaperWallet(userId = DEFAULT_USER_ID): Promise<PaperWallet> {
    return this.resetSimulation(userId, { archiveHistory: true });
  },

  async getLedger(userId = DEFAULT_USER_ID, limit = 80): Promise<WalletLedgerEntry[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_wallet_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) {
        return data.map((r: any) => ({
          id: r.id,
          userId: r.user_id,
          idempotencyKey: r.idempotency_key,
          opType: r.op_type,
          symbol: r.symbol,
          positionId: r.position_id,
          amountUsdt: Number(r.amount_usdt),
          balanceAfterUsdt: Number(r.balance_after_usdt),
          note: r.note || '',
          createdAt: String(r.created_at),
        }));
      }
    }
    return getLocal().ledger.filter((x) => x.userId === userId).slice(0, limit);
  },

  async getTrades(userId = DEFAULT_USER_ID, includeArchived = false): Promise<PaperPosition[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_paper_trades')
        .select('*')
        .eq('user_id', userId)
        .order('opened_at', { ascending: false })
        .limit(250);
      if (!error && data) {
        const mapped = data.map(mapTradeRow);
        return includeArchived ? mapped : mapped.filter((t) => !t.archivedAt);
      }
    }
    const localList = getLocal()
      .trades.filter((t) => t.userId === userId)
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, 250);
    return includeArchived ? localList : localList.filter((t) => !t.archivedAt);
  },

  async upsertTrade(pos: PaperPosition): Promise<{ inserted: boolean; trade: PaperPosition }> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data: existing } = await sb
        .from('cx_paper_trades')
        .select('id')
        .eq('user_id', pos.userId)
        .eq('idempotency_key', pos.idempotencyKey)
        .maybeSingle();

      const baseRow: Record<string, any> = {
        id: pos.id,
        user_id: pos.userId,
        idempotency_key: pos.idempotencyKey,
        symbol: pos.symbol,
        side: pos.side,
        order_type: pos.orderType,
        status: pos.status,
        score: pos.score,
        tier: pos.tier,
        mode: pos.mode,
        entry_kind: pos.entryKind || 'CONFIRMED_ENTRY',
        simulation_run_id: pos.simulationRunId || 'run-1',
        archived_at: pos.archivedAt ?? null,
        entry_price: pos.entryPrice,
        stop_loss: pos.stopLoss,
        stop_current: pos.stopCurrent,
        liq_price: pos.liqPrice,
        mark_price_last: pos.markPriceLast,
        maintenance_margin_rate: pos.maintenanceMarginRate,
        maintenance_margin_usdt: pos.maintenanceMarginUsdt,
        leverage: pos.leverage,
        qty: pos.qty,
        remaining_qty: pos.remainingQty,
        notional_usdt: pos.notionalUsdt,
        margin_usdt: pos.marginUsdt,
        tps_json: pos.tps,
        fees_usdt: pos.feesUsdt,
        slippage_usdt: pos.slippageUsdt,
        funding_usdt: pos.fundingUsdt,
        realized_pnl_usdt: pos.realizedPnlUsdt,
        net_pnl_usdt: pos.netPnlUsdt,
        r_multiple: pos.rMultiple,
        outcome: pos.outcome,
        exit_price: pos.exitPrice,
        last_funding_ts: pos.lastFundingTs,
        safety_buffer_pct: pos.safetyBufferPct,
        liq_warning_sent: Boolean(pos.liqWarningSent),
        opened_at: pos.openedAt,
        filled_at: pos.filledAt,
        closed_at: pos.closedAt,
        expires_at: pos.expiresAt ?? null,
        meta_json: {
          ...(pos.meta || {}),
          liqWarningSent: Boolean(pos.liqWarningSent),
          expiresAt: pos.expiresAt ?? null,
          entryKind: pos.entryKind || 'CONFIRMED_ENTRY',
          simulationRunId: pos.simulationRunId || 'run-1',
          archivedAt: pos.archivedAt ?? null,
        },
      };
      let { error } = await sb.from('cx_paper_trades').upsert(baseRow, { onConflict: 'id' });
      if (error && /entry_kind|simulation_run_id|archived_at|expires_at|schema cache|42703/i.test(error.message)) {
        delete baseRow.entry_kind;
        delete baseRow.simulation_run_id;
        delete baseRow.archived_at;
        if (/expires_at/i.test(error.message)) delete baseRow.expires_at;
        ({ error } = await sb.from('cx_paper_trades').upsert(baseRow, { onConflict: 'id' }));
      }
      if (!error) return { inserted: !existing, trade: pos };
      console.error('[repo] upsertTrade supabase error:', error.message);
    }

    const store = getLocal();
    const idx = store.trades.findIndex((t) => t.id === pos.id);
    if (idx >= 0) {
      store.trades[idx] = pos;
      saveLocalStore(store);
      return { inserted: false, trade: pos };
    }
    const dup = store.trades.find(
      (t) => t.userId === pos.userId && t.idempotencyKey === pos.idempotencyKey
    );
    if (dup) return { inserted: false, trade: dup };
    store.trades.unshift(pos);
    if (store.trades.length > 350) store.trades.length = 350;
    saveLocalStore(store);
    return { inserted: true, trade: pos };
  },

  async getBotSettings(userId = DEFAULT_USER_ID): Promise<BotSettings> {
    const store = getLocal();
    const localFallback = store.settings[userId];
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_bot_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (!error && data) return mapSettingsRow(data, localFallback);
      if (!error && !data) {
        const def = defaultBotSettings(userId);
        await this.saveBotSettings(def);
        return def;
      }
    }
    if (!store.settings[userId]) {
      store.settings[userId] = defaultBotSettings(userId);
      saveLocalStore(store);
    }
    return { ...defaultBotSettings(userId), ...store.settings[userId] };
  },

  async saveBotSettings(s: BotSettings): Promise<BotSettings> {
    s.updatedAt = new Date().toISOString();
    // Synchronize executionMode and autoTradeEnabled strictly
    if (s.executionMode === 'AUTO' || s.executionMode === 'MANUAL') {
      s.autoTradeEnabled = s.executionMode === 'AUTO';
    } else {
      s.executionMode = s.autoTradeEnabled ? 'AUTO' : 'MANUAL';
    }

    const sb = getSupabaseAdmin();
    if (sb) {
      const row: Record<string, any> = {
        user_id: s.userId,
        auto_trade_enabled: s.autoTradeEnabled,
        execution_mode: s.executionMode,
        emergency_stopped: s.emergencyStopped,
        emergency_reason: s.emergencyReason,
        mode: s.mode,
        early_trigger_tf: s.earlyTriggerTf || '15m',
        risk_pct: s.riskPct,
        max_leverage: s.maxLeverage,
        max_open_positions: s.maxOpenPositions,
        equal_allocation_enabled: s.equalAllocationEnabled !== false,
        cash_reserve_pct: s.cashReservePct ?? 10,
        max_portfolio_heat_pct: s.maxPortfolioHeatPct,
        max_same_side_positions: s.maxSameSidePositions,
        btc_filter_enabled: s.btcFilterEnabled,
        min_volume_usdt: s.minVolumeUsdt,
        max_spread_bps: s.maxSpreadBps,
        daily_loss_limit_usdt: s.dailyLossLimitUsdt,
        daily_loss_limit_pct: s.dailyLossLimitPct,
        min_liq_safety_pct: s.minLiqSafetyPct,
        allowed_symbols: s.allowedSymbols,
        min_tier: s.minTier,
        min_score: s.minScore,
        strong_score: s.strongScore,
        watch_score: s.watchScore,
        taker_fee: s.takerFee,
        maker_fee: s.makerFee,
        slippage: s.slippage,
        tp_pcts_json: s.tpPcts || [40, 35, 25],
        limit_expire_bars: s.limitExpireBars ?? 8,
        cancel_chased_atr: s.cancelChasedAtr ?? 2.4,
        allow_reentry: s.allowReentry !== false,
        reentry_cooldown_bars: s.reentryCooldownBars ?? 6,
        trailing_stop_enabled: s.trailingStopEnabled !== false,
        filter_flags_json: s.filterFlags || defaultBotSettings(s.userId).filterFlags,
        notify_prefs_json: s.notifyPrefs || defaultBotSettings(s.userId).notifyPrefs,
        early_weights_json: s.earlyWeights || DEFAULT_EARLY_WEIGHTS,
        smart_profit_shield: s.smartProfitShield !== false,
        smart_tp_enabled: s.smartTakeProfitEnabled !== false,
        smart_tp_min_r: s.smartTakeProfitMinR ?? 0.6,
        smart_tp_partial_pct: s.smartTakeProfitPartialPct ?? 50,
        smart_tp_sensitivity: s.smartTakeProfitSensitivity || 'balanced',
        updated_at: s.updatedAt,
      };
      let { error } = await sb.from('cx_bot_settings').upsert(row);
      if (error && /execution_mode|equal_allocation|cash_reserve|early_trigger|tp_pcts|schema cache|42703/i.test(error.message)) {
        delete row.execution_mode;
        delete row.equal_allocation_enabled;
        delete row.cash_reserve_pct;
        delete row.early_trigger_tf;
        delete row.tp_pcts_json;
        delete row.limit_expire_bars;
        delete row.cancel_chased_atr;
        delete row.allow_reentry;
        delete row.reentry_cooldown_bars;
        delete row.trailing_stop_enabled;
        delete row.filter_flags_json;
        delete row.notify_prefs_json;
        delete row.early_weights_json;
        ({ error } = await sb.from('cx_bot_settings').upsert(row));
      }
      if (error && /smart_profit_shield|smart_tp_|max_portfolio_heat_pct|schema cache|42703/i.test(error.message)) {
        delete row.smart_profit_shield;
        delete row.smart_tp_enabled;
        delete row.smart_tp_min_r;
        delete row.smart_tp_partial_pct;
        delete row.smart_tp_sensitivity;
        await sb.from('cx_bot_settings').upsert(row);
      }
    }
    const store = getLocal();
    store.settings[s.userId] = s;
    saveLocalStore(store);
    return s;
  },

  async addNotification(n: AppNotification): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_notifications').upsert({
        id: n.id,
        user_id: n.userId,
        event_type: n.eventType,
        severity: n.severity,
        symbol: n.symbol,
        title: n.title,
        body: n.body,
        is_read: n.isRead,
        meta_json: n.meta || {},
        created_at: n.createdAt,
      });
    }
    const store = getLocal();
    store.notifications.unshift(n);
    if (store.notifications.length > 250) store.notifications.length = 250;
    saveLocalStore(store);
  },

  async getNotifications(userId = DEFAULT_USER_ID, limit = 80): Promise<AppNotification[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) {
        return data.map((r: any) => ({
          id: r.id,
          userId: r.user_id,
          eventType: r.event_type,
          severity: r.severity,
          symbol: r.symbol,
          title: r.title,
          body: r.body,
          isRead: Boolean(r.is_read),
          meta: r.meta_json || {},
          createdAt: String(r.created_at),
        }));
      }
    }
    return getLocal().notifications.filter((n) => n.userId === userId).slice(0, limit);
  },

  async markNotificationsRead(userId = DEFAULT_USER_ID): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_notifications').update({ is_read: true }).eq('user_id', userId);
    }
    const store = getLocal();
    for (const n of store.notifications) {
      if (n.userId === userId) n.isRead = true;
    }
    saveLocalStore(store);
  },

  async savePushSubscription(sub: PushSubscriptionRecord): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_push_subscriptions').upsert(
        {
          user_id: sub.userId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
        { onConflict: 'endpoint' }
      );
    }
    const store = getLocal();
    const idx = store.pushSubscriptions.findIndex((s) => s.endpoint === sub.endpoint);
    if (idx >= 0) store.pushSubscriptions[idx] = sub;
    else store.pushSubscriptions.push(sub);
    saveLocalStore(store);
  },

  async getPushSubscriptions(userId = DEFAULT_USER_ID): Promise<PushSubscriptionRecord[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_push_subscriptions')
        .select('*')
        .eq('user_id', userId);
      if (!error && data) {
        return data.map((r: any) => ({
          userId: r.user_id,
          endpoint: r.endpoint,
          p256dh: r.p256dh,
          auth: r.auth,
          createdAt: String(r.created_at),
        }));
      }
    }
    return getLocal().pushSubscriptions.filter((s) => s.userId === userId);
  },

  async removePushSubscription(endpoint: string): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_push_subscriptions').delete().eq('endpoint', endpoint);
    }
    const store = getLocal();
    store.pushSubscriptions = store.pushSubscriptions.filter((s) => s.endpoint !== endpoint);
    saveLocalStore(store);
  },

  async getSignals(userId = DEFAULT_USER_ID, limit = 300): Promise<any[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_signals')
        .select('payload')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (!error && data) {
        return data.map((r: any) => r.payload).filter(Boolean).reverse();
      }
    }
    const list = Object.values(getLocal().signals || {})
      .filter((s: any) => !s.userId || s.userId === userId)
      .sort((a: any, b: any) => Number(a.t0 || 0) - Number(b.t0 || 0));
    return list.slice(-limit);
  },

  async upsertSignals(userId = DEFAULT_USER_ID, signals: any[]): Promise<void> {
    if (!Array.isArray(signals) || !signals.length) return;
    const nowIso = new Date().toISOString();
    const sb = getSupabaseAdmin();
    if (sb) {
      const rows = signals
        .filter((s) => s && s.id && s.sym)
        .map((s) => ({
          id: String(s.id),
          user_id: userId,
          symbol: String(s.sym),
          payload: s,
          status: String(s.status || 'OPEN'),
          created_at: s.t0 ? new Date(s.t0).toISOString() : nowIso,
          updated_at: nowIso,
        }));
      if (rows.length) {
        const { error } = await sb.from('cx_signals').upsert(rows, { onConflict: 'id' });
        if (error) console.error('[repo] upsertSignals supabase error:', error.message);
      }
    }

    const store = getLocal();
    store.signals = store.signals || {};
    for (const s of signals) {
      if (s && s.id) {
        store.signals[String(s.id)] = { ...s, userId };
      }
    }
    const keys = Object.keys(store.signals);
    if (keys.length > 350) {
      const sorted = keys
        .map((k) => store.signals[k])
        .sort((a: any, b: any) => Number(a.t0 || 0) - Number(b.t0 || 0))
        .slice(-300);
      store.signals = {};
      for (const item of sorted) store.signals[String(item.id)] = item;
    }
    saveLocalStore(store);
  },

  async clearSignals(userId = DEFAULT_USER_ID): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_signals').delete().eq('user_id', userId);
    }
    const store = getLocal();
    for (const k of Object.keys(store.signals || {})) {
      const item = store.signals[k];
      if (!item?.userId || item.userId === userId) {
        delete store.signals[k];
      }
    }
    saveLocalStore(store);
  },

  async getAllActiveAutoUsers(): Promise<string[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_bot_settings')
        .select('user_id')
        .eq('auto_trade_enabled', true)
        .eq('emergency_stopped', false);
      if (!error && data && data.length > 0) {
        return data.map((r: any) => r.user_id);
      }
    }
    const localIds = Object.keys(getLocal().settings);
    return localIds.length ? localIds : [DEFAULT_USER_ID];
  },

  // ---------- Worker State & Heartbeat Persistence ----------
  async getEngineState(userId = DEFAULT_USER_ID): Promise<WorkerStatusRecord> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_engine_state')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (!error && data) {
        const started = data.started_at ? new Date(data.started_at).getTime() : 0;
        const lastHb = data.last_heartbeat_at ? new Date(data.last_heartbeat_at).getTime() : 0;
        const freshHb = lastHb > 0 && Date.now() - lastHb < 90_000;
        return {
          userId: data.user_id,
          workerId: data.worker_id || 'main-worker',
          workerStatus: data.worker_status || 'STOPPED',
          executionMode: data.execution_mode === 'AUTO' ? 'AUTO' : 'MANUAL',
          workerConnected: freshHb && data.worker_status === 'RUNNING',
          supabaseConnected: true,
          lastHeartbeatAt: data.last_heartbeat_at ? String(data.last_heartbeat_at) : null,
          lastScanAt: data.last_scan_at ? String(data.last_scan_at) : null,
          lastSignalEvalAt: data.last_signal_eval_at ? String(data.last_signal_eval_at) : null,
          lastTradeExecAt: data.last_trade_exec_at ? String(data.last_trade_exec_at) : null,
          startedAt: data.started_at ? String(data.started_at) : null,
          uptimeSec: started > 0 && data.worker_status === 'RUNNING' ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0,
          symbolsScanned: Number(data.symbols_scanned || 0),
          activeSignalsCount: Number(data.active_signals_count || 0),
          openPositionsCount: Number(data.open_positions_count || 0),
          pendingOrdersCount: Number(data.pending_orders_count || 0),
          tradesToday: Number(data.trades_today || 0),
          cyclesCompleted: Number(data.cycles_completed || 0),
          lastError: data.last_error || null,
          consecutiveErrors: Number(data.consecutive_errors || 0),
          paperTradingStatus: data.worker_status === 'RUNNING' ? 'محرك نشط (Paper Trading)' : 'متوقف',
          updatedAt: String(data.updated_at),
        };
      }
    }
    const store = getLocal();
    const cur = store.engineState[userId] || defaultWorkerStatus(userId);
    const lastHb = cur.lastHeartbeatAt ? new Date(cur.lastHeartbeatAt).getTime() : 0;
    const started = cur.startedAt ? new Date(cur.startedAt).getTime() : 0;
    return {
      ...cur,
      supabaseConnected: sb !== null,
      workerConnected: lastHb > 0 && Date.now() - lastHb < 90_000 && cur.workerStatus === 'RUNNING',
      uptimeSec: started > 0 && cur.workerStatus === 'RUNNING' ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0,
    };
  },

  async saveEngineState(st: WorkerStatusRecord): Promise<void> {
    const nowIso = new Date().toISOString();
    st.updatedAt = nowIso;
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_engine_state').upsert({
        user_id: st.userId,
        worker_id: st.workerId,
        worker_status: st.workerStatus,
        execution_mode: st.executionMode,
        last_heartbeat_at: st.lastHeartbeatAt,
        last_scan_at: st.lastScanAt,
        last_signal_eval_at: st.lastSignalEvalAt,
        last_trade_exec_at: st.lastTradeExecAt,
        started_at: st.startedAt,
        symbols_scanned: st.symbolsScanned,
        active_signals_count: st.activeSignalsCount,
        open_positions_count: st.openPositionsCount,
        pending_orders_count: st.pendingOrdersCount,
        trades_today: st.tradesToday,
        cycles_completed: st.cyclesCompleted,
        last_error: st.lastError,
        consecutive_errors: st.consecutiveErrors,
        updated_at: nowIso,
      });
    }
    const store = getLocal();
    store.engineState[st.userId] = st;
    saveLocalStore(store);
  },

  // ---------- Backend Decision & Diagnostic Logs ----------
  async appendEngineLog(entry: Omit<EngineLogEntry, 'id' | 'createdAt'>): Promise<EngineLogEntry> {
    const item: EngineLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      ...entry,
    };
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_engine_logs').insert({
        id: item.id,
        user_id: item.userId,
        level: item.level,
        category: item.category,
        symbol: item.symbol,
        message: item.message,
        details_json: item.details || {},
        created_at: item.createdAt,
      });
    }
    const store = getLocal();
    store.engineLogs.unshift(item);
    if (store.engineLogs.length > 300) store.engineLogs.length = 300;
    saveLocalStore(store);
    return item;
  },

  async getEngineLogs(userId = DEFAULT_USER_ID, limit = 80): Promise<EngineLogEntry[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_engine_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) {
        return data.map((r: any) => ({
          id: r.id,
          userId: r.user_id,
          level: r.level,
          category: r.category,
          symbol: r.symbol ?? null,
          message: r.message,
          details: r.details_json || {},
          createdAt: String(r.created_at),
        }));
      }
    }
    return getLocal().engineLogs.filter((l) => l.userId === userId).slice(0, limit);
  },

  // ---------- Signal Analytics & Adaptive Strategy Weights ----------
  async upsertSignalAnalytics(rec: SignalTelemetryRecord): Promise<void> {
    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_signal_analytics').upsert({
        id: rec.id,
        user_id: rec.userId,
        symbol: rec.symbol,
        side: rec.side,
        strategy_mode: rec.strategyMode,
        entry_kind: rec.entryKind,
        entry_status: rec.entryStatus,
        timeframe: rec.timeframe,
        regime: rec.regime,
        score: rec.score,
        raw_score: rec.rawScore,
        signal_price: rec.signalPrice,
        entry_price: rec.entryPrice,
        fill_price: rec.fillPrice ?? null,
        distance_moved_pct: rec.distanceMovedPct,
        delay_ms: rec.delayMs ?? null,
        still_valid: rec.stillValid,
        early_reason: rec.earlyReason,
        confirm_factors_json: rec.confirmFactors || [],
        missing_confirmations_json: rec.missingConfirmations || [],
        score_breakdown_json: rec.scoreBreakdown || {},
        taken_by_user_or_auto: rec.takenByUserOrAuto,
        position_id: rec.positionId ?? null,
        outcome: rec.outcome ?? null,
        close_reason: rec.closeReason ?? null,
        net_r: rec.netR ?? null,
        net_pnl_usdt: rec.netPnlUsdt ?? null,
        mfe_r: rec.mfeR ?? null,
        mae_r: rec.maeR ?? null,
        tp1_hit: Boolean(rec.tp1Hit),
        tp2_hit: Boolean(rec.tp2Hit),
        tp3_hit: Boolean(rec.tp3Hit),
        was_late_entry: Boolean(rec.wasLateEntry),
        missed_opportunity: Boolean(rec.missedOpportunity),
        simulation_run_id: rec.simulationRunId ?? null,
        created_at: rec.createdAt,
        closed_at: rec.closedAt ?? null,
      });
    }
    const store = getLocal();
    const idx = store.signalAnalytics.findIndex((x) => x.id === rec.id || (rec.positionId && x.positionId === rec.positionId));
    if (idx >= 0) store.signalAnalytics[idx] = { ...store.signalAnalytics[idx], ...rec };
    else store.signalAnalytics.unshift(rec);
    if (store.signalAnalytics.length > 600) store.signalAnalytics.length = 600;
    saveLocalStore(store);
  },

  async getSignalAnalytics(userId = DEFAULT_USER_ID, limit = 400): Promise<SignalTelemetryRecord[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_signal_analytics')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) {
        return data.map((r: any) => ({
          id: r.id,
          userId: r.user_id,
          symbol: r.symbol,
          side: r.side,
          strategyMode: r.strategy_mode,
          entryKind: r.entry_kind,
          entryStatus: r.entry_status,
          timeframe: r.timeframe,
          regime: r.regime,
          score: Number(r.score),
          rawScore: Number(r.raw_score),
          signalPrice: Number(r.signal_price),
          entryPrice: Number(r.entry_price),
          fillPrice: r.fill_price != null ? Number(r.fill_price) : null,
          distanceMovedPct: Number(r.distance_moved_pct || 0),
          delayMs: r.delay_ms != null ? Number(r.delay_ms) : null,
          stillValid: Boolean(r.still_valid),
          earlyReason: r.early_reason || '',
          confirmFactors: Array.isArray(r.confirm_factors_json) ? r.confirm_factors_json : [],
          missingConfirmations: Array.isArray(r.missing_confirmations_json) ? r.missing_confirmations_json : [],
          scoreBreakdown: r.score_breakdown_json || {},
          takenByUserOrAuto: Boolean(r.taken_by_user_or_auto),
          positionId: r.position_id ?? null,
          outcome: r.outcome ?? null,
          closeReason: r.close_reason ?? null,
          netR: r.net_r != null ? Number(r.net_r) : null,
          netPnlUsdt: r.net_pnl_usdt != null ? Number(r.net_pnl_usdt) : null,
          mfeR: r.mfe_r != null ? Number(r.mfe_r) : null,
          maeR: r.mae_r != null ? Number(r.mae_r) : null,
          tp1Hit: Boolean(r.tp1_hit),
          tp2Hit: Boolean(r.tp2_hit),
          tp3Hit: Boolean(r.tp3_hit),
          wasLateEntry: Boolean(r.was_late_entry),
          missedOpportunity: Boolean(r.missed_opportunity),
          simulationRunId: r.simulation_run_id ?? null,
          createdAt: String(r.created_at),
          closedAt: r.closed_at ? String(r.closed_at) : null,
        }));
      }
    }
    return getLocal().signalAnalytics.filter((x) => x.userId === userId).slice(0, limit);
  },

  async getStrategyWeightHistory(userId = DEFAULT_USER_ID): Promise<StrategyWeightSnapshot[]> {
    const sb = getSupabaseAdmin();
    if (sb) {
      const { data, error } = await sb
        .from('cx_strategy_weights')
        .select('*')
        .eq('user_id', userId)
        .order('version', { ascending: false })
        .limit(30);
      if (!error && data && data.length > 0) {
        return data.map((r: any) => ({
          id: r.id,
          userId: r.user_id,
          version: Number(r.version),
          strategyMode: 'early',
          weights: normalizeEarlyWeights(r.weights_json),
          note: r.note || '',
          proposalId: r.proposal_id ?? null,
          metricsSummary: r.metrics_summary_json || {},
          isActive: Boolean(r.is_active),
          createdAt: String(r.created_at),
        }));
      }
    }
    const list = getLocal()
      .strategyWeights.filter((x) => x.userId === userId)
      .sort((a, b) => b.version - a.version);
    if (list.length === 0) {
      return [
        {
          id: `w-${userId}-v1`,
          userId,
          version: 1,
          strategyMode: 'early',
          weights: { ...DEFAULT_EARLY_WEIGHTS },
          note: 'الأوزان المبدئية المرجعية لاستراتيجية الدخول المبكر',
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    return list;
  },

  async saveStrategyWeightSnapshot(params: {
    userId: string;
    weights: EarlyEntryWeights;
    note: string;
    proposalId?: string | null;
    metricsSummary?: Record<string, any>;
  }): Promise<StrategyWeightSnapshot> {
    const hist = await this.getStrategyWeightHistory(params.userId);
    const nextVersion = hist.length > 0 ? Math.max(...hist.map((h) => h.version)) + 1 : 2;
    const snap: StrategyWeightSnapshot = {
      id: `w-${params.userId}-v${nextVersion}-${Date.now().toString(36)}`,
      userId: params.userId,
      version: nextVersion,
      strategyMode: 'early',
      weights: normalizeEarlyWeights(params.weights),
      note: params.note,
      proposalId: params.proposalId ?? null,
      metricsSummary: params.metricsSummary || {},
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    const sb = getSupabaseAdmin();
    if (sb) {
      await sb.from('cx_strategy_weights').update({ is_active: false }).eq('user_id', params.userId);
      await sb.from('cx_strategy_weights').insert({
        id: snap.id,
        user_id: snap.userId,
        version: snap.version,
        strategy_mode: snap.strategyMode,
        weights_json: snap.weights,
        note: snap.note,
        proposal_id: snap.proposalId,
        metrics_summary_json: snap.metricsSummary || {},
        is_active: true,
        created_at: snap.createdAt,
      });
    }

    const store = getLocal();
    for (const item of store.strategyWeights) {
      if (item.userId === params.userId) item.isActive = false;
    }
    store.strategyWeights.unshift(snap);
    saveLocalStore(store);

    // Sync active earlyWeights into bot settings
    const settings = await this.getBotSettings(params.userId);
    settings.earlyWeights = snap.weights;
    await this.saveBotSettings(settings);

    return snap;
  },
};
