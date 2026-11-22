import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req, req.nextUrl.searchParams.get('userId'));
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const signals = await repo.getSignals(auth.userId, 300);
    return NextResponse.json({ ok: true, signals });
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
    const action = body.action || 'sync';

    if (action === 'clear') {
      await repo.clearSignals(userId);
      return NextResponse.json({ ok: true, signals: [] });
    }

    if (action === 'sync') {
      const list = Array.isArray(body.signals) ? body.signals : [];
      await repo.upsertSignals(userId, list);
      return NextResponse.json({ ok: true, count: list.length });
    }

    return NextResponse.json({ ok: false, error: 'عملية غير مدعومة' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
