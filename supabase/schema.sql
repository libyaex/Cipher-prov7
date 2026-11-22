-- ============================================================================
-- CIPHER X PRO — Supabase PostgreSQL Schema (Idempotent & Protected v2)
-- Note: Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere to allow
-- safe re-runs without duplicating existing tables.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. User Paper Trading Wallets (Default 10,000 USDT)
CREATE TABLE IF NOT EXISTS public.cx_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  balance_usdt NUMERIC(18, 6) NOT NULL DEFAULT 10000.000000,
  locked_margin_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
  realized_pnl_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
  total_fees_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
  total_funding_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
  daily_pnl_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
  daily_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
  initial_balance_usdt NUMERIC(18, 6) NOT NULL DEFAULT 10000.000000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Immutable Wallet Financial Ledger with Idempotency Keys
CREATE TABLE IF NOT EXISTS public.cx_wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  op_type TEXT NOT NULL,
  symbol TEXT,
  position_id TEXT,
  amount_usdt NUMERIC(18, 6) NOT NULL,
  balance_after_usdt NUMERIC(18, 6) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cx_wallet_ledger_idem_uniq UNIQUE (user_id, idempotency_key)
);

-- 3. Paper Positions & Trade History
CREATE TABLE IF NOT EXISTS public.cx_paper_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'LIQUIDATED')),
  score INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'GOOD',
  mode TEXT NOT NULL DEFAULT 'intraday',
  entry_price NUMERIC(20, 8) NOT NULL,
  stop_loss NUMERIC(20, 8) NOT NULL,
  stop_current NUMERIC(20, 8) NOT NULL,
  liq_price NUMERIC(20, 8) NOT NULL,
  mark_price_last NUMERIC(20, 8),
  maintenance_margin_rate NUMERIC(10, 6) NOT NULL DEFAULT 0.005,
  maintenance_margin_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  leverage NUMERIC(8, 2) NOT NULL,
  qty NUMERIC(20, 8) NOT NULL,
  remaining_qty NUMERIC(20, 8) NOT NULL,
  notional_usdt NUMERIC(18, 6) NOT NULL,
  margin_usdt NUMERIC(18, 6) NOT NULL,
  tps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  fees_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  slippage_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  funding_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  realized_pnl_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  net_pnl_usdt NUMERIC(18, 6) NOT NULL DEFAULT 0,
  r_multiple NUMERIC(10, 4),
  outcome TEXT,
  exit_price NUMERIC(20, 8),
  last_funding_ts BIGINT DEFAULT 0,
  safety_buffer_pct NUMERIC(8, 4) NOT NULL DEFAULT 0,
  liq_warning_sent BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT cx_paper_trades_idem_uniq UNIQUE (user_id, idempotency_key)
);

ALTER TABLE public.cx_paper_trades
  ADD COLUMN IF NOT EXISTS liq_warning_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 4. Auto-Trading, Risk Shield & Strategy Settings
