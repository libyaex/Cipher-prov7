'use client';

import React, { useState } from 'react';
import { ArrowDownUp, Search, X } from 'lucide-react';
import { isN } from '@/lib/cx-engine/indicators';
import {
  clsPnL,
  fmtNum,
  fmtP,
  fmtPct,
  fmtUsd,
  REG_MAP,
  scoreColor,
  shortSym,
} from '@/lib/client/formatters';
import type { CipherClientEngine } from '@/lib/client/market-engine';
import type { OfflineMarketSummary } from '@/lib/client/offline-store';

interface MarketTabProps {
  engine: CipherClientEngine;
  offlineMarket?: OfflineMarketSummary[];
  onOpenChart: (sym: string) => void;
  tickVersion: number;
}

type SortKey = 'score' | 'vol' | 'chg' | 'funding' | 'oi';
type QuickFilter = 'all' | 'ready' | 'fav' | 'long' | 'short' | 'ttm';

export default function MarketTab({
  engine,
  offlineMarket,
  onOpenChart,
}: MarketTabProps) {
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('score');
  const [sortAsc, setSortAsc] = useState(false);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');

  const S = engine.storeState;
  const tfs = engine.tfs();
  const cfg = engine.getSettings();
  const favSet = new Set(cfg.favorites);
  const readyRows = S.universe.map((sym) => engine.rec(sym)).filter((r) => r.ready);

  const toggleSort = (k: SortKey) => {
    if (sortBy === k) {
      setSortAsc((v) => !v);
    } else {
      setSortBy(k);
      setSortAsc(false);
    }
  };

  if (readyRows.length === 0 && offlineMarket && offlineMarket.length > 0) {
    let off = offlineMarket;
    if (query) off = off.filter((r) => r.sym.includes(query.trim().toUpperCase()));
    off = [...off].sort((a, b) => {
      const valA =
        sortBy === 'score'
          ? a.score || 0
          : sortBy === 'vol'
            ? a.vol || 0
            : sortBy === 'funding'
              ? Math.abs(a.funding || 0)
              : a.chg || 0;
      const valB =
        sortBy === 'score'
          ? b.score || 0
          : sortBy === 'vol'
            ? b.vol || 0
            : sortBy === 'funding'
              ? Math.abs(b.funding || 0)
              : b.chg || 0;
      return sortAsc ? valA - valB : valB - valA;
    });

    return (
      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 10 }}>
          <div className="row wrap" style={{ flex: 1 }}>
            <div style={{ position: 'relative', maxWidth: 220, width: '100%' }}>
              <input
                placeholder="بحث عن عملة…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingInlineStart: 28 }}
              />
              <Search
                size={13}
                style={{ position: 'absolute', insetInlineStart: 9, top: 12, color: 'var(--tx3)' }}
              />
            </div>
            <div className="chips" style={{ flex: 1 }}>
              {(
                [
                  ['score', 'الدرجة'],
                  ['vol', 'الحجم'],
                  ['chg', 'التغير'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip ${sortBy === k ? 'on' : ''}`}
                  onClick={() => toggleSort(k)}
                >
                  {lbl} {sortBy === k ? (sortAsc ? '↑' : '↓') : ''}
                </button>
              ))}
            </div>
          </div>
          <span className="b b-pend">بيانات محفوظة (دون اتصال)</span>
        </div>
        <div className="tblw">
          <table className="tbl">
            <thead>
              <tr>
                <th>الرمز</th>
                <th>السعر</th>
                <th>24س</th>
                <th>الدرجة</th>
                <th>الاتجاه</th>
                <th>RSI</th>
                <th>Funding</th>
                <th>النظام</th>
                <th>الحجم 24س</th>
              </tr>
            </thead>
            <tbody>
              {off.map((r) => (
                <tr key={r.sym} className="click" onClick={() => onOpenChart(r.sym)}>
                  <td>
                    <span className="sym">{shortSym(r.sym)}</span>
                  </td>
                  <td className="num">{fmtP(r.price)}</td>
                  <td className={`num ${clsPnL(r.chg)}`}>{fmtPct(r.chg)}</td>
                  <td className="num">{r.score ?? '—'}</td>
                  <td>
                    {r.dir ? (
                      <span className={`b ${r.dir > 0 ? 'b-long' : 'b-short'}`}>
                        {r.dir > 0 ? 'LONG' : 'SHORT'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{r.rsi != null ? fmtNum(r.rsi, 0) : '—'}</td>
                  <td className="num">
                    {isN(r.funding) ? `${(r.funding * 100).toFixed(4)}%` : '—'}
                  </td>
                  <td>{r.regime ? REG_MAP[r.regime] || r.regime : ''}</td>
                  <td className="num dim">{fmtUsd(r.vol)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const btcCtx = engine.getBtcContext();

  // Market breadth metrics across entire scanned universe
  const upCount = readyRows.filter((r) => (r.chg || 0) > 0).length;
  const dnCount = readyRows.filter((r) => (r.chg || 0) < 0).length;
  const avgChg = readyRows.length
    ? readyRows.reduce((s, r) => s + (r.chg || 0), 0) / readyRows.length
    : 0;
  const readySignalsCount = readyRows.filter(
    (r) => r.report && (r.report.tier === 'GOOD' || r.report.tier === 'STRONG') && r.report.plan?.ok
  ).length;
  const ttmCount = readyRows.filter(
    (r) => r.report?.regime?.ttmSqueeze || r.report?.regime?.squeezeFired
  ).length;
  const topMover = readyRows.length
    ? [...readyRows].sort((a, b) => Math.abs(b.chg || 0) - Math.abs(a.chg || 0))[0]
    : null;

  let rows = readyRows;
  if (query.trim()) {
    const q = query.trim().toUpperCase();
    rows = rows.filter((r) => r.sym.includes(q));
  }
  if (quickFilter === 'ready') {
    rows = rows.filter(
      (r) => r.report && (r.report.tier === 'GOOD' || r.report.tier === 'STRONG')
    );
  } else if (quickFilter === 'fav') {
    rows = rows.filter((r) => favSet.has(r.sym));
  } else if (quickFilter === 'long') {
    rows = rows.filter((r) => (r.report?.dir || 0) > 0);
  } else if (quickFilter === 'short') {
    rows = rows.filter((r) => (r.report?.dir || 0) < 0);
  } else if (quickFilter === 'ttm') {
    rows = rows.filter(
      (r) => r.report?.regime?.ttmSqueeze || r.report?.regime?.squeezeFired || r.report?.regime?.squeeze
    );
  }

  const sortedRows = [...rows].sort((a, b) => {
    let diff = 0;
    if (sortBy === 'score') diff = (b.report?.score || 0) - (a.report?.score || 0);
    else if (sortBy === 'vol') diff = (b.vol || 0) - (a.vol || 0);
    else if (sortBy === 'chg') diff = (b.chg || 0) - (a.chg || 0);
    else if (sortBy === 'funding') diff = Math.abs(b.funding || 0) - Math.abs(a.funding || 0);
    else if (sortBy === 'oi') diff = (b.report?.deriv?.oiChg4h || -999) - (a.report?.deriv?.oiChg4h || -999);
    return sortAsc ? -diff : diff;
  });

  return (
    <div>
      {/* Market Breadth Summary */}
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <div className="tile">
          <div className="l">اتساع السوق (صاعد / هابط)</div>
          <div className="v" style={{ fontSize: 14 }}>
            <span className="pos">{upCount}↑</span> / <span className="neg">{dnCount}↓</span>
            <span className={`dim`} style={{ marginInlineStart: 6, fontSize: 11.5 }}>
              ({fmtPct(avgChg, 1)})
            </span>
          </div>
        </div>
        <div className="tile">
          <div className="l">فرص جاهزة (GOOD+)</div>
          <div className="v cy">{readySignalsCount}</div>
        </div>
        <div className="tile">
          <div className="l">انضغاط / انفجار TTM</div>
          <div className="v gold">{ttmCount}</div>
        </div>
        <div className="tile">
          <div className="l">أكبر حركة 24س</div>
          <div className="v" style={{ fontSize: 13.5 }}>
            {topMover ? (
              <>
                {shortSym(topMover.sym)}{' '}
                <span className={clsPnL(topMover.chg)}>{fmtPct(topMover.chg, 1)}</span>
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row sb wrap" style={{ marginBottom: 8 }}>
          <div className="row wrap" style={{ flex: 1 }}>
            <div style={{ position: 'relative', maxWidth: 210, width: '100%' }}>
              <input
                placeholder="بحث عن عملة…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ paddingInlineStart: 28, paddingInlineEnd: query ? 28 : 10 }}
              />
              <Search
                size={13}
                style={{ position: 'absolute', insetInlineStart: 9, top: 12, color: 'var(--tx3)' }}
              />
              {query && (
                <button
                  type="button"
                  aria-label="مسح البحث"
                  onClick={() => setQuery('')}
                  style={{
                    position: 'absolute',
                    insetInlineEnd: 6,
                    top: 8,
                    padding: 4,
                    color: 'var(--tx2)',
                  }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="chips">
              {(
                [
                  ['score', 'الدرجة'],
                  ['vol', 'الحجم'],
                  ['chg', 'التغير'],
                  ['funding', 'Funding'],
                  ['oi', 'OI 4س'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  className={`chip ${sortBy === k ? 'on' : ''}`}
                  onClick={() => toggleSort(k)}
                >
                  {lbl} {sortBy === k ? (sortAsc ? '↑' : '↓') : ''}
                </button>
              ))}
              <button
                type="button"
                className="chip"
                onClick={() => setSortAsc((v) => !v)}
                title="عكس الترتيب"
              >
                <ArrowDownUp size={11} style={{ display: 'inline', marginInlineEnd: 3 }} />
                {sortAsc ? 'تصاعدي' : 'تنازلي'}
              </button>
            </div>
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

        {/* Quick Category Filters */}
        <div className="chips" style={{ marginBottom: 10 }}>
          {(
            [
              ['all', `الكل (${readyRows.length})`],
              ['ready', 'فرص GOOD+'],
              ['fav', 'المفضلة'],
              ['long', 'LONG'],
              ['short', 'SHORT'],
              ['ttm', 'انضغاط TTM'],
            ] as const
          ).map(([k, lbl]) => (
            <button
              key={k}
              type="button"
              className={`chip ${quickFilter === k ? 'on' : ''}`}
              onClick={() => setQuickFilter(k)}
            >
              {lbl}
            </button>
          ))}
        </div>

        {sortedRows.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            {readyRows.length === 0
              ? 'جارٍ تحميل بيانات السوق من Binance…'
              : 'لا توجد عملات تطابق البحث أو الفلتر الحالي.'}
            {readyRows.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setQuery('');
                    setQuickFilter('all');
                  }}
                >
                  عرض جميع العملات
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="tblw">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>السعر</th>
                  <th>24س</th>
                  <th>الدرجة</th>
                  <th>الاتجاه</th>
                  <th>RSI {tfs.trigger}</th>
                  <th>Funding</th>
                  <th>OI 4س</th>
                  <th>النظام</th>
                  <th>الحجم 24س</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const R = r.report;
                  const D = R?.deriv;
                  const rs = R ? R.state.trigger : null;
                  return (
                    <tr key={r.sym} className="click" onClick={() => onOpenChart(r.sym)}>
                      <td>
                        <span className="sym">{shortSym(r.sym)}</span>
                        {favSet.has(r.sym) && (
                          <span className="gold" style={{ marginInlineStart: 4, fontSize: 10 }}>
                            ★
                          </span>
                        )}
                      </td>
                      <td className="num">{fmtP(r.price, r.meta.tick)}</td>
                      <td className={`num ${clsPnL(r.chg)}`}>{fmtPct(r.chg)}</td>
                      <td>
                        {R ? (
                          <>
                            <span className="num" style={{ color: scoreColor(R.score) }}>
                              {R.score}
                            </span>{' '}
                            {R.tier !== 'NONE' && (
                              <span
                                className={`b b-${
                                  R.tier === 'STRONG' ? 'strong' : R.tier === 'GOOD' ? 'good' : 'watch'
                                }`}
                              >
                                {R.tier}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="dim">…</span>
                        )}
                      </td>
                      <td>
                        {R && R.dir ? (
                          <span className={`b ${R.dir > 0 ? 'b-long' : 'b-short'}`}>
                            {R.dir > 0 ? 'LONG' : 'SHORT'}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td
                        className={`num ${
                          rs && rs.rsi > 70 ? 'neg' : rs && rs.rsi < 30 ? 'pos' : ''
                        }`}
                      >
                        {rs ? fmtNum(rs.rsi, 0) : '—'}
                      </td>
                      <td
                        className={`num ${
                          isN(r.funding)
                            ? r.funding > 0.0004
                              ? 'neg'
                              : r.funding < -0.0004
                                ? 'pos'
                                : ''
                            : ''
                        }`}
                      >
                        {isN(r.funding) ? `${(r.funding * 100).toFixed(4)}%` : '—'}
                      </td>
                      <td className={`num ${D ? clsPnL(D.oiChg4h) : ''}`}>
                        {D && isN(D.oiChg4h) ? fmtPct(D.oiChg4h) : <span className="dim">—</span>}
                      </td>
                      <td>
                        {R
                          ? `${REG_MAP[R.regime.type] || ''}${
                              R.regime.squeezeFired
                                ? ' · انفجار TTM!'
                                : R.regime.ttmSqueeze
                                  ? ' · TTM'
                                  : R.regime.squeeze
                                    ? ' · انضغاط'
                                    : ''
                            }`
                          : ''}
                      </td>
                      <td className="num dim">{fmtUsd(r.vol)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint" style={{ marginTop: 8 }}>
          OI يظهر للمرشحين الأقوى فقط (توفيراً لحدود الطلبات). اضغط أي صف للتحليل الكامل.
        </div>
      </div>
    </div>
  );
}
