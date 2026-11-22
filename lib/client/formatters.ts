import { isN, util } from '../cx-engine/indicators';
import type { PaperPosition } from '../cx-engine/types';

export const REG_MAP: Record<string, string> = {
  trend: 'اتجاه',
  range: 'عرضي',
  mixed: 'مختلط',
};

export const OUT_MAP: Record<string, string> = {
  SL: 'وقف خسارة',
  TP1: 'TP1',
  TP2: 'TP2',
  TP3: 'TP3 كامل',
  'TP1+BE': 'TP1 ثم تعادل',
  'TP2+BE': 'TP2 ثم وقف',
  'TP3+BE': 'TP3',
  TRAIL_PROFIT: 'حماية أرباح ديناميكية',
  SMART_EXIT: 'خروج ذكي (انعكاس السيولة)',
  SMART_PARTIAL_TP: 'جني أرباح ذكي جزئي',
  MANUAL: 'إغلاق يدوي',
  EXPIRED: 'انتهت',
  MISSED: 'فاتت',
  LIQUIDATED: 'تصفية',
  EMERGENCY_STOP: 'إيقاف طارئ',
  WALLET_RESET: 'إعادة ضبط المحفظة',
  CANCELLED_MANUAL: 'إلغاء يدوي',
};

export const fmtP = (p: number | null | undefined, tick?: number) =>
  isN(p) ? util.fmtP(p as number, tick) : '—';

export const fmtPct = (x: number | null | undefined, d = 2) =>
  isN(x) ? `${(x as number) >= 0 ? '+' : ''}${(x as number).toFixed(d)}%` : '—';

export const fmtNum = (x: number | null | undefined, d = 2) =>
  isN(x) ? (x as number).toFixed(d) : '—';

export const clsPnL = (x: number | null | undefined) =>
  isN(x) ? ((x as number) > 0 ? 'pos' : (x as number) < 0 ? 'neg' : '') : '';

export const fmtUsd = (x: number | null | undefined) => {
  if (!isN(x)) return '—';
  const v = x as number;
  const a = Math.abs(v);
  return `${v < 0 ? '-' : ''}$${
    a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0)
  }`;
};

export const fmtAgo = (t: number | string) => {
  const ms = typeof t === 'string' ? new Date(t).getTime() : t;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60
    ? 'الآن'
    : s < 3600
      ? `منذ ${Math.floor(s / 60)} د`
      : s < 86400
        ? `منذ ${Math.floor(s / 3600)} س`
        : `منذ ${Math.floor(s / 86400)} يوم`;
};

export const fmtClock = (t: number | string) =>
  new Date(t).toLocaleTimeString('ar-LY', { hour: '2-digit', minute: '2-digit', hour12: false });

export const fmtDt = (t: number | string) =>
  new Date(t).toLocaleString('ar-LY', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export const fmtCountdown = (ms: number) => {
  if (!(ms > 0)) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const shortSym = (s: string) => s.replace(/USDT$/, '');

export const scoreColor = (s: number) =>
  s >= 80 ? 'var(--gold)' : s >= 70 ? 'var(--cyan)' : s >= 62 ? 'var(--tx2)' : 'var(--tx3)';

export function calcClientPortfolioHeatUsd(trades: PaperPosition[]): number {
  let total = 0;
  for (const t of trades) {
    if (t.status !== 'OPEN' && t.status !== 'PENDING') continue;
    const perUnitRisk =
      t.side === 'LONG'
        ? Math.max(0, t.entryPrice - t.stopCurrent)
        : Math.max(0, t.stopCurrent - t.entryPrice);
    total += perUnitRisk * t.remainingQty;
  }
  return total;
}