CREATE TABLE IF NOT EXISTS public.cx_bot_settings (
  user_id TEXT PRIMARY KEY,
  auto_trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stopped BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_reason TEXT,
  mode TEXT NOT NULL DEFAULT 'intraday',
  risk_pct NUMERIC(6, 3) NOT NULL DEFAULT 1.000,
  max_leverage INTEGER NOT NULL DEFAULT 15,
  max_open_positions INTEGER NOT NULL DEFAULT 4,
  max_portfolio_heat_pct NUMERIC(6, 3) NOT NULL DEFAULT 6.000,
  max_same_side_positions INTEGER NOT NULL DEFAULT 3,
  btc_filter_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  min_volume_usdt NUMERIC(18, 2) NOT NULL DEFAULT 25000000,
  max_spread_bps NUMERIC(8, 2) NOT NULL DEFAULT 8.00,
  daily_loss_limit_usdt NUMERIC(18, 6) NOT NULL DEFAULT 500.000000,
  daily_loss_limit_pct NUMERIC(6, 3) NOT NULL DEFAULT 5.000,
  min_liq_safety_pct NUMERIC(6, 3) NOT NULL DEFAULT 25.000,
  allowed_symbols JSONB NOT NULL DEFAULT '["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"]'::jsonb,
  min_tier TEXT NOT NULL DEFAULT 'GOOD',
  min_score INTEGER NOT NULL DEFAULT 70,
  strong_score INTEGER NOT NULL DEFAULT 80,
  watch_score INTEGER NOT NULL DEFAULT 62,
  taker_fee NUMERIC(10, 6) NOT NULL DEFAULT 0.0005,
  maker_fee NUMERIC(10, 6) NOT NULL DEFAULT 0.0002,
  slippage NUMERIC(10, 6) NOT NULL DEFAULT 0.0002,
  smart_profit_shield BOOLEAN NOT NULL DEFAULT TRUE,
  smart_tp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  smart_tp_min_r NUMERIC(6, 3) NOT NULL DEFAULT 0.600,
  smart_tp_partial_pct INTEGER NOT NULL DEFAULT 50,
  smart_tp_sensitivity TEXT NOT NULL DEFAULT 'balanced',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.cx_bot_settings
  ADD COLUMN IF NOT EXISTS max_portfolio_heat_pct NUMERIC(6, 3) NOT NULL DEFAULT 6.000,
  ADD COLUMN IF NOT EXISTS max_same_side_positions INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS btc_filter_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS min_volume_usdt NUMERIC(18, 2) NOT NULL DEFAULT 25000000,
  ADD COLUMN IF NOT EXISTS max_spread_bps NUMERIC(8, 2) NOT NULL DEFAULT 8.00,
  ADD COLUMN IF NOT EXISTS smart_profit_shield BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS smart_tp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS smart_tp_min_r NUMERIC(6, 3) NOT NULL DEFAULT 0.600,
  ADD COLUMN IF NOT EXISTS smart_tp_partial_pct INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS smart_tp_sensitivity TEXT NOT NULL DEFAULT 'balanced';

-- 5. In-App & Push Notifications Log
CREATE TABLE IF NOT EXISTS public.cx_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  symbol TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Web Push Subscriptions
CREATE TABLE IF NOT EXISTS public.cx_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Signals History
CREATE TABLE IF NOT EXISTS public.cx_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_cx_paper_trades_user_status ON public.cx_paper_trades(user_id, status);
CREATE INDEX IF NOT EXISTS idx_cx_wallet_ledger_user_time ON public.cx_wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_notifications_user_time ON public.cx_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_signals_user_updated ON public.cx_signals(user_id, updated_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.cx_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_signals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_wallets' AND policyname = 'cx_wallets_owner') THEN
    CREATE POLICY cx_wallets_owner ON public.cx_wallets FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_wallet_ledger' AND policyname = 'cx_wallet_ledger_owner') THEN
    CREATE POLICY cx_wallet_ledger_owner ON public.cx_wallet_ledger FOR SELECT USING (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_paper_trades' AND policyname = 'cx_paper_trades_owner') THEN
    CREATE POLICY cx_paper_trades_owner ON public.cx_paper_trades FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_bot_settings' AND policyname = 'cx_bot_settings_owner') THEN
    CREATE POLICY cx_bot_settings_owner ON public.cx_bot_settings FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_notifications' AND policyname = 'cx_notifications_owner') THEN
    CREATE POLICY cx_notifications_owner ON public.cx_notifications FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_push_subscriptions' AND policyname = 'cx_push_subscriptions_owner') THEN
    CREATE POLICY cx_push_subscriptions_owner ON public.cx_push_subscriptions FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_signals' AND policyname = 'cx_signals_owner') THEN
    CREATE POLICY cx_signals_owner ON public.cx_signals FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
END $$;

-- Atomic Idempotent Wallet Mutation RPC
CREATE OR REPLACE FUNCTION public.cx_apply_wallet_op(
  p_user_id TEXT,
  p_idempotency_key TEXT,
  p_op_type TEXT,
  p_symbol TEXT,
  p_position_id TEXT,
  p_balance_delta NUMERIC,
  p_margin_delta NUMERIC,
  p_realized_delta NUMERIC,
  p_fee_delta NUMERIC,
  p_funding_delta NUMERIC,
  p_note TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.cx_wallets%ROWTYPE;
  v_new_balance NUMERIC;
BEGIN
  INSERT INTO public.cx_wallets (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1 FROM public.cx_wallet_ledger WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT * INTO v_wallet FROM public.cx_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('applied', FALSE, 'duplicate', TRUE, 'balance_usdt', v_wallet.balance_usdt);
  END IF;

  SELECT * INTO v_wallet FROM public.cx_wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_wallet.daily_reset_date < CURRENT_DATE THEN
    UPDATE public.cx_wallets SET daily_pnl_usdt = 0, daily_reset_date = CURRENT_DATE WHERE user_id = p_user_id;
    v_wallet.daily_pnl_usdt := 0;
  END IF;

  v_new_balance := GREATEST(0, v_wallet.balance_usdt + p_balance_delta);

  UPDATE public.cx_wallets
  SET balance_usdt = v_new_balance,
      locked_margin_usdt = GREATEST(0, locked_margin_usdt + p_margin_delta),
      realized_pnl_usdt = realized_pnl_usdt + p_realized_delta,
      daily_pnl_usdt = daily_pnl_usdt + p_realized_delta,
      total_fees_usdt = total_fees_usdt + p_fee_delta,
      total_funding_usdt = total_funding_usdt + p_funding_delta,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO public.cx_wallet_ledger (
    user_id, idempotency_key, op_type, symbol, position_id, amount_usdt, balance_after_usdt, note
  ) VALUES (
    p_user_id, p_idempotency_key, p_op_type, p_symbol, p_position_id, p_balance_delta, v_new_balance, p_note
  );

  RETURN jsonb_build_object('applied', TRUE, 'duplicate', FALSE, 'balance_usdt', v_new_balance);
END;
$$;

-- ============================================================================
-- CIPHER X PRO v3 — Incremental Additions (Idempotent & Backward-Compatible)
-- ============================================================================

ALTER TABLE public.cx_wallets
  ADD COLUMN IF NOT EXISTS simulation_run_id TEXT DEFAULT 'run-1',
  ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;

ALTER TABLE public.cx_paper_trades
  ADD COLUMN IF NOT EXISTS entry_kind TEXT DEFAULT 'CONFIRMED_ENTRY',
  ADD COLUMN IF NOT EXISTS simulation_run_id TEXT DEFAULT 'run-1',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE public.cx_bot_settings
  ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS equal_allocation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cash_reserve_pct NUMERIC(6, 2) NOT NULL DEFAULT 10.00,
  ADD COLUMN IF NOT EXISTS early_trigger_tf TEXT NOT NULL DEFAULT '15m',
  ADD COLUMN IF NOT EXISTS tp_pcts_json JSONB NOT NULL DEFAULT '[40, 35, 25]'::jsonb,
  ADD COLUMN IF NOT EXISTS limit_expire_bars INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS cancel_chased_atr NUMERIC(6, 2) NOT NULL DEFAULT 2.40,
  ADD COLUMN IF NOT EXISTS allow_reentry BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reentry_cooldown_bars INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS trailing_stop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS filter_flags_json JSONB NOT NULL DEFAULT '{"useFvg":true,"useOb":true,"useChochBos":true,"useMomentum":true,"useOrderFlow":true,"btcShockBlock":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS notify_prefs_json JSONB NOT NULL DEFAULT '{"browser":true,"push":true,"sound":true,"onOpen":true,"onClose":true,"onRisk":true,"onError":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS early_weights_json JSONB;

-- 8. Persistent Worker & Engine Heartbeat State
CREATE TABLE IF NOT EXISTS public.cx_engine_state (
  user_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL DEFAULT 'main-worker',
  worker_status TEXT NOT NULL DEFAULT 'STOPPED',
  execution_mode TEXT NOT NULL DEFAULT 'MANUAL',
  last_heartbeat_at TIMESTAMPTZ,
  last_scan_at TIMESTAMPTZ,
  last_signal_eval_at TIMESTAMPTZ,
  last_trade_exec_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  symbols_scanned INTEGER NOT NULL DEFAULT 0,
  active_signals_count INTEGER NOT NULL DEFAULT 0,
  open_positions_count INTEGER NOT NULL DEFAULT 0,
  pending_orders_count INTEGER NOT NULL DEFAULT 0,
  trades_today INTEGER NOT NULL DEFAULT 0,
  cycles_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Backend Engine Decision & Diagnostic Logs
CREATE TABLE IF NOT EXISTS public.cx_engine_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO',
  category TEXT NOT NULL DEFAULT 'WORKER',
  symbol TEXT,
  message TEXT NOT NULL,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Signal Analytics & Learning Telemetry
CREATE TABLE IF NOT EXISTS public.cx_signal_analytics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  strategy_mode TEXT NOT NULL,
  entry_kind TEXT NOT NULL DEFAULT 'EARLY_ENTRY',
  entry_status TEXT NOT NULL DEFAULT 'EARLY',
  timeframe TEXT NOT NULL DEFAULT '15m',
  regime TEXT NOT NULL DEFAULT 'range',
  score NUMERIC(6, 2) NOT NULL DEFAULT 0,
  raw_score NUMERIC(6, 2) NOT NULL DEFAULT 0,
  signal_price NUMERIC(20, 8) NOT NULL DEFAULT 0,
  entry_price NUMERIC(20, 8) NOT NULL DEFAULT 0,
  fill_price NUMERIC(20, 8),
  distance_moved_pct NUMERIC(8, 4) NOT NULL DEFAULT 0,
  delay_ms BIGINT,
  still_valid BOOLEAN NOT NULL DEFAULT TRUE,
  early_reason TEXT,
  confirm_factors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_confirmations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_breakdown_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  taken_by_user_or_auto BOOLEAN NOT NULL DEFAULT FALSE,
  position_id TEXT,
  outcome TEXT,
  close_reason TEXT,
  net_r NUMERIC(10, 4),
  net_pnl_usdt NUMERIC(18, 6),
  mfe_r NUMERIC(10, 4),
  mae_r NUMERIC(10, 4),
  tp1_hit BOOLEAN NOT NULL DEFAULT FALSE,
  tp2_hit BOOLEAN NOT NULL DEFAULT FALSE,
  tp3_hit BOOLEAN NOT NULL DEFAULT FALSE,
  was_late_entry BOOLEAN NOT NULL DEFAULT FALSE,
  missed_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
  simulation_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- 11. Versioned Adaptive Strategy Weights (Rollback-Safe)
CREATE TABLE IF NOT EXISTS public.cx_strategy_weights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  strategy_mode TEXT NOT NULL DEFAULT 'early',
  weights_json JSONB NOT NULL,
  note TEXT,
  proposal_id TEXT,
  metrics_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cx_engine_logs_user_time ON public.cx_engine_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_signal_analytics_user_time ON public.cx_signal_analytics(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_strategy_weights_user_ver ON public.cx_strategy_weights(user_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_cx_paper_trades_archived ON public.cx_paper_trades(user_id, archived_at);

ALTER TABLE public.cx_engine_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_engine_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_signal_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cx_strategy_weights ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_engine_state' AND policyname = 'cx_engine_state_owner') THEN
    CREATE POLICY cx_engine_state_owner ON public.cx_engine_state FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_engine_logs' AND policyname = 'cx_engine_logs_owner') THEN
    CREATE POLICY cx_engine_logs_owner ON public.cx_engine_logs FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_signal_analytics' AND policyname = 'cx_signal_analytics_owner') THEN
    CREATE POLICY cx_signal_analytics_owner ON public.cx_signal_analytics FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cx_strategy_weights' AND policyname = 'cx_strategy_weights_owner') THEN
    CREATE POLICY cx_strategy_weights_owner ON public.cx_strategy_weights FOR ALL USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);
  END IF;
END $$;

