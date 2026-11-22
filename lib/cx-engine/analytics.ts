/* ============================================================
   CIPHER X PRO — ENGINE E : محرك التحليل التطوري وتقييم جودة الإشارات
   إحصائيات حقيقية + مقارنة EARLY vs CONFIRMED + اقتراح أوزان مع Walk-Forward
   ============================================================ */
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from './early-entry';
import type {
  EarlyEntryWeights,
  PerformanceBucketStats,
  SignalTelemetryRecord,
  StrategyPerformanceReport,
  WeightTuningProposal,
} from './types';

export const MIN_TUNING_SAMPLES = 15;

function computeBucketStats(
  key: string,
  label: string,
  items: SignalTelemetryRecord[]
): PerformanceBucketStats {
  const closed = items.filter((x) => x.takenByUserOrAuto && typeof x.netR === 'number');
  const wins = closed.filter((x) => (x.netR ?? 0) > 0);
  const losses = closed.filter((x) => (x.netR ?? 0) <= 0);
  const grossWin = wins.reduce((s, x) => s + Math.max(0, x.netR ?? 0), 0);
  const grossLoss = losses.reduce((s, x) => s + Math.abs(Math.min(0, x.netR ?? 0)), 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Math.min(9.99, grossWin + 1) : 0;
  const avgWinR = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLossR = losses.length > 0 ? grossLoss / losses.length : 0;
  const wr = closed.length > 0 ? wins.length / closed.length : 0;
  const expectancyR = wr * avgWinR - (1 - wr) * avgLossR;
  const avgNetR = closed.length > 0 ? closed.reduce((s, x) => s + (x.netR ?? 0), 0) / closed.length : 0;
  const totalPnlUsdt = closed.reduce((s, x) => s + (x.netPnlUsdt ?? 0), 0);
  const avgDistanceMovedPct =
    items.length > 0 ? items.reduce((s, x) => s + (x.distanceMovedPct || 0), 0) / items.length : 0;
  const lateCount = items.filter((x) => x.wasLateEntry || (x.distanceMovedPct || 0) >= 2.0).length;
  const lateEntryRate = items.length > 0 ? (lateCount / items.length) * 100 : 0;

  return {
    key,
    label,
    count: items.length,
    closedCount: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    profitFactor: +profitFactor.toFixed(2),
    expectancyR: +expectancyR.toFixed(3),
    avgNetR: +avgNetR.toFixed(3),
    totalPnlUsdt: +totalPnlUsdt.toFixed(2),
    avgDistanceMovedPct: +avgDistanceMovedPct.toFixed(2),
    lateEntryRate: +lateEntryRate.toFixed(1),
  };
}

function calcMaxDrawdownPct(closed: SignalTelemetryRecord[]): number {
  if (!closed.length) return 0;
  const ordered = [...closed].sort(
    (a, b) => new Date(a.closedAt || a.createdAt).getTime() - new Date(b.closedAt || b.createdAt).getTime()
  );
  let eq = 100;
  let peak = 100;
  let maxDd = 0;
  for (const t of ordered) {
    // Approximate 1R = 1% equity if pnlUsdt absent
    const stepPct = typeof t.netR === 'number' ? t.netR * 1.0 : 0;
    eq += stepPct;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return +maxDd.toFixed(2);
}

const COMP_MAX: Record<keyof EarlyEntryWeights, number> = {
  zoneQuality: 20,
  structureShift: 20,
  momentumVolume: 20,
  liquidityConfirm: 15,
  mtfAlignment: 15,
  stopRrQuality: 10,
};

function rescoreWithWeights(
  rec: SignalTelemetryRecord,
  weights: EarlyEntryWeights
): number {
  const bd = rec.scoreBreakdown || {};
  let sum = 0;
  (Object.keys(COMP_MAX) as (keyof EarlyEntryWeights)[]).forEach((k) => {
    const curVal = Number(bd[k] ?? 0);
    const maxCur = COMP_MAX[k];
    const ratio = maxCur > 0 ? Math.max(0, Math.min(1, curVal / maxCur)) : 0.5;
    sum += ratio * weights[k];
  });
  return sum;
}

export function evaluateWeightTuningProposal(
  records: SignalTelemetryRecord[],
  currentWeights?: Partial<EarlyEntryWeights> | null,
  minSamples = MIN_TUNING_SAMPLES
): WeightTuningProposal {
  const cur = normalizeEarlyWeights(currentWeights || DEFAULT_EARLY_WEIGHTS);
  const earlyClosed = records
    .filter(
      (r) =>
        r.takenByUserOrAuto &&
        typeof r.netR === 'number' &&
        r.scoreBreakdown &&
        Object.keys(r.scoreBreakdown).length >= 4
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const sufficientSample = earlyClosed.length >= minSamples;
  const baseId = `prop-${Date.now().toString(36)}`;

  if (!sufficientSample) {
    return {
      id: baseId,
      createdAt: new Date().toISOString(),
      sampleCount: earlyClosed.length,
      minSampleRequired: minSamples,
      sufficientSample: false,
      currentWeights: cur,
      proposedWeights: cur,
      reasons: [
        `العينة الحالية (${earlyClosed.length}) أقل من الحد الأدنى المطلوب (${minSamples}) لتجنب Overfitting.`,
      ],
      expectedImprovementNote: 'استمر في تشغيل الإشارات لجمع بيانات كافية قبل اقتراح أي تعديل أوزان.',
      status: 'PENDING',
    };
  }

  // Split 60% train / 40% walk-forward holdout
  const splitIdx = Math.max(8, Math.floor(earlyClosed.length * 0.6));
  const train = earlyClosed.slice(0, splitIdx);
  const holdout = earlyClosed.slice(splitIdx);

  const wins = train.filter((t) => (t.netR ?? 0) > 0);
  const losses = train.filter((t) => (t.netR ?? 0) <= 0);
  const draft: EarlyEntryWeights = { ...cur };
  const reasons: string[] = [];

  if (wins.length >= 3 && losses.length >= 3) {
    const labels: Record<keyof EarlyEntryWeights, string> = {
      zoneQuality: 'جودة المنطقة (OB/FVG)',
      structureShift: 'تحول الهيكل (CHoCH/BOS)',
      momentumVolume: 'الزخم والحجم',
      liquidityConfirm: 'رادار السيولة والأوامر',
      mtfAlignment: 'توافق الأطر و BTC',
      stopRrQuality: 'جودة الوقف والعائد',
    };
    (Object.keys(COMP_MAX) as (keyof EarlyEntryWeights)[]).forEach((k) => {
      const avgWin =
        wins.reduce((s, x) => s + Number(x.scoreBreakdown?.[k] ?? 0) / COMP_MAX[k], 0) / wins.length;
      const avgLoss =
        losses.reduce((s, x) => s + Number(x.scoreBreakdown?.[k] ?? 0) / COMP_MAX[k], 0) / losses.length;
      const edge = avgWin - avgLoss; // positive means winning trades scored higher on this factor
      if (edge >= 0.08) {
        const delta = Math.min(2.5, +(edge * 10).toFixed(1));
        draft[k] = +(cur[k] + delta).toFixed(2);
        reasons.push(`زيادة وزن «${labels[k]}» (+${delta}) لارتفاع تفريقه بين الصفقات الرابحة والخاسرة.`);
      } else if (edge <= -0.08) {
        const delta = Math.min(2.5, +(Math.abs(edge) * 10).toFixed(1));
        draft[k] = Math.max(4, +(cur[k] - delta).toFixed(2));
        reasons.push(`تخفيض وزن «${labels[k]}» (-${delta}) لضعف ارتباطه بجودة النتيجة.`);
      }
    });
  }

  const proposed = normalizeEarlyWeights(draft);
  if (reasons.length === 0) {
    reasons.push('الأوزان الحالية متوازنة عبر العينة التدريبية ولا تتطلب تغييراً حاداً.');
  }

  // Walk-forward holdout validation: select top-half signals by score and compare PF
  const evalPf = (list: SignalTelemetryRecord[], w: EarlyEntryWeights) => {
    const scored = list.map((r) => ({ r, s: rescoreWithWeights(r, w) })).sort((a, b) => b.s - a.s);
    const topHalf = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.65))).map((x) => x.r);
    const gw = topHalf.reduce((s, x) => s + Math.max(0, x.netR ?? 0), 0);
    const gl = topHalf.reduce((s, x) => s + Math.abs(Math.min(0, x.netR ?? 0)), 0);
    return gl > 0 ? +(gw / gl).toFixed(2) : gw > 0 ? 3.0 : 1.0;
  };

  const wfBase = holdout.length >= 4 ? evalPf(holdout, cur) : 1.0;
  const wfProp = holdout.length >= 4 ? evalPf(holdout, proposed) : 1.0;
  const walkForwardPassed = wfProp >= wfBase;

  return {
    id: baseId,
    createdAt: new Date().toISOString(),
    sampleCount: earlyClosed.length,
    minSampleRequired: minSamples,
    sufficientSample: true,
    currentWeights: cur,
    proposedWeights: proposed,
    reasons,
    expectedImprovementNote: walkForwardPassed
      ? `اجتاز التحقق الخلفي Out-of-Sample (PF ${wfBase} → ${wfProp}) مع الحفاظ الكامل على حدود المخاطرة.`
      : `لم يتفوق التعديل في التحقق الخلفي (${wfBase} → ${wfProp}) — يُنصح بالإبقاء على الأوزان الحالية حتى تتجمع عينة أكبر.`,
    walkForwardBaselinePF: wfBase,
    walkForwardProposedPF: wfProp,
    walkForwardPassed,
    status: 'PENDING',
  };
}

