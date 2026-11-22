'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellRing,
  Bot,
  CheckCircle2,
  Copy,
  Database,
  Download,
  Filter,
  RefreshCw,
  RotateCcw,
  Shield,
  Sliders,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { MODES, resolveModeConfig } from '@/lib/cx-engine/analyzer';
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from '@/lib/cx-engine/early-entry';
import type {
  BotSettings,
  ExecutionMode,
  PaperWallet,
  SmartTpSensitivity,
  TradingModeKey,
} from '@/lib/cx-engine/types';
import { fmtCountdown, fmtDt } from '@/lib/client/formatters';
import {
  DEFAULT_CLIENT_SETTINGS,
  type CipherClientEngine,
  type ClientSettings,
} from '@/lib/client/market-engine';
import { subscribeWebPush, unsubscribeWebPush, usePWAInstall } from '@/lib/client/use-pwa';

interface SettingsTabProps {
  engine: CipherClientEngine;
  wallet?: PaperWallet | null;
  botSettings?: BotSettings | null;
  pushSubscribed: boolean;
  onPushChange: (v: boolean) => void;
  lastOfflineAt: string | null;
  onToast: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  onModeChanged: () => void;
  onSettingsSynced?: () => void;
}

type SectionKey = 'ALL' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

function NumInput({
  value,
  min,
  max,
  decimals,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  decimals?: number;
  onCommit: (val: number) => void;
}) {
  const fmt = (v: number) => (decimals != null ? v.toFixed(decimals) : String(v));
  const [text, setText] = useState<string>(() => fmt(value));
  const [editing, setEditing] = useState(false);

  const displayed = editing ? text : fmt(value);

  return (
    <input
      inputMode="decimal"
      value={displayed}
      onFocus={() => {
        setText(fmt(value));
        setEditing(true);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === '' || raw.endsWith('.') || raw === '-') return;
        const n = Number(raw);
        if (!Number.isNaN(n) && Number.isFinite(n)) {
          const clamped = min != null && n < min ? min : max != null && n > max ? max : n;
          if (clamped === n) onCommit(n);
        }
      }}
      onBlur={() => {
        setEditing(false);
        const n = Number(text);
        if (text.trim() === '' || Number.isNaN(n) || !Number.isFinite(n)) {
          setText(fmt(value));
          return;
        }
        const clamped = min != null && n < min ? min : max != null && n > max ? max : n;
        setText(fmt(clamped));
        onCommit(clamped);
      }}
    />
  );
}

