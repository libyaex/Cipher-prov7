'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Brain, Download, RefreshCw, RotateCcw } from 'lucide-react';
import { stats as calcBtStats } from '@/lib/cx-engine/backtest';
import { isN } from '@/lib/cx-engine/indicators';
import type {
  EarlyEntryWeights,
  SimulatedTrade,
  StrategyPerformanceReport,
  StrategyWeightSnapshot,
} from '@/lib/cx-engine/types';
import { downloadCsv, downloadJson } from '@/lib/client/export';
import { clsPnL, fmtDt, OUT_MAP, REG_MAP, shortSym } from '@/lib/client/formatters';
import type { CipherClientEngine } from '@/lib/client/market-engine';

interface PerformanceTabProps {
  engine: CipherClientEngine;
  onToast: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  onWeightsUpdated?: () => void;
}

function wilson(w: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const a = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(100 * (c - a)) / d, (100 * (c + a)) / d];
}

function tstat(trades: SimulatedTrade[]): number {
  const a = trades.filter((t) => t.status === 'CLOSED' && isN(t.R)).map((t) => t.R as number);
  const n = a.length;
  if (n < 3) return NaN;
  const m = a.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1));
  return sd ? m / (sd / Math.sqrt(n)) : NaN;
}

function EquityCurveSvg({ curve }: { curve: { t: number | null; v: number }[] }) {
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  if (!curve || curve.length < 2) {
    return (
      <div className="hint" style={{ textAlign: 'center', padding: 14 }}>
        لا بيانات كافية للمنحنى
      </div>
    );
  }
  const W = 640;
  const H = 164;
  const vs = curve.map((c) => c.v);
  const mn = Math.min(0, ...vs);
  const mx = Math.max(0, ...vs);
  const peak = Math.max(...vs);
  const pad = 12;
  const sx = (i: number) => pad + (i / (curve.length - 1)) * (W - 2 * pad);
  const sy = (v: number) => pad + ((mx - v) / (mx - mn || 1)) * (H - 2 * pad);
  const pts = curve.map((c, i) => `${sx(i).toFixed(1)},${sy(c.v).toFixed(1)}`).join(' ');
  const last = vs[vs.length - 1];
  const col = last >= 0 ? '#00ff88' : '#ff2d55';
  const y0 = sy(0);
  const areaPts = `${sx(0).toFixed(1)},${y0.toFixed(1)} ${pts} ${sx(curve.length - 1).toFixed(1)},${y0.toFixed(1)}`;
  const activePt = selectedIdx != null && curve[selectedIdx] ? curve[selectedIdx] : null;

  return (
    <div>
      <div className="row sb hint num" style={{ marginBottom: 4 }}>
        <span>
          {activePt
            ? `نقطة #${selectedIdx}: ${activePt.v >= 0 ? '+' : ''}${activePt.v.toFixed(2)}R${activePt.t ? ` · ${fmtDt(activePt.t)}` : ''}`
            : `عدد الصفقات: ${curve.length - 1}`}
        </span>
        <span>
          القمة: <b className="pos">+{peak.toFixed(2)}R</b> · النهاية:{' '}
          <b className={last >= 0 ? 'pos' : 'neg'}>
            {last >= 0 ? '+' : ''}
            {last.toFixed(2)}R
          </b>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: '100%',
          height: 164,
          background: '#04101c',
          border: '1px solid var(--bd)',
          borderRadius: 10,
        }}
        onMouseLeave={() => setSelectedIdx(null)}
      >
        <line
          x1={pad}
          x2={W - pad}
          y1={y0}
          y2={y0}
          stroke="rgba(122,155,191,.35)"
          strokeDasharray="4 4"
        />
        <polygon
          points={areaPts}
          fill={last >= 0 ? 'rgba(0, 255, 136, 0.08)' : 'rgba(255, 45, 85, 0.08)'}
        />
        <polyline points={pts} fill="none" stroke={col} strokeWidth={2} />
        {curve.map((c, i) => (
          <circle
            key={i}
            cx={sx(i)}
            cy={sy(c.v)}
            r={selectedIdx === i ? 4.5 : 2.5}
            fill={selectedIdx === i ? '#fff' : col}
            opacity={selectedIdx === i || curve.length <= 35 ? 0.9 : 0}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setSelectedIdx(i)}
            onClick={() => setSelectedIdx(i)}
          />
        ))}
        <text
          x={W - pad}
          y={Math.max(16, sy(last) - 8)}
          textAnchor="end"
          fill={col}
          fontFamily="IBM Plex Mono"
          fontSize="12"
        >
          {last >= 0 ? '+' : ''}
          {last.toFixed(1)}R
        </text>
      </svg>
    </div>
  );
}

