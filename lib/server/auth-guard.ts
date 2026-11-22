import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { DEFAULT_USER_ID } from './repository';

const SESSION_COOKIE_NAME = 'cx_session';
const SECRET_FILE = path.join(process.cwd(), '.data', 'session.key');

let cachedSecret: string | null = null;

function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const envSecret =
    process.env.SESSION_SECRET ||
    process.env.CIPHER_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (envSecret && envSecret.length >= 16) {
    cachedSecret = crypto.createHash('sha256').update(envSecret).digest('hex');
    return cachedSecret;
  }
  try {
    const dir = path.dirname(SECRET_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) {
        cachedSecret = s;
        return cachedSecret;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    cachedSecret = generated;
    return cachedSecret;
  } catch {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    return cachedSecret;
  }
}

export function signSessionToken(userId: string, ttlSec = 60 * 60 * 24 * 30): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payload)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded?.uid || typeof decoded.exp !== 'number') return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return String(decoded.uid);
  } catch {
    return null;
  }
}

async function verifySupabaseJwt(jwt: string): Promise<string | null> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  if (!url || !key || url.includes('YOUR_PROJECT_ID')) return null;
  try {
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser / same-site fetch without Origin header
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (!host) return true;
  try {
    const originHost = new URL(origin).host;
    return originHost === host;
  } catch {
    return false;
  }
}

export interface AuthResolveResult {
  ok: boolean;
  userId: string;
  authenticatedVia: 'supabase-jwt' | 'signed-session' | 'default-owner';
  status?: number;
  error?: string;
}

export async function resolveAuthenticatedUser(
  req: NextRequest,
  requestedUserId?: string | null
): Promise<AuthResolveResult> {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req)) {
    return {
      ok: false,
      userId: '',
      authenticatedVia: 'default-owner',
      status: 403,
      error: 'طلب مرفوض: مصدر الطلب (Origin) لا يطابق مضيف الخادم',
    };
  }

  let resolvedUserId: string | null = null;
  let via: AuthResolveResult['authenticatedVia'] = 'default-owner';

  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return {
        ok: false,
        userId: '',
        authenticatedVia: 'default-owner',
        status: 401,
        error: 'رمز المصادقة فارغ',
      };
    }
    const signedUid = verifySessionToken(token);
    if (signedUid) {
      resolvedUserId = signedUid;
      via = 'signed-session';
    } else {
      const sbUid = await verifySupabaseJwt(token);
      if (sbUid) {
        resolvedUserId = sbUid;
        via = 'supabase-jwt';
      } else {
        return {
          ok: false,
          userId: '',
          authenticatedVia: 'default-owner',
          status: 401,
          error: 'رمز المصادقة غير صالح أو منتهي الصلاحية',
        };
      }
    }
  }

  if (!resolvedUserId) {
    const cookieToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (cookieToken) {
      const cookieUid = verifySessionToken(cookieToken);
      if (cookieUid) {
        resolvedUserId = cookieUid;
        via = 'signed-session';
      }
    }
  }

  const strictAuth = process.env.CIPHER_STRICT_AUTH === 'true';
  if (!resolvedUserId && strictAuth) {
    return {
      ok: false,
      userId: '',
      authenticatedVia: 'default-owner',
      status: 401,
      error: 'يتطلب تسجيل الدخول أولاً',
    };
  }

  const effectiveOwner = resolvedUserId || DEFAULT_USER_ID;

  // Prevent IDOR / client-side userId spoofing: reject whenever a client tries to pass a different userId
  if (
    requestedUserId &&
    typeof requestedUserId === 'string' &&
    requestedUserId.trim() !== '' &&
    requestedUserId.trim() !== effectiveOwner
  ) {
    return {
      ok: false,
      userId: '',
      authenticatedVia: via,
      status: 403,
      error: 'غير مصرح: لا يمكن الوصول أو تعديل بيانات مستخدم آخر',
    };
  }

  return {
    ok: true,
    userId: effectiveOwner,
    authenticatedVia: via,
  };
}

export { SESSION_COOKIE_NAME };
