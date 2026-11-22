import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { emitAlert } from '@/lib/server/push-service';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req, req.nextUrl.searchParams.get('userId'));
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const notifications = await repo.getNotifications(auth.userId, 80);
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    return NextResponse.json({ ok: true, notifications, unreadCount });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const auth = await resolveAuthenticatedUser(req, body.userId);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    await repo.markNotificationsRead(auth.userId);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const auth = await resolveAuthenticatedUser(req, body.userId);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 403 });
    }
    const n = await emitAlert({
      userId: auth.userId,
      eventType: body.eventType || 'INFO',
      severity: body.severity || 'info',
      symbol: body.symbol || null,
      title: body.title || 'اختبار تنبيهات CIPHER X PRO',
      body: body.body || 'نظام الإشعارات الفورية و Push يعمل بنجاح.',
      sendPush: body.sendPush !== false,
    });
    return NextResponse.json({ ok: true, notification: n });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
