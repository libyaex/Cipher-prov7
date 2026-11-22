'use client';

import React, { useEffect, useState } from 'react';
import { PlayCircle, Search, Wallet } from 'lucide-react';
import { f2 } from '@/lib/cx-engine/analyzer';
import { isN, TF_MS } from '@/lib/cx-engine/indicators';
import { headline } from '@/lib/cx-engine/planner';
import type { ModeConfig, PaperPosition } from '@/lib/cx-engine/types';
import CandlestickChart, { type ChartOverlayData } from '@/components/CandlestickChart';
import LiquidityRadar from '@/components/LiquidityRadar';
import {
  clsPnL,
  fmtAgo,
  fmtClock,
  fmtCountdown,
  fmtNum,
  fmtP,
  fmtPct,
  fmtUsd,
  REG_MAP,
  scoreColor,
  shortSym,
} from '@/lib/client/formatters';
import type { CipherClientEngine } from '@/lib/client/market-engine';

interface ChartTabProps {
  engine: CipherClientEngine;
  openPositions: PaperPosition[];
  onOpenWallet?: () => void;
  onExecutePaper: (sym: string, evaluation?: any) => Promise<void>;
  onToast: (msg: string, kind?: 'long' | 'short' | 'bad' | 'info') => void;
  tickVersion: number;
}

const TFL: Record<string, string> = {
  trigger: 'محفّز',
  setup: 'وسيط',
  trend: 'اتجاه',
  htf: 'أعلى',
};

