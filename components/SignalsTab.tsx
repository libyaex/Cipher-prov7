'use client';

import React, { useEffect, useState } from 'react';
import { Download, PlayCircle, RefreshCw, Wallet } from 'lucide-react';
import { isN, TF_MS } from '@/lib/cx-engine/indicators';
import { sizePosition } from '@/lib/cx-engine/planner';
import { unrealizedR } from '@/lib/cx-engine/backtest';
import type { BotSettings, PaperPosition, PaperWallet } from '@/lib/cx-engine/types';
import { downloadCsv, downloadJson } from '@/lib/client/export';
import {
  clsPnL,
  fmtAgo,
  fmtClock,
  fmtCountdown,
  fmtP,
  OUT_MAP,
  REG_MAP,
  scoreColor,
  shortSym,
} from '@/lib/client/formatters';
import type { CipherClientEngine, TrackedSignal } from '@/lib/client/market-engine';
import LiquidityRadar from '@/components/LiquidityRadar';

interface SignalsTabProps {
  engine: CipherClientEngine;
  wallet: PaperWallet | null;
  botSettings?: BotSettings | null;
  openPositions?: PaperPosition[];
  onOpenChart: (sym: string) => void;
  onOpenWallet?: () => void;
  onExecutePaper: (sym: string, evaluation?: any) => Promise<void>;
  onToast: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  tickVersion: number;
}