export default function SettingsTab({
  engine,
  wallet,
  botSettings,
  pushSubscribed,
  onPushChange,
  lastOfflineAt,
  onToast,
  onModeChanged,
  onSettingsSynced,
}: SettingsTabProps) {
  const [s, setS] = useState<ClientSettings>(() => engine.getSettings());
  const [activeSection, setActiveSection] = useState<SectionKey>('ALL');
  const [confirmMode, setConfirmMode] = useState<TradingModeKey | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingSensitiveRisk, setPendingSensitiveRisk] = useState<{
    patch: Partial<ClientSettings>;
    reason: string;
  } | null>(null);
  const [supaInfo, setSupaInfo] = useState<{ status: any; vapid?: any; schemaSql: string } | null>(null);
  const [checkingSupa, setCheckingSupa] = useState(false);
  const [syncBadge, setSyncBadge] = useState<'saved' | 'syncing' | 'unsaved' | 'offline'>('saved');
  const [nowMs, setNowMs] = useState(0);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { isInstalled, promptInstall } = usePWAInstall();

  const fetchSupaStatus = useCallback(async () => {
    setCheckingSupa(true);
    try {
      const r = await fetch('/api/supabase/status', { cache: 'no-store' });
      const j = await r.json();
      if (j.ok) setSupaInfo({ status: j.status, vapid: j.vapid, schemaSql: j.schemaSql });
    } catch {
      // ignore offline
    } finally {
      setCheckingSupa(false);
    }
  }, []);

  useEffect(() => {
    const unsub = engine.bus.on('settings', (next: ClientSettings) => setS({ ...next }));
    const id = setInterval(() => setNowMs(Date.now()), 2000);
    const t0 = setTimeout(() => {
      fetchSupaStatus();
    }, 0);
    return () => {
      unsub();
      clearInterval(id);
      clearTimeout(t0);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [engine, fetchSupaStatus]);

  const buildServerPatch = (
    updated: ClientSettings,
    includeExecutionMode = false
  ): Record<string, any> => {
    const payload: Record<string, any> = {
      mode: updated.mode,
      earlyTriggerTf: updated.earlyTriggerTf,
      riskPct: updated.riskPct,
      maxLeverage: updated.maxLev,
      maxOpenPositions: updated.maxOpenPositions,
      equalAllocationEnabled: updated.equalAllocationEnabled,
      cashReservePct: updated.cashReservePct,
      maxPortfolioHeatPct: updated.maxPortfolioHeatPct,
      maxSameSidePositions: updated.maxSameSidePositions,
      dailyLossLimitUsdt: updated.dailyLossLimitUsdt,
      dailyLossLimitPct: updated.dailyLossLimitPct,
      btcFilterEnabled: updated.btcFilterEnabled,
      watchScore: updated.watchScore,
      minScore: updated.minScore,
      strongScore: updated.strongScore,
      minTier: updated.minTier,
      takerFee: updated.takerFee,
      makerFee: updated.makerFee,
      slippage: updated.slip,
      minLiqSafetyPct: updated.minLiqSafetyPct,
      minVolumeUsdt: updated.minVolM * 1_000_000,
      maxSpreadBps: updated.maxSpreadBps,
      tpPcts: updated.tpPcts,
      limitExpireBars: updated.limitExpireBars,
      cancelChasedAtr: updated.cancelChasedAtr,
      allowReentry: updated.allowReentry,
      reentryCooldownBars: updated.reentryCooldownBars,
      trailingStopEnabled: updated.trailingStopEnabled,
      filterFlags: updated.filterFlags,
      notifyPrefs: updated.notifyPrefs,
      earlyWeights: updated.earlyWeights,
      smartProfitShield: updated.smartProfitShield,
      smartTakeProfitEnabled: updated.smartTakeProfitEnabled,
      smartTakeProfitSensitivity: updated.smartTakeProfitSensitivity,
      smartTakeProfitMinR: updated.smartTakeProfitMinR,
      smartTakeProfitPartialPct: updated.smartTakeProfitPartialPct,
    };
    if (includeExecutionMode) {
      payload.executionMode = updated.executionMode;
      payload.autoTradeEnabled = updated.executionMode === 'AUTO';
    }
    return payload;
  };

  const pushToServerNow = useCallback(
    (updated: ClientSettings, includeExecutionMode = false) => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      setSyncBadge('syncing');
      syncTimerRef.current = setTimeout(() => {
        fetch('/api/auto-trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update_settings',
            settings: buildServerPatch(updated, includeExecutionMode),
            clearEmergency: includeExecutionMode && updated.executionMode === 'AUTO',
          }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j?.ok) {
              setSyncBadge('saved');
              onSettingsSynced?.();
            } else {
              setSyncBadge('unsaved');
            }
          })
          .catch(() => setSyncBadge('offline'));
      }, 450);
    },
    [onSettingsSynced]
  );

  const commitUpdate = (patch: Partial<ClientSettings>, bypassRiskGuard = false) => {
    if (!bypassRiskGuard) {
      const nextRisk = patch.riskPct ?? s.riskPct;
      const nextLev = patch.maxLev ?? s.maxLev;
      const nextSafety = patch.minLiqSafetyPct ?? s.minLiqSafetyPct;
      const warnings: string[] = [];
      if (patch.riskPct !== undefined && nextRisk > 2 && nextRisk !== s.riskPct) {
        warnings.push(`المخاطرة لكل صفقة ارتفعت إلى ${nextRisk}% (أعلى من الحد الموصى به 2%)`);
      }
      if (patch.maxLev !== undefined && nextLev > 20 && nextLev !== s.maxLev) {
        warnings.push(`أقصى رافعة ارتفعت إلى ${nextLev}x (تزيد حساسية التصفية)`);
      }
      if (patch.minLiqSafetyPct !== undefined && nextSafety < 20 && nextSafety !== s.minLiqSafetyPct) {
        warnings.push(`هامش الأمان قبل التصفية انخفض إلى ${nextSafety}%`);
      }
      if (warnings.length > 0) {
        setPendingSensitiveRisk({ patch, reason: warnings.join(' · ') });
        setSyncBadge('unsaved');
        return;
      }
    }

    const includeExecutionMode = patch.executionMode !== undefined;
    engine.setSettings(patch);
    const updated = { ...engine.getSettings() };
    setS(updated);
    pushToServerNow(updated, includeExecutionMode);
  };

  const commitScores = () => {
    const updated = { ...engine.normalizeScores() };
    setS(updated);
    pushToServerNow(updated, false);
  };

  const resetSection = (section: Exclude<SectionKey, 'ALL'>) => {
    const D = DEFAULT_CLIENT_SETTINGS;
    let patch: Partial<ClientSettings> = {};
    if (section === 'A') {
      patch = {
        mode: D.mode,
        earlyTriggerTf: D.earlyTriggerTf,
        minTier: D.minTier,
        minScore: D.minScore,
        strongScore: D.strongScore,
        watchScore: D.watchScore,
        autoScan: D.autoScan,
        earlyWeights: { ...DEFAULT_EARLY_WEIGHTS },
      };
    } else if (section === 'B') {
      patch = {
        riskPct: D.riskPct,
        maxLev: D.maxLev,
        maxOpenPositions: D.maxOpenPositions,
        equalAllocationEnabled: D.equalAllocationEnabled,
        cashReservePct: D.cashReservePct,
        maxPortfolioHeatPct: D.maxPortfolioHeatPct,
        maxSameSidePositions: D.maxSameSidePositions,
        dailyLossLimitUsdt: D.dailyLossLimitUsdt,
        dailyLossLimitPct: D.dailyLossLimitPct,
        minLiqSafetyPct: D.minLiqSafetyPct,
      };
    } else if (section === 'C') {
      patch = {
        tpPcts: [...D.tpPcts],
        trailingStopEnabled: D.trailingStopEnabled,
        limitExpireBars: D.limitExpireBars,
        cancelChasedAtr: D.cancelChasedAtr,
        allowReentry: D.allowReentry,
        reentryCooldownBars: D.reentryCooldownBars,
        smartProfitShield: D.smartProfitShield,
        smartTakeProfitEnabled: D.smartTakeProfitEnabled,
        smartTakeProfitMinR: D.smartTakeProfitMinR,
        smartTakeProfitPartialPct: D.smartTakeProfitPartialPct,
        smartTakeProfitSensitivity: D.smartTakeProfitSensitivity,
        takerFee: D.takerFee,
        makerFee: D.makerFee,
        slip: D.slip,
      };
    } else if (section === 'D') {
      patch = {
        universe: D.universe,
        minVolM: D.minVolM,
        maxSpreadBps: D.maxSpreadBps,
        liquidityRadarGate: D.liquidityRadarGate,
        btcFilterEnabled: D.btcFilterEnabled,
        filterFlags: { ...D.filterFlags },
        favorites: [...D.favorites],
      };
    } else if (section === 'E') {
      patch = {
        executionMode: 'MANUAL',
      };
    } else if (section === 'F') {
      patch = {
        soundOn: D.soundOn,
        vibrateOn: D.vibrateOn,
        notifyOn: D.notifyOn,
        wakeLock: D.wakeLock,
        notifyPrefs: { ...D.notifyPrefs },
      };
    }
    commitUpdate(patch, true);
    onToast(`تمت استعادة افتراضيات القسم (${section}) ✔`, 'info');
  };

  const tfs = resolveModeConfig(s.mode, s.earlyTriggerTf);
  const a = engine.apiState;
  const f = engine.wsStatus();
  const sc = engine.scanState;

  const toggleSwitch = (k: keyof ClientSettings, label: string) => (
    <div className="tog" key={k}>
      <span>{label}</span>
      <div
        className={`sw ${s[k] ? 'on' : ''}`}
        onClick={() => {
          const val = !s[k];
          commitUpdate({ [k]: val } as Partial<ClientSettings>);
          if (k === 'wakeLock') engine.updateWakeLock();
        }}
      />
    </div>
  );

  const showSection = (sec: Exclude<SectionKey, 'ALL'>) =>
    activeSection === 'ALL' || activeSection === sec;

  const sectionTabs: { key: SectionKey; label: string }[] = [
    { key: 'ALL', label: 'الكل' },
    { key: 'A', label: 'A التداول' },
    { key: 'B', label: 'B رأس المال' },
    { key: 'C', label: 'C الصفقة' },
    { key: 'D', label: 'D الفلاتر' },
    { key: 'E', label: 'E المحرك' },
    { key: 'F', label: 'F الإشعارات' },
  ];

  const syncTpPct = (idx: 0 | 1 | 2, val: number) => {
    const next: [number, number, number] = [...(s.tpPcts || [40, 35, 25])] as [number, number, number];
    next[idx] = Math.max(5, Math.min(90, Math.round(val)));
    commitUpdate({ tpPcts: next });
  };

  const tpTotal = (s.tpPcts?.[0] ?? 40) + (s.tpPcts?.[1] ?? 35) + (s.tpPcts?.[2] ?? 25);

  return (
    <div>
      {/* Control Center Header + Sync State + Section Filter */}
      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 10 }}>
          <div className="row">
            <Sliders size={17} color="var(--cyan)" />
            <h3 style={{ margin: 0 }}>مركز التحكم والإعدادات (Quant Control Center)</h3>
          </div>
          <span
            className={`b ${
              syncBadge === 'saved'
                ? 'b-open'
                : syncBadge === 'syncing'
                  ? 'b-good'
                  : syncBadge === 'unsaved'
                    ? 'b-short'
                    : 'b-pend'
            }`}
          >
            {syncBadge === 'saved'
              ? 'محفوظ ومتزامن ✔'
              : syncBadge === 'syncing'
                ? 'جارٍ المزامنة…'
                : syncBadge === 'unsaved'
                  ? 'بانتظار التأكيد'
                  : 'محفوظ محلياً'}
          </span>
        </div>

        <div className="chips">
          {sectionTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`chip ${activeSection === t.key ? 'on' : ''}`}
              onClick={() => setActiveSection(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {pendingSensitiveRisk && (
          <div className="warn" style={{ marginTop: 10 }}>
            <div className="row" style={{ gap: 6, marginBottom: 6 }}>
              <AlertTriangle size={15} />
              <b>تنبيه تعديل مخاطر حساس:</b>
            </div>
            <div style={{ marginBottom: 8 }}>{pendingSensitiveRisk.reason}</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn sm red"
                onClick={() => {
                  const target = pendingSensitiveRisk.patch;
                  setPendingSensitiveRisk(null);
                  commitUpdate(target, true);
                  onToast('تم حفظ تعديل المخاطر بناءً على تأكيدك ✔', 'info');
                }}
              >
                تأكيد وحفظ التعديل
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setPendingSensitiveRisk(null);
                  setS({ ...engine.getSettings() });
                  setSyncBadge('saved');
                }}
              >
                تراجع
              </button>
            </div>
          </div>
        )}
      </div>

      {/* SECTION A: Trading Settings + Strategy Mode */}
      {showSection('A') && (
        <>
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 10 }}>
              <div className="row">
                <TrendingUp size={16} color="var(--cyan)" />
                <h3 style={{ margin: 0 }}>A. إعدادات التداول — نمط التداول والأطر الزمنية</h3>
              </div>
              <button type="button" className="btn sm" onClick={() => resetSection('A')}>
                <RotateCcw size={12} />
                <span>افتراضيات A</span>
              </button>
            </div>

            <div className="seg">
              {(Object.entries(MODES) as [TradingModeKey, { label: string }][]).map(([k, m]) => (
                <button
                  key={k}
                  type="button"
                  className={s.mode === k ? 'on' : ''}
                  onClick={() => {
                    if (k === s.mode) return;
                    setConfirmMode(k);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {confirmMode && (
              <div className="warn row sb wrap" style={{ marginTop: 8 }}>
                <span>
                  تغيير النمط إلى {MODES[confirmMode].label} يعيد تحميل الشموع للأطر الجديدة.
                </span>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn sm pri"
                    onClick={() => {
                      const target = confirmMode;
                      setConfirmMode(null);
                      commitUpdate({ mode: target });
                      onModeChanged();
                      engine.reboot();
                    }}
                  >
                    متابعة
                  </button>
                  <button type="button" className="btn sm" onClick={() => setConfirmMode(null)}>
                    إلغاء
                  </button>
                </div>
              </div>
            )}

            {s.mode === 'early' && (
              <div className="tile" style={{ marginTop: 10 }}>
                <div className="row sb wrap" style={{ marginBottom: 6 }}>
                  <b className="cy" style={{ fontSize: 12.5 }}>
                    ⚡ إطار محفّز الاقتناص المبكر (EARLY ENTRY Trigger TF)
                  </b>
                  <span className="hint">يكتشف الاختراق من التضييق قبل الامتداد السعري</span>
                </div>
                <div className="seg">
                  {(['5m', '15m', '1h'] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      className={s.earlyTriggerTf === tf ? 'on' : ''}
                      onClick={() => {
                        if (s.earlyTriggerTf === tf) return;
                        commitUpdate({ earlyTriggerTf: tf });
                        onModeChanged();
                        engine.reboot();
                      }}
                    >
                      {tf}
                    </button>
                  ))}
                </div>

                <details>
                  <summary>تخصيص أوزان معايير الدخول المبكر (6 مكونات — مجموع ≈ 100)</summary>
                  <div className="grid g3" style={{ gap: 8, marginTop: 8 }}>
                    <div>
                      <label className="f">جودة المنطقة (Zone 0-25)</label>
                      <NumInput
                        value={s.earlyWeights?.zoneQuality ?? DEFAULT_EARLY_WEIGHTS.zoneQuality}
                        min={5}
                        max={35}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              zoneQuality: v,
                            }),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="f">كسر الهيكل CHoCH/BOS</label>
                      <NumInput
                        value={s.earlyWeights?.structureShift ?? DEFAULT_EARLY_WEIGHTS.structureShift}
                        min={5}
                        max={35}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              structureShift: v,
                            }),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="f">الزخم والحجم RVOL/Delta</label>
                      <NumInput
                        value={s.earlyWeights?.momentumVolume ?? DEFAULT_EARLY_WEIGHTS.momentumVolume}
                        min={5}
                        max={35}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              momentumVolume: v,
                            }),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="f">السيولة والامتصاص</label>
                      <NumInput
                        value={s.earlyWeights?.liquidityConfirm ?? DEFAULT_EARLY_WEIGHTS.liquidityConfirm}
                        min={5}
                        max={30}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              liquidityConfirm: v,
                            }),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="f">توافق الأطر العليا (MTF)</label>
                      <NumInput
                        value={s.earlyWeights?.mtfAlignment ?? DEFAULT_EARLY_WEIGHTS.mtfAlignment}
                        min={5}
                        max={30}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              mtfAlignment: v,
                            }),
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="f">جودة الوقف و R:R</label>
                      <NumInput
                        value={s.earlyWeights?.stopRrQuality ?? DEFAULT_EARLY_WEIGHTS.stopRrQuality}
                        min={3}
                        max={25}
                        onCommit={(v) =>
                          commitUpdate({
                            earlyWeights: normalizeEarlyWeights({
                              ...s.earlyWeights,
                              stopRrQuality: v,
                            }),
                          })
                        }
                      />
                    </div>
                  </div>
                </details>
              </div>
            )}

            <div className="hint" style={{ marginTop: 8 }}>
              محفّز {tfs.trigger} · وسيط {tfs.setup} · اتجاه {tfs.trend}
              {tfs.htf ? ` · مرجع ${tfs.htf}` : ''} —{' '}
              {s.mode === 'early'
                ? 'يلتقط بداية الحركة السعرية (تضييق + CHoCH + سيولة + FVG) مع رفض الدخول المتأخر (Anti-FOMO).'
                : s.mode === 'scalp'
                  ? 'صفقات قصيرة، إشارات أكثر، ضوضاء أعلى'
                  : s.mode === 'swing'
                    ? 'صفقات أطول، إشارات أقل، وقف أوسع'
                    : 'توازن بين الجودة والتكرار (الموصى به)'}
            </div>

            <div className="sep" />
            <label className="f">أدنى مستوى للإشعار والإصدار</label>
            <div className="seg">
              <button
                type="button"
                className={s.minTier === 'GOOD' ? 'on' : ''}
                onClick={() => commitUpdate({ minTier: 'GOOD' })}
              >
                GOOD وأعلى
              </button>
              <button
                type="button"
                className={s.minTier === 'STRONG' ? 'on' : ''}
                onClick={() => commitUpdate({ minTier: 'STRONG' })}
              >
                STRONG فقط
              </button>
            </div>
            <div className="grid g3">
              <div>
                <label className="f">حد GOOD</label>
                <NumInput
                  value={s.minScore}
                  min={50}
                  max={95}
                  onCommit={(v) => {
                    commitUpdate({ minScore: Math.round(v) });
                    commitScores();
                  }}
                />
              </div>
              <div>
                <label className="f">حد STRONG</label>
                <NumInput
                  value={s.strongScore}
                  min={60}
                  max={98}
                  onCommit={(v) => {
                    commitUpdate({ strongScore: Math.round(v) });
                    commitScores();
                  }}
                />
              </div>
              <div>
                <label className="f">حد المراقبة</label>
                <NumInput
                  value={s.watchScore}
                  min={45}
                  max={90}
                  onCommit={(v) => {
                    commitUpdate({ watchScore: Math.round(v) });
                    commitScores();
                  }}
                />
              </div>
            </div>
            {toggleSwitch('autoScan', 'إصدار الإشارات تلقائياً عند كل إغلاق شمعة')}
          </div>
        </>
      )}

      {/* SECTION B: Capital & Risk Management */}
      {showSection('B') && (
        <div className="card">
          <div className="row sb wrap" style={{ marginBottom: 10 }}>
            <div className="row">
              <Wallet size={16} color="var(--cyan)" />
              <h3 style={{ margin: 0 }}>B. إدارة رأس المال وتوزيعه بالتساوي</h3>
            </div>
            <button type="button" className="btn sm" onClick={() => resetSection('B')}>
              <RotateCcw size={12} />
              <span>افتراضيات B</span>
            </button>
          </div>

          <div className="grid g2">
            <div>
              <label className="f">رأس المال المرجعي للحاسبة (USDT)</label>
              <div className="row" style={{ gap: 6 }}>
                <NumInput
                  value={s.equity}
                  min={10}
                  max={10000000}
                  onCommit={(v) => commitUpdate({ equity: v })}
                />
                {wallet && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => {
                      commitUpdate({ equity: Number(wallet.balanceUsdt.toFixed(2)) });
                      onToast('تمت المزامنة مع رصيد المحفظة التجريبية ✔', 'info');
                    }}
                  >
                    مزامنة ({wallet.balanceUsdt.toFixed(0)}$)
                  </button>
                )}
              </div>
            </div>
            <div>
              <label className="f">المخاطرة لكل صفقة % (Strict Precedence)</label>
              <NumInput
                value={s.riskPct}
                min={0.1}
                max={10}
                onCommit={(v) => commitUpdate({ riskPct: v })}
              />
            </div>
            <div>
              <label className="f">نسبة الاحتياطي النقدي غير المستثمر %</label>
              <NumInput
                value={s.cashReservePct}
                min={0}
                max={50}
                onCommit={(v) => commitUpdate({ cashReservePct: v })}
              />
            </div>
            <div>
              <label className="f">أقصى رافعة مالية</label>
              <NumInput
                value={s.maxLev}
                min={1}
                max={50}
                onCommit={(v) => commitUpdate({ maxLev: Math.round(v) })}
              />
            </div>
          </div>

          {toggleSwitch(
            'equalAllocationEnabled',
            'توزيع رأس المال بالتساوي على المراكز (Equal Allocation Sleeves)'
          )}

          <label className="f">الحد الأقصى للصفقات المفتوحة بالتوازي (Presets أو رقم مخصص)</label>
          <div className="row wrap" style={{ gap: 6 }}>
            <div className="chips" style={{ flex: 1 }}>
              {[1, 3, 5, 8, 10].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`chip ${s.maxOpenPositions === n ? 'on' : ''}`}
                  onClick={() => commitUpdate({ maxOpenPositions: n })}
                >
                  {n} {n === 1 ? 'صفقة' : 'صفقات'}
                </button>
              ))}
            </div>
            <div style={{ width: 92 }}>
              <NumInput
                value={s.maxOpenPositions}
                min={1}
                max={15}
                onCommit={(v) => commitUpdate({ maxOpenPositions: Math.round(v) })}
              />
            </div>
          </div>

          <details>
            <summary>قيود المخاطرة اليومية وأمان التصفية (Risk Guard)</summary>
            <div className="grid g2" style={{ marginTop: 8 }}>
              <div>
                <label className="f">حد المخاطرة الكلية للمحفظة %</label>
                <NumInput
                  value={s.maxPortfolioHeatPct}
                  min={1}
                  max={30}
                  onCommit={(v) => commitUpdate({ maxPortfolioHeatPct: v })}
                />
              </div>
              <div>
                <label className="f">أقصى صفقات بنفس الاتجاه</label>
                <NumInput
                  value={s.maxSameSidePositions}
                  min={1}
                  max={10}
                  onCommit={(v) => commitUpdate({ maxSameSidePositions: Math.round(v) })}
                />
              </div>
              <div>
                <label className="f">حد الخسارة اليومي (USDT)</label>
                <NumInput
                  value={s.dailyLossLimitUsdt}
                  min={10}
                  max={1000000}
                  onCommit={(v) => commitUpdate({ dailyLossLimitUsdt: v })}
                />
              </div>
              <div>
                <label className="f">حد الخسارة اليومي %</label>
                <NumInput
                  value={s.dailyLossLimitPct}
                  min={0.5}
                  max={50}
                  onCommit={(v) => commitUpdate({ dailyLossLimitPct: v })}
                />
              </div>
              <div>
                <label className="f">أدنى مسافة أمان قبل التصفية %</label>
                <NumInput
                  value={s.minLiqSafetyPct}
                  min={10}
                  max={70}
                  onCommit={(v) => commitUpdate({ minLiqSafetyPct: v })}
                />
              </div>
            </div>
          </details>

          <div className="hint" style={{ marginTop: 8 }}>
            الترتيب الصارم للمخاطر: حصة رأس المال تحد الهامش، والمخاطرة % تحد الخسارة القصوى — إذا
            كان الوقف واسعاً تقل الكمية تلقائياً ولا تُرفع الرافعة لتعويض الحجم.
          </div>
        </div>
      )}

      {/* SECTION C: Trade Management */}
      {showSection('C') && (
        <div className="card">
          <div className="row sb wrap" style={{ marginBottom: 10 }}>
            <div className="row">
              <Shield size={16} color="var(--cyan)" />
              <h3 style={{ margin: 0 }}>C. إدارة الصفقة والأهداف والحماية الذكية</h3>
            </div>
            <button type="button" className="btn sm" onClick={() => resetSection('C')}>
              <RotateCcw size={12} />
              <span>افتراضيات C</span>
            </button>
          </div>

          <div className="grid g3">
            <div>
              <label className="f">إغلاق TP1 %</label>
              <NumInput
                value={s.tpPcts?.[0] ?? 40}
                min={5}
                max={90}
                onCommit={(v) => syncTpPct(0, v)}
              />
            </div>
            <div>
              <label className="f">إغلاق TP2 %</label>
              <NumInput
                value={s.tpPcts?.[1] ?? 35}
                min={5}
                max={90}
                onCommit={(v) => syncTpPct(1, v)}
              />
            </div>
            <div>
              <label className="f">إغلاق TP3 % (المجموع {tpTotal}%)</label>
              <NumInput
                value={s.tpPcts?.[2] ?? 25}
                min={5}
                max={90}
                onCommit={(v) => syncTpPct(2, v)}
              />
            </div>
          </div>
          {tpTotal !== 100 && (
            <div className="hint gold">ملاحظة: سيتم موازنة نسب TP1/TP2/TP3 تلقائياً لمجموع 100% عند الحفظ.</div>
          )}

          {toggleSwitch('trailingStopEnabled', 'نقل الوقف التدريجي للتعادل وما بعد TP1 (Trailing / Break-Even)')}
          {toggleSwitch(
            'smartProfitShield',
            'درع حماية الأرباح الذكي (قفل أرباح القمة + خروج انعكاس السيولة)'
          )}
          {toggleSwitch(
            'smartTakeProfitEnabled',
            'تفعيل جني الأرباح الذكي (مراقبة الزخم وانعكاس الشموع على 1m/5m)'
          )}

          {s.smartTakeProfitEnabled && (
            <>
              <label className="f">حساسية اكتشاف الانعكاس المبكر</label>
              <div className="seg">
                {(
                  [
                    ['conservative', 'متحفظ'],
                    ['balanced', 'متوازن (موصى به)'],
                    ['aggressive', 'سريع (حساس)'],
                  ] as [SmartTpSensitivity, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={s.smartTakeProfitSensitivity === k ? 'on' : ''}
                    onClick={() => commitUpdate({ smartTakeProfitSensitivity: k })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid g2">
                <div>
                  <label className="f">أدنى ربح للتفعيل قبل الأهداف (R)</label>
                  <NumInput
                    value={s.smartTakeProfitMinR}
                    min={0.25}
                    max={3}
                    onCommit={(v) => commitUpdate({ smartTakeProfitMinR: v })}
                  />
                </div>
                <div>
                  <label className="f">نسبة الإغلاق الجزئي عند الانعكاس الأولي %</label>
                  <NumInput
                    value={s.smartTakeProfitPartialPct}
                    min={20}
                    max={80}
                    onCommit={(v) => commitUpdate({ smartTakeProfitPartialPct: Math.round(v) })}
                  />
                </div>
              </div>
            </>
          )}

          <details>
            <summary>صلاحية الأوامر وإعادة الدخول والرسوم</summary>
            <div className="grid g3" style={{ marginTop: 8 }}>
              <div>
                <label className="f">انتهاء Limit بعد (شمعة)</label>
                <NumInput
                  value={s.limitExpireBars}
                  min={2}
                  max={48}
                  onCommit={(v) => commitUpdate({ limitExpireBars: Math.round(v) })}
                />
              </div>
              <div>
                <label className="f">إلغاء المطاردة (×ATR)</label>
                <NumInput
                  value={s.cancelChasedAtr}
                  min={1.2}
                  max={5}
                  onCommit={(v) => commitUpdate({ cancelChasedAtr: v })}
                />
              </div>
              <div>
                <label className="f">تهدئة إعادة الدخول (شمعة)</label>
                <NumInput
                  value={s.reentryCooldownBars}
                  min={1}
                  max={30}
                  onCommit={(v) => commitUpdate({ reentryCooldownBars: Math.round(v) })}
                />
              </div>
              <div>
                <label className="f">رسوم Taker %</label>
                <NumInput
                  value={s.takerFee * 100}
                  decimals={3}
                  min={0}
                  max={0.5}
                  onCommit={(v) => commitUpdate({ takerFee: v / 100 })}
                />
              </div>
              <div>
                <label className="f">رسوم Maker %</label>
                <NumInput
                  value={s.makerFee * 100}
                  decimals={3}
                  min={0}
                  max={0.5}
                  onCommit={(v) => commitUpdate({ makerFee: v / 100 })}
                />
              </div>
              <div>
                <label className="f">انزلاق % (افتراضي)</label>
                <NumInput
                  value={s.slip * 100}
                  decimals={3}
                  min={0}
                  max={1}
                  onCommit={(v) => commitUpdate({ slip: v / 100 })}
                />
              </div>
            </div>
            {toggleSwitch('allowReentry', 'السماح بإعادة دخول نفس العملة بعد انتهاء فترة التهدئة')}
          </details>
        </div>
      )}

      {/* SECTION D: Market Filters */}
      {showSection('D') && (
        <div className="card">
          <div className="row sb wrap" style={{ marginBottom: 10 }}>
            <div className="row">
              <Filter size={16} color="var(--cyan)" />
              <h3 style={{ margin: 0 }}>D. فلاتر السوق والسيولة والهيكل</h3>
            </div>
            <button type="button" className="btn sm" onClick={() => resetSection('D')}>
              <RotateCcw size={12} />
              <span>افتراضيات D</span>
            </button>
          </div>

          <div className="grid g3">
            <div>
              <label className="f">عدد العملات</label>
              <NumInput
                value={s.universe}
                min={6}
                max={60}
                onCommit={(v) => commitUpdate({ universe: Math.round(v) })}
              />
            </div>
            <div>
              <label className="f">أدنى حجم 24س (مليون $)</label>
              <NumInput
                value={s.minVolM}
                min={1}
                max={1000}
                onCommit={(v) => commitUpdate({ minVolM: v })}
              />
            </div>
            <div>
              <label className="f">أقصى سبريد مسموح (bps)</label>
              <NumInput
                value={s.maxSpreadBps}
                min={1}
                max={50}
                onCommit={(v) => commitUpdate({ maxSpreadBps: v })}
              />
            </div>
          </div>

          {toggleSwitch('liquidityRadarGate', 'دمج رادار السيولة (1m/5m) كشرط لإصدار الإشارات')}
          {toggleSwitch('btcFilterEnabled', 'حارس BTC الماكرو (منع عكس الصدمات السعرية الحادة)')}

          <details>
            <summary>فلاتر الهيكل الفني التفصيلية (FVG / OB / CHoCH / Momentum)</summary>
            <div style={{ marginTop: 6 }}>
              {(
                [
                  ['useFvg', 'فلتر فجوات القيمة العادلة (FVG)'],
                  ['useOb', 'فلتر مناطق العرض والطلب (Order Blocks)'],
                  ['useChochBos', 'فلتر تغير الهيكل (CHoCH / BOS)'],
                  ['useMomentum', 'فلتر الزخم وانفجار الحجم (Momentum / RVOL)'],
                  ['useOrderFlow', 'فلتر تدفق الأوامر الفوري (OrderFlow Delta)'],
                  ['btcShockBlock', 'حظر التداول أثناء صدمات BTC الفجائية'],
                ] as const
              ).map(([fk, flabel]) => (
                <div className="tog" key={fk}>
                  <span>{flabel}</span>
                  <div
                    className={`sw ${s.filterFlags?.[fk] !== false ? 'on' : ''}`}
                    onClick={() =>
                      commitUpdate({
                        filterFlags: {
                          ...s.filterFlags,
                          [fk]: !(s.filterFlags?.[fk] !== false),
                        },
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </details>

          <label className="f">مفضلة دائماً (مفصولة بفاصلة)</label>
          <input
            style={{ direction: 'ltr' }}
            value={s.favorites.join(',')}
            onChange={(e) =>
              commitUpdate({
                favorites: e.target.value
                  .toUpperCase()
                  .split(/[\s,]+/)
                  .filter(Boolean)
                  .map((x) => (x.endsWith('USDT') ? x : `${x}USDT`)),
              })
            }
          />
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                onModeChanged();
                engine.reboot();
              }}
            >
              تطبيق وإعادة المسح
            </button>
          </div>
        </div>
      )}

      {/* SECTION E: Automated Engine & Backend Persistence */}
      {showSection('E') && (
        <>
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 10 }}>
              <div className="row">
                <Bot size={16} color="var(--cyan)" />
                <h3 style={{ margin: 0 }}>E. المحرك الآلي والتشغيل المستمر 24/7</h3>
              </div>
              <button type="button" className="btn sm" onClick={() => resetSection('E')}>
                <RotateCcw size={12} />
                <span>افتراضيات E</span>
              </button>
            </div>

            <label className="f">نمط التنفيذ الافتراضي</label>
            <div className="seg">
              {(
                [
                  ['MANUAL', 'يدوي — إشارات فقط (MANUAL)'],
                  ['AUTO', 'آلي — فتح وإدارة تلقائية (AUTO)'],
                ] as [ExecutionMode, string][]
              ).map(([modeKey, lbl]) => (
                <button
                  key={modeKey}
                  type="button"
                  className={
                    (botSettings?.executionMode || s.executionMode) === modeKey ? 'on' : ''
                  }
                  onClick={() => commitUpdate({ executionMode: modeKey })}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              يدعم المحرك عملية خلفية مستقلة (<span className="mono">bun run worker</span>) تعمل
              بشكل دائم خارج المتصفح، وتحفظ النبضات والسجلات والمحفظة التجريبية في Supabase بشكل فوري.
            </div>
          </div>

          <div className="card">
            <h3>
              <Database size={15} /> قاعدة بيانات Supabase والتخزين الخلفي
            </h3>
            <div className="kv">
              <span>الحالة الحالية</span>
              <span className={`num ${supaInfo?.status?.connected ? 'pos' : 'gold'}`}>
                {supaInfo?.status?.connected
                  ? 'متصل بـ Supabase (Service Role)'
                  : supaInfo?.status?.missingServiceKey
                    ? 'مفتاح Service Role مفقود'
                    : supaInfo?.status?.configured
                      ? 'جداول Supabase قيد الإعداد'
                      : 'وضع التخزين المحلي المستمر (.data) حتى توفير المفاتيح'}
              </span>
            </div>
            <div className="kv">
              <span>مفاتيح Web Push الدائمة (VAPID)</span>
              <span className={`num ${supaInfo?.vapid?.persistentEnv ? 'pos' : 'gold'}`}>
                {supaInfo?.vapid?.persistentEnv
                  ? 'مضبوطة في متغيرات البيئة ✔'
                  : 'مفاتيح محلية مؤقتة (أضفها للبيئة قبل الإطلاق)'}
              </span>
            </div>
            {supaInfo?.status?.message && (
              <div className="hint" style={{ marginTop: 6 }}>
                {supaInfo.status.message}
              </div>
            )}
            {supaInfo?.status?.tables && Object.keys(supaInfo.status.tables).length > 0 && (
              <div className="row wrap" style={{ marginTop: 8 }}>
                {Object.entries(supaInfo.status.tables).map(([tbl, st]: [string, any]) => (
                  <span key={tbl} className={`b ${st.exists ? 'b-open' : 'b-pend'}`}>
                    {tbl}: {st.exists ? 'جاهز' : 'مفقود'}
                  </span>
                ))}
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 10 }}>
              {supaInfo?.schemaSql && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(supaInfo.schemaSql);
                      onToast('تم نسخ كود supabase/schema.sql المحدّث ✔', 'info');
                    } catch {
                      onToast('تعذر النسخ', 'bad');
                    }
                  }}
                >
                  <Copy size={13} />
                  <span>نسخ كود SQL المحدّث لـ Supabase</span>
                </button>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={checkingSupa}
                onClick={fetchSupaStatus}
              >
                <RefreshCw size={13} />
                <span>{checkingSupa ? 'جارٍ الفحص…' : 'تحديث فحص الجاهزية'}</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* SECTION F: Notifications & Telegram */}
      {showSection('F') && (
        <>
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 10 }}>
              <div className="row">
                <Bell size={16} color="var(--cyan)" />
                <h3 style={{ margin: 0 }}>F. الإشعارات و Web Push وتيليجرام</h3>
              </div>
              <button type="button" className="btn sm" onClick={() => resetSection('F')}>
                <RotateCcw size={12} />
                <span>افتراضيات F</span>
              </button>
            </div>

            {toggleSwitch('soundOn', 'صوت التنبيه')}
            {toggleSwitch('vibrateOn', 'اهتزاز')}
            {toggleSwitch('notifyOn', 'إشعارات المتصفح')}
            {toggleSwitch('wakeLock', 'إبقاء الشاشة مضاءة أثناء المسح المباشر')}

            <details>
              <summary>تصفية أحداث الإشعارات المرسلة (Open / Close / Risk / Error)</summary>
              <div style={{ marginTop: 6 }}>
                {(
                  [
                    ['onOpen', 'إشعار عند فتح صفقة جديدة'],
                    ['onClose', 'إشعار عند إغلاق صفقة أو تحقق TP / SL'],
                    ['onRisk', 'إشعارات المخاطر واقتراب التصفية والحد اليومي'],
                    ['onError', 'إشعارات أخطاء المحرك الخلفي'],
                  ] as const
                ).map(([nk, nlabel]) => (
                  <div className="tog" key={nk}>
                    <span>{nlabel}</span>
                    <div
                      className={`sw ${s.notifyPrefs?.[nk] !== false ? 'on' : ''}`}
                      onClick={() =>
                        commitUpdate({
                          notifyPrefs: {
                            ...s.notifyPrefs,
                            [nk]: !(s.notifyPrefs?.[nk] !== false),
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </details>

            <div style={{ marginTop: 10 }} className="row wrap">
              <button
                type="button"
                className={`btn sm ${pushSubscribed ? 'red' : 'pri'}`}
                onClick={async () => {
                  if (pushSubscribed) {
                    await unsubscribeWebPush();
                    onPushChange(false);
                    onToast('تم إلغاء اشتراك Push', 'info');
                  } else {
                    const res = await subscribeWebPush();
                    if (res.ok) {
                      onPushChange(true);
                      onToast('تم تفعيل Web Push في الخلفية ✔', 'info');
                    } else {
                      onToast(res.error || 'تعذر تفعيل Push', 'bad');
                    }
                  }
                }}
              >
                <BellRing size={14} />
                <span>
                  {pushSubscribed ? 'إيقاف إشعارات Push الخلفية' : 'تفعيل Web Push في الخلفية'}
                </span>
              </button>
              <button type="button" className="btn sm" onClick={() => engine.beep('strong')}>
                اختبار الصوت
              </button>
            </div>
          </div>

          <div className="card">
            <h3>تيليجرام</h3>
            {toggleSwitch('tgOn', 'إرسال الإشارات والأحداث إلى تيليجرام')}
            <label className="f">Bot Token (من @BotFather)</label>
            <input
              type="password"
              autoComplete="off"
              value={s.tgToken}
              onChange={(e) => commitUpdate({ tgToken: e.target.value.trim() })}
            />
            <label className="f">Chat ID</label>
            <input
              value={s.tgChat}
              onChange={(e) => commitUpdate({ tgChat: e.target.value.trim() })}
            />
            <div style={{ marginTop: 10 }} className="row wrap">
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  commitUpdate({ tgOn: true });
                  const r = await engine.telegram('✅ CIPHER X PRO — رسالة اختبار. الاتصال يعمل.');
                  onToast(r.ok ? 'وصلت الرسالة ✔' : `فشل: ${r.err || ''}`, r.ok ? 'info' : 'bad');
                }}
              >
                إرسال رسالة اختبار
              </button>
            </div>
          </div>
        </>
      )}

      {/* PWA, Advanced, Diagnostics & Risk Warning (always accessible at bottom when ALL or E/F) */}
      {(activeSection === 'ALL' || activeSection === 'E' || activeSection === 'F') && (
        <>
          <div className="card">
            <h3>التطبيق المثبت (PWA) والعمل دون اتصال</h3>
            <div className="kv">
              <span>حالة التثبيت</span>
              <span>
                {isInstalled ? (
                  <span className="pos">
                    <CheckCircle2 size={13} style={{ display: 'inline' }} /> مثبّت كتطبيق مستقل
                  </span>
                ) : (
                  'يعمل من المتصفح (قابل للتثبيت)'
                )}
              </span>
            </div>
            <div className="kv">
              <span>آخر لقطة محفوظة للعمل دون اتصال</span>
              <span className="num">{lastOfflineAt ? fmtDt(lastOfflineAt) : 'جارٍ الحفظ…'}</span>
            </div>
            {!isInstalled && (
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn sm pri" onClick={promptInstall}>
                  <Download size={14} />
                  <span>تثبيت CIPHER X PRO على الهاتف / الكمبيوتر</span>
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h3>متقدم وتشخيص الاتصال</h3>
            <label className="f">REST Base</label>
            <input
              style={{ direction: 'ltr' }}
              value={s.apiBase}
              onChange={(e) => commitUpdate({ apiBase: e.target.value.trim() })}
            />
            <label className="f">WebSocket Base</label>
            <input
              style={{ direction: 'ltr' }}
              value={s.wsBase}
              onChange={(e) => commitUpdate({ wsBase: e.target.value.trim() })}
            />
            <div className="row wrap" style={{ marginTop: 10, marginBottom: 12 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  onModeChanged();
                  engine.reboot();
                }}
              >
                حفظ وإعادة الاتصال
              </button>
              {confirmReset ? (
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn sm red"
                    onClick={() => {
                      engine.resetSettings();
                      const next = { ...engine.getSettings() };
                      setS(next);
                      pushToServerNow(next, true);
                      setConfirmReset(false);
                      onToast('تمت استعادة كافة الإعدادات الافتراضية ✔', 'info');
                    }}
                  >
                    تأكيد الاستعادة الشاملة
                  </button>
                  <button type="button" className="btn sm" onClick={() => setConfirmReset(false)}>
                    إلغاء
                  </button>
                </div>
              ) : (
                <button type="button" className="btn sm red" onClick={() => setConfirmReset(true)}>
                  استعادة كافة الافتراضيات
                </button>
              )}
            </div>

            <div className="kv">
              <span>REST ناجح / فاشل</span>
              <span className="num">
                {a.ok} / {a.fail}
              </span>
            </div>
            <div className="kv">
              <span>الوزن المستهلك (دقيقة)</span>
              <span className="num">{Math.round(a.used)} / 2400</span>
            </div>
            <div className="kv">
              <span>آخر خطأ</span>
              <span className="num">{a.lastErr || '—'}</span>
            </div>
            <div className="kv">
              <span>حظر مؤقت</span>
              <span className="num">
                {nowMs > 0 && nowMs < a.banUntil ? fmtCountdown(a.banUntil - nowMs) : 'لا'}
              </span>
            </div>
            <div className="kv">
              <span>WebSocket /market & /public</span>
              <span className="num">
                {f.market} / {f.public}
              </span>
            </div>
            <div className="kv">
              <span>دورات المسح / الأخطاء</span>
              <span className="num">
                {sc.cycles} / {sc.errors}
              </span>
            </div>
            <div className="kv">
              <span>انحراف ساعة الخادم</span>
              <span className="num">{Math.round(a.offset)} ms</span>
            </div>
            <div className="kv">
              <span>الإشارات المخزنة</span>
              <span className="num">{engine.getSignals().length}</span>
            </div>
          </div>

          <div className="card">
            <h3>تنبيه المخاطر</h3>
            <div className="hint" style={{ lineHeight: 1.9 }}>
              هذه أداة تحليل وتداول تجريبي (Paper Trading) بدون أي أموال حقيقية أو أوامر فعلية على
              Binance. التداول بالرافعة في عقود Futures عالي المخاطر؛ اختبر دائماً على صفحة «الأداء»
              و«المحفظة التجريبية» قبل أي قرار حقيقي.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
