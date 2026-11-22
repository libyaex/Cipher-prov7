'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Bell,
  Clock,
  LineChart,
  Settings,
  Wallet,
  Zap,
} from 'lucide-react';
import { motion } from 'motion/react';
import { MODES } from '@/lib/cx-engine/analyzer';
import type {
  AppNotification,
  BotSettings,
  EngineLogEntry,
  EqualAllocationPlan,
  PaperPosition,
  PaperWallet,
  WalletLedgerEntry,
  WorkerStatusRecord,
} from '@/lib/cx-engine/types';
import { getClientEngine, type ToastItem } from '@/lib/client/market-engine';
import {
  loadOfflineSnapshot,
  saveOfflineSnapshot,
  type OfflineMarketSummary,
} from '@/lib/client/offline-store';
import { checkWebPushSubscribed, useOnlineStatus } from '@/lib/client/use-pwa';
import ChartTab from './ChartTab';
import MarketTab from './MarketTab';
import NotificationsDrawer from './NotificationsDrawer';
import PerformanceTab from './PerformanceTab';
import { OfflineBanner, PWAInstallButton } from './PwaControls';
import SettingsTab from './SettingsTab';
import SignalsTab from './SignalsTab';
import WalletAutoTab from './WalletAutoTab';

type TabKey = 'signals' | 'market' | 'chart' | 'wallet' | 'perf' | 'settings';