export function buildStrategyPerformanceReport(
  records: SignalTelemetryRecord[],
  currentWeights?: Partial<EarlyEntryWeights> | null,
  minSamples = MIN_TUNING_SAMPLES
): StrategyPerformanceReport {
  const taken = records.filter((r) => r.takenByUserOrAuto);
  const closed = taken.filter((r) => typeof r.netR === 'number');
  const overall = computeBucketStats('all', 'الإجمالي', records);

  const earlyItems = records.filter((r) => r.entryKind === 'EARLY_ENTRY');
  const confItems = records.filter((r) => r.entryKind === 'CONFIRMED_ENTRY');

  const strategyMap = new Map<string, SignalTelemetryRecord[]>();
  const tfMap = new Map<string, SignalTelemetryRecord[]>();
  const regimeMap = new Map<string, SignalTelemetryRecord[]>();

  for (const r of records) {
    const sk = r.strategyMode || 'intraday';
    strategyMap.set(sk, [...(strategyMap.get(sk) || []), r]);

    const tk = r.timeframe || '15m';
    tfMap.set(tk, [...(tfMap.get(tk) || []), r]);

    const rk = r.regime || 'range';
    regimeMap.set(rk, [...(regimeMap.get(rk) || []), r]);
  }

  const stratLabels: Record<string, string> = {
    early: 'EARLY ENTRY',
    scalp: 'سكالبينج',
    intraday: 'يومي',
    swing: 'سوينج',
  };

  const byStrategy = [...strategyMap.entries()].map(([k, list]) =>
    computeBucketStats(k, stratLabels[k] || k, list)
  );
  const byTimeframe = [...tfMap.entries()].map(([k, list]) => computeBucketStats(k, k, list));
  const byRegime = [...regimeMap.entries()].map(([k, list]) => computeBucketStats(k, k, list));

  // Loss causes
  const losing = closed.filter((r) => (r.netR ?? 0) <= 0);
  const causeCounts = new Map<string, number>();
  for (const l of losing) {
    let cause = 'وقف خسارة مباشر قبل TP1';
    if (l.outcome === 'LIQUIDATED') cause = 'تصفية قسرية';
    else if (l.outcome === 'SL_AFTER_TP' || l.tp1Hit) cause = 'ارتداد وضرب الوقف بعد TP1';
    else if (l.wasLateEntry) cause = 'دخول متأخر بعد تحرك السعر';
    else if (l.outcome === 'SMART_EXIT') cause = 'إغلاق حماية الأرباح الذكي';
    causeCounts.set(cause, (causeCounts.get(cause) || 0) + 1);
  }
  const lossCauses = [...causeCounts.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      pct: losing.length > 0 ? +((count / losing.length) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Score calibration buckets
  const ranges = [
    { label: '60-69', lo: 0, hi: 69.9 },
    { label: '70-79', lo: 70, hi: 79.9 },
    { label: '80-89', lo: 80, hi: 89.9 },
    { label: '90-100', lo: 90, hi: 101 },
  ];
  const scoreCalibration = ranges.map((rg) => {
    const sub = closed.filter((c) => c.score >= rg.lo && c.score <= rg.hi);
    const w = sub.filter((c) => (c.netR ?? 0) > 0).length;
    return {
      bucket: rg.label,
      count: sub.length,
      winRate: sub.length > 0 ? +((w / sub.length) * 100).toFixed(1) : 0,
      avgR: sub.length > 0 ? +(sub.reduce((s, x) => s + (x.netR ?? 0), 0) / sub.length).toFixed(2) : 0,
    };
  });

  const missed = records.filter((r) => r.missedOpportunity || r.outcome === 'EXPIRED' || r.outcome === 'MISSED');

  return {
    totalSignals: records.length,
    totalTaken: taken.length,
    closedTrades: closed.length,
    winRate: overall.winRate,
    profitFactor: overall.profitFactor,
    expectancyR: overall.expectancyR,
    maxDrawdownPct: calcMaxDrawdownPct(closed),
    lateEntryPct: overall.lateEntryRate,
    missedMoveRate: records.length > 0 ? +((missed.length / records.length) * 100).toFixed(1) : 0,
    earlyVsConfirmed: {
      early: computeBucketStats('EARLY_ENTRY', 'الدخول المبكر (EARLY)', earlyItems),
      confirmed: computeBucketStats('CONFIRMED_ENTRY', 'الدخول المؤكد (CONFIRMED)', confItems),
    },
    byStrategy,
    byTimeframe,
    byRegime,
    lossCauses,
    scoreCalibration,
    proposal: evaluateWeightTuningProposal(records, currentWeights, minSamples),
  };
}
