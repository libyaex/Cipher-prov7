import { NextRequest, NextResponse } from 'next/server';
import {
  buildStrategyPerformanceReport,
  evaluateWeightTuningProposal,
  MIN_TUNING_SAMPLES,
} from '@/lib/cx-engine/analytics';
import { DEFAULT_EARLY_WEIGHTS, normalizeEarlyWeights } from '@/lib/cx-engine/early-entry';
import type { SignalTelemetryRecord } from '@/lib/cx-engine/types';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req, req.nextUrl.searchParams.get('userId'));
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const userId = auth.userId;

    const [records, weightsHistory, settings] = await Promise.all([
      repo.getSignalAnalytics(userId, 400),
      repo.getStrategyWeightHistory(userId),
      repo.getBotSettings(userId),
    ]);
    const activeSnap = weightsHistory.find((w) => w.isActive) || weightsHistory[0];
    const activeWeights = activeSnap?.weights || settings.earlyWeights || DEFAULT_EARLY_WEIGHTS;
    const report = buildStrategyPerformanceReport(records, activeWeights, MIN_TUNING_SAMPLES);

    return NextResponse.json({
      ok: true,
      report,
      records: records.slice(0, 120),
      weightsHistory,
      activeWeights,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await resolveAuthenticatedUser(req, body.userId);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const userId = auth.userId;
    const action = body.action;

    if (action === 'record') {
      const list: SignalTelemetryRecord[] = Array.isArray(body.records)
        ? body.records
        : body.record
          ? [body.record]
          : [];
      for (const item of list.slice(0, 50)) {
        if (!item?.id || !item?.symbol) continue;
        await repo.upsertSignalAnalytics({ ...item, userId });
      }
      return NextResponse.json({ ok: true, count: list.length });
    }

    if (action === 'backtest_weights') {
      const records = await repo.getSignalAnalytics(userId, 400);
      const weightsHistory = await repo.getStrategyWeightHistory(userId);
      const currentWeights = weightsHistory.find((w) => w.isActive)?.weights || DEFAULT_EARLY_WEIGHTS;
      const proposal = evaluateWeightTuningProposal(records, currentWeights, MIN_TUNING_SAMPLES);
      return NextResponse.json({ ok: true, proposal });
    }

    if (action === 'apply_weights') {
      const [records, weightsHistory] = await Promise.all([
        repo.getSignalAnalytics(userId, 400),
        repo.getStrategyWeightHistory(userId),
      ]);
      const currentWeights = weightsHistory.find((w) => w.isActive)?.weights || DEFAULT_EARLY_WEIGHTS;
      const proposal = evaluateWeightTuningProposal(records, currentWeights, MIN_TUNING_SAMPLES);

      if (!proposal.sufficientSample && !body.allowManualOverride) {
        return NextResponse.json(
          {
            ok: false,
            error: `العينة الحالية (${proposal.sampleCount}) أقل من الحد الأدنى الآمن (${proposal.minSampleRequired}) لمنع Overfitting.`,
          },
          { status: 400 }
        );
      }

      const nextWeights = normalizeEarlyWeights(body.weights || proposal.proposedWeights);
      const snap = await repo.saveStrategyWeightSnapshot({
        userId,
        weights: nextWeights,
        note: body.note || `تطبيق أوزان مقترحة (PF ${proposal.walkForwardBaselinePF ?? '-'} → ${proposal.walkForwardProposedPF ?? '-'})`,
        proposalId: proposal.id,
        metricsSummary: {
          sampleCount: proposal.sampleCount,
          walkForwardBaselinePF: proposal.walkForwardBaselinePF,
          walkForwardProposedPF: proposal.walkForwardProposedPF,
          walkForwardPassed: proposal.walkForwardPassed,
        },
      });

      await repo.appendEngineLog({
        userId,
        level: 'INFO',
        category: 'WEIGHTS',
        symbol: null,
        message: `تم حفظ نسخة أوزان جديدة (v${snap.version}) لاستراتيجية الدخول المبكر مع حفظ النسخة السابقة للتراجع.`,
        details: { version: snap.version, weights: snap.weights },
      });

      const updatedHist = await repo.getStrategyWeightHistory(userId);
      const report = buildStrategyPerformanceReport(records, snap.weights, MIN_TUNING_SAMPLES);
      return NextResponse.json({
        ok: true,
        snapshot: snap,
        weightsHistory: updatedHist,
        activeWeights: snap.weights,
        report,
      });
    }

    if (action === 'rollback_weights') {
      const weightsHistory = await repo.getStrategyWeightHistory(userId);
      if (weightsHistory.length < 2) {
        return NextResponse.json(
          { ok: false, error: 'لا توجد نسخة سابقة للتراجع إليها' },
          { status: 400 }
        );
      }
      const targetVersion = Number(body.targetVersion || 0);
      const target =
        targetVersion > 0
          ? weightsHistory.find((w) => w.version === targetVersion)
          : weightsHistory.find((w) => !w.isActive) || weightsHistory[1];

      if (!target) {
        return NextResponse.json({ ok: false, error: 'النسخة المطلوبة غير موجودة' }, { status: 404 });
      }

      const snap = await repo.saveStrategyWeightSnapshot({
        userId,
        weights: target.weights,
        note: `تراجع إلى نسخة الأوزان v${target.version}`,
        metricsSummary: { rolledBackFrom: weightsHistory[0]?.version, restoredVersion: target.version },
      });

      await repo.appendEngineLog({
        userId,
        level: 'WARN',
        category: 'WEIGHTS',
        symbol: null,
        message: `تم التراجع عن تعديل الأوزان والعودة إلى قيم النسخة v${target.version} (مسجلة كـ v${snap.version}).`,
      });

      const [records, updatedHist] = await Promise.all([
        repo.getSignalAnalytics(userId, 400),
        repo.getStrategyWeightHistory(userId),
      ]);
      const report = buildStrategyPerformanceReport(records, snap.weights, MIN_TUNING_SAMPLES);

      return NextResponse.json({
        ok: true,
        snapshot: snap,
        weightsHistory: updatedHist,
        activeWeights: snap.weights,
        report,
      });
    }

    return NextResponse.json({ ok: false, error: 'عملية غير مدعومة' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