export default function SignalsTab({
  engine,
  wallet,
  botSettings,
  openPositions = [],
  onOpenChart,
  onOpenWallet,
  onExecutePaper,
  onToast,
  tickVersion,
}: SignalsTabProps) {
  const [filter, setFilter] = useState<'all' | 'long' | 'short' | 'early'>('all');
  const [tierFilter, setTierFilter] = useState<'all' | 'STRONG' | 'GOOD'>('all');
  const [onlyLiquidityConfirmed, setOnlyLiquidityConfirmed] = useState(false);
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [countdownTxt, setCountdownTxt] = useState('—');
  const [nowMs, setNowMs] = useState(0);

  const cfg = engine.getSettings();
  const tfs = engine.tfs();
  const S = engine.storeState;
  const scan = engine.scanState;

  useEffect(() => {
    const update = () => {
      const msTr = TF_MS[tfs.trigger] || 900e3;
      const nextAt = (Math.floor(engine.now() / msTr) + 1) * msTr;
      setCountdownTxt(fmtCountdown(nextAt - engine.now()));
      setNowMs(Date.now());
    };
    const t0 = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [engine, tfs.trigger]);

  let live = engine.getLiveSignals();
  if (filter === 'long' || filter === 'short') {
    live = live.filter((s) => (filter === 'long') === s.dir > 0);
  } else if (filter === 'early') {
    live = live.filter(
      (s) =>
        (s.earlyEntry || s.evalSnapshot?.earlyEntry)?.entryKind === 'EARLY_ENTRY' ||
        s.strategyMode === 'early' ||
        s.mode === 'early'
    );
  }
  if (tierFilter !== 'all') {
    live = live.filter((s) => s.tier === tierFilter);
  }
  const hasGoodLiquidity = (sym: string, evalOrderFlow?: any) => {
    const flow = engine.rec(sym).report?.orderFlow || evalOrderFlow;
    if (!flow) return true;
    return flow.liquidity?.liquidityPass !== false && flow.verdict !== 'COUNTER_FLOW';
  };
  if (onlyLiquidityConfirmed) {
    live = live.filter((s) => hasGoodLiquidity(s.sym, s.evalSnapshot?.orderFlow));
  }
  const nLive = engine.getLiveSignals().length;
  const done = engine
    .getSignals()
    .filter((s) => s.status !== 'OPEN' && s.status !== 'PENDING')
    .slice(-10)
    .reverse();

  const cands = S.universe
    .map((sym) => engine.rec(sym))
    .filter(
      (r) =>
        r.report &&
        r.report.dir &&
        r.report.tier !== 'NONE' &&
        !engine.getLiveSignals().some((s) => s.sym === r.sym) &&
        (!onlyLiquidityConfirmed || hasGoodLiquidity(r.sym))
    )
    .sort((a, b) => {
      const aOk = a.report?.plan?.ok ? 1 : 0;
      const bOk = b.report?.plan?.ok ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return (b.report?.score || 0) - (a.report?.score || 0);
    })
    .slice(0, 8);
  const best = cands.find((r) => r.report?.plan?.ok) || cands[0];

  const copyText = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      onToast('تم النسخ ✔', 'info');
    } catch {
      onToast('تعذر النسخ إلى الحافظة', 'bad');
    }
  };

  const btcCtx = engine.getBtcContext();
  const allSignals = engine.getSignals();

  const exportSignalsCsv = () => {
    if (!allSignals.length) {
      onToast('لا توجد إشارات للتصدير بعد', 'bad');
      return;
    }
    const headers = ['ID', 'Symbol', 'Side', 'Tier', 'Score', 'Type', 'Status', 'Entry', 'Stop', 'Exit', 'R', 'Outcome', 'Regime', 'Time'];
    const rows = allSignals.map((s) => [
      s.id,
      s.sym,
      s.dir > 0 ? 'LONG' : 'SHORT',
      s.tier,
      s.score,
      s.type,
      s.status,
      s.entry,
      s.stopCur,
      s.exitPrice ?? '',
      s.R != null ? Number(s.R.toFixed(3)) : '',
      s.outcome || '',
      s.regime,
      new Date(s.t0).toISOString(),
    ]);
    downloadCsv(`cipherx-signals-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    onToast('تم تصدير سجل الإشارات CSV ✔', 'info');
  };

  const exportSignalsJson = () => {
    if (!allSignals.length) {
      onToast('لا توجد إشارات للتصدير بعد', 'bad');
      return;
    }
    downloadJson(`cipherx-signals-${new Date().toISOString().slice(0, 10)}.json`, allSignals);
    onToast('تم تصدير سجل الإشارات JSON ✔', 'info');
  };

  const renderSignalCard = (s: TrackedSignal) => {
    const r = engine.rec(s.sym);
    const price = r.price;
    const L = s.dir > 0;
    const P = (p: number) => fmtP(p, s.tick);
    const meta = r.meta || {};
    const open = s.status === 'OPEN';
    const ur = open ? unrealizedR(s, price) : null;
    const activePaper = openPositions.find((p) => p.symbol === s.sym);
    const liveFlow = r.report?.orderFlow || s.evalSnapshot?.orderFlow;
    const ee = s.earlyEntry || s.evalSnapshot?.earlyEntry || null;
    const isEarlyEntry = ee?.entryKind === 'EARLY_ENTRY';
    const eeStatusAr =
      ee?.entryStatus === 'EARLY'
        ? 'دخول مبكر'
        : ee?.entryStatus === 'WAIT_RETEST'
          ? 'انتظار إعادة اختبار'
          : ee?.entryStatus === 'CANCELLED'
            ? 'ملغى (تمت المطاردة)'
            : 'مؤكد';

    const rows: { k: string; n: string; p: number; extra?: string; r?: number; pct?: number; hit?: boolean }[] = [
      { k: 'sl', n: 'الوقف', p: s.stopCur, extra: s.stopCur !== s.stop ? '(متحرك)' : '' },
      { k: 'entry', n: 'الدخول', p: s.entry },
    ];
    s.tps.forEach((t, k) =>
      rows.push({ k: 'tp', hit: t.hit, n: `TP${k + 1}`, p: t.p, r: s.rr[k], pct: t.pct })
    );
    if (isN(price)) rows.push({ k: 'now', n: 'الآن', p: price });
    rows.sort((a, b) => b.p - a.p);

    const effEquity = wallet?.balanceUsdt ?? cfg.equity;
    const sz = sizePosition({
      entry: s.entry,
      stop: s.stop,
      equity: effEquity,
      riskPct: cfg.riskPct,
      maxLev: cfg.maxLev,
      mmr: cfg.mmr,
      takerFee: cfg.takerFee,
      minSafetyPct: cfg.minLiqSafetyPct,
      step: meta.step,
      minQty: meta.minQty,
      minNotional: meta.minNotional,
      long: L,
    });

    return (
      <div key={s.id} className={`card sig ${L ? 'long' : 'short'}`}>
        <div className="head">
          <div
            className="ring"
            style={{ ['--v' as any]: s.score, ['--c' as any]: scoreColor(s.score) }}
          >
            <b>{s.score}</b>
          </div>
          <div style={{ flex: 1 }}>
            <div className="row wrap">
              <span className="sym">
                {shortSym(s.sym)}
                <small className="dim">/USDT</small>
              </span>
              <span className={`b ${L ? 'b-long' : 'b-short'}`}>
                {isEarlyEntry ? `EARLY ${L ? 'LONG' : 'SHORT'}` : L ? 'LONG' : 'SHORT'}
              </span>
              <span
                className={`b b-${
                  s.tier === 'STRONG' ? 'strong' : s.tier === 'GOOD' ? 'good' : 'watch'
                }`}
              >
                {s.tier}
              </span>
              {ee && (
                <span
                  className={`b ${
                    ee.entryStatus === 'EARLY'
                      ? 'b-good'
                      : ee.entryStatus === 'WAIT_RETEST'
                        ? 'b-pend'
                        : ee.entryStatus === 'CANCELLED'
                          ? 'b-short'
                          : 'b-open'
                  }`}
                >
                  {eeStatusAr}
                </span>
              )}
            </div>
            <div className="hint">
              {fmtAgo(s.t0)} · {s.tfs.trigger}/{s.tfs.setup}/{s.tfs.trend} · {s.aligned} عوامل متوافقة · نظام{' '}
              {REG_MAP[s.regime] || s.regime}
            </div>
          </div>
          <div style={{ textAlign: 'left' }}>
            <span className={`b ${open ? 'b-open' : 'b-pend'}`}>
              {open ? 'مفتوحة' : 'بانتظار التنفيذ'}
            </span>
            {open && isN(ur) && (
              <>
                <div className={`num ${clsPnL(ur)}`} style={{ fontSize: 15, marginTop: 4 }}>
                  {ur! >= 0 ? '+' : ''}
                  {ur!.toFixed(2)}R
                </div>
                <div className="hint" style={{ fontSize: 10.5 }}>
                  قبل الرسوم {ur! + s.feeR >= 0 ? '+' : ''}
                  {(ur! + s.feeR).toFixed(2)}R
                </div>
              </>
            )}
          </div>
        </div>

        <div className="ladder">
          {rows.map((x, idx) => {
            const rrTxt =
              x.k === 'now'
                ? (open || s.status === 'PENDING') && s.risk > 0
                  ? `${((s.dir * (x.p - s.entry)) / s.risk).toFixed(2)}R`
                  : ''
                : x.k === 'entry'
                  ? ''
                  : x.r
                    ? `${x.r.toFixed(2)}R · ${x.pct}%`
                    : x.k === 'sl'
                      ? '-1R'
                      : '';
            return (
              <div key={idx} className={`lv ${x.k} ${x.hit ? 'hit' : ''}`}>
                <span className="n">{x.n}</span>
                <span className="p num">
                  {P(x.p)} {x.extra || ''}
                </span>
                {x.k === 'entry' && (
                  <span className={`b ${s.type === 'MARKET' ? 'b-open' : 'b-pend'}`}>
                    {s.type === 'MARKET' ? '⚡ سوقي الآن' : '⏳ Limit'}
                  </span>
                )}
                <span className="r">{rrTxt}</span>
              </div>
            );
          })}
        </div>

        {s.status === 'PENDING' && isN(price) && s.entry > 0 && (
          <div className="hint">
            السعر الحالي {P(price)} · يبعد {((100 * Math.abs(price - s.entry)) / s.entry).toFixed(2)}% عن
            أمر الدخول · ينتهي خلال {nowMs > 0 ? fmtCountdown(s.expireAt - nowMs) : '—'}
          </div>
        )}

        <div className="hint">
          الوقف خلف <b>{s.stopRef}</b> · {s.riskATR.toFixed(2)}×ATR · منطقة القيمة {P(s.zone.lo)} –{' '}
          {P(s.zone.hi)} ({s.zone.labels.slice(0, 3).join(' + ')})
          {liveFlow && (
            <>
              {' '}
              · تدفق السيولة:{' '}
              <span
                className={
                  liveFlow.verdict === 'CONFIRMED' || liveFlow.verdict === 'ABSORPTION'
                    ? 'pos'
                    : liveFlow.verdict === 'COUNTER_FLOW' || liveFlow.verdict === 'ILLIQUID'
                      ? 'neg'
                      : ''
                }
              >
                {liveFlow.verdict === 'CONFIRMED'
                  ? 'مؤكد'
                  : liveFlow.verdict === 'ABSORPTION'
                    ? 'امتصاص'
                    : liveFlow.verdict === 'COUNTER_FLOW'
                      ? 'معاكس'
                      : liveFlow.verdict === 'ILLIQUID'
                        ? 'سيولة ضعيفة'
                        : 'متوازن'}
              </span>
            </>
          )}
          {s.meta?.smartTpPartialDone && (
            <span className="pos"> · جني ذكي جزئي (+{Number(s.meta.smartTpPartialR || 0).toFixed(2)}R)</span>
          )}
        </div>

        {ee && (
          <div className="tile" style={{ marginTop: 8, padding: '8px 10px' }}>
            <div className="row sb wrap" style={{ gap: 6 }}>
              <span className="hint" style={{ color: 'var(--cyan)', fontWeight: 700 }}>
                {isEarlyEntry ? '⚡ سبب الاقتناص المبكر:' : '📊 جودة توقيت الدخول:'} {ee.earlyReason}
              </span>
              <span className="num hint">
                تحرك {ee.distanceMovedPct.toFixed(2)}% · متبقي {ee.remainingRR1.toFixed(2)}R
              </span>
            </div>
            {(ee.confirmFactors.length > 0 || ee.missingConfirmations.length > 0) && (
              <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
                {ee.confirmFactors.slice(0, 4).map((f, idx) => (
                  <span key={`cf-${idx}`} className="b b-open" style={{ fontSize: 10 }}>
                    ✔ {f}
                  </span>
                ))}
                {ee.missingConfirmations.slice(0, 3).map((m, idx) => (
                  <span key={`mc-${idx}`} className="b b-watch" style={{ fontSize: 10 }}>
                    ⏳ {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <details>
          <summary>
            {s.type === 'MARKET'
              ? 'لماذا السعر الحالي هو سعر الدخول؟'
              : 'لماذا الدخول عند هذا السعر وليس الحالي؟'}
          </summary>
          <div>
            {s.checks.map((c, idx) => (
              <div key={idx} className="chk">
                <i className={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'nt'}>
                  {c.ok === true ? '✔' : c.ok === false ? '✘' : '•'}
                </i>
                <div>
                  <span className="t">{c.label}</span>
                  <span className="d">{c.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </details>

        <details>
          <summary>أسباب الإشارة ({s.reasons.length})</summary>
          <div>
            {s.reasons.map((x, idx) => (
              <div key={idx} className="part">
                <div className="ph">
                  <b>{x.label}</b>
                  <span className={`num ${x.raw > 0 ? 'pos' : 'neg'}`}>
                    {x.raw >= 0 ? '+' : ''}
                    {x.raw.toFixed(2)}
                  </span>
                </div>
                <div className="pd">{x.detail}</div>
              </div>
            ))}
            {(s.against || []).map((x, idx) => (
              <div key={`ag-${idx}`} className="part">
                <div className="ph">
                  <b className="neg">ضد الإشارة: {x.label}</b>
                </div>
                <div className="pd">{x.detail}</div>
              </div>
            ))}
            {(s.gates || []).map((g, idx) => (
              <div key={`gt-${idx}`} className="warn">
                {g}
              </div>
            ))}
            {(s.warnings || []).map((w, idx) => (
              <div key={`wn-${idx}`} className="warn">
                ⚠ {w}
              </div>
            ))}
          </div>
        </details>

        <details>
          <summary>
            حجم المركز والرافعة (رصيد {effEquity.toFixed(0)}$ · مخاطرة {cfg.riskPct}%)
          </summary>
          {sz.ok ? (
            <div>
              <div className="grid g2" style={{ gap: 6, marginTop: 6 }}>
                <div className="tile">
                  <div className="l">الكمية</div>
                  <div className="v">{sz.qty}</div>
                </div>
                <div className="tile">
                  <div className="l">الرافعة المقترحة</div>
                  <div className="v">{sz.lev}x</div>
                </div>
                <div className="tile">
                  <div className="l">قيمة المركز</div>
                  <div className="v">{sz.notional.toFixed(1)}$</div>
                </div>
                <div className="tile">
                  <div className="l">الهامش</div>
                  <div className="v">{sz.margin.toFixed(1)}$</div>
                </div>
                <div className="tile">
                  <div className="l">المخاطرة الفعلية</div>
                  <div className="v neg">
                    {sz.effRiskUsd.toFixed(2)}$ ({sz.effRiskPct.toFixed(2)}%)
                  </div>
                </div>
                <div className="tile">
                  <div className="l">سعر التصفية (هامش أمان {sz.safetyBufferPct.toFixed(0)}%)</div>
                  <div className="v">{P(sz.liq)}</div>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                أقصى رافعة آمنة لهذا الوقف: {sz.safeMax}x (الوقف يسبق التصفية دائماً بهامش أمان محمي).{' '}
                {sz.note}
              </div>
            </div>
          ) : (
            <div className="warn">{sz.note || 'تعذر الحساب'}</div>
          )}
        </details>

        <div className="row wrap" style={{ marginTop: 12 }}>
          {activePaper ? (
            <button
              type="button"
              className="btn sm pri"
              onClick={() => onOpenWallet?.()}
            >
              <Wallet size={13} />
              <span>
                {activePaper.status === 'OPEN' ? 'مفتوحة في المحفظة' : 'أمر معلق بالمحفظة'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="btn sm green"
              disabled={executingId === s.id}
              onClick={async () => {
                setExecutingId(s.id);
                try {
                  await onExecutePaper(s.sym, s.evalSnapshot);
                } finally {
                  setExecutingId(null);
                }
              }}
            >
              <PlayCircle size={13} />
              <span>{executingId === s.id ? 'جارٍ التنفيذ…' : 'تنفيذ تجريبي'}</span>
            </button>
          )}
          <button type="button" className="btn sm" onClick={() => onOpenChart(s.sym)}>
            فتح التحليل
          </button>
          <button type="button" className="btn sm" onClick={() => copyText(engine.signalText(s))}>
            نسخ الخطة
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              engine
                .telegram(engine.signalText(s))
                .then((res) =>
                  onToast(
                    res.ok ? 'أُرسلت إلى تيليجرام ✔' : `تعذر الإرسال: ${res.err || ''}`,
                    res.ok ? 'info' : 'bad'
                  )
                )
            }
          >
            إرسال تيليجرام
          </button>
          {confirmCloseId === s.id ? (
            <div className="row" style={{ gap: 4 }}>
              <button
                type="button"
                className="btn sm red"
                onClick={() => {
                  engine.manualCloseSignal(s);
                  setConfirmCloseId(null);
                }}
              >
                تأكيد الإغلاق
              </button>
              <button type="button" className="btn sm" onClick={() => setConfirmCloseId(null)}>
                تراجع
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn sm red"
              onClick={() => setConfirmCloseId(s.id)}
            >
              {open ? 'إغلاق يدوي' : 'إلغاء'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <div className="tile">
          <div className="l">إشارات نشطة</div>
          <div className="v">{nLive}</div>
        </div>
        <div className="tile">
          <div className="l">عملات تحت المسح</div>
          <div className="v">{S.universe.length}</div>
        </div>
        <div className="tile">
          <div className="l">المسح القادم بعد</div>
          <div className="v">{countdownTxt}</div>
        </div>
        <div className="tile">
          <div className="l">أفضل مرشح</div>
          <div className="v">
            {best ? (
              <>
                {shortSym(best.sym)}{' '}
                <span style={{ color: scoreColor(best.report!.score) }}>{best.report!.score}</span>
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
      </div>

      <div className="row sb wrap" style={{ marginBottom: 12 }}>
        <div className="row wrap">
          <div className="chips">
            {(
              [
                ['all', 'الكل'],
                ['long', 'LONG'],
                ['short', 'SHORT'],
                ['early', 'EARLY'],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={`chip ${filter === k ? 'on' : ''}`}
                onClick={() => setFilter(k)}
              >
                {lbl}
              </button>
            ))}
            {(['STRONG', 'GOOD'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${tierFilter === t ? 'on' : ''}`}
                onClick={() => setTierFilter((prev) => (prev === t ? 'all' : t))}
              >
                {t}
              </button>
            ))}
          </div>
          {btcCtx && (
            <span
              className={`b ${
                btcCtx.shock
                  ? 'b-short'
                  : btcCtx.dir > 0
                    ? 'b-open'
                    : btcCtx.dir < 0
                      ? 'b-pend'
                      : 'b-watch'
              }`}
            >
              {btcCtx.detail}
            </span>
          )}
        </div>
        <div className="row wrap">
          <div className="hint">
            التشغيل:{' '}
            <b className={botSettings?.executionMode === 'AUTO' && !botSettings?.emergencyStopped ? 'pos' : 'gold'}>
              {botSettings?.executionMode === 'AUTO' && !botSettings?.emergencyStopped ? 'AUTO آلي' : 'MANUAL يدوي'}
            </b>{' '}
            · {scan.busy ? 'جارٍ المسح…' : scan.lastCycle ? `آخر مسح ${fmtClock(scan.lastCycle)}` : ''} · حد
            الإصدار: {cfg.minTier === 'STRONG' ? 'STRONG فقط' : 'GOOD+'} · الإطار {tfs.trigger}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button
              type="button"
              className="btn sm"
              disabled={scan.busy || scan.phase !== 'ready'}
              onClick={() => engine.cycle()}
            >
              <RefreshCw size={12} />
              <span>{scan.busy ? 'يمسح…' : 'فحص الآن'}</span>
            </button>
            {allSignals.length > 0 && (
              <>
                <button type="button" className="btn sm" onClick={exportSignalsCsv}>
                  <Download size={12} />
                  <span>CSV</span>
                </button>
                <button type="button" className="btn sm" onClick={exportSignalsJson}>
                  <Download size={12} />
                  <span>JSON</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {live.length ? (
        <div className="cards">{live.map(renderSignalCard)}</div>
      ) : nLive > 0 ? (
        <div className="card empty">
          <b style={{ fontSize: 15, color: 'var(--tx)' }}>
            لا توجد إشارات مطابقة للفلتر الحالي ({nLive} إشارات نشطة مخفية)
          </b>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn sm pri"
              onClick={() => {
                setFilter('all');
                setTierFilter('all');
                setOnlyLiquidityConfirmed(false);
              }}
            >
              عرض جميع الإشارات
            </button>
          </div>
        </div>
      ) : (
        <div className="card empty">
          <b style={{ fontSize: 15, color: 'var(--tx)' }}>لا توجد إشارات نشطة الآن</b>
          <br />
          المحرك يمسح {S.universe.length} عقداً عند إغلاق كل شمعة {tfs.trigger} ولا يُصدر إشارة إلا
          إذا اجتمع: درجة ≥ {cfg.minScore}، و4 عوامل متوافقة على الأقل، ومنطقة دخول مبررة،
          وعائد/مخاطرة ≥ 1.0. غياب الإشارات هو القرار الصحيح في أغلب الأوقات.
        </div>
      )}

      <LiquidityRadar
        engine={engine}
        variant="scanner"
        onOpenChart={onOpenChart}
        filterOnlyConfirmed={onlyLiquidityConfirmed}
        onToggleFilterConfirmed={setOnlyLiquidityConfirmed}
        onToast={onToast}
        tickVersion={tickVersion}
      />

      <div className="card">
        <h3>
          مرشحون قيد المراقبة
          <span className="sub">درجة ≥ {cfg.watchScore} · ليست إشارات بعد</span>
        </h3>
        {cands.length ? (
          <div className="candl">
            {cands.map((r) => {
              const R = r.report!;
              const P = R.plan;
              const why =
                P && P.ok
                  ? `منطقة ${fmtP(P.zone!.lo, r.meta.tick)}–${fmtP(P.zone!.hi, r.meta.tick)} · ${
                      P.type === 'LIMIT'
                        ? `Limit عند ${fmtP(P.entry, r.meta.tick)}`
                        : 'دخول سوقي'
                    }${R.tier === 'WATCH' ? ' · الدرجة دون حد الإصدار' : ''}`
                  : P
                    ? P.why || 'لا خطة'
                    : 'لا خطة';
              return (
                <div
                  key={r.sym}
                  className="cand"
                  onClick={() => onOpenChart(r.sym)}
                >
                  <div className="row">
                    <span className="sym">{shortSym(r.sym)}</span>
                    <span className={`b ${R.dir > 0 ? 'b-long' : 'b-short'}`}>
                      {R.dir > 0 ? 'LONG' : 'SHORT'}
                    </span>
                    <span
                      className={`b b-${
                        R.tier === 'STRONG' ? 'strong' : R.tier === 'GOOD' ? 'good' : 'watch'
                      }`}
                    >
                      {R.tier}
                    </span>
                    {R.orderFlow && R.orderFlow.verdict !== 'NEUTRAL' && (
                      <span
                        className={`b ${
                          R.orderFlow.verdict === 'CONFIRMED' || R.orderFlow.verdict === 'ABSORPTION'
                            ? 'b-open'
                            : R.orderFlow.verdict === 'COUNTER_FLOW'
                              ? 'b-short'
                              : 'b-pend'
                        }`}
                      >
                        {R.orderFlow.verdict === 'CONFIRMED'
                          ? 'سيولة مؤكدة'
                          : R.orderFlow.verdict === 'ABSORPTION'
                            ? 'امتصاص'
                            : R.orderFlow.verdict === 'COUNTER_FLOW'
                              ? 'تدفق معاكس'
                              : 'سيولة ضعيفة'}
                      </span>
                    )}
                    <span
                      className="num"
                      style={{
                        marginInlineStart: 'auto',
                        fontSize: 15,
                        color: scoreColor(R.score),
                      }}
                    >
                      {R.score}
                    </span>
                  </div>
                  <div className="hint cwhy">{why}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty" style={{ padding: 12 }}>
            لا مرشحين الآن — السوق بلا التقاء كافٍ.
          </div>
        )}
      </div>

      {done.length > 0 && (
        <div className="card">
          <h3>آخر الإشارات المغلقة</h3>
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th></th>
                  <th>الدخول</th>
                  <th>الخروج</th>
                  <th>النتيجة</th>
                  <th>السبب</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {done.map((s) => (
                  <tr key={s.id} className="click" onClick={() => onOpenChart(s.sym)}>
                    <td>
                      <span className="sym">{shortSym(s.sym)}</span>
                    </td>
                    <td>
                      <span className={`b ${s.dir > 0 ? 'b-long' : 'b-short'}`}>
                        {s.dir > 0 ? 'LONG' : 'SHORT'}
                      </span>
                    </td>
                    <td className="num">{fmtP(s.entry, s.tick)}</td>
                    <td className="num">
                      {isN(s.exitPrice) ? fmtP(s.exitPrice, s.tick) : '—'}
                    </td>
                    <td className={`num ${clsPnL(s.R)}`}>
                      {isN(s.R) ? `${s.R! >= 0 ? '+' : ''}${s.R!.toFixed(2)}R` : '—'}
                    </td>
                    <td className="out">{OUT_MAP[s.outcome || ''] || s.outcome || ''}</td>
                    <td className="dim">{fmtAgo(s.tEnd || s.t0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="hint" style={{ textAlign: 'center', margin: '8px 0' }}>
        إشارات تحليلية وتداول تجريبي (Paper Trading) بدون أموال حقيقية — راجع صفحة «الأداء»
        لنتائج الإشارات الفعلية والباكتيست المحسّن قبل أي استخدام بمال حقيقي.
      </div>
    </div>
  );
}
