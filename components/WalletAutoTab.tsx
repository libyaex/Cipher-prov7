'use client';

import React, { useState } from 'react';
import {
  Activity,
  AlertOctagon,
  Download,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { isN } from '@/lib/cx-engine/indicators';
import type {
  BotSettings,
  EngineLogEntry,
  EqualAllocationPlan,
  ExecutionMode,
  PaperPosition,
  PaperWallet,
  SmartTpSensitivity,
  WalletLedgerEntry,
  WorkerStatusRecord,
} from '@/lib/cx-engine/types';
import { downloadCsv, downloadJson } from '@/lib/client/export';
import {
  calcClientPortfolioHeatUsd,
  clsPnL,
  fmtAgo,
  fmtDt,
  fmtP,
  OUT_MAP,
  shortSym,
} from '@/lib/client/formatters';
import type { CipherClientEngine } from '@/lib/client/market-engine';

interface WalletAutoTabProps {
  engine: CipherClientEngine;
  wallet: PaperWallet | null;
  trades: PaperPosition[];
  ledger: WalletLedgerEntry[];
  botSettings: BotSettings | null;
  engineStatus: any;
  allocation?: EqualAllocationPlan | null;
  workerState?: WorkerStatusRecord | null;
  engineLogs?: EngineLogEntry[];
  onRefresh: () => Promise<void>;
  onOpenChart: (sym: string) => void;
  onToast: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  tickVersion: number;
}

function fmtUptime(sec?: number | null): string {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  if (!s) return '0 ث';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}ي ${h}س`;
  if (h > 0) return `${h}س ${m}د`;
  if (m > 0) return `${m}د ${r}ث`;
  return `${r}ث`;
}

export default function WalletAutoTab({
  engine,
  wallet,
  trades,
  ledger,
  botSettings,
  engineStatus,
  allocation,
  workerState,
  engineLogs = [],
  onRefresh,
  onOpenChart,
  onToast,
}: WalletAutoTabProps) {
  const [subTab, setSubTab] = useState<'positions' | 'auto' | 'monitor' | 'history'>('positions');
  const [historyFilter, setHistoryFilter] = useState<'all' | 'win' | 'loss' | 'smart'>('all');
  const [saving, setSaving] = useState(false);
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const [confirmResetTop, setConfirmResetTop] = useState(false);
  const [confirmResetSettings, setConfirmResetSettings] = useState(false);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [capitalDraft, setCapitalDraft] = useState<string>('');
  const [archiveOnReset, setArchiveOnReset] = useState<boolean>(true);

  const [draft, setDraft] = useState<Partial<BotSettings> | null>(null);
  const effectiveSettings = { ...(botSettings || {}), ...(draft || {}) } as BotSettings;
  const activeExecMode: ExecutionMode =
    effectiveSettings.executionMode || (effectiveSettings.autoTradeEnabled ? 'AUTO' : 'MANUAL');

  const openPositions = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
  const closedPositions = trades.filter(
    (t) => t.status === 'CLOSED' || t.status === 'CANCELLED' || t.status === 'LIQUIDATED'
  );

  // Live unrealized PnL using client live mark/last prices or server mark prices
  let totalUnrealized = 0;
  const markMap: Record<string, number> = {};
  for (const pos of openPositions) {
    const rec = engine.rec(pos.symbol);
    const srvMark = engineStatus?.latestMarkPrices?.[pos.symbol]?.mark;
    const mark =
      (isN(rec.mark) && rec.mark > 0 ? rec.mark : undefined) ??
      (isN(srvMark) && srvMark > 0 ? srvMark : undefined) ??
      (isN(rec.price) && rec.price > 0 ? rec.price : undefined) ??
      pos.markPriceLast ??
      pos.entryPrice;
    markMap[pos.symbol] = mark;
    if (pos.status === 'OPEN') {
      const dir = pos.side === 'LONG' ? 1 : -1;
      totalUnrealized += dir * (mark - pos.entryPrice) * pos.remainingQty;
    }
  }

  const equity = (wallet?.balanceUsdt ?? 10000) + totalUnrealized;
  const availableUsdt = Math.max(0, (wallet?.balanceUsdt ?? 10000) - (wallet?.lockedMarginUsdt ?? 0));

  const saveAutoSettings = async (patch: Partial<BotSettings>, clearEmergency = false) => {
    setSaving(true);
    try {
      const res = await fetch('/api/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_settings', settings: patch, clearEmergency }),
      });
      const json = await res.json();
      if (!json.ok) {
        onToast(json.error || 'تعذر حفظ الإعدادات', 'bad');
      } else {
        setDraft(null);
        engine.applyServerBotSettings(json.settings);
        onToast('تم حفظ إعدادات التداول الآلي والحماية ✔', 'info');
        await onRefresh();
      }
    } catch {
      onToast('تعذر الاتصال بالخادم (قد تكون بدون اتصال)', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const handleEmergencyStop = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'emergency_stop' }),
      });
      const json = await res.json();
      setConfirmEmergency(false);
      if (json.ok) {
        engine.applyServerBotSettings({ executionMode: 'MANUAL', autoTradeEnabled: false });
        onToast(`تم تفعيل الإيقاف الطارئ وإغلاق ${json.closedCount} مركز ✔`, 'bad');
        await onRefresh();
      } else {
        onToast(json.error || 'فشل الإيقاف الطارئ', 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRunCycle = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_cycle' }),
      });
      const json = await res.json();
      if (json.ok) {
        onToast('تم تشغيل دورة فحص المحرك الخلفي ✔', 'info');
        await onRefresh();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClosePos = async (pos: PaperPosition) => {
    setClosingId(pos.id);
    try {
      const exitPrice = markMap[pos.symbol] || pos.markPriceLast || pos.entryPrice;
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close_position', positionId: pos.id, exitPrice }),
      });
      const json = await res.json();
      if (json.ok) {
        onToast(`تم إغلاق مركز ${pos.symbol}`, 'info');
        await onRefresh();
      } else {
        onToast(json.error || 'تعذر الإغلاق', 'bad');
      }
    } finally {
      setClosingId(null);
    }
  };

  const handleResetWallet = async (archiveHistory = true, customCap?: number) => {
    setSaving(true);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reset_simulation',
          archiveHistory,
          newInitialCapital: customCap,
        }),
      });
      const json = await res.json();
      setConfirmResetTop(false);
      setConfirmResetSettings(false);
      if (json.ok) {
        engine.applyServerBotSettings(undefined, json.wallet?.balanceUsdt);
        onToast(
          archiveHistory
            ? `تمت إعادة ضبط المحاكاة وأرشفة السجل السابق (${(json.wallet?.initialBalanceUsdt ?? 10000).toFixed(0)} USDT) ✔`
            : `تمت إعادة تعيين المحفظة إلى ${(json.wallet?.initialBalanceUsdt ?? 10000).toFixed(0)} USDT ✔`,
          'info'
        );
        await onRefresh();
      } else {
        onToast(json.error || 'تعذر إعادة الضبط', 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSetInitialCapital = async () => {
    const val = Number(capitalDraft || wallet?.initialBalanceUsdt || 10000);
    if (!Number.isFinite(val) || val < 10 || val > 100_000_000) {
      onToast('أدخل رأس مال صالح بين 10 و 100,000,000 USDT', 'bad');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set_initial_capital',
          initialCapitalUsdt: val,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setCapitalDraft('');
        engine.applyServerBotSettings(undefined, json.wallet?.balanceUsdt);
        onToast(`تم ضبط رصيد المحفظة إلى ${(json.wallet?.balanceUsdt ?? val).toFixed(2)} USDT مع الحفاظ على السجل ✔`, 'info');
        await onRefresh();
      } else {
        onToast(json.error || 'تعذر تحديث رأس المال', 'bad');
      }
    } finally {
      setSaving(false);
    }
  };

  const maxDailyLoss = botSettings
    ? Math.min(
        botSettings.dailyLossLimitUsdt,
        ((wallet?.initialBalanceUsdt ?? 10000) * botSettings.dailyLossLimitPct) / 100
      )
    : 500;

  const portfolioHeatUsd = calcClientPortfolioHeatUsd(openPositions);
  const portfolioHeatPct = equity > 0 ? (portfolioHeatUsd / equity) * 100 : 0;
  const maxHeatPct = botSettings?.maxPortfolioHeatPct ?? 6;
  const marginUtilPct =
    (wallet?.balanceUsdt ?? 10000) > 0
      ? ((wallet?.lockedMarginUsdt ?? 0) / (wallet?.balanceUsdt ?? 10000)) * 100
      : 0;
  const longOpenCount = openPositions.filter((p) => p.side === 'LONG').length;
  const shortOpenCount = openPositions.filter((p) => p.side === 'SHORT').length;
  const maxSameSide = botSettings?.maxSameSidePositions ?? 3;
  const btcCtx = engine.getBtcContext();

  const exportClosedTradesCsv = () => {
    if (!closedPositions.length) {
      onToast('لا توجد صفقات مغلقة للتصدير', 'bad');
      return;
    }
    const headers = ['ID', 'Symbol', 'Side', 'Leverage', 'OrderType', 'Status', 'Entry', 'Exit', 'Qty', 'Fees', 'Slippage', 'Funding', 'NetPnlUsdt', 'R', 'Outcome', 'OpenedAt', 'ClosedAt'];
    const rows = closedPositions.map((t) => [
      t.id,
      t.symbol,
      t.side,
      t.leverage,
      t.orderType,
      t.status,
      t.entryPrice,
      t.exitPrice ?? '',
      t.qty,
      Number(t.feesUsdt.toFixed(4)),
      Number(t.slippageUsdt.toFixed(4)),
      Number(t.fundingUsdt.toFixed(4)),
      Number(t.netPnlUsdt.toFixed(4)),
      t.rMultiple != null ? Number(t.rMultiple.toFixed(3)) : '',
      t.outcome || '',
      t.openedAt,
      t.closedAt || '',
    ]);
    downloadCsv(`cipherx-paper-trades-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    onToast('تم تصدير سجل الصفقات CSV ✔', 'info');
  };

  const exportClosedTradesJson = () => {
    if (!closedPositions.length) {
      onToast('لا توجد صفقات مغلقة للتصدير', 'bad');
      return;
    }
    downloadJson(`cipherx-paper-trades-${new Date().toISOString().slice(0, 10)}.json`, {
      wallet,
      trades: closedPositions,
      ledger: ledger.slice(0, 200),
    });
    onToast('تم تصدير سجل المحفظة JSON ✔', 'info');
  };

  return (
    <div>
      {/* Portfolio Summary Header Card */}
      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 10 }}>
          <div className="row">
            <Wallet size={18} color="var(--cyan)" />
            <h3 style={{ margin: 0 }}>المحفظة التجريبية والحماية (Paper Trading)</h3>
          </div>
          <div className="row wrap">
            <span
              className={`b ${
                botSettings?.emergencyStopped
                  ? 'b-short'
                  : botSettings?.autoTradeEnabled
                    ? 'b-open'
                    : 'b-watch'
              }`}
            >
              {botSettings?.emergencyStopped
                ? 'إيقاف طارئ نشط'
                : botSettings?.autoTradeEnabled
                  ? 'المحرك الآلي 24/7 يعمل'
                  : 'التداول الآلي متوقف'}
            </span>
          </div>
        </div>

        <div className="grid g4" style={{ gap: 8 }}>
          <div className="tile">
            <div className="l">صافي قيمة المحفظة (Equity)</div>
            <div className="v cy">{equity.toFixed(2)}$</div>
          </div>
          <div className="tile">
            <div className="l">الرصيد المحقق</div>
            <div className="v">{(wallet?.balanceUsdt ?? 10000).toFixed(2)}$</div>
            <div className="hint num" style={{ fontSize: 10.5, marginTop: 2 }}>
              متاح {availableUsdt.toFixed(0)}$
            </div>
          </div>
          <div className="tile">
            <div className="l">الربح/الخسارة غير المحققة</div>
            <div className={`v ${clsPnL(totalUnrealized)}`}>
              {totalUnrealized >= 0 ? '+' : ''}
              {totalUnrealized.toFixed(2)}$
            </div>
          </div>
          <div className="tile">
            <div className="l">صافي الربح اليومي</div>
            <div className={`v ${clsPnL(wallet?.dailyPnlUsdt)}`}>
              {(wallet?.dailyPnlUsdt ?? 0) >= 0 ? '+' : ''}
              {(wallet?.dailyPnlUsdt ?? 0).toFixed(2)}$
            </div>
          </div>
          <div className="tile">
            <div className="l">الهامش المحجوز</div>
            <div className="v">{(wallet?.lockedMarginUsdt ?? 0).toFixed(2)}$</div>
          </div>
          <div className="tile">
            <div className="l">الربح المحقق التراكمي</div>
            <div className={`v ${clsPnL(wallet?.realizedPnlUsdt)}`}>
              {(wallet?.realizedPnlUsdt ?? 0) >= 0 ? '+' : ''}
              {(wallet?.realizedPnlUsdt ?? 0).toFixed(2)}$
            </div>
          </div>
          <div className="tile">
            <div className="l">الرسوم المدفوعة</div>
            <div className="v neg">-{(wallet?.totalFeesUsdt ?? 0).toFixed(2)}$</div>
          </div>
          <div className="tile">
            <div className="l">صافي التمويل (Funding)</div>
            <div className={`v ${clsPnL(wallet?.totalFundingUsdt)}`}>
              {(wallet?.totalFundingUsdt ?? 0) >= 0 ? '+' : ''}
              {(wallet?.totalFundingUsdt ?? 0).toFixed(2)}$
            </div>
          </div>
        </div>

        {/* Portfolio Risk Radar */}
        <div className="sep" />
        <div className="grid g4" style={{ gap: 8 }}>
          <div className="tile">
            <div className="l">رادار المخاطرة الكلية (Heat)</div>
            <div className={`v ${portfolioHeatPct >= maxHeatPct * 0.85 ? 'neg' : 'cy'}`} style={{ fontSize: 13.5 }}>
              {portfolioHeatPct.toFixed(1)}% / {maxHeatPct}%{' '}
              <span className="dim">({portfolioHeatUsd.toFixed(0)}$)</span>
            </div>
          </div>
          <div className="tile">
            <div className="l">استهلاك الهامش</div>
            <div className={`v ${marginUtilPct >= 75 ? 'neg' : ''}`} style={{ fontSize: 13.5 }}>
              {marginUtilPct.toFixed(1)}%
            </div>
          </div>
          <div className="tile">
            <div className="l">توازن الاتجاهات (حد ×{maxSameSide})</div>
            <div className="v" style={{ fontSize: 13.5 }}>
              <span className="pos">{longOpenCount}L</span> / <span className="neg">{shortOpenCount}S</span>
            </div>
          </div>
          <div className="tile">
            <div className="l">حارس BTC الماكرو</div>
            <div className="v" style={{ fontSize: 12 }}>
              {botSettings?.btcFilterEnabled === false
                ? 'معطّل'
                : btcCtx
                  ? btcCtx.detail
                  : 'نشط على الخادم'}
            </div>
          </div>
        </div>

        {/* Execution Mode Toggle (MANUAL vs AUTO) + Controls */}
        <div className="sep" />
        <div className="row sb wrap" style={{ gap: 10, marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 230 }}>
            <div className="hint" style={{ marginBottom: 4 }}>
              نمط التنفيذ (Execution Mode):{' '}
              <b className={activeExecMode === 'AUTO' ? 'pos' : 'gold'}>
                {activeExecMode === 'AUTO' ? 'AUTO — تداول آلي' : 'MANUAL — إشارات فقط'}
              </b>
            </div>
            <div className="seg">
              <button
                type="button"
                className={activeExecMode === 'MANUAL' ? 'on' : ''}
                disabled={saving}
                onClick={() =>
                  saveAutoSettings({ executionMode: 'MANUAL', autoTradeEnabled: false })
                }
              >
                يدوي (MANUAL)
              </button>
              <button
                type="button"
                className={activeExecMode === 'AUTO' ? 'on' : ''}
                disabled={saving}
                onClick={() =>
                  saveAutoSettings({ executionMode: 'AUTO', autoTradeEnabled: true }, true)
                }
              >
                آلي 24/7 (AUTO)
              </button>
            </div>
          </div>

          <div className="row wrap" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn sm"
              disabled={saving}
              onClick={handleRunCycle}
            >
              <RefreshCw size={14} />
              <span>فحص المحرك الآن</span>
            </button>

            {botSettings?.autoTradeEnabled && (
              <button
                type="button"
                className="btn sm"
                disabled={saving}
                onClick={() =>
                  saveAutoSettings({ executionMode: 'MANUAL', autoTradeEnabled: false })
                }
                title="يوقف فتح الصفقات الجديدة ويحافظ على إدارة وحماية المراكز الحالية"
              >
                <PauseCircle size={14} />
                <span>إيقاف مؤقت للآلي</span>
              </button>
            )}

            {confirmEmergency ? (
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm red"
                  disabled={saving}
                  onClick={handleEmergencyStop}
                >
                  تأكيد الإيقاف الطارئ وإغلاق الكل
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setConfirmEmergency(false)}
                >
                  إلغاء
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn sm red"
                disabled={saving}
                onClick={() => setConfirmEmergency(true)}
                title="يوقف المحرك ويغلق جميع المراكز والأوامر فوراً"
              >
                <AlertOctagon size={14} />
                <span>إيقاف طارئ (Emergency Stop)</span>
              </button>
            )}
          </div>
        </div>

        <div className="hint" style={{ marginTop: 4 }}>
          {activeExecMode === 'MANUAL'
            ? 'الوضع اليدوي: يولّد الإشارات والتحليلات دون فتح صفقات آلياً — تبقى حماية الوقف والأهداف وجني الأرباح الذكي فعّالة على صفقاتك المفتوحة.'
            : 'الوضع الآلي: يقيّم فقط الإشارات الجديدة الصالحة بعد لحظة التفعيل (لا يسحب إشارات قديمة)، ويوزع رأس المال بالتساوي مع احترام حد الخسارة اليومية.'}
        </div>

        <div className="hint" style={{ marginTop: 6 }}>
          <ShieldCheck size={13} style={{ display: 'inline', marginInlineEnd: 4 }} />
          الوقف يسبق التصفية بهامش أمان {botSettings?.minLiqSafetyPct ?? 25}% على الأقل · حد الخسارة
          اليومي النشط: -{maxDailyLoss.toFixed(2)}$ · نبض الخادم:{' '}
          {(workerState?.lastHeartbeatAt || engineStatus?.lastHeartbeatAt)
            ? fmtAgo(workerState?.lastHeartbeatAt || engineStatus?.lastHeartbeatAt)
            : 'جارٍ الاتصال'}
        </div>
      </div>

      {/* Equal Capital Allocation & Virtual Capital Control Card */}
      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>توزيع رأس المال بالتساوي وإدارة رأس المال الافتراضي</h3>
          <span className={`b ${allocation?.equalAllocationEnabled !== false ? 'b-open' : 'b-watch'}`}>
            {allocation?.equalAllocationEnabled !== false ? 'توزيع متساوٍ نشط' : 'حجم ديناميكي'}
          </span>
        </div>

        {allocation && (
          <div className="grid g4" style={{ gap: 8, marginBottom: 10 }}>
            <div className="tile">
              <div className="l">حصة كل صفقة (Sleeve)</div>
              <div className="v cy">{allocation.perPositionSleeveUsdt.toFixed(2)}$</div>
            </div>
            <div className="tile">
              <div className="l">السيولة الاحتياطية ({allocation.cashReservePct}%)</div>
              <div className="v gold">{allocation.reservedCashUsdt.toFixed(2)}$</div>
            </div>
            <div className="tile">
              <div className="l">الفتحات المتاحة / الحد</div>
              <div className="v">
                {allocation.availableSleevesCount} / {allocation.maxOpenPositions}
              </div>
            </div>
            <div className="tile">
              <div className="l">أقصى مخاطرة للصفقة ({effectiveSettings.riskPct ?? 1}%)</div>
              <div className="v neg">-{allocation.maxPositionRiskUsd.toFixed(2)}$</div>
            </div>
          </div>
        )}

        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 190 }}>
            <label className="f" style={{ marginTop: 0 }}>
              تعديل رأس المال الافتراضي (الحالي: {(wallet?.initialBalanceUsdt ?? 10000).toFixed(0)} USDT
              {wallet?.simulationRunId ? ` · جولة ${wallet.simulationRunId.slice(-6)}` : ''})
            </label>
            <input
              type="number"
              min={10}
              step={100}
              placeholder={String(wallet?.initialBalanceUsdt ?? 10000)}
              value={capitalDraft}
              onChange={(e) => setCapitalDraft(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm pri"
            disabled={saving}
            onClick={handleSetInitialCapital}
          >
            <PlayCircle size={14} />
            <span>حفظ رأس المال (دون مسح السجل)</span>
          </button>
          {confirmResetTop ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <label className="row" style={{ gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={archiveOnReset}
                  onChange={(e) => setArchiveOnReset(e.target.checked)}
                />
                <span>أرشفة السجل السابق</span>
              </label>
              <button
                type="button"
                className="btn sm red"
                disabled={saving}
                onClick={() =>
                  handleResetWallet(
                    archiveOnReset,
                    capitalDraft && Number(capitalDraft) >= 10 ? Number(capitalDraft) : undefined
                  )
                }
              >
                تأكيد إعادة ضبط المحاكاة
              </button>
              <button type="button" className="btn sm" onClick={() => setConfirmResetTop(false)}>
                إلغاء
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn sm red"
              disabled={saving}
              onClick={() => setConfirmResetTop(true)}
            >
              <RotateCcw size={13} />
              <span>إعادة ضبط المحاكاة</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className={subTab === 'positions' ? 'on' : ''}
          onClick={() => setSubTab('positions')}
        >
          المراكز المفتوحة ({openPositions.length})
        </button>
        <button
          type="button"
          className={subTab === 'auto' ? 'on' : ''}
          onClick={() => setSubTab('auto')}
        >
          إعدادات الآلي والحماية
        </button>
        <button
          type="button"
          className={subTab === 'monitor' ? 'on' : ''}
          onClick={() => setSubTab('monitor')}
        >
          المراقبة والسجلات ({engineLogs.length})
        </button>
        <button
          type="button"
          className={subTab === 'history' ? 'on' : ''}
          onClick={() => setSubTab('history')}
        >
          سجل الصفقات ({closedPositions.length})
        </button>
      </div>

      {/* Positions View */}
      {subTab === 'positions' && (
        <div>
          {openPositions.length === 0 ? (
            <div className="card empty">
              لا توجد مراكز تجريبية مفتوحة حالياً. يمكنك فتح صفقة تجريبية من بطاقة أي إشارة أو
              تفعيل «التداول الآلي 24/7» أعلاه.
            </div>
          ) : (
            <div className="cards">
              {openPositions.map((pos) => {
                const tick = pos.meta?.tick || engine.rec(pos.symbol).meta.tick || 0;
                const mark = markMap[pos.symbol] || pos.markPriceLast || pos.entryPrice;
                const long = pos.side === 'LONG';
                const dir = long ? 1 : -1;
                const unreal =
                  pos.status === 'OPEN' ? dir * (mark - pos.entryPrice) * pos.remainingQty : 0;
                const estNet =
                  pos.realizedPnlUsdt + unreal - pos.feesUsdt - pos.slippageUsdt + pos.fundingUsdt;
                const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
                const curR =
                  pos.status === 'OPEN' && riskDist > 0
                    ? (dir * (mark - pos.entryPrice)) / riskDist
                    : null;
                const remPct = pos.qty > 0 ? Math.round((pos.remainingQty / pos.qty) * 100) : 100;

                return (
                  <div
                    key={pos.id}
                    className={`card sig ${long ? 'long' : 'short'}`}
                  >
                    <div className="head">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row wrap">
                          <span className="sym">
                            {shortSym(pos.symbol)}
                            <small className="dim">/USDT</small>
                          </span>
                          <span className={`b ${long ? 'b-long' : 'b-short'}`}>{pos.side}</span>
                          {pos.entryKind === 'EARLY_ENTRY' && (
                            <span className="b b-good">EARLY</span>
                          )}
                          <span className="b b-good">{pos.leverage}x</span>
                          <span className={`b ${pos.status === 'OPEN' ? 'b-open' : 'b-pend'}`}>
                            {pos.status === 'OPEN' ? 'مفتوحة' : 'Limit معلق'}
                          </span>
                        </div>
                        <div className="hint" style={{ marginTop: 3 }}>
                          <span>{fmtAgo(pos.openedAt)}</span> · <span>درجة {pos.score}</span> ·{' '}
                          <span style={{ whiteSpace: 'nowrap' }}>هامش {pos.marginUsdt.toFixed(2)}$</span> ·{' '}
                          <span style={{ whiteSpace: 'nowrap' }}>
                            صيانة {pos.maintenanceMarginUsdt.toFixed(2)}$
                          </span>
                          {Number(pos.meta?.peakFavR || 0) >= 0.8 && (
                            <>
                              {' '}
                              · <span style={{ whiteSpace: 'nowrap' }}>القمة +{Number(pos.meta?.peakFavR).toFixed(2)}R</span>
                            </>
                          )}
                          {pos.meta?.smartTpPartialDone && (
                            <span className="pos" style={{ whiteSpace: 'nowrap' }}>
                              {' '}
                              · جني ذكي جزئي (+{Number(pos.meta?.smartTpPartialR || 0).toFixed(2)}R)
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'left', flexShrink: 0 }}>
                        <div className={`num ${clsPnL(estNet)}`} style={{ fontSize: 16.5, fontWeight: 700 }}>
                          {estNet >= 0 ? '+' : ''}
                          {estNet.toFixed(2)}$
                        </div>
                        <div className="hint num" style={{ fontSize: 10.5 }}>
                          {curR != null && (
                            <span className={clsPnL(curR)} style={{ marginInlineEnd: 6 }}>
                              {curR >= 0 ? '+' : ''}
                              {curR.toFixed(2)}R
                            </span>
                          )}
                          Mark: {fmtP(mark, tick)}
                        </div>
                      </div>
                    </div>

                    <div className="ladder">
                      <div className="lv liq">
                        <span className="n">التصفية</span>
                        <span className="p num">{fmtP(pos.liqPrice, tick)}</span>
                        <span className="r">أمان {pos.safetyBufferPct.toFixed(0)}%</span>
                      </div>
                      <div className="lv sl">
                        <span className="n">الوقف</span>
                        <span className="p num">
                          {fmtP(pos.stopCurrent, tick)}{' '}
                          {pos.meta?.shieldActive
                            ? `(درع +${pos.meta.shieldLockR}R)`
                            : pos.stopCurrent !== pos.stopLoss
                              ? '(متحرك)'
                              : ''}
                        </span>
                        <span className="r">يسبق التصفية</span>
                      </div>
                      <div className="lv entry">
                        <span className="n">الدخول</span>
                        <span className="p num">{fmtP(pos.entryPrice, tick)}</span>
                        <span className="r">متبقي {remPct}% ({pos.remainingQty})</span>
                      </div>
                      {pos.tps.map((t, k) => (
                        <div key={k} className={`lv tp ${t.hit ? 'hit' : ''}`}>
                          <span className="n">TP{k + 1}</span>
                          <span className="p num">{fmtP(t.p, tick)}</span>
                          <span className="r">
                            {t.r.toFixed(2)}R · {t.pct}%
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="kv">
                      <span>الرسوم + الانزلاق</span>
                      <span className="num neg">
                        -{(pos.feesUsdt + pos.slippageUsdt).toFixed(2)}$
                      </span>
                    </div>
                    <div className="kv">
                      <span>التمويل المتراكم (Funding)</span>
                      <span className={`num ${clsPnL(pos.fundingUsdt)}`}>
                        {pos.fundingUsdt >= 0 ? '+' : ''}
                        {pos.fundingUsdt.toFixed(4)}$
                      </span>
                    </div>

                    <div className="row wrap" style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => onOpenChart(pos.symbol)}
                      >
                        عرض الشارت
                      </button>
                      {confirmCloseId === pos.id ? (
                        <div className="row" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="btn sm red"
                            disabled={closingId === pos.id}
                            onClick={async () => {
                              await handleClosePos(pos);
                              setConfirmCloseId(null);
                            }}
                          >
                            {closingId === pos.id
                              ? 'جارٍ التنفيذ…'
                              : pos.status === 'PENDING'
                                ? 'تأكيد إلغاء الأمر'
                                : 'تأكيد الإغلاق عند Mark'}
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setConfirmCloseId(null)}
                          >
                            تراجع
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn sm red"
                          disabled={closingId === pos.id}
                          onClick={() => setConfirmCloseId(pos.id)}
                        >
                          {pos.status === 'PENDING' ? 'إلغاء الأمر المعلق' : 'إغلاق عند Mark'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Auto-Trade Settings */}
      {subTab === 'auto' && (
        <div className="card">
          <h3>إعدادات التداول الآلي وحماية رأس المال</h3>
          <div className="grid g2">
            <div>
              <label className="f">المخاطرة لكل صفقة (%)</label>
              <input
                type="number"
                step="0.1"
                value={effectiveSettings.riskPct ?? 1}
                onChange={(e) => setDraft((d) => ({ ...d, riskPct: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="f">أقصى رافعة مالية مسموحة</label>
              <input
                type="number"
                value={effectiveSettings.maxLeverage ?? 15}
                onChange={(e) => setDraft((d) => ({ ...d, maxLeverage: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="f">الحد الأقصى للصفقات المفتوحة</label>
              <input
                type="number"
                value={effectiveSettings.maxOpenPositions ?? 4}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, maxOpenPositions: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">أدنى مسافة أمان قبل التصفية (%)</label>
              <input
                type="number"
                value={effectiveSettings.minLiqSafetyPct ?? 25}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, minLiqSafetyPct: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">حد الخسارة اليومية (USDT)</label>
              <input
                type="number"
                value={effectiveSettings.dailyLossLimitUsdt ?? 500}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, dailyLossLimitUsdt: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">حد الخسارة اليومية (%)</label>
              <input
                type="number"
                step="0.5"
                value={effectiveSettings.dailyLossLimitPct ?? 5}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, dailyLossLimitPct: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">حد المخاطرة الكلية للمحفظة (%)</label>
              <input
                type="number"
                step="0.5"
                value={effectiveSettings.maxPortfolioHeatPct ?? 6}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, maxPortfolioHeatPct: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">أقصى صفقات بنفس الاتجاه</label>
              <input
                type="number"
                value={effectiveSettings.maxSameSidePositions ?? 3}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, maxSameSidePositions: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">أدنى سيولة 24س (مليون $)</label>
              <input
                type="number"
                step="5"
                value={Math.round((effectiveSettings.minVolumeUsdt ?? 30_000_000) / 1_000_000)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, minVolumeUsdt: Math.max(0, Number(e.target.value)) * 1_000_000 }))
                }
              />
            </div>
            <div>
              <label className="f">نسبة الاحتياطي النقدي غير المستثمر (%)</label>
              <input
                type="number"
                step="1"
                min="0"
                max="50"
                value={effectiveSettings.cashReservePct ?? 10}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, cashReservePct: Number(e.target.value) }))
                }
              />
            </div>
            <div>
              <label className="f">أقصى سبريد دفتر أوامر (bps)</label>
              <input
                type="number"
                step="0.5"
                value={effectiveSettings.maxSpreadBps ?? 8}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, maxSpreadBps: Number(e.target.value) }))
                }
              />
            </div>
          </div>

          <div className="tog" style={{ marginTop: 8 }}>
            <span>توزيع رأس المال بالتساوي على المراكز المتاحة (Equal Capital Allocation)</span>
            <div
              className={`sw ${effectiveSettings.equalAllocationEnabled !== false ? 'on' : ''}`}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  equalAllocationEnabled: !(effectiveSettings.equalAllocationEnabled !== false),
                }))
              }
            />
          </div>

          <div className="tog" style={{ marginTop: 8 }}>
            <span>حماية اتجاه BTC الماكرو (تقييد الصفقات المعاكسة للصدمات والاتجاه القوي)</span>
            <div
              className={`sw ${effectiveSettings.btcFilterEnabled !== false ? 'on' : ''}`}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  btcFilterEnabled: !(effectiveSettings.btcFilterEnabled !== false),
                }))
              }
            />
          </div>

          <div className="tog" style={{ marginTop: 8 }}>
            <span>درع حماية الأرباح الذكي (قفل أرباح القمة + خروج انعكاس السيولة على 1m/5m)</span>
            <div
              className={`sw ${effectiveSettings.smartProfitShield !== false ? 'on' : ''}`}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  smartProfitShield: !(effectiveSettings.smartProfitShield !== false),
                }))
              }
            />
          </div>

          <div className="tog" style={{ marginTop: 8 }}>
            <span>جني الأرباح الذكي قبل الأهداف (إغلاق جزئي/كامل عند ضعف الزخم وانعكاس 1m/5m)</span>
            <div
              className={`sw ${effectiveSettings.smartTakeProfitEnabled !== false ? 'on' : ''}`}
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  smartTakeProfitEnabled: !(effectiveSettings.smartTakeProfitEnabled !== false),
                }))
              }
            />
          </div>

          {effectiveSettings.smartTakeProfitEnabled !== false && (
            <div className="grid g3" style={{ marginTop: 8 }}>
              <div>
                <label className="f">حساسية جني الأرباح الذكي</label>
                <select
                  value={effectiveSettings.smartTakeProfitSensitivity || 'balanced'}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      smartTakeProfitSensitivity: e.target.value as SmartTpSensitivity,
                    }))
                  }
                >
                  <option value="conservative">متحفظ</option>
                  <option value="balanced">متوازن</option>
                  <option value="aggressive">سريع</option>
                </select>
              </div>
              <div>
                <label className="f">أدنى ربح للتفعيل (R)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0.25"
                  max="3"
                  value={effectiveSettings.smartTakeProfitMinR ?? 0.6}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, smartTakeProfitMinR: Number(e.target.value) }))
                  }
                />
              </div>
              <div>
                <label className="f">نسبة الإغلاق الجزئي (%)</label>
                <input
                  type="number"
                  step="5"
                  min="20"
                  max="80"
                  value={effectiveSettings.smartTakeProfitPartialPct ?? 50}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, smartTakeProfitPartialPct: Number(e.target.value) }))
                  }
                />
              </div>
            </div>
          )}

          <label className="f">أدنى مستوى إشارة للتنفيذ الآلي</label>
          <div className="seg">
            {(['GOOD', 'STRONG'] as const).map((tier) => (
              <button
                key={tier}
                type="button"
                className={effectiveSettings.minTier === tier ? 'on' : ''}
                onClick={() => setDraft((d) => ({ ...d, minTier: tier }))}
              >
                {tier === 'GOOD' ? 'GOOD وأعلى' : 'STRONG فقط'}
              </button>
            ))}
          </div>

          <label className="f">العملات المسموح بتداولها آلياً (مفصولة بفاصلة)</label>
          <input
            value={(effectiveSettings.allowedSymbols || []).join(',')}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                allowedSymbols: e.target.value
                  .toUpperCase()
                  .split(/[\s,]+/)
                  .filter(Boolean)
                  .map((s) => (s.endsWith('USDT') ? s : `${s}USDT`)),
              }))
            }
          />

          {draft && (
            <div className="warn row sb wrap" style={{ marginTop: 12 }}>
              <span>توجد تعديلات غير محفوظة في إعدادات التداول الآلي.</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => setDraft(null)}
              >
                تراجع عن التعديلات
              </button>
            </div>
          )}

          <div className="row sb wrap" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn pri"
              disabled={saving}
              onClick={() => saveAutoSettings(effectiveSettings)}
            >
              {saving ? 'جارٍ الحفظ…' : 'حفظ إعدادات التداول الآلي'}
            </button>

            {confirmResetSettings ? (
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm red"
                  disabled={saving}
                  onClick={() => handleResetWallet(true)}
                >
                  تأكيد إعادة الضبط مع الأرشفة
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setConfirmResetSettings(false)}
                >
                  إلغاء
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn sm red"
                onClick={() => setConfirmResetSettings(true)}
              >
                <RotateCcw size={13} />
                <span>إعادة ضبط المحفظة التجريبية</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Live Backend & Worker Monitoring Panel */}
      {subTab === 'monitor' && (() => {
        const ws = workerState;
        const st = ws?.workerStatus || (engineStatus?.running ? 'RUNNING' : 'STOPPED');
        const execMode = ws?.executionMode || activeExecMode;
        return (
          <div>
            <div className="card">
              <div className="row sb wrap" style={{ marginBottom: 10 }}>
                <div className="row">
                  <Server size={16} color="var(--cyan)" />
                  <h3 style={{ margin: 0 }}>حالة الخادم الخلفي والمحرك المستمر (Worker Monitor)</h3>
                </div>
                <span className={`b ${st === 'RUNNING' ? 'b-open' : st === 'ERROR' ? 'b-short' : 'b-watch'}`}>
                  {st}
                </span>
              </div>

              <div className="grid g4" style={{ gap: 8 }}>
                <div className="tile">
                  <div className="l">اتصال Worker</div>
                  <div className={`v ${ws?.workerConnected ? 'pos' : 'gold'}`}>
                    {ws?.workerConnected ? 'متصل' : engineStatus?.running ? 'مدمج بالخادم' : 'متوقف'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">اتصال Supabase</div>
                  <div className={`v ${ws?.supabaseConnected ? 'pos' : 'gold'}`}>
                    {ws?.supabaseConnected ? 'متصل' : 'تخزين محلي احتياطي'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">نمط التنفيذ</div>
                  <div className={`v ${execMode === 'AUTO' ? 'pos' : 'gold'}`}>{execMode}</div>
                </div>
                <div className="tile">
                  <div className="l">مدة التشغيل (Uptime)</div>
                  <div className="v">{fmtUptime(ws?.uptimeSec)}</div>
                </div>
                <div className="tile">
                  <div className="l">آخر نبض (Heartbeat)</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {ws?.lastHeartbeatAt ? fmtAgo(ws.lastHeartbeatAt) : '—'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">آخر مسح سوق (Scan)</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {ws?.lastScanAt ? fmtAgo(ws.lastScanAt) : '—'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">آخر تقييم إشارة</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {ws?.lastSignalEvalAt ? fmtAgo(ws.lastSignalEvalAt) : '—'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">آخر تنفيذ صفقة</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {ws?.lastTradeExecAt ? fmtAgo(ws.lastTradeExecAt) : '—'}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">عملات مفحوصة / إشارات</div>
                  <div className="v">
                    {ws?.symbolsScanned ?? 0} / {ws?.activeSignalsCount ?? 0}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">مراكز مفتوحة / معلقة</div>
                  <div className="v">
                    {ws?.openPositionsCount ?? openPositions.length} / {ws?.pendingOrdersCount ?? 0}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">عمليات اليوم / دورات</div>
                  <div className="v">
                    {ws?.tradesToday ?? 0} / {ws?.cyclesCompleted ?? engineStatus?.scanCycles ?? 0}
                  </div>
                </div>
                <div className="tile">
                  <div className="l">حالة Paper Trading</div>
                  <div className="v" style={{ fontSize: 12 }}>
                    {ws?.paperTradingStatus || 'ACTIVE'}
                  </div>
                </div>
              </div>

              {(ws?.lastError || engineStatus?.lastError) && (
                <div className="warn" style={{ marginTop: 10 }}>
                  آخر خطأ مسجّل: {ws?.lastError || engineStatus?.lastError} (تتابع الأخطاء:{' '}
                  {ws?.consecutiveErrors ?? engineStatus?.consecutiveErrors ?? 0})
                </div>
              )}

              <div className="row wrap" style={{ marginTop: 10 }}>
                <button type="button" className="btn sm pri" disabled={saving} onClick={handleRunCycle}>
                  <Activity size={13} />
                  <span>فحص فوري وتحديث النبض</span>
                </button>
                <button type="button" className="btn sm" onClick={onRefresh}>
                  <RefreshCw size={13} />
                  <span>تحديث السجلات</span>
                </button>
              </div>
            </div>

            <div className="card">
              <h3>سجل قرارات المحرك الخلفي (Engine Decision Logs)</h3>
              {engineLogs.length === 0 ? (
                <div className="empty" style={{ padding: 14 }}>
                  لا توجد سجلات محرك بعد — اضغط «فحص فوري وتحديث النبض» لتسجيل دورة حية.
                </div>
              ) : (
                <div className="tblw">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>الوقت</th>
                        <th>المستوى</th>
                        <th>التصنيف</th>
                        <th>الرمز</th>
                        <th>الرسالة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {engineLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="dim">{fmtDt(log.createdAt)}</td>
                          <td>
                            <span
                              className={`b ${
                                log.level === 'ERROR'
                                  ? 'b-short'
                                  : log.level === 'WARN'
                                    ? 'b-pend'
                                    : log.level === 'DECISION'
                                      ? 'b-good'
                                      : 'b-open'
                              }`}
                            >
                              {log.level}
                            </span>
                          </td>
                          <td className="num">{log.category}</td>
                          <td>{log.symbol ? <span className="sym">{shortSym(log.symbol)}</span> : '—'}</td>
                          <td className="out" style={{ minWidth: 220 }}>{log.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* History & Financial Ledger */}
      {subTab === 'history' && (() => {
        const executedClosed = closedPositions.filter((t) => t.status !== 'CANCELLED');
        const winsCount = executedClosed.filter((t) => t.netPnlUsdt > 0).length;
        const winPct = executedClosed.length ? (100 * winsCount) / executedClosed.length : 0;
        const netSum = executedClosed.reduce((s, t) => s + t.netPnlUsdt, 0);
        const rItems = executedClosed.filter((t) => isN(t.rMultiple));
        const avgR = rItems.length
          ? rItems.reduce((s, t) => s + Number(t.rMultiple || 0), 0) / rItems.length
          : 0;

        const filteredClosed = closedPositions.filter((t) => {
          if (historyFilter === 'win') return t.netPnlUsdt > 0;
          if (historyFilter === 'loss') return t.netPnlUsdt < 0;
          if (historyFilter === 'smart')
            return (
              t.outcome === 'SMART_EXIT' ||
              t.outcome === 'SMART_PARTIAL_TP' ||
              t.outcome === 'TRAIL_PROFIT' ||
              Boolean(t.meta?.smartTpPartialDone)
            );
          return true;
        });

        return (
        <div>
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>سجل الصفقات التجريبية المغلقة</h3>
              {closedPositions.length > 0 && (
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn sm" onClick={exportClosedTradesCsv}>
                    <Download size={12} />
                    <span>تصدير CSV</span>
                  </button>
                  <button type="button" className="btn sm" onClick={exportClosedTradesJson}>
                    <Download size={12} />
                    <span>تصدير JSON</span>
                  </button>
                </div>
              )}
            </div>

            {executedClosed.length > 0 && (
              <div className="grid g4" style={{ gap: 8, marginBottom: 10 }}>
                <div className="tile">
                  <div className="l">صفقات منفذة</div>
                  <div className="v">{executedClosed.length}</div>
                </div>
                <div className="tile">
                  <div className="l">نسبة الفوز</div>
                  <div className={`v ${winPct >= 50 ? 'pos' : ''}`}>{winPct.toFixed(0)}%</div>
                </div>
                <div className="tile">
                  <div className="l">إجمالي الصافي</div>
                  <div className={`v ${clsPnL(netSum)}`}>
                    {netSum >= 0 ? '+' : ''}
                    {netSum.toFixed(2)}$
                  </div>
                </div>
                <div className="tile">
                  <div className="l">متوسط R</div>
                  <div className={`v ${clsPnL(avgR)}`}>
                    {avgR >= 0 ? '+' : ''}
                    {avgR.toFixed(2)}R
                  </div>
                </div>
              </div>
            )}

            {closedPositions.length > 0 && (
              <div className="chips" style={{ marginBottom: 8 }}>
                {(
                  [
                    ['all', `الكل (${closedPositions.length})`],
                    ['win', 'رابحة'],
                    ['loss', 'خاسرة'],
                    ['smart', 'حماية / جني ذكي'],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${historyFilter === k ? 'on' : ''}`}
                    onClick={() => setHistoryFilter(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            )}

            {filteredClosed.length === 0 ? (
              <div className="empty" style={{ padding: 14 }}>
                {closedPositions.length === 0 ? 'لا توجد صفقات مغلقة بعد.' : 'لا توجد صفقات مطابقة للفلتر.'}
              </div>
            ) : (
              <div className="tblw">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>التاريخ</th>
                      <th>الرمز</th>
                      <th>النوع</th>
                      <th>الدخول</th>
                      <th>الخروج</th>
                      <th>التمويل</th>
                      <th>الرسوم</th>
                      <th>الصافي $</th>
                      <th>R</th>
                      <th>النتيجة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClosed.map((t) => (
                      <tr key={t.id} className="click" onClick={() => onOpenChart(t.symbol)}>
                        <td className="dim">{fmtDt(t.closedAt || t.openedAt)}</td>
                        <td>
                          <span className="sym">{shortSym(t.symbol)}</span>
                        </td>
                        <td>
                          <span className={`b ${t.side === 'LONG' ? 'b-long' : 'b-short'}`}>
                            {t.side} {t.leverage}x
                          </span>
                        </td>
                        <td className="num">{fmtP(t.entryPrice, t.meta?.tick)}</td>
                        <td className="num">
                          {t.exitPrice != null ? fmtP(t.exitPrice, t.meta?.tick) : '—'}
                        </td>
                        <td className={`num ${clsPnL(t.fundingUsdt)}`}>
                          {t.fundingUsdt >= 0 ? '+' : ''}
                          {t.fundingUsdt.toFixed(2)}$
                        </td>
                        <td className="num neg">
                          -{(t.feesUsdt + t.slippageUsdt).toFixed(2)}$
                        </td>
                        <td className={`num ${clsPnL(t.netPnlUsdt)}`}>
                          {t.netPnlUsdt >= 0 ? '+' : ''}
                          {t.netPnlUsdt.toFixed(2)}$
                        </td>
                        <td className={`num ${clsPnL(t.rMultiple)}`}>
                          {t.rMultiple != null
                            ? `${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R`
                            : '—'}
                        </td>
                        <td className="out">{OUT_MAP[t.outcome || ''] || t.outcome || t.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3>دفتر العمليات المالية (Idempotent Ledger)</h3>
            {ledger.length === 0 ? (
              <div className="empty" style={{ padding: 14 }}>
                لا توجد قيود مسجلة بعد.
              </div>
            ) : (
              <div className="tblw">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>الوقت</th>
                      <th>العملية</th>
                      <th>الرمز</th>
                      <th>المبلغ</th>
                      <th>الرصيد بعد</th>
                      <th>التفاصيل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.slice(0, 40).map((e) => (
                      <tr key={e.id}>
                        <td className="dim">{fmtDt(e.createdAt)}</td>
                        <td className="num">{e.opType}</td>
                        <td>{e.symbol ? <span className="sym">{shortSym(e.symbol)}</span> : '—'}</td>
                        <td className={`num ${clsPnL(e.amountUsdt)}`}>
                          {e.amountUsdt >= 0 ? '+' : ''}
                          {e.amountUsdt.toFixed(2)}$
                        </td>
                        <td className="num">{e.balanceAfterUsdt.toFixed(2)}$</td>
                        <td className="hint">{e.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
