import { NextRequest, NextResponse } from 'next/server';
import {
  resolveAuthenticatedUser,
  SESSION_COOKIE_NAME,
  signSessionToken,
} from '@/lib/server/auth-guard';
import { DEFAULT_USER_ID } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await resolveAuthenticatedUser(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status || 401 });
  }
  const token = signSessionToken(auth.userId || DEFAULT_USER_ID);
  const res = NextResponse.json({
    ok: true,
    userId: auth.userId,
    authenticatedVia: auth.authenticatedVia,
  });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