export default function CipherXApp() {
  const [engine] = useState(() => getClientEngine());
  const [nowMs, setNowMs] = useState(0);

  const online = useOnlineStatus();
  const [page, setPage] = useState<TabKey>('signals');
  const [bootHidden, setBootHidden] = useState(false);
  const [scanPhase, setScanPhase] = useState<'idle' | 'boot' | 'ready' | 'error'>('idle');
  const [scanMsg, setScanMsg] = useState('');
  const [scanProg, setScanProg] = useState(0);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanGeo, setScanGeo] = useState(false);

  const [tickVersion, setTickVersion] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);

  const [wallet, setWallet] = useState<PaperWallet | null>(null);
  const [trades, setTrades] = useState<PaperPosition[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerEntry[]>([]);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [engineStatus, setEngineStatus] = useState<any>(null);
  const [allocation, setAllocation] = useState<EqualAllocationPlan | null>(null);
  const [workerState, setWorkerState] = useState<WorkerStatusRecord | null>(null);
  const [engineLogs, setEngineLogs] = useState<EngineLogEntry[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [offlineMarket, setOfflineMarket] = useState<OfflineMarketSummary[]>([]);
  const [lastOfflineAt, setLastOfflineAt] = useState<string | null>(null);
  const initialServerSyncRef = useRef(false);

  const addToast = useCallback(
    (title: string, kind: ToastItem['kind'] = 'info', sig?: any) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-2), { id, kind, title, sig }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, 8500);
    },
    []
  );

  const persistOffline = useCallback(
    async (override?: {
      wallet?: PaperWallet | null;
      trades?: PaperPosition[];
      ledger?: WalletLedgerEntry[];
      botSettings?: BotSettings | null;
      notifications?: AppNotification[];
    }) => {
      const marketSummary: OfflineMarketSummary[] = engine.storeState.universe
        .map((sym) => {
          const r = engine.rec(sym);
          if (!r.ready) return null;
          return {
            sym,
            price: r.price,
            chg: r.chg,
            vol: r.vol,
            funding: r.funding,
            score: r.report?.score,
            dir: r.report?.dir,
            tier: r.report?.tier,
            regime: r.report?.regime?.type,
            rsi: r.report?.state?.trigger?.rsi,
          };
        })
        .filter(Boolean) as OfflineMarketSummary[];

      const snap = await saveOfflineSnapshot({
        wallet: override?.wallet ?? wallet ?? undefined,
        trades: override?.trades ?? trades,
        ledger: override?.ledger ?? ledger,
        botSettings: override?.botSettings ?? botSettings ?? undefined,
        notifications: override?.notifications ?? notifications,
        signals: engine.getSignals(),
        market: marketSummary.length ? marketSummary : offlineMarket,
      });
      setLastOfflineAt(snap.lastUpdatedAt);
    },
    [botSettings, engine, ledger, notifications, offlineMarket, trades, wallet]
  );

  const refreshServerState = useCallback(async () => {
    try {
      if (!initialServerSyncRef.current) {
        await fetch('/api/auth/session', { cache: 'no-store' }).catch(() => undefined);
      }
      const [pRes, nRes, sRes] = await Promise.all([
        fetch('/api/portfolio', { cache: 'no-store' }),
        fetch('/api/notifications', { cache: 'no-store' }),
        !initialServerSyncRef.current
          ? fetch('/api/signals', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);
      const pJson = await pRes.json();
      const nJson = await nRes.json();
      if (pJson.ok) {
        setWallet(pJson.wallet);
        setTrades(pJson.trades || []);
        setLedger(pJson.ledger || []);
        setBotSettings(pJson.settings);
        setEngineStatus(pJson.engine);
        if (pJson.allocation) setAllocation(pJson.allocation);
        if (pJson.workerState) setWorkerState(pJson.workerState);
        if (Array.isArray(pJson.engineLogs)) setEngineLogs(pJson.engineLogs);
        if (!initialServerSyncRef.current) {
          engine.applyServerBotSettings(pJson.settings, pJson.wallet?.balanceUsdt);
        } else if (pJson.settings) {
          const cur = engine.getSettings();
          const syncPatch: Partial<BotSettings> = {};
          if (pJson.settings.emergencyStopped && cur.executionMode !== 'MANUAL') {
            syncPatch.executionMode = 'MANUAL';
            syncPatch.autoTradeEnabled = false;
          }
          if (
            pJson.settings.earlyWeights &&
            JSON.stringify(pJson.settings.earlyWeights) !== JSON.stringify(cur.earlyWeights)
          ) {
            syncPatch.earlyWeights = pJson.settings.earlyWeights;
          }
          if (Object.keys(syncPatch).length > 0) {
            engine.applyServerBotSettings(syncPatch);
          }
        }
      }
      if (nJson.ok) {
        setNotifications(nJson.notifications || []);
      }
      if (sRes) {
        const sJson = await sRes.json().catch(() => null);
        if (sJson?.ok && Array.isArray(sJson.signals)) {
          engine.mergeRemoteSignals(sJson.signals);
        }
        initialServerSyncRef.current = true;
      }
      await persistOffline({
        wallet: pJson.ok ? pJson.wallet : undefined,
        trades: pJson.ok ? pJson.trades : undefined,
        ledger: pJson.ok ? pJson.ledger : undefined,
        botSettings: pJson.ok ? pJson.settings : undefined,
        notifications: nJson.ok ? nJson.notifications : undefined,
      });
    } catch {
      // Offline or transient error: keep existing / cached snapshot
    }
  }, [engine, persistOffline]);

  const persistOfflineRef = useRef(persistOffline);
  useEffect(() => {
    persistOfflineRef.current = persistOffline;
  }, [persistOffline]);

  const refreshServerRef = useRef(refreshServerState);
  useEffect(() => {
    refreshServerRef.current = refreshServerState;
  }, [refreshServerState]);

  useEffect(() => {
    loadOfflineSnapshot().then((snap) => {
      if (!snap) return;
      if (snap.wallet) setWallet(snap.wallet);
      if (snap.trades) setTrades(snap.trades);
      if (snap.ledger) setLedger(snap.ledger);
      if (snap.botSettings) setBotSettings(snap.botSettings);
      if (snap.notifications) setNotifications(snap.notifications);
      if (snap.market) setOfflineMarket(snap.market);
      if (snap.lastUpdatedAt) setLastOfflineAt(snap.lastUpdatedAt);
      if (!navigator.onLine) {
        setBootHidden(true);
      }
    });

    checkWebPushSubscribed().then(setPushSubscribed);
    const bootTimer = setTimeout(() => {
      refreshServerRef.current();
    }, 0);

    const bump = () => setTickVersion((v) => v + 1);
    const unsubs = [
      engine.bus.on('scan-state', (s: any) => {
        setScanPhase(s.phase);
        setScanMsg(s.msg);
        setScanProg(s.progress);
        setScanBusy(Boolean(s.busy));
        setScanGeo(Boolean(s.geo));
      }),
      engine.bus.on('boot-done', () => {
        setBootHidden(true);
        bump();
        persistOfflineRef.current();
      }),
      engine.bus.on('toast', (t: ToastItem) => addToast(t.title, t.kind, t.sig)),
      engine.bus.on('signal', bump),
      engine.bus.on('signal-update', bump),
      engine.bus.on('signals-changed', bump),
      engine.bus.on('cycle', () => {
        bump();
        persistOfflineRef.current();
      }),
      engine.bus.on('prices', bump),
      engine.bus.on('active', bump),
      engine.bus.on('settings', bump),
      engine.bus.on('report', bump),
      engine.bus.on('ws-state', bump),
      engine.bus.on('tick', () => setTickVersion((v) => v + 1)),
      engine.bus.on('depth', bump),
    ];

    engine.initOnce();

    const pollId = setInterval(() => {
      setNowMs(Date.now());
      refreshServerRef.current();
    }, 8000);

    return () => {
      clearTimeout(bootTimer);
      unsubs.forEach((fn) => fn());
      clearInterval(pollId);
    };
  }, [addToast, engine]);

  const handleOpenChart = (sym: string) => {
    engine.setActive(sym);
    setPage('chart');
    window.scrollTo(0, 0);
  };

  const handleExecutePaper = async (sym: string, evaluation?: any) => {
    try {
      const res = await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'open_manual',
          symbol: sym,
          evaluation,
          meta: engine.rec(sym).meta,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        addToast(json.reason || json.error || 'تعذر تنفيذ الصفقة التجريبية', 'bad');
      } else {
        addToast(`تم فتح صفقة تجريبية على ${sym} ✔`, 'info');
        await refreshServerState();
      }
    } catch {
      addToast('تعذر الاتصال بخادم المحفظة التجريبية', 'bad');
    }
  };

  const handleMarkAllRead = async () => {
    await fetch('/api/notifications', { method: 'PATCH' }).catch(() => undefined);
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
  };

  const handleTestPush = async () => {
    const res = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'INFO',
        severity: 'info',
        title: 'اختبار CIPHER X PRO Push',
        body: 'تم توصيل إشعارات التطبيق بنجاح!',
      }),
    });
    if (res.ok) {
      addToast('تم إرسال إشعار تجريبي ✔', 'info');
      refreshServerState();
    }
  };

  const a = engine.apiState;
  const f = engine.wsStatus();
  const restCls = a.geo ? 'bad' : nowMs > 0 && nowMs < a.banUntil ? 'warn' : a.ok ? 'ok' : '';
  const wsCls =
    f.market === 'open' && f.healthy
      ? 'ok'
      : f.market === 'connecting'
        ? 'warn'
        : f.market === 'closed'
          ? 'bad'
          : '';

  const tfs = engine.tfs();
  const modeCfg = engine.getSettings().mode;
  const nLiveSignals = engine.getLiveSignals().length;
  const openPaperCount = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
  const unreadNotifs = notifications.filter((n) => !n.isRead).length;

  const navItems: { k: TabKey; label: string; icon: React.ReactNode; badge?: number }[] = [
    { k: 'signals', label: 'الإشارات', icon: <Zap size={20} />, badge: nLiveSignals },
    { k: 'market', label: 'السوق', icon: <BarChart3 size={20} /> },
    { k: 'chart', label: 'التحليل', icon: <LineChart size={20} /> },
    { k: 'wallet', label: 'المحفظة', icon: <Wallet size={20} />, badge: openPaperCount },
    { k: 'perf', label: 'الأداء', icon: <Clock size={20} /> },
    { k: 'settings', label: 'الإعدادات', icon: <Settings size={20} /> },
  ];

  return (
    <>
      {/* Boot Splash Overlay */}
      {!bootHidden && (
        <div className="boot">
          <div className="logo">CIPHER X</div>
          <div className="mut">
            {scanPhase === 'error' ? 'تعذر الاتصال بـ Binance Futures' : scanMsg || 'جارٍ التهيئة…'}
          </div>
          <div className="pb">
            <i style={{ width: `${Math.round(scanProg * 100)}%` }} />
          </div>
          {scanPhase === 'error' && (
            <>
              <div className="hint" style={{ maxWidth: 420 }}>
                {scanGeo
                  ? 'Binance يرفض الاتصال من هذه الشبكة/الدولة (HTTP 451/403). جرّب شبكة أخرى أو ضع عنوان وسيط في الإعدادات.'
                  : `${scanMsg} — تحقق من الإنترنت ثم أعد المحاولة.`}
              </div>
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn pri"
                  onClick={() => engine.boot()}
                >
                  إعادة المحاولة
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setBootHidden(true)}
                >
                  عرض آخر البيانات المحفوظة
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="app">
        {/* Sticky Header */}
        <header className="top">
          <div className="brand">
            CIPHER X<small>PRO</small>
          </div>
          <button type="button" className="modebtn" onClick={() => setPage('settings')}>
            {modeCfg === 'early' ? 'EARLY' : MODES[modeCfg]?.label || modeCfg} · {tfs.trigger}
            {botSettings?.executionMode === 'AUTO' && !botSettings?.emergencyStopped ? ' · آلي' : ''}
          </button>
          <div className="sp" />
          <PWAInstallButton />
          <button
            type="button"
            className="modebtn"
            style={{ position: 'relative', padding: '5px 8px' }}
            onClick={() => setNotifOpen(true)}
            title="الإشعارات"
          >
            <Bell size={14} />
            {unreadNotifs > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: -4,
                  insetInlineEnd: -4,
                  background: 'var(--red)',
                  color: '#fff',
                  fontSize: 9,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--f-mono)',
                }}
              >
                {unreadNotifs}
              </span>
            )}
          </button>
          <div className="stat">
            <span className={`dot ${restCls}`} />
            REST
          </div>
          <div className="stat">
            <span className={`dot ${wsCls}`} />
            WS
          </div>
          <div className="progress">
            <i
              style={{
                width: scanPhase === 'boot' ? `${scanProg * 100}%` : scanBusy ? '60%' : '0%',
              }}
            />
          </div>
        </header>

        <OfflineBanner lastUpdatedAt={lastOfflineAt} />

        {/* Active Tab Page */}
        <main>
          <motion.div
            key={page}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.14 }}
            className="page"
          >
            {page === 'signals' && (
              <SignalsTab
                engine={engine}
                wallet={wallet}
                botSettings={botSettings}
                openPositions={trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING')}
                onOpenChart={handleOpenChart}
                onOpenWallet={() => {
                  setPage('wallet');
                  window.scrollTo(0, 0);
                }}
                onExecutePaper={handleExecutePaper}
                onToast={(m, k) => addToast(m, k)}
                tickVersion={tickVersion}
              />
            )}
            {page === 'market' && (
              <MarketTab
                engine={engine}
                offlineMarket={!online || engine.storeState.universe.length === 0 ? offlineMarket : undefined}
                onOpenChart={handleOpenChart}
                tickVersion={tickVersion}
              />
            )}
            {page === 'chart' && (
              <ChartTab
                engine={engine}
                openPositions={trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING')}
                onOpenWallet={() => {
                  setPage('wallet');
                  window.scrollTo(0, 0);
                }}
                onExecutePaper={handleExecutePaper}
                onToast={(m, k) => addToast(m, k)}
                tickVersion={tickVersion}
              />
            )}
            {page === 'wallet' && (
              <WalletAutoTab
                engine={engine}
                wallet={wallet}
                trades={trades}
                ledger={ledger}
                botSettings={botSettings}
                engineStatus={engineStatus}
                allocation={allocation}
                workerState={workerState}
                engineLogs={engineLogs}
                onRefresh={refreshServerState}
                onOpenChart={handleOpenChart}
                onToast={(m, k) => addToast(m, k)}
                tickVersion={tickVersion}
              />
            )}
            {page === 'perf' && (
              <PerformanceTab
                engine={engine}
                onToast={(m, k) => addToast(m, k)}
                onWeightsUpdated={refreshServerState}
              />
            )}
            {page === 'settings' && (
              <SettingsTab
                engine={engine}
                wallet={wallet}
                botSettings={botSettings}
                pushSubscribed={pushSubscribed}
                onPushChange={setPushSubscribed}
                lastOfflineAt={lastOfflineAt}
                onToast={(m, k) => addToast(m, k)}
                onModeChanged={() => setBootHidden(false)}
                onSettingsSynced={refreshServerState}
              />
            )}
          </motion.div>
        </main>
      </div>

      {/* Bottom Navigation */}
      <nav className="nav">
        <div className="in">
          {navItems.map((item) => (
            <button
              key={item.k}
              type="button"
              className={page === item.k ? 'on' : ''}
              onClick={() => {
                setPage(item.k);
                window.scrollTo(0, 0);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge != null && item.badge > 0 && (
                <b className="badge">{item.badge}</b>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Toasts */}
      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.kind}`}
            onClick={() => {
              setToasts((prev) => prev.filter((x) => x.id !== t.id));
              if (t.sig) setPage('signals');
            }}
          >
            {t.title}
          </div>
        ))}
      </div>

      {/* Notifications Drawer */}
      <NotificationsDrawer
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
        pushSubscribed={pushSubscribed}
        onPushChange={setPushSubscribed}
        onMarkAllRead={handleMarkAllRead}
        onTestPush={handleTestPush}
      />
    </>
  );
}
