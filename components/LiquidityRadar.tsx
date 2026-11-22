'use client';

import React, { useState } from 'react';
import { Activity, ArrowDownUp, CheckCircle2, Filter, RefreshCw, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { isN } from '@/lib/cx-engine/indicators';
import { computeOrderFlowSnapshot } from '@/lib/cx-engine/orderflow';
import type { MicroBarFlow, OrderFlowSnapshot } from '@/lib/cx-engine/types';
import { clsPnL, fmtAgo, fmtClock, fmtUsd, scoreColor, shortSym } from '@/lib/client/formatters';
import type { CipherClientEngine } from '@/lib/client/market-engine';

interface LiquidityRadarProps {
  engine: CipherClientEngine;
  variant: 'detail' | 'scanner';
  sym?: string;
  onOpenChart?: (sym: string) => void;
  filterOnlyConfirmed?: boolean;
  onToggleFilterConfirmed?: (next: boolean) => void;
  onToast?: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  tickVersion?: number;
}

const VERDICT_META: Record<
  OrderFlowSnapshot['verdict'],
  { label: string; cls: string; short: string }
> = {
  CONFIRMED: { label: 'مؤكد بالسيولة والتدفق', cls: 'b-open', short: 'مؤكد' },
  ABSORPTION: { label: 'امتصاص سيولة مؤسسي', cls: 'b-strong', short: 'امتصاص' },
  NEUTRAL: { label: 'تدفق متوازن (قيد المراقبة)', cls: 'b-watch', short: 'متوازن' },
  COUNTER_FLOW: { label: 'تدفق صغرى معاكس للإشارة', cls: 'b-short', short: 'معاكس' },
  ILLIQUID: { label: 'لم يجتز فلتر السيولة', cls: 'b-pend', short: 'سيولة ضعيفة' },
};

export default function LiquidityRadar({
  engine,
  variant,
  sym,
  onOpenChart,
  filterOnlyConfirmed = false,
  onToggleFilterConfirmed,
  onToast,
}: LiquidityRadarProps) {
  const [selectedTf, setSelectedTf] = useState<'auto' | '1m' | '5m'>('auto');
  const [showFilterTuning, setShowFilterTuning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hoveredBar, setHoveredBar] = useState<MicroBarFlow | null>(null);

  const cfg = engine.getSettings();
  const S = engine.storeState;

  const updateLiquiditySettings = (patch: {
    minVolM?: number;
    maxSpreadBps?: number;
    liquidityRadarGate?: boolean;
  }) => {
    engine.setSettings(patch);
    const next = engine.getSettings();
    const serverPatch: Record<string, any> = {};
    if (patch.minVolM !== undefined) serverPatch.minVolumeUsdt = next.minVolM * 1_000_000;
    if (patch.maxSpreadBps !== undefined) serverPatch.maxSpreadBps = next.maxSpreadBps;
    if (Object.keys(serverPatch).length > 0) {
      fetch('/api/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_settings', settings: serverPatch }),
      }).catch(() => undefined);
    }
    if (sym) engine.analyze(sym, false);
  };

  if (variant === 'scanner') {
    const rows = S.universe
      .map((s) => {
        const rec = engine.rec(s);
        const rep = rec.report;
        const flow =
          rep?.orderFlow ||
          (rec.ready
            ? computeOrderFlowSnapshot({
                microCandles: rec.micro,
                triggerCandles: rec.candles[engine.tfs().trigger]?.slice(-30),
                triggerTf: engine.tfs().trigger,
                book: rec.book,
                vol24h: rec.vol,
                minVolumeUsdt: cfg.minVolM * 1_000_000,
                maxSpreadBps: cfg.maxSpreadBps,
                dirHint: rep?.dir || 0,
              })
            : null);
        return { rec, rep, flow };
      })
      .filter((x) => x.flow && x.rep)
      .sort((a, b) => {
        const scoreA =
          (a.rep?.score || 0) + Math.abs(a.flow?.netBias || 0) * 18 + (a.flow?.liquidity.liquidityPass ? 5 : -20);
        const scoreB =
          (b.rep?.score || 0) + Math.abs(b.flow?.netBias || 0) * 18 + (b.flow?.liquidity.liquidityPass ? 5 : -20);
        return scoreB - scoreA;
      })
      .slice(0, 7);

    const passedCount = rows.filter((x) => x.flow?.liquidity.liquidityPass && x.flow.verdict !== 'COUNTER_FLOW').length;

    return (
      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <Activity size={16} color="var(--cyan)" />
            <h3 style={{ margin: 0 }}>رادار سيولة الفريمات الصغرى (Order Flow)</h3>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="hint num">
              فلتر السيولة: ≥{cfg.minVolM}M$ · ≤{cfg.maxSpreadBps}bps · اجتاز {passedCount}/{rows.length}
            </span>
            {onToggleFilterConfirmed && (
              <div className="seg" style={{ flex: 'none' }}>
                <button
                  type="button"
                  className={!filterOnlyConfirmed ? 'on' : ''}
                  onClick={() => onToggleFilterConfirmed(false)}
                >
                  كل الإشارات
                </button>
                <button
                  type="button"
                  className={filterOnlyConfirmed ? 'on' : ''}
                  onClick={() => onToggleFilterConfirmed(true)}
                >
                  المؤكدة بالسيولة فقط
                </button>
              </div>
            )}
            <button
              type="button"
              className={`btn sm ${cfg.liquidityRadarGate ? 'green' : ''}`}
              onClick={() => {
                const nextGate = !cfg.liquidityRadarGate;
                updateLiquiditySettings({ liquidityRadarGate: nextGate });
                onToast?.(
                  nextGate
                    ? 'تم دمج بوابة رادار السيولة في إصدار الإشارات ✔'
                    : 'تم تحويل رادار السيولة إلى وضع المراقبة الاستشاري',
                  'info'
                );
              }}
            >
              <Filter size={12} />
              <span>{cfg.liquidityRadarGate ? 'بوابة الدقة: مفعّلة' : 'بوابة الدقة: استشاري'}</span>
            </button>
          </div>
        </div>

        {!rows.length ? (
          <div className="empty" style={{ padding: 14 }}>
            جارٍ تجميع بيانات تدفق السيولة والأوامر من Binance…
          </div>
        ) : (
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>العملة</th>
                  <th>الاتجاه / الدرجة</th>
                  <th>تدفق السيولة</th>
                  <th>الامتصاص</th>
                  <th>سيولة 24س / السبريد</th>
                  <th>حالة الفلتر المدمج</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ rec, rep, flow }) => {
                  const vm = VERDICT_META[flow!.verdict];
                  const spread = flow!.liquidity.spreadBps;
                  const fMicro = flow!.frames[flow!.primaryTf];
                  return (
                    <tr
                      key={rec.sym}
                      className="click"
                      onClick={() => onOpenChart?.(rec.sym)}
                    >
                      <td>
                        <span className="sym">{shortSym(rec.sym)}</span>{' '}
                        <span className="dim" style={{ fontSize: 10.5 }}>
                          ({flow!.primaryTf})
                        </span>
                      </td>
                      <td>
                        {rep!.dir ? (
                          <span className={`b ${rep!.dir > 0 ? 'b-long' : 'b-short'}`}>
                            {rep!.dir > 0 ? 'L' : 'S'} · {rep!.score}
                          </span>
                        ) : (
                          <span className="num" style={{ color: scoreColor(rep!.score) }}>
                            {rep!.score}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <span className={clsPnL(flow!.netBias)}>
                          {flow!.netBias >= 0 ? '+' : ''}
                          {(flow!.netBias * 100).toFixed(0)}%
                        </span>
                        {fMicro && (
                          <span className="dim" style={{ marginInlineStart: 6, fontSize: 11 }}>
                            ({fMicro.netDeltaUsd >= 0 ? '+' : '-'}
                            {fmtUsd(Math.abs(fMicro.netDeltaUsd))})
                          </span>
                        )}
                      </td>
                      <td>
                        {flow!.absorption === 'BULL' ? (
                          <span className="pos">امتصاص شرائي</span>
                        ) : flow!.absorption === 'BEAR' ? (
                          <span className="neg">امتصاص بيعي</span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="num">
                        <span className={flow!.liquidity.volPass ? '' : 'neg'}>
                          {fmtUsd(rec.vol)}
                        </span>
                        <span className="dim">
                          {' '}
                          / {spread != null ? `${spread.toFixed(1)}bp` : '—'}
                        </span>
                      </td>
                      <td>
                        <span className={`b ${vm.cls}`}>{vm.short}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // Detail View for ChartTab
  const activeSym = sym || S.active || S.universe[0] || 'BTCUSDT';
  const rec = engine.rec(activeSym);
  const R = rec.report;

  const flow =
    R?.orderFlow ||
    (rec.ready
      ? computeOrderFlowSnapshot({
          microCandles: rec.micro,
          triggerCandles: rec.candles[engine.tfs().trigger]?.slice(-30),
          triggerTf: engine.tfs().trigger,
          book: rec.book,
          vol24h: rec.vol,
          minVolumeUsdt: cfg.minVolM * 1_000_000,
          maxSpreadBps: cfg.maxSpreadBps,
          dirHint: R?.dir || 0,
        })
      : null);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await engine.enrich(activeSym, true);
      engine.analyze(activeSym, false);
      onToast?.(`تم تحديث تدفقات السيولة لـ ${shortSym(activeSym)} ✔`, 'info');
    } finally {
      setRefreshing(false);
    }
  };

  if (!flow) {
    return (
      <div className="card">
        <h3>
          <Activity size={15} /> رادار السيولة (Order Flow)
        </h3>
        <div className="empty" style={{ padding: 14 }}>
          جارٍ تحميل شموع الأطر الصغرى (1m / 5m) وبيانات السيولة…
        </div>
      </div>
    );
  }

  const availableKeys = Object.keys(flow.frames);
  const chosenFrame =
    selectedTf !== 'auto' && flow.frames[selectedTf]
      ? flow.frames[selectedTf]
      : flow.frames[flow.primaryTf] || flow.frames[availableKeys[0]];

  const vm = VERDICT_META[flow.verdict];
  const recentBars = chosenFrame?.recentBars || [];
  const maxBarDelta = Math.max(
    1,
    ...recentBars.map((b) => Math.abs(b.deltaUsd))
  );
  const buyPct = chosenFrame ? Math.round(chosenFrame.buyRatio * 100) : 50;
  const sellPct = 100 - buyPct;

  return (
    <div className="card">
      <div className="row sb wrap" style={{ marginBottom: 8 }}>
        <div className="row" style={{ gap: 7 }}>
          <Activity size={16} color="var(--cyan)" />
          <h3 style={{ margin: 0 }}>رادار السيولة (Order Flow)</h3>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn sm"
            onClick={() => setShowFilterTuning((v) => !v)}
            title="ضبط عتبات فلتر السيولة"
          >
            <SlidersHorizontal size={12} />
            <span>الفلتر</span>
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={refreshing}
            onClick={handleManualRefresh}
            title="تحديث تدفق 1m / 5m"
          >
            <RefreshCw size={12} />
            <span>{refreshing ? 'تحديث…' : 'تحديث'}</span>
          </button>
        </div>
      </div>

      {/* Timeframe Switcher + Summary Metadata */}
      <div className="row sb wrap" style={{ marginBottom: 10 }}>
        <div className="seg" style={{ flex: 'none' }}>
          {(
            [
              ['auto', `مدمج (${flow.primaryTf})`],
              ...(flow.frames['1m'] ? [['1m', '1m'] as const] : []),
              ...(flow.frames['5m'] ? [['5m', '5m'] as const] : []),
            ] as const
          ).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className={selectedTf === k ? 'on' : ''}
              onClick={() => {
                setSelectedTf(k);
                setHoveredBar(null);
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="hint num">
          ثقة القراءة {(flow.confidence * 100).toFixed(0)}% ·{' '}
          {rec.microAt ? fmtAgo(rec.microAt) : 'بيانات الإطار الحالي'}
        </div>
      </div>

      {/* Integrated Liquidity Filter + Order Flow Verdict Banner */}
      <div
        className="tile"
        style={{
          marginBottom: 10,
          borderColor:
            flow.verdict === 'CONFIRMED' || flow.verdict === 'ABSORPTION'
              ? 'rgba(0, 255, 136, 0.32)'
              : flow.verdict === 'COUNTER_FLOW' || flow.verdict === 'ILLIQUID'
                ? 'rgba(255, 45, 85, 0.35)'
                : 'var(--bd)',
        }}
      >
        <div className="row sb wrap" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 6 }}>
            {flow.liquidity.liquidityPass && flow.verdict !== 'COUNTER_FLOW' ? (
              <CheckCircle2 size={14} color="var(--green)" />
            ) : (
              <ShieldAlert size={14} color="var(--orange)" />
            )}
            <span className={`b ${vm.cls}`}>{vm.label}</span>
          </div>
          <span className={`num ${clsPnL(flow.netBias)}`} style={{ fontSize: 14, fontWeight: 700 }}>
            انحياز السيولة {flow.netBias >= 0 ? '+' : ''}
            {(flow.netBias * 100).toFixed(0)}%
          </span>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          {flow.verdictLabel}
        </div>
        <div className="kv" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--bd)' }}>
          <span>سيولة 24س (الحد ≥ {cfg.minVolM}M$)</span>
          <span className={`num ${flow.liquidity.volPass ? 'pos' : 'neg'}`}>
            {flow.liquidity.vol24hUsd != null ? fmtUsd(flow.liquidity.vol24hUsd) : '—'}{' '}
            <small>{flow.liquidity.volPass ? '✔ مقبول' : '✘ منخفض'}</small>
          </span>
        </div>
        <div className="kv">
          <span>السبريد الدفتري (الحد ≤ {cfg.maxSpreadBps} bps)</span>
          <span className={`num ${flow.liquidity.spreadPass ? 'pos' : 'neg'}`}>
            {flow.liquidity.spreadBps != null ? `${flow.liquidity.spreadBps.toFixed(2)} bps` : '—'}{' '}
            <small>{flow.liquidity.spreadPass ? '✔ ضيق' : '✘ واسع'}</small>
          </span>
        </div>
      </div>

      {/* Inline Liquidity Filter Threshold Tuning */}
      {showFilterTuning && (
        <div
          className="tile"
          style={{ marginBottom: 10, background: 'rgba(17, 34, 64, 0.65)' }}
        >
          <div className="grid g2" style={{ gap: 8 }}>
            <div>
              <label className="f" style={{ marginTop: 0 }}>
                أدنى سيولة 24س (مليون $)
              </label>
              <input
                type="number"
                step="5"
                value={cfg.minVolM}
                onChange={(e) =>
                  updateLiquiditySettings({ minVolM: Math.max(0, Number(e.target.value)) })
                }
              />
            </div>
            <div>
              <label className="f" style={{ marginTop: 0 }}>
                أقصى سبريد مسموح (bps)
              </label>
              <input
                type="number"
                step="0.5"
                value={cfg.maxSpreadBps}
                onChange={(e) =>
                  updateLiquiditySettings({ maxSpreadBps: Math.max(1, Number(e.target.value)) })
                }
              />
            </div>
          </div>
          <div className="tog" style={{ borderBottom: 0, paddingBottom: 2, marginTop: 4 }}>
            <span style={{ fontSize: 12 }}>ربط بوابة الرادار بفلترة إصدار الإشارات</span>
            <div
              className={`sw ${cfg.liquidityRadarGate ? 'on' : ''}`}
              onClick={() =>
                updateLiquiditySettings({ liquidityRadarGate: !cfg.liquidityRadarGate })
              }
            />
          </div>
        </div>
      )}

      {/* Chosen Micro Timeframe Metrics */}
      {chosenFrame && (
        <>
          <div className="part" style={{ marginTop: 4 }}>
            <div className="ph">
              <span>
                <ArrowDownUp size={12} style={{ display: 'inline', marginInlineEnd: 4 }} />
                توازن المشترين vs البائعين ({chosenFrame.tf} · آخر {chosenFrame.bars} شمعة)
              </span>
              <span className="num">
                <span className="pos">{buyPct}% شراء</span> /{' '}
                <span className="neg">{sellPct}% بيع</span>
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                height: 8,
                borderRadius: 6,
                overflow: 'hidden',
                background: 'rgba(255, 45, 85, 0.35)',
                border: '1px solid var(--bd)',
              }}
            >
              <div
                style={{
                  width: `${buyPct}%`,
                  background: 'var(--green)',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            <div className="row sb hint num" style={{ marginTop: 4 }}>
              <span className="pos">شراء: {fmtUsd(chosenFrame.buyVolUsd)}</span>
              <span className="neg">بيع: {fmtUsd(chosenFrame.sellVolUsd)}</span>
            </div>
          </div>

          <div className="grid g4" style={{ gap: 6, marginTop: 8, marginBottom: 10 }}>
            <div className="tile">
              <div className="l">صافي الدلتا ({chosenFrame.tf})</div>
              <div className={`v ${clsPnL(chosenFrame.netDeltaUsd)}`} style={{ fontSize: 13 }}>
                {chosenFrame.netDeltaUsd >= 0 ? '+' : '-'}
                {fmtUsd(Math.abs(chosenFrame.netDeltaUsd))}
              </div>
            </div>
            <div className="tile">
              <div className="l">ميل CVD</div>
              <div className={`v ${clsPnL(chosenFrame.cvdSlope)}`} style={{ fontSize: 13 }}>
                {chosenFrame.cvdSlope >= 0 ? '+' : ''}
                {(chosenFrame.cvdSlope * 100).toFixed(0)}%
              </div>
            </div>
            <div className="tile">
              <div className="l">تدفق $/دقيقة</div>
              <div className="v cy" style={{ fontSize: 13 }}>
                {fmtUsd(chosenFrame.usdPerMin)}
              </div>
            </div>
            <div className="tile">
              <div className="l">RVOL / متوسط الصفقة</div>
              <div className="v" style={{ fontSize: 12.5 }}>
                {chosenFrame.rvol.toFixed(1)}x{' '}
                <span className="dim">
                  · {chosenFrame.avgTradeUsd > 0 ? fmtUsd(chosenFrame.avgTradeUsd) : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Interactive Bar-by-Bar Delta Sparkchart */}
          {recentBars.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="row sb hint" style={{ marginBottom: 4 }}>
                <span>نبض الدلتا اللحظي ({chosenFrame.tf})</span>
                <span className="num">
                  {hoveredBar
                    ? `${fmtClock(hoveredBar.t)} · ${hoveredBar.deltaUsd >= 0 ? '+' : '-'}${fmtUsd(Math.abs(hoveredBar.deltaUsd))} (${(hoveredBar.buyRatio * 100).toFixed(0)}% شراء)`
                    : `آخر 18 شمعة ${chosenFrame.tf}`}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 3,
                  height: 46,
                  padding: '6px 6px 4px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--bd)',
                  borderRadius: 8,
                }}
                onMouseLeave={() => setHoveredBar(null)}
              >
                {recentBars.map((b) => {
                  const pct = Math.max(12, Math.round((Math.abs(b.deltaUsd) / maxBarDelta) * 100));
                  const pos = b.deltaUsd >= 0;
                  const active = hoveredBar?.t === b.t;
                  return (
                    <button
                      key={b.t}
                      type="button"
                      onMouseEnter={() => setHoveredBar(b)}
                      onClick={() => setHoveredBar(b)}
                      aria-label={`دلتا ${fmtClock(b.t)}`}
                      style={{
                        flex: 1,
                        height: `${pct}%`,
                        background: pos ? 'var(--green)' : 'var(--red)',
                        opacity: active ? 1 : 0.72,
                        borderRadius: 3,
                        padding: 0,
                        border: active ? '1px solid #fff' : 'none',
                        transition: 'opacity 0.15s',
                      }}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {chosenFrame.absorption !== 'NONE' && (
            <div className="warn" style={{ marginTop: 8 }}>
              {chosenFrame.absorptionDetail}
            </div>
          )}
        </>
      )}
    </div>
  );
}