export default function PerformanceTab({ engine, onToast, onWeightsUpdated }: PerformanceTabProps) {
  const [tab, setTab] = useState<'live' | 'analytics' | 'bt'>('live');
  const [btSym, setBtSym] = useState<string>(
    engine.storeState.active || engine.storeState.universe[0] || 'BTCUSDT'
  );
  const [btDays, setBtDays] = useState<number>(60);
  const [btRunning, setBtRunning] = useState(false);
  const [btProg, setBtProg] = useState(0);
  const [btRes, setBtRes] = useState<{ sym: string; days: number; res: any } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [tradeFilter, setTradeFilter] = useState<'all' | 'win' | 'loss' | 'smart'>('all');
  const [showAllTrades, setShowAllTrades] = useState(false);

  const [anLoading, setAnLoading] = useState(false);
  const [anReport, setAnReport] = useState<StrategyPerformanceReport | null>(null);
  const [anWeightsHist, setAnWeightsHist] = useState<StrategyWeightSnapshot[]>([]);
  const [activeWeights, setActiveWeights] = useState<EarlyEntryWeights | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setAnLoading(true);
    try {
      const r = await fetch('/api/analytics', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok) {
        setAnReport(j.report || null);
        setAnWeightsHist(j.weightsHistory || []);
        setActiveWeights(j.activeWeights || null);
      }
    } catch {
      // ignore offline
    } finally {
      setAnLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'analytics') return;
    const t = setTimeout(() => {
      void fetchAnalytics();
    }, 0);
    return () => clearTimeout(t);
  }, [tab, fetchAnalytics]);

  const handleApplyProposal = async (allowManualOverride = false) => {
    setAnLoading(true);
    try {
      const r = await fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply_weights', allowManualOverride }),
      });
      const j = await r.json();
      if (j?.ok) {
        setAnReport(j.report || null);
        setAnWeightsHist(j.weightsHistory || []);
        setActiveWeights(j.activeWeights || null);
        onToast(`تم تطبيق أوزان النسخة v${j.snapshot?.version} ✔`, 'info');
        onWeightsUpdated?.();
      } else {
        onToast(j?.error || 'تعذر تطبيق الأوزان', 'bad');
      }
    } finally {
      setAnLoading(false);
    }
  };

  const handleRollbackWeights = async (targetVersion?: number) => {
    setAnLoading(true);
    try {
      const r = await fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback_weights', targetVersion }),
      });
      const j = await r.json();
      if (j?.ok) {
        setAnReport(j.report || null);
        setAnWeightsHist(j.weightsHistory || []);
        setActiveWeights(j.activeWeights || null);
        onToast('تم التراجع إلى النسخة السابقة من الأوزان ✔', 'info');
        onWeightsUpdated?.();
      } else {
        onToast(j?.error || 'تعذر التراجع', 'bad');
      }
    } finally {
      setAnLoading(false);
    }
  };

  const S = engine.storeState;
  const uni = S.universe.length ? S.universe : [S.active || 'BTCUSDT'];
  const cfg = engine.getSettings();
  const [btSmartShield, setBtSmartShield] = useState<boolean>(cfg.smartProfitShield !== false);
  const [btSmartTp, setBtSmartTp] = useState<boolean>(cfg.smartTakeProfitEnabled !== false);

  const renderStatsBlock = (trades: SimulatedTrade[], label: string) => {
    const s = calcBtStats(trades);
    const n = s.n;
    if (!n) return <div className="empty">لا صفقات مغلقة {label} بعد.</div>;
    const [lo, hi] = wilson(s.wins, n);
    const t = tstat(trades);

    return (
      <>
        <div className="grid g4" style={{ gap: 8 }}>
          <div className="tile">
            <div className="l">الصفقات</div>
            <div className="v">{n}</div>
          </div>
          <div className="tile">
            <div className="l">نسبة الفوز</div>
            <div className={`v ${s.winRate >= 50 ? 'pos' : ''}`}>{s.winRate.toFixed(1)}%</div>
          </div>
          <div className="tile">
            <div className="l">متوسط R / صفقة</div>
            <div className={`v ${clsPnL(s.avgR)}`}>
              {s.avgR >= 0 ? '+' : ''}
              {s.avgR.toFixed(3)}
            </div>
          </div>
          <div className="tile">
            <div className="l">Profit Factor</div>
            <div className={`v ${s.pf >= 1 ? 'pos' : 'neg'}`}>
              {Number.isFinite(s.pf) ? s.pf.toFixed(2) : '∞'}
            </div>
          </div>
          <div className="tile">
            <div className="l">إجمالي R (صافي)</div>
            <div className={`v ${clsPnL(s.sumR)}`}>
              {s.sumR >= 0 ? '+' : ''}
              {s.sumR.toFixed(1)}
            </div>
          </div>
          <div className="tile">
            <div className="l">أقصى تراجع</div>
            <div className="v neg">-{s.maxDD.toFixed(1)}R</div>
          </div>
          <div className="tile">
            <div className="l">متوسط ربح / خسارة</div>
            <div className="v">
              {isN(s.avgWin) ? `+${s.avgWin.toFixed(2)}` : '—'} /{' '}
              {isN(s.avgLoss) ? s.avgLoss.toFixed(2) : '—'}
            </div>
          </div>
          <div className="tile">
            <div className="l">وصول TP1</div>
            <div className="v">{s.tp1Rate.toFixed(0)}%</div>
          </div>
        </div>

        <div className="grid g4" style={{ gap: 8, marginTop: 8 }}>
          <div className="tile">
            <div className="l">التوقع الرياضي (Expectancy)</div>
            <div className={`v ${clsPnL(s.expectancy)}`}>
              {isN(s.expectancy) ? `${s.expectancy >= 0 ? '+' : ''}${s.expectancy.toFixed(3)}R` : '—'}
            </div>
          </div>
          <div className="tile">
            <div className="l">Sharpe / Sortino</div>
            <div className="v" style={{ fontSize: 13.5 }}>
              {isN(s.sharpe) ? s.sharpe.toFixed(2) : '—'} /{' '}
              {isN(s.sortino) ? s.sortino.toFixed(2) : '—'}
            </div>
          </div>
          <div className="tile">
            <div className="l">Calmar / تتابع</div>
            <div className="v" style={{ fontSize: 13.5 }}>
              {Number.isFinite(s.calmar) ? s.calmar.toFixed(2) : isN(s.calmar) ? '∞' : '—'} ·{' '}
              <span className="pos">+{s.maxWinStreak}</span>/<span className="neg">-{s.maxLossStreak}</span>
            </div>
          </div>
          <div className="tile">
            <div className="l">متوسط MFE / MAE</div>
            <div className="v" style={{ fontSize: 13.5 }}>
              <span className="pos">+{isN(s.avgMfe) ? s.avgMfe.toFixed(2) : '0'}R</span> /{' '}
              <span className="neg">-{isN(s.avgMae) ? s.avgMae.toFixed(2) : '0'}R</span>
            </div>
          </div>
        </div>

        <div style={{ margin: '10px 0' }}>
          {n < 30 ? (
            <div className="warn">
              عينة صغيرة ({n} صفقة): النسب أدناه غير موثوقة إحصائياً. نسبة الفوز الحقيقية قد تقع
              بين {lo.toFixed(0)}% و{hi.toFixed(0)}% (ثقة 95%).
            </div>
          ) : isN(t) && Math.abs(t) < 2 ? (
            <div className="warn">
              النتيجة غير دالّة إحصائياً (t={t.toFixed(2)}): لا يمكن الجزم بوجود ميزة تداولية.
            </div>
          ) : (
            <div className="hint">
              فاصل ثقة نسبة الفوز 95%: {lo.toFixed(0)}%–{hi.toFixed(0)}% · t=
              {isN(t) ? t.toFixed(2) : '—'} · صافي أثر التمويل التراكمي:{' '}
              {-s.totalFundingR >= 0 ? '+' : ''}
              {(-s.totalFundingR).toFixed(2)}R
            </div>
          )}
        </div>

        <EquityCurveSvg curve={s.curve} />

        <div className="grid g2" style={{ marginTop: 10, gap: 8 }}>
          <div className="tile">
            <div className="l">LONG</div>
            <div className="v">
              {s.long ? `${s.long.n} · ${s.long.winRate.toFixed(0)}% · ${s.long.avgR.toFixed(2)}R` : '—'}
            </div>
          </div>
          <div className="tile">
            <div className="l">SHORT</div>
            <div className="v">
              {s.short
                ? `${s.short.n} · ${s.short.winRate.toFixed(0)}% · ${s.short.avgR.toFixed(2)}R`
                : '—'}
            </div>
          </div>
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          النتائج:{' '}
          {Object.entries(s.outcomes)
            .map(([k, v]) => `${OUT_MAP[k] || k}: ${v}`)
            .join(' · ')}
        </div>

        {Object.keys(s.byRegime || {}).length > 0 && (
          <>
            <div className="sep" />
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
              تفصيل الأداء حسب نظام السوق (Market Regime)
            </div>
            <div className="tblw">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>النظام</th>
                    <th>الصفقات</th>
                    <th>نسبة الفوز</th>
                    <th>متوسط R</th>
                    <th>الإجمالي R</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(s.byRegime).map(([reg, rs]) => (
                    <tr key={reg}>
                      <td>{REG_MAP[reg] || reg}</td>
                      <td className="num">{rs.n}</td>
                      <td className="num">{rs.winRate.toFixed(0)}%</td>
                      <td className={`num ${clsPnL(rs.avgR)}`}>{rs.avgR >= 0 ? '+' : ''}{rs.avgR.toFixed(2)}</td>
                      <td className={`num ${clsPnL(rs.sumR)}`}>{rs.sumR >= 0 ? '+' : ''}{rs.sumR.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {s.buckets.length > 0 && (
          <>
            <div className="sep" />
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
              معايرة الدرجة: هل الدرجة الأعلى أفضل فعلاً؟
            </div>
            <div className="tblw">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>الدرجة</th>
                    <th>صفقات</th>
                    <th>فوز%</th>
                    <th>متوسط R</th>
                  </tr>
                </thead>
                <tbody>
                  {s.buckets.map((b) => (
                    <tr key={b.name}>
                      <td>{b.name}</td>
                      <td className="num">{b.n}</td>
                      <td className="num">{b.winRate.toFixed(0)}%</td>
                      <td className={`num ${clsPnL(b.avgR)}`}>{b.avgR.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </>
    );
  };

  const renderTradesTable = (trades: SimulatedTrade[], singleSym = false) => {
    const allClosed = trades.filter((t) => t.status === 'CLOSED');
    if (!allClosed.length) return null;
    const filtered = allClosed.filter((t) => {
      if (tradeFilter === 'win') return (t.R || 0) > 0;
      if (tradeFilter === 'loss') return (t.R || 0) < 0;
      if (tradeFilter === 'smart')
        return (
          t.outcome === 'SMART_EXIT' ||
          t.outcome === 'SMART_PARTIAL_TP' ||
          t.outcome === 'TRAIL_PROFIT' ||
          Boolean(t.meta?.smartTpPartialDone)
        );
      return true;
    });
    const done = (showAllTrades ? filtered : filtered.slice(-40)).slice().reverse();

    return (
      <div style={{ marginTop: 10 }}>
        <div className="row sb wrap" style={{ marginBottom: 8 }}>
          <div className="chips">
            {(
              [
                ['all', `الكل (${allClosed.length})`],
                ['win', 'رابحة'],
                ['loss', 'خاسرة'],
                ['smart', 'خروج / جني ذكي'],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={`chip ${tradeFilter === k ? 'on' : ''}`}
                onClick={() => setTradeFilter(k)}
              >
                {lbl}
              </button>
            ))}
          </div>
          {filtered.length > 40 && (
            <button
              type="button"
              className="btn sm"
              onClick={() => setShowAllTrades((v) => !v)}
            >
              {showAllTrades ? 'عرض آخر 40' : `عرض الكل (${filtered.length})`}
            </button>
          )}
        </div>
        {!done.length ? (
          <div className="empty" style={{ padding: 12 }}>
            لا توجد صفقات مطابقة للفلتر.
          </div>
        ) : (
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الوقت</th>
                  {!singleSym && <th>الرمز</th>}
                  <th></th>
                  <th>الدرجة</th>
                  <th>الدخول</th>
                  <th>النظام</th>
                  <th>R الصافي</th>
                  <th>النتيجة</th>
                </tr>
              </thead>
              <tbody>
                {done.map((t) => (
                  <tr key={t.id}>
                    <td className="dim">{fmtDt(t.tFill || t.t0)}</td>
                    {!singleSym && (
                      <td>
                        <span className="sym">{shortSym(t.sym)}</span>
                      </td>
                    )}
                    <td>
                      <span className={`b ${t.dir > 0 ? 'b-long' : 'b-short'}`}>
                        {t.dir > 0 ? 'LONG' : 'SHORT'}
                      </span>
                    </td>
                    <td className="num">{t.score}</td>
                    <td className="num">{t.type === 'MARKET' ? 'سوقي' : 'Limit'}</td>
                    <td>{t.regime ? REG_MAP[t.regime] || t.regime : '—'}</td>
                    <td className={`num ${clsPnL(t.R)}`}>
                      {isN(t.R) ? `${(t.R as number) >= 0 ? '+' : ''}${(t.R as number).toFixed(2)}` : '—'}
                    </td>
                    <td className="out">{OUT_MAP[t.outcome || ''] || t.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const handleRunBt = async () => {
    if (btRunning) return;
    setBtRunning(true);
    setBtProg(0);
    try {
      const res = await engine.runSymbolBacktest(
        btSym,
        btDays,
        (p) => setBtProg(p),
        btSmartShield,
        btSmartTp
      );
      setBtRes({ sym: btSym, days: btDays, res });
    } catch (err: any) {
      onToast(`فشل الباكتيست: ${err?.message || err}`, 'bad');
    } finally {
      setBtRunning(false);
    }
  };

  const allSignals = engine.getSignals();

  const exportTrades = (list: SimulatedTrade[], label: string, fmt: 'csv' | 'json') => {
    const closed = list.filter((t) => t.status === 'CLOSED');
    if (!closed.length) {
      onToast('لا توجد صفقات مغلقة للتصدير', 'bad');
      return;
    }
    if (fmt === 'json') {
      downloadJson(`cipherx-${label}-${new Date().toISOString().slice(0, 10)}.json`, closed);
      onToast('تم التصدير بصيغة JSON ✔', 'info');
      return;
    }
    const headers = ['ID', 'Symbol', 'Side', 'Tier', 'Score', 'Type', 'Entry', 'Stop', 'Exit', 'NetR', 'FundingR', 'MFE_R', 'MAE_R', 'Regime', 'OOS', 'Outcome', 'TimeFill', 'TimeEnd'];
    const rows = closed.map((t) => [
      t.id,
      t.sym,
      t.dir > 0 ? 'LONG' : 'SHORT',
      t.tier,
      t.score,
      t.type,
      t.entry,
      t.stopCur,
      t.exitPrice ?? '',
      t.R != null ? Number(t.R.toFixed(3)) : '',
      Number((t.fundingR || 0).toFixed(4)),
      Number((t.maxFav || 0).toFixed(2)),
      Number((t.maxAdv || 0).toFixed(2)),
      t.regime || '',
      t.isOos ? 'OOS' : 'IS',
      t.outcome || '',
      t.tFill ? new Date(t.tFill).toISOString() : '',
      t.tEnd ? new Date(t.tEnd).toISOString() : '',
    ]);
    downloadCsv(`cipherx-${label}-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    onToast('تم التصدير بصيغة CSV ✔', 'info');
  };

  return (
    <div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
          الإشارات الفعلية
        </button>
        <button
          type="button"
          className={tab === 'analytics' ? 'on' : ''}
          onClick={() => setTab('analytics')}
        >
          تحليل وتطور المحرك
        </button>
        <button type="button" className={tab === 'bt' ? 'on' : ''} onClick={() => setTab('bt')}>
          الباكتيست (Walk-Forward)
        </button>
      </div>

      {tab === 'analytics' ? (
        <div>
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 10 }}>
              <div className="row">
                <Brain size={17} color="var(--cyan)" />
                <h3 style={{ margin: 0 }}>تقييم الإشارات وتحسين الأوزان (Analytics & Walk-Forward)</h3>
              </div>
              <button
                type="button"
                className="btn sm"
                disabled={anLoading}
                onClick={fetchAnalytics}
              >
                <RefreshCw size={13} />
                <span>{anLoading ? 'جارٍ التحديث…' : 'تحديث التحليل'}</span>
              </button>
            </div>

            {!anReport ? (
              <div className="empty">جارٍ تحميل بيانات التحليل…</div>
            ) : (
              <>
                <div className="grid g4" style={{ gap: 8 }}>
                  <div className="tile">
                    <div className="l">إجمالي الإشارات / المنفذة</div>
                    <div className="v">
                      {anReport.totalSignals} / {anReport.totalTaken}
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">نسبة الفوز (Win Rate)</div>
                    <div className={`v ${anReport.winRate >= 50 ? 'pos' : ''}`}>
                      {anReport.winRate.toFixed(1)}%
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">Profit Factor</div>
                    <div className={`v ${anReport.profitFactor >= 1.1 ? 'pos' : 'neg'}`}>
                      {Number.isFinite(anReport.profitFactor) ? anReport.profitFactor.toFixed(2) : '∞'}
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">التوقع (Expectancy)</div>
                    <div className={`v ${clsPnL(anReport.expectancyR)}`}>
                      {anReport.expectancyR >= 0 ? '+' : ''}
                      {anReport.expectancyR.toFixed(3)}R
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">أقصى تراجع (Max DD)</div>
                    <div className="v neg">-{anReport.maxDrawdownPct.toFixed(2)}%</div>
                  </div>
                  <div className="tile">
                    <div className="l">نسبة الدخول المتأخر</div>
                    <div className={`v ${anReport.lateEntryPct > 30 ? 'neg' : 'cy'}`}>
                      {anReport.lateEntryPct.toFixed(1)}%
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">الفرص الفائتة (Missed)</div>
                    <div className="v">{anReport.missedMoveRate.toFixed(1)}%</div>
                  </div>
                  <div className="tile">
                    <div className="l">صفقات مغلقة بالتحليل</div>
                    <div className="v">{anReport.closedTrades}</div>
                  </div>
                </div>

                {/* EARLY_ENTRY vs CONFIRMED_ENTRY Comparison */}
                <div className="sep" />
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                  مقارنة الأداء: الدخول المبكر (EARLY_ENTRY) مقابل المؤكد (CONFIRMED_ENTRY)
                </div>
                <div className="grid g2" style={{ gap: 10 }}>
                  {[anReport.earlyVsConfirmed.early, anReport.earlyVsConfirmed.confirmed].map((b) => (
                    <div key={b.key} className="tile">
                      <div className="row sb" style={{ marginBottom: 6 }}>
                        <b className="cy">{b.key === 'EARLY_ENTRY' ? '⚡ EARLY ENTRY' : '✔ CONFIRMED ENTRY'}</b>
                        <span className="num hint">{b.closedCount} مغلقة / {b.count} إشارة</span>
                      </div>
                      <div className="kv">
                        <span>نسبة الفوز</span>
                        <span className="num">{b.winRate.toFixed(1)}%</span>
                      </div>
                      <div className="kv">
                        <span>Profit Factor / Expectancy</span>
                        <span className={`num ${clsPnL(b.expectancyR)}`}>
                          {Number.isFinite(b.profitFactor) ? b.profitFactor.toFixed(2) : '∞'} ·{' '}
                          {b.expectancyR >= 0 ? '+' : ''}
                          {b.expectancyR.toFixed(2)}R
                        </span>
                      </div>
                      <div className="kv">
                        <span>متوسط التحرك / الدخول المتأخر</span>
                        <span className="num">
                          {b.avgDistanceMovedPct.toFixed(2)}% · {b.lateEntryRate.toFixed(0)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {anReport.byStrategy.length > 0 && (
                  <>
                    <div className="sep" />
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                      الأداء حسب الاستراتيجية
                    </div>
                    <div className="tblw">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>الاستراتيجية</th>
                            <th>إشارات / مغلقة</th>
                            <th>فوز %</th>
                            <th>PF</th>
                            <th>متوسط R</th>
                            <th>الصافي $</th>
                          </tr>
                        </thead>
                        <tbody>
                          {anReport.byStrategy.map((row) => (
                            <tr key={row.key}>
                              <td>{row.label}</td>
                              <td className="num">{row.count} / {row.closedCount}</td>
                              <td className="num">{row.winRate.toFixed(1)}%</td>
                              <td className="num">{Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : '∞'}</td>
                              <td className={`num ${clsPnL(row.avgNetR)}`}>{row.avgNetR >= 0 ? '+' : ''}{row.avgNetR.toFixed(2)}R</td>
                              <td className={`num ${clsPnL(row.totalPnlUsdt)}`}>{row.totalPnlUsdt >= 0 ? '+' : ''}{row.totalPnlUsdt.toFixed(2)}$</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {anReport.lossCauses.length > 0 && (
                  <>
                    <div className="sep" />
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                      تحليل أسباب الخسائر الشائعة
                    </div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {anReport.lossCauses.map((lc) => (
                        <span key={lc.reason} className="b b-pend">
                          {lc.reason}: {lc.count} ({lc.pct.toFixed(0)}%)
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Adaptive Weight Tuning Card */}
          <div className="card">
            <div className="row sb wrap" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>محرك تحسين أوزان الدخول المبكر (Safe Walk-Forward Tuning)</h3>
              {anReport?.proposal && (
                <span className={`b ${anReport.proposal.walkForwardPassed ? 'b-open' : 'b-watch'}`}>
                  {anReport.proposal.sufficientSample
                    ? anReport.proposal.walkForwardPassed
                      ? 'اجتاز Walk-Forward OOS'
                      : 'لم يتفوق على الأساس'
                    : `عينة ${anReport.proposal.sampleCount}/${anReport.proposal.minSampleRequired}`}
                </span>
              )}
            </div>

            {activeWeights && (
              <div className="grid g3" style={{ gap: 6, marginBottom: 10 }}>
                <div className="tile">
                  <div className="l">جودة المنطقة (Zone)</div>
                  <div className="v">{activeWeights.zoneQuality}</div>
                </div>
                <div className="tile">
                  <div className="l">كسر الهيكل (CHoCH/BOS)</div>
                  <div className="v">{activeWeights.structureShift}</div>
                </div>
                <div className="tile">
                  <div className="l">الزخم والحجم (RVOL/Delta)</div>
                  <div className="v">{activeWeights.momentumVolume}</div>
                </div>
                <div className="tile">
                  <div className="l">السيولة (Sweep/Book)</div>
                  <div className="v">{activeWeights.liquidityConfirm}</div>
                </div>
                <div className="tile">
                  <div className="l">توافق الأطر (MTF)</div>
                  <div className="v">{activeWeights.mtfAlignment}</div>
                </div>
                <div className="tile">
                  <div className="l">جودة الوقف و R:R</div>
                  <div className="v">{activeWeights.stopRrQuality}</div>
                </div>
              </div>
            )}

            {anReport?.proposal && (
              <div className={anReport.proposal.sufficientSample ? 'tile' : 'warn'} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {anReport.proposal.expectedImprovementNote}
                </div>
                <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
                  {anReport.proposal.reasons.map((rs, idx) => (
                    <li key={idx}>{rs}</li>
                  ))}
                </ul>
                {anReport.proposal.walkForwardBaselinePF != null && (
                  <div className="hint num" style={{ marginTop: 6 }}>
                    Walk-Forward PF: Baseline {anReport.proposal.walkForwardBaselinePF} → Proposed{' '}
                    {anReport.proposal.walkForwardProposedPF}
                  </div>
                )}
              </div>
            )}

            <div className="row wrap" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn sm pri"
                disabled={anLoading || !anReport?.proposal?.sufficientSample}
                onClick={() => handleApplyProposal(false)}
              >
                تطبيق الأوزان المقترحة (مع حفظ النسخة)
              </button>
              {anWeightsHist.length >= 2 && (
                <button
                  type="button"
                  className="btn sm red"
                  disabled={anLoading}
                  onClick={() => handleRollbackWeights()}
                >
                  <RotateCcw size={13} />
                  <span>التراجع إلى النسخة السابقة</span>
                </button>
              )}
            </div>

            {anWeightsHist.length > 0 && (
              <>
                <div className="sep" />
                <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
                  سجل نسخ الأوزان المحفوظة (Versioning & Rollback)
                </div>
                <div className="tblw">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>النسخة</th>
                        <th>الحالة</th>
                        <th>الملاحظة</th>
                        <th>التاريخ</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {anWeightsHist.slice(0, 8).map((snap) => (
                        <tr key={snap.id}>
                          <td className="num">v{snap.version}</td>
                          <td>
                            <span className={`b ${snap.isActive ? 'b-open' : 'b-watch'}`}>
                              {snap.isActive ? 'نشطة' : 'سابقة'}
                            </span>
                          </td>
                          <td className="out">{snap.note}</td>
                          <td className="dim">{fmtDt(snap.createdAt)}</td>
                          <td>
                            {!snap.isActive && (
                              <button
                                type="button"
                                className="btn sm"
                                disabled={anLoading}
                                onClick={() => handleRollbackWeights(snap.version)}
                              >
                                استعادة
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      ) : tab === 'live' ? (
        <div className="card">
          <div className="row sb wrap" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>
              أداء الإشارات الفعلية
              <span className="sub">بشموع 1د وبترتيب متحفظ بدون إعادة رسم</span>
            </h3>
            {allSignals.some((t) => t.status === 'CLOSED') && (
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => exportTrades(allSignals, 'live-signals', 'csv')}
                >
                  <Download size={12} />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => exportTrades(allSignals, 'live-signals', 'json')}
                >
                  <Download size={12} />
                  <span>JSON</span>
                </button>
              </div>
            )}
          </div>
          {renderStatsBlock(allSignals, '')}
          {renderTradesTable(allSignals)}
          <div className="row" style={{ marginTop: 12 }}>
            {confirmClear ? (
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm red"
                  onClick={() => {
                    engine.clearSignals();
                    setConfirmClear(false);
                    onToast('تم مسح سجل الإشارات', 'info');
                  }}
                >
                  تأكيد المسح الكامل
                </button>
                <button type="button" className="btn sm" onClick={() => setConfirmClear(false)}>
                  إلغاء
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn sm red"
                onClick={() => setConfirmClear(true)}
              >
                مسح السجل
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h3>
              باكتيست حقيقي + Walk-Forward Out-of-Sample
              <span className="sub">دخول افتتاح الشمعة التالية · تمويل تاريخي · بدون بيانات مستقبلية</span>
            </h3>
            <div className="row wrap">
              <select
                value={btSym}
                onChange={(e) => setBtSym(e.target.value)}
                style={{ maxWidth: 160 }}
              >
                {uni.map((s) => (
                  <option key={s} value={s}>
                    {shortSym(s)}/USDT
                  </option>
                ))}
              </select>
              <select
                value={btDays}
                onChange={(e) => setBtDays(Number(e.target.value))}
                style={{ maxWidth: 130 }}
              >
                {[14, 30, 60, 90, 120].map((d) => (
                  <option key={d} value={d}>
                    {d} يوم
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn pri"
                disabled={btRunning}
                onClick={handleRunBt}
              >
                {btRunning ? 'جارٍ الاختبار…' : 'تشغيل الباكتيست'}
              </button>
            </div>

            <div className="tog" style={{ marginTop: 10 }}>
              <span>درع حماية الأرباح الذكي (قفل أرباح القمة + خروج شمعة الانعكاس)</span>
              <div
                className={`sw ${btSmartShield ? 'on' : ''}`}
                onClick={() => setBtSmartShield((v) => !v)}
              />
            </div>

            <div className="tog" style={{ marginTop: 8 }}>
              <span>جني الأرباح الذكي قبل الأهداف (إغلاق جزئي/كامل عند ضعف الزخم وانعكاس الشموع)</span>
              <div
                className={`sw ${btSmartTp ? 'on' : ''}`}
                onClick={() => setBtSmartTp((v) => !v)}
              />
            </div>

            {btRunning && (
              <div className="bar" style={{ marginTop: 10 }}>
                <i style={{ width: `${(btProg * 100).toFixed(0)}%`, background: 'var(--cyan)' }} />
              </div>
            )}

            <div className="hint" style={{ marginTop: 8 }}>
              الافتراضات الواقعية المصحّحة: تنفيذ MARKET عند افتتاح الشمعة التالية مع الانزلاق (
              {(cfg.slip * 100).toFixed(3)}%) + رسوم ({(cfg.takerFee * 100).toFixed(3)}%) + تسوية
              التمويل التاريخي كل 8 ساعات + سياق BTC الماكرو +{' '}
              {btSmartShield || btSmartTp
                ? `${btSmartShield ? 'درع حماية الأرباح الذكي' : ''}${btSmartShield && btSmartTp ? ' + ' : ''}${btSmartTp ? `جني الأرباح الذكي (${cfg.smartTakeProfitSensitivity === 'aggressive' ? 'سريع' : cfg.smartTakeProfitSensitivity === 'conservative' ? 'متحفظ' : 'متوازن'}، جزئي ${cfg.smartTakeProfitPartialPct}%)` : ''}.`
                : 'نقل الوقف إلى التعادل الصافي بعد TP1 فقط.'}
            </div>
          </div>

          {btRes ? (
            <>
              {btRes.res.walkForward && (
                <div className="card">
                  <div className="row sb wrap" style={{ marginBottom: 8 }}>
                    <h3 style={{ margin: 0 }}>اختبار الخروج من العينة (Walk-Forward 65% / 35%)</h3>
                    <span className={`b ${btRes.res.walkForward.degraded ? 'b-pend' : 'b-open'}`}>
                      {btRes.res.walkForward.degraded ? 'تراجع في OOS' : 'ثبات Out-of-Sample'}
                    </span>
                  </div>
                  <div className="grid g2" style={{ gap: 8 }}>
                    <div className="tile">
                      <div className="l">العينة الداخلية In-Sample (65%)</div>
                      <div className="v" style={{ fontSize: 13.5 }}>
                        {btRes.res.walkForward.inSample.n} صفقة ·{' '}
                        {btRes.res.walkForward.inSample.n
                          ? `${btRes.res.walkForward.inSample.winRate.toFixed(0)}% فوز · ${btRes.res.walkForward.inSample.sumR >= 0 ? '+' : ''}${btRes.res.walkForward.inSample.sumR.toFixed(1)}R`
                          : '—'}
                      </div>
                    </div>
                    <div className="tile">
                      <div className="l">خارج العينة Out-of-Sample (35%)</div>
                      <div className="v" style={{ fontSize: 13.5 }}>
                        {btRes.res.walkForward.outOfSample.n} صفقة ·{' '}
                        {btRes.res.walkForward.outOfSample.n
                          ? `${btRes.res.walkForward.outOfSample.winRate.toFixed(0)}% فوز · ${btRes.res.walkForward.outOfSample.sumR >= 0 ? '+' : ''}${btRes.res.walkForward.outOfSample.sumR.toFixed(1)}R`
                          : '—'}
                      </div>
                    </div>
                  </div>
                  <div className={btRes.res.walkForward.degraded ? 'warn' : 'hint'} style={{ marginTop: 8 }}>
                    {btRes.res.walkForward.note} · نقطة الانقسام: {fmtDt(btRes.res.walkForward.splitTs)}
                  </div>
                </div>
              )}

              <div className="card">
                <div className="row sb wrap" style={{ marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>
                    نتيجة {shortSym(btRes.sym)} — {btRes.days} يوماً
                    <span className="sub">
                      {btRes.res.bars} شمعة · {btRes.res.evals} تقييم ·{' '}
                      {(btRes.res.ms / 1000).toFixed(1)}ث
                    </span>
                  </h3>
                  {btRes.res.trades.length > 0 && (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => exportTrades(btRes.res.trades, `backtest-${btRes.sym}`, 'csv')}
                      >
                        <Download size={12} />
                        <span>CSV</span>
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => exportTrades(btRes.res.trades, `backtest-${btRes.sym}`, 'json')}
                      >
                        <Download size={12} />
                        <span>JSON</span>
                      </button>
                    </div>
                  )}
                </div>
                {renderStatsBlock(btRes.res.trades, '')}
                {renderTradesTable(btRes.res.trades, true)}
              </div>
            </>
          ) : (
            <div className="card empty">
              اختر رمزاً وفترة ثم شغّل الاختبار لترى كيف كان المحرك سيتصرف على بيانات حقيقية، بما
              فيها الخسائر والرسوم والتمويل التاريخي واختبار الخروج من العينة (OOS).
            </div>
          )}
        </>
      )}
    </div>
  );
}