export default function ChartTab({
  engine,
  openPositions,
  onOpenWallet,
  onExecutePaper,
  onToast,
  tickVersion,
}: ChartTabProps) {
  const [role, setRole] = useState<'trigger' | 'setup' | 'trend' | 'htf'>('trigger');
  const [customSym, setCustomSym] = useState('');
  const [fundingCountdown, setFundingCountdown] = useState('—');
  const [nowMs, setNowMs] = useState(0);
  const [executing, setExecuting] = useState(false);

  const S = engine.storeState;
  const sym = S.active || S.universe[0] || 'BTCUSDT';
  const r = engine.rec(sym);
  const R = r.report;
  const tfs = engine.tfs();
  const tick = r.meta.tick;
  const activePaper = openPositions.find(
    (p) => p.symbol === sym && (p.status === 'OPEN' || p.status === 'PENDING')
  );

  useEffect(() => {
    const update = () => {
      const rec = engine.rec(sym);
      const n = Date.now();
      setNowMs(n);
      setFundingCountdown(fmtCountdown((rec.next || 0) - n));
    };
    const t0 = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [engine, sym]);

  const tf = tfs[role] || tfs.trigger;
  const candles = (r.candles[tf] || []).slice(-700);
  const Sbundle = r.ctx ? r.ctx.B[role] : null;

  const overlay: ChartOverlayData = {
    key: sym + tf,
    candles,
    S: Sbundle,
    tick,
    ms: TF_MS[tf] || 900e3,
    zones: [],
    levels: [],
    plan: null,
  };

  if (R && r.ctx) {
    const mkz = (Sx: any, z: any) => ({
      top: z.top,
      bot: z.bot,
      dir: z.dir,
      kind: z.kind,
      label: z.kind === 'OB' ? 'OB' : z.kind === 'BRK' ? 'BRK' : 'FVG',
      t0: Sx.t[z.form],
    });
    if (role === 'trigger' && r.ctx.B.trigger) {
      overlay.zones = R.zones.T.ob
        .concat(R.zones.T.fvg, R.zones.T.brk || [])
        .map((z: any) => mkz(r.ctx!.B.trigger, z));
    } else if (role === 'setup' && r.ctx.B.setup) {
      overlay.zones = R.zones.S.ob
        .concat(R.zones.S.fvg, R.zones.S.brk || [])
        .map((z: any) => mkz(r.ctx!.B.setup, z));
    }
    const lv = R.levels
      .filter((L: any) => Math.abs(L.p - R.price) < 7 * R.atr)
      .sort((a: any, b: any) => b.strength - a.strength)
      .slice(0, 8);
    overlay.levels = lv.map((L: any) => ({
      p: L.p,
      label: `${L.kind === 'swing' ? '' : L.kind + ' '}${f2(L.p)}`,
      kind: 'lvl',
    }));
    if (R.vp) {
      overlay.levels.push(
        { p: R.vp.poc, label: 'POC', kind: 'poc' },
        { p: R.vp.vah, label: 'VAH', kind: 'poc' },
        { p: R.vp.val, label: 'VAL', kind: 'poc' }
      );
    }
    for (const pl of R.pools) {
      if (pl.swept < 0) {
        overlay.levels.push({
          p: pl.level,
          label: pl.side === 'high' ? 'EQH' : 'EQL',
          kind: 'liq',
        });
      }
    }
  }

  const liveSig = engine.getLiveSignals().find((s) => s.sym === sym);
  if (activePaper) {
    overlay.plan = {
      entry: activePaper.entryPrice,
      stop: activePaper.stopCurrent,
      type: activePaper.orderType,
      tps: activePaper.tps.map((t) => ({ p: t.p, r: t.r })),
      liqPrice: activePaper.liqPrice,
    };
  } else if (liveSig) {
    overlay.plan = {
      entry: liveSig.entry,
      stop: liveSig.stop,
      type: liveSig.type,
      tps: liveSig.tps.map((t, k) => ({ p: t.p, r: liveSig.rr[k] })),
    };
  } else if (R && R.plan && R.plan.ok) {
    overlay.plan = {
      entry: R.plan.entry!,
      stop: R.plan.stop!,
      type: R.plan.type,
      tps: (R.plan.tps || []).map((t) => ({ p: t.p, r: t.r })),
      liqPrice: R.plan.size?.liq,
    };
  }

  const symOptions = S.universe.includes(sym) ? S.universe : [sym, ...S.universe];
  const cfg = engine.getSettings();

  const renderTrd = (v: number) =>
    v > 0.25 ? (
      <span className="pos">صاعد</span>
    ) : v < -0.25 ? (
      <span className="neg">هابط</span>
    ) : (
      <span className="mut">محايد</span>
    );

  const B = r.book && (nowMs === 0 || nowMs - r.bookAt < 120e3) ? r.book : null;
  const bids = B ? B.bids.slice(0, 10) : [];
  const asks = B ? B.asks.slice(0, 10) : [];
  const mxBook = B ? Math.max(...bids.map((x) => x[1]), ...asks.map((x) => x[1]), 1) : 1;

  const liqs = S.liq.slice(-14).reverse();

  const submitCustomSymbol = () => {
    const v = customSym.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!v) return;
    const target = v.endsWith('USDT') ? v : `${v}USDT`;
    if (!S.meta[target]) {
      onToast('الرمز غير موجود في عقود USDⓈ-M الدائمة', 'bad');
      return;
    }
    setCustomSym('');
    engine.setActive(target);
  };

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <select
          value={sym}
          onChange={(e) => engine.setActive(e.target.value)}
          style={{ maxWidth: 165 }}
        >
          {symOptions.map((s) => (
            <option key={s} value={s}>
              {shortSym(s)}/USDT
            </option>
          ))}
        </select>
        <div className="row" style={{ gap: 4, flex: '1 1 180px', maxWidth: 230 }}>
          <input
            placeholder="رمز آخر مثل PEPE"
            value={customSym}
            onChange={(e) => setCustomSym(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustomSymbol();
            }}
          />
          <button
            type="button"
            className="btn sm"
            onClick={submitCustomSymbol}
            title="فتح الرمز"
          >
            <Search size={13} />
            <span>عرض</span>
          </button>
        </div>
        <div className="seg" style={{ flex: 1, minWidth: 200 }}>
          {(['trigger', 'setup', 'trend', 'htf'] as const)
            .filter((k) => Boolean(tfs[k as keyof ModeConfig]))
            .map((k) => (
              <button
                key={k}
                type="button"
                className={role === k ? 'on' : ''}
                onClick={() => setRole(k)}
              >
                {tfs[k]} <small className="dim">{TFL[k]}</small>
              </button>
            ))}
        </div>
      </div>

      <div className="pricehead">
        <div>
          <div className="hint">{shortSym(sym)}/USDT PERP</div>
          <div className="px">{fmtP(r.price, tick)}</div>
        </div>
        <div className={`num ${clsPnL(r.chg)}`} style={{ fontSize: 15 }}>
          {fmtPct(r.chg)} <span className="hint">24س</span>
        </div>
        <div className="hint num">
          H {fmtP(r.hi, tick)} · L {fmtP(r.lo, tick)} · Vol {fmtUsd(r.vol)}
        </div>
      </div>

      <CandlestickChart data={overlay} />

      {activePaper && (
        <div
          className="card"
          style={{
            marginTop: 8,
            borderColor: 'rgba(0, 245, 255, 0.35)',
            padding: '10px 12px',
          }}
        >
          <div className="row sb wrap">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className={`b ${activePaper.side === 'LONG' ? 'b-long' : 'b-short'}`}>
                مركز {activePaper.side} {activePaper.leverage}x
              </span>
              <span className={`b ${activePaper.status === 'OPEN' ? 'b-open' : 'b-pend'}`}>
                {activePaper.status === 'OPEN' ? 'مفتوحة الآن' : 'أمر Limit معلق'}
              </span>
              {activePaper.meta?.shieldActive && (
                <span className="b b-good">درع +{activePaper.meta.shieldLockR}R</span>
              )}
              {activePaper.meta?.smartTpPartialDone && (
                <span className="b b-open">
                  جني ذكي جزئي (+{Number(activePaper.meta.smartTpPartialR || 0).toFixed(2)}R)
                </span>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {activePaper.status === 'OPEN' && isN(r.price) && (
                <span
                  className={`num ${clsPnL(
                    (activePaper.side === 'LONG' ? 1 : -1) *
                      (r.price - activePaper.entryPrice) *
                      activePaper.remainingQty
                  )}`}
                  style={{ fontWeight: 700 }}
                >
                  {(() => {
                    const dir = activePaper.side === 'LONG' ? 1 : -1;
                    const u = dir * (r.price - activePaper.entryPrice) * activePaper.remainingQty;
                    return `${u >= 0 ? '+' : ''}${u.toFixed(2)}$`;
                  })()}
                </span>
              )}
              <button
                type="button"
                className="btn sm pri"
                onClick={() => onOpenWallet?.()}
              >
                <Wallet size={13} />
                <span>إدارة في المحفظة</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="two">
        <div>
          {/* Report Card */}
          <div className="card">
            <h3>
              تقرير التحليل
              <span className="sub">شموع مغلقة فقط — لا إعادة رسم</span>
            </h3>
            {!R ? (
              <div className="empty">
                {r.loading ? 'جارٍ تحميل البيانات…' : r.err || 'لا بيانات كافية بعد'}
              </div>
            ) : (
              <>
                <div className="row" style={{ gap: 12, marginBottom: 8 }}>
                  <div
                    className="ring"
                    style={{ ['--v' as any]: R.score, ['--c' as any]: scoreColor(R.score) }}
                  >
                    <b>{R.score}</b>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="row wrap">
                      {R.dir ? (
                        <span className={`b ${R.dir > 0 ? 'b-long' : 'b-short'}`}>
                          {R.dir > 0 ? 'LONG' : 'SHORT'}
                        </span>
                      ) : (
                        <span className="b b-watch">محايد</span>
                      )}
                      {R.tier !== 'NONE' && (
                        <span
                          className={`b b-${
                            R.tier === 'STRONG' ? 'strong' : R.tier === 'GOOD' ? 'good' : 'watch'
                          }`}
                        >
                          {R.tier}
                        </span>
                      )}
                      <span className="b b-watch">{R.grade}</span>
                      {R.regime.squeezeFired && (
                        <span className="b b-strong">انفجار TTM Squeeze</span>
                      )}
                      {!R.regime.squeezeFired && R.regime.ttmSqueeze && (
                        <span className="b b-pend">انضغاط TTM</span>
                      )}
                      {R.sessionLabel && (
                        <span className="b b-watch">{R.sessionLabel}</span>
                      )}
                      {R.btcContext && sym !== 'BTCUSDT' && (
                        <span
                          className={`b ${
                            R.btcContext.shock
                              ? 'b-short'
                              : R.btcContext.dir > 0
                                ? 'b-open'
                                : R.btcContext.dir < 0
                                  ? 'b-pend'
                                  : 'b-watch'
                          }`}
                        >
                          {R.btcContext.detail}
                        </span>
                      )}
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {headline(R, shortSym(r.sym))}
                    </div>
                  </div>
                </div>

                <div className="grid g4" style={{ gap: 6, marginBottom: 8 }}>
                  <div className="tile">
                    <div className="l">صافي الميل</div>
                    <div className={`v ${clsPnL(R.net)}`}>
                      {R.net >= 0 ? '+' : ''}
                      {R.net.toFixed(2)}
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">عوامل متوافقة</div>
                    <div className="v">
                      {R.aligned}/{R.parts.length}
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">ATR / VWAP Z</div>
                    <div className="v" style={{ fontSize: 13 }}>
                      {R.atrp.toFixed(2)}%{' '}
                      <span className="dim">
                        / {isN(R.vwapZ) ? `${R.vwapZ! >= 0 ? '+' : ''}${R.vwapZ!.toFixed(1)}σ` : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">النظام</div>
                    <div className="v" style={{ fontSize: 13 }}>
                      {REG_MAP[R.regime.type] || R.regime.type}
                      {R.regime.squeezeFired
                        ? ' · انفجار!'
                        : R.regime.ttmSqueeze
                          ? ' · TTM'
                          : R.regime.squeeze
                            ? ' · انضغاط'
                            : ''}
                      {R.regime.expansion ? ' · تمدد' : ''}
                    </div>
                  </div>
                </div>

                {R.parts.map((p) => {
                  const w = Math.abs(p.raw) * 50;
                  const col = p.raw >= 0 ? 'var(--green)' : 'var(--red)';
                  return (
                    <div key={p.key} className="part">
                      <div className="ph">
                        <span>
                          {p.label} <span className="dim num">×{p.wEff.toFixed(0)}</span>
                        </span>
                        <b className={`num ${clsPnL(p.raw)}`}>
                          {p.raw >= 0 ? '+' : ''}
                          {p.raw.toFixed(2)}
                        </b>
                      </div>
                      <div className="bar">
                        <span className="mid" />
                        <i
                          style={{
                            ...(p.raw >= 0 ? { left: '50%' } : { right: '50%' }),
                            width: `${w}%`,
                            background: col,
                          }}
                        />
                      </div>
                      <div className="pd">{p.detail}</div>
                    </div>
                  );
                })}

                {R.gates.map((g, i) => (
                  <div key={i} className="warn">
                    ⛔ {g} — الدرجة محدودة بـ {R.cap}
                  </div>
                ))}
                {R.warns.map((w, i) => (
                  <div key={i} className="warn">
                    ⚠ {w}
                  </div>
                ))}
                <div className="hint" style={{ marginTop: 8 }}>
                  الدرجة = 50 + 50 × (صافي الميل × 1.6). الحدود: WATCH ≥ {cfg.watchScore} · GOOD ≥{' '}
                  {cfg.minScore} · STRONG ≥ {cfg.strongScore} (مع 5 عوامل متوافقة).
                </div>
              </>
            )}
          </div>

          {/* Plan Card */}
          <div className="card">
            <h3>
              خطة الصفقة{' '}
              {liveSig ? (
                <span className="b b-open">إشارة مفعّلة</span>
              ) : R?.plan?.ok ? (
                <span className={`b ${R.tier === 'WATCH' ? 'b-watch' : 'b-good'}`}>
                  {R.tier === 'WATCH' ? 'معاينة — دون حد الإصدار' : 'جاهزة للإصدار'}
                </span>
              ) : null}
            </h3>

            {!R || !R.dir ? (
              <div className="empty" style={{ padding: 12 }}>
                لا اتجاه واضح — لا خطة.
              </div>
            ) : !R.plan ? (
              <div className="empty" style={{ padding: 12 }}>
                الدرجة {R.score} دون حد المراقبة — لا خطة دخول.
              </div>
            ) : !R.plan.ok ? (
              <>
                <div className="warn">لا خطة دخول الآن: {R.plan.why}</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  رفض الخطة جزء من الانضباط: لا نصدر إشارة بلا منطقة قيمة قريبة ووقف هيكلي وعائد/مخاطرة مقبول.
                </div>
              </>
            ) : (
              (() => {
                const P = R.plan!;
                const sz = P.size!;
                const rows = [
                  { k: 'sl', n: 'الوقف', p: P.stop!, r: '-1R' },
                  { k: 'entry', n: 'الدخول', p: P.entry!, r: '' },
                  ...(P.tps || []).map((t, k) => ({
                    k: 'tp',
                    n: `TP${k + 1}`,
                    p: t.p,
                    r: `${t.r.toFixed(2)}R · ${t.pct}%`,
                  })),
                ];
                if (sz.liq > 0) rows.push({ k: 'liq', n: 'التصفية', p: sz.liq, r: `أمان ${sz.safetyBufferPct.toFixed(0)}%` });
                if (isN(R.price)) rows.push({ k: 'now', n: 'الآن', p: R.price, r: '' });
                rows.sort((a, b) => b.p - a.p);

                return (
                  <>
                    <div className="ladder">
                      {rows.map((x, idx) => (
                        <div key={idx} className={`lv ${x.k}`}>
                          <span className="n">{x.n}</span>
                          <span className="p num">{fmtP(x.p, tick)}</span>
                          {x.k === 'entry' && (
                            <span className={`b ${P.type === 'MARKET' ? 'b-open' : 'b-pend'}`}>
                              {P.type === 'MARKET' ? '⚡ سوقي الآن' : '⏳ Limit'}
                            </span>
                          )}
                          <span className="r">{x.r}</span>
                        </div>
                      ))}
                    </div>
                    <div className="hint">
                      {P.type === 'MARKET'
                        ? 'دخول سوقي عند السعر الحالي'
                        : `أمر Limit — السعر الحالي ${fmtP(R.price, tick)}`}{' '}
                      · الوقف خلف {P.stopRef} ({P.riskATR?.toFixed(2)}×ATR / {P.riskPct?.toFixed(2)}
                      %) · رسوم+انزلاق ≈ {P.feeR?.toFixed(2)}R
                    </div>
                    <div className="sep" />
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                      {P.type === 'MARKET'
                        ? 'لماذا السعر الحالي هو سعر الدخول؟'
                        : 'لماذا ليس السعر الحالي؟'}
                    </div>
                    {(P.checks || []).map((c, idx) => (
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
                    {(P.warnings || []).map((w, idx) => (
                      <div key={idx} className="warn">
                        ⚠ {w}
                      </div>
                    ))}
                    <div className="sep" />
                    <div className="row sb wrap">
                      <div className="hint">
                        {sz.ok
                          ? `الحجم: ${sz.qty} · رافعة ${sz.lev}x · هامش ${sz.margin.toFixed(1)}$ · مخاطرة ${sz.effRiskUsd.toFixed(2)}$`
                          : sz.note}
                      </div>
                      {activePaper ? (
                        <button
                          type="button"
                          className="btn sm pri"
                          onClick={() => onOpenWallet?.()}
                        >
                          <Wallet size={13} />
                          <span>مفتوحة في المحفظة</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm green"
                          disabled={!sz.ok || !sz.safetyOk || executing}
                          onClick={async () => {
                            setExecuting(true);
                            try {
                              await onExecutePaper(sym, R);
                            } finally {
                              setExecuting(false);
                            }
                          }}
                        >
                          <PlayCircle size={13} />
                          <span>{executing ? 'جارٍ التنفيذ…' : 'تنفيذ في المحفظة التجريبية'}</span>
                        </button>
                      )}
                    </div>
                  </>
                );
              })()
            )}
          </div>

          {/* MTF Card */}
          {R && (
            <div className="card">
              <h3>الأطر الزمنية</h3>
              <div className="tblw">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>الإطار</th>
                      <th>الاتجاه</th>
                      <th>EMA</th>
                      <th>ST</th>
                      <th>الهيكل</th>
                      <th>ADX</th>
                      <th>RSI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['htf', 'trend', 'setup', 'trigger'] as const).map((rl) => {
                      const s = R.state[rl];
                      const tfName = R.tf[rl];
                      if (!s || !tfName) return null;
                      return (
                        <tr key={rl}>
                          <td>
                            <b>{tfName}</b> <span className="dim">{TFL[rl]}</span>
                          </td>
                          <td>{renderTrd(s.score)}</td>
                          <td>
                            {s.ema > 0 ? (
                              <span className="pos">فوق EMA</span>
                            ) : s.ema < 0 ? (
                              <span className="neg">تحت EMA</span>
                            ) : (
                              <span className="mut">متشابك</span>
                            )}
                          </td>
                          <td>{s.st > 0 ? <span className="pos">↑</span> : <span className="neg">↓</span>}</td>
                          <td>
                            {s.struct > 0 ? (
                              <span className="pos">HH/HL</span>
                            ) : s.struct < 0 ? (
                              <span className="neg">LH/LL</span>
                            ) : (
                              <span className="mut">عرضي</span>
                            )}
                          </td>
                          <td className="num">{fmtNum(s.adx, 0)}</td>
                          <td className={`num ${s.rsi > 70 ? 'neg' : s.rsi < 30 ? 'pos' : ''}`}>
                            {fmtNum(s.rsi, 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Levels & Liquidity */}
          {R && (
            <div className="card">
              <h3>المستويات والسيولة</h3>
              <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700 }}>مقاومات</div>
              {R.levels
                .filter((L: any) => L.p > R.price)
                .sort((a: any, b: any) => a.p - b.p)
                .slice(0, 5)
                .reverse()
                .map((L: any, i: number) => (
                  <div key={i} className="kv">
                    <span>
                      {L.kind === 'swing' ? 'مستوى' : L.kind}{' '}
                      <span className="dim">{(L.tfs || []).join('/')}</span>
                    </span>
                    <span className="num">
                      {fmtP(L.p, tick)}{' '}
                      <span className="dim">
                        ({R.price > 0 ? ((100 * (L.p - R.price)) / R.price).toFixed(2) : '0.00'}% ·{' '}
                        {'★'.repeat(Math.min(5, Math.max(1, Math.round(L.strength / 3))))})
                      </span>
                    </span>
                  </div>
                ))}
              <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700, marginTop: 8 }}>
                دعوم
              </div>
              {R.levels
                .filter((L: any) => L.p < R.price)
                .sort((a: any, b: any) => b.p - a.p)
                .slice(0, 5)
                .map((L: any, i: number) => (
                  <div key={i} className="kv">
                    <span>
                      {L.kind === 'swing' ? 'مستوى' : L.kind}{' '}
                      <span className="dim">{(L.tfs || []).join('/')}</span>
                    </span>
                    <span className="num">
                      {fmtP(L.p, tick)}{' '}
                      <span className="dim">
                        ({R.price > 0 ? ((100 * (L.p - R.price)) / R.price).toFixed(2) : '0.00'}% ·{' '}
                        {'★'.repeat(Math.min(5, Math.max(1, Math.round(L.strength / 3))))})
                      </span>
                    </span>
                  </div>
                ))}
              <div className="sep" />
              {R.vp && (
                <div className="kv">
                  <span>Volume Profile</span>
                  <span className="num">
                    POC {fmtP(R.vp.poc, tick)} · VAH {fmtP(R.vp.vah, tick)} · VAL {fmtP(R.vp.val, tick)}
                  </span>
                </div>
              )}
              {(R.range.S || R.range.T) && (
                <>
                  <div className="kv">
                    <span>النطاق الحالي</span>
                    <span className="num">
                      {fmtP((R.range.S || R.range.T).lo, tick)} – {fmtP((R.range.S || R.range.T).hi, tick)} ·{' '}
                      {((R.range.S || R.range.T).pos * 100).toFixed(0)}%{' '}
                      {(R.range.S || R.range.T).pos < 0.5 ? '(خصم)' : '(علاوة)'}
                    </span>
                  </div>
                  <div className="kv">
                    <span>منطقة OTE</span>
                    <span className="num">
                      {fmtP((R.range.S || R.range.T).ote[0], tick)} –{' '}
                      {fmtP((R.range.S || R.range.T).ote[1], tick)}
                    </span>
                  </div>
                </>
              )}
              {R.pools
                .filter((p: any) => p.swept < 0)
                .map((p: any, i: number) => (
                  <div key={i} className="kv">
                    <span>
                      سيولة {p.side === 'high' ? 'Equal Highs' : 'Equal Lows'} ({p.n})
                    </span>
                    <span className="num">{fmtP(p.level, tick)}</span>
                  </div>
                ))}
              {R.sweeps[0] && (
                <div className="kv">
                  <span>آخر كنس سيولة</span>
                  <span className="num">
                    {R.sweeps[0].side === 'sell' ? 'قيعان' : 'قمم'} @ {fmtP(R.sweeps[0].level, tick)} · قبل{' '}
                    {R.sweeps[0].ago} شمعة
                  </span>
                </div>
              )}
              {R.patterns.length > 0 && (
                <div className="kv">
                  <span>أنماط الشمعة الأخيرة</span>
                  <span>{R.patterns.map((p: any) => p.ar).join('، ')}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <LiquidityRadar
            engine={engine}
            variant="detail"
            sym={sym}
            onToast={onToast}
            tickVersion={tickVersion}
          />

          {/* Derivatives */}
          <div className="card">
            <h3>
              المشتقات (Binance Futures)
              <span className="sub">بيانات حقيقية</span>
            </h3>
            <div className="kv">
              <span>Funding الحالي</span>
              <span
                className={`num ${
                  r.funding > 0.0004 ? 'neg' : r.funding < -0.0004 ? 'pos' : ''
                }`}
              >
                {isN(r.funding) ? `${(r.funding * 100).toFixed(4)}%` : '—'}
              </span>
            </div>
            <div className="kv">
              <span>التسوية القادمة بعد</span>
              <span className="num">{fundingCountdown}</span>
            </div>
            <div className="kv">
              <span>Mark / Index</span>
              <span className="num">
                {fmtP(r.mark, tick)} / {fmtP(r.index, tick)}
              </span>
            </div>
            <div className="kv">
              <span>Basis</span>
              <span className="num">
                {R?.deriv && isN(R.deriv.basisBps) ? `${R.deriv.basisBps!.toFixed(1)} bps` : '—'}
              </span>
            </div>
            <div className="kv">
              <span>Open Interest</span>
              <span className="num">
                {R?.deriv && isN(R.deriv.oiUsd) ? (
                  fmtUsd(R.deriv.oiUsd)
                ) : (
                  <span className="dim">يُجلب للمرشحين</span>
                )}
              </span>
            </div>
            <div className="kv">
              <span>تغير OI (1س / 4س)</span>
              <span className="num">
                {R?.deriv && isN(R.deriv.oiChg4h) ? (
                  <>
                    <span className={clsPnL(R.deriv.oiChg1h)}>{fmtPct(R.deriv.oiChg1h)}</span> /{' '}
                    <span className={clsPnL(R.deriv.oiChg4h)}>{fmtPct(R.deriv.oiChg4h)}</span>
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="kv">
              <span>Long/Short (كل الحسابات)</span>
              <span className="num">
                {R?.deriv && isN(R.deriv.lsRatio)
                  ? `${R.deriv.lsRatio!.toFixed(2)} (${R.deriv.lsLongPct!.toFixed(0)}% لونج)`
                  : '—'}
              </span>
            </div>
            <div className="kv">
              <span>كبار المتداولين (مراكز)</span>
              <span className="num">
                {R?.deriv && isN(R.deriv.topLongPct) ? `${R.deriv.topLongPct!.toFixed(0)}% لونج` : '—'}
              </span>
            </div>
            <div className="kv">
              <span>Taker Buy/Sell (ساعة)</span>
              <span
                className={`num ${
                  R?.deriv?.takerRatio && R.deriv.takerRatio > 1.1
                    ? 'pos'
                    : R?.deriv?.takerRatio && R.deriv.takerRatio < 0.9
                      ? 'neg'
                      : ''
                }`}
              >
                {R?.deriv && isN(R.deriv.takerRatio) ? R.deriv.takerRatio!.toFixed(2) : '—'}
              </span>
            </div>
            <div className="kv">
              <span>تصفيات 15د (لونج / شورت)</span>
              <span className="num">
                {R?.deriv ? (
                  <>
                    <span className="neg">{fmtUsd(R.deriv.liqLong15)}</span> /{' '}
                    <span className="pos">{fmtUsd(R.deriv.liqShort15)}</span>
                  </>
                ) : (
                  '—'
                )}
              </span>
            </div>
          </div>

          {/* Orderbook */}
          <div className="card">
            <h3>
              دفتر الأوامر الحقيقي
              {B && <span className="sub">{fmtAgo(B.t)}</span>}
            </h3>
            {!B ? (
              <div className="empty" style={{ padding: 12 }}>
                {r.bbo && (
                  <>
                    أفضل سعر: {fmtP(r.bbo.bid, tick)} / {fmtP(r.bbo.ask, tick)} · سبريد{' '}
                    {r.bbo.spreadBps.toFixed(2)}bps
                    <br />
                  </>
                )}
                جارٍ جلب العمق…
              </div>
            ) : (
              <>
                <div className="grid g3" style={{ gap: 6, marginBottom: 8 }}>
                  <div className="tile">
                    <div className="l">السبريد</div>
                    <div className="v">
                      {(r.bbo && (nowMs === 0 || nowMs - r.bbo.t < 10e3) ? r.bbo.spreadBps : B.spreadBps).toFixed(2)}bp
                    </div>
                  </div>
                  <div className="tile">
                    <div className="l">الاختلال ±{B.bandPct.toFixed(2)}%</div>
                    <div className={`v ${clsPnL(B.imb05)}`}>{(B.imb05 * 100).toFixed(0)}%</div>
                  </div>
                  <div className="tile">
                    <div className="l">شراء/بيع</div>
                    <div className="v" style={{ fontSize: 12 }}>
                      {fmtUsd(B.bid05)}/{fmtUsd(B.ask05)}
                    </div>
                  </div>
                </div>
                <div className="dp">
                  <div className="b">
                    {bids.map(([p, q], i) => (
                      <div key={i} className="rw b">
                        <i style={{ width: `${((q / mxBook) * 100).toFixed(0)}%` }} />
                        <span>{fmtP(p, tick)}</span>
                        <span>{q >= 100 ? q.toFixed(0) : q.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="a">
                    {asks.map(([p, q], i) => (
                      <div key={i} className="rw a">
                        <i style={{ width: `${((q / mxBook) * 100).toFixed(0)}%` }} />
                        <span>{fmtP(p, tick)}</span>
                        <span>{q >= 100 ? q.toFixed(0) : q.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {B.bidWall && (
                  <div className="hint">
                    جدار شراء {fmtP(B.bidWall.p, tick)} ({fmtUsd(B.bidWall.usd)})
                  </div>
                )}
                {B.askWall && (
                  <div className="hint">
                    جدار بيع {fmtP(B.askWall.p, tick)} ({fmtUsd(B.askWall.usd)})
                  </div>
                )}
              </>
            )}
          </div>

          {/* Live Liquidations */}
          <div className="card">
            <h3>
              تصفيات السوق الحية
              <span className="sub">!forceOrder@arr</span>
            </h3>
            {liqs.length ? (
              <div className="tblw">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>الوقت</th>
                      <th>الرمز</th>
                      <th>النوع</th>
                      <th>القيمة</th>
                      <th>السعر</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liqs.map((x, i) => (
                      <tr key={i}>
                        <td className="dim">{fmtClock(x.t)}</td>
                        <td>
                          <span className="sym">{shortSym(x.sym)}</span>
                        </td>
                        <td>
                          {x.side === 'SELL' ? (
                            <span className="neg">تصفية لونج</span>
                          ) : (
                            <span className="pos">تصفية شورت</span>
                          )}
                        </td>
                        <td className="num">{fmtUsd(x.usd)}</td>
                        <td className="num dim">{fmtP(x.price, S.meta[x.sym]?.tick)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty" style={{ padding: 12 }}>
                بانتظار أحداث التصفية من Binance… (تظهر عند حدوثها فقط)
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
