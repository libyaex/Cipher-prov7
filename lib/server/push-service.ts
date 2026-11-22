import fs from 'fs';
import path from 'path';
import * as webpush from 'web-push';
import type { AppNotification } from '../cx-engine/types';
import { DEFAULT_USER_ID, repo } from './repository';

const VAPID_FILE = path.join(process.cwd(), '.data', 'vapid.json');

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const g = globalThis as unknown as { __cipherVapid?: VapidKeys };

const DEFAULT_VAPID_SUBJECT = 'mailto:admin@cipherxpro.local';

function normalizeVapidSubject(raw?: string): string {
  let val = (raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!val) return DEFAULT_VAPID_SUBJECT;
  if (!/^mailto:/i.test(val) && !/^https?:\/\//i.test(val)) {
    if (val.includes('@') && !val.includes('://')) {
      val = `mailto:${val}`;
    } else {
      return DEFAULT_VAPID_SUBJECT;
    }
  }
  try {
    const parsed = new URL(val);
    if (parsed.protocol === 'mailto:' || parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return val;
    }
  } catch {
    // invalid URL -> fall back safely
  }
  return DEFAULT_VAPID_SUBJECT;
}

export function getVapidKeys(): VapidKeys {
  if (g.__cipherVapid) return g.__cipherVapid;

  const envPub = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = normalizeVapidSubject(process.env.VAPID_SUBJECT);

  if (envPub && envPriv) {
    webpush.setVapidDetails(subject, envPub, envPriv);
    g.__cipherVapid = { publicKey: envPub, privateKey: envPriv, subject };
    return g.__cipherVapid;
  }

  try {
    if (fs.existsSync(VAPID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (saved.publicKey && saved.privateKey) {
        webpush.setVapidDetails(subject, saved.publicKey, saved.privateKey);
        g.__cipherVapid = { publicKey: saved.publicKey, privateKey: saved.privateKey, subject };
        return g.__cipherVapid;
      }
    }
  } catch {
    // regenerate below
  }

  const keys = webpush.generateVAPIDKeys();
  const dir = path.dirname(VAPID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify({ ...keys, subject }, null, 2), 'utf8');
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  g.__cipherVapid = { ...keys, subject };
  return g.__cipherVapid;
}

export function getVapidStatus() {
  const envPub = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const keys = getVapidKeys();
  return {
    persistentEnv: Boolean(envPub && envPriv),
    publicKey: keys.publicKey,
    subject: keys.subject,
  };
}

export async function emitAlert(params: {
  userId?: string;
  eventType: AppNotification['eventType'];
  severity: AppNotification['severity'];
  symbol?: string | null;
  title: string;
  body: string;
  meta?: Record<string, any>;
  sendPush?: boolean;
}) {
  const userId = params.userId || DEFAULT_USER_ID;
  const notification: AppNotification = {
    id: `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    eventType: params.eventType,
    severity: params.severity,
    symbol: params.symbol ?? null,
    title: params.title,
    body: params.body,
    isRead: false,
    meta: params.meta || {},
    createdAt: new Date().toISOString(),
  };

  await repo.addNotification(notification);

  if (params.sendPush !== false) {
    try {
      getVapidKeys();
      const subs = await repo.getPushSubscriptions(userId);
      if (subs.length > 0) {
        const payload = JSON.stringify({
          title: params.title,
          body: params.body,
          type: params.eventType,
          symbol: params.symbol,
          tag: `${params.eventType}-${params.symbol || 'sys'}`,
          url: '/',
        });

        await Promise.allSettled(
          subs.map(async (sub) => {
            try {
              await webpush.sendNotification(
                {
                  endpoint: sub.endpoint,
                  keys: { p256dh: sub.p256dh, auth: sub.auth },
                },
                payload
              );
            } catch (err: any) {
              const code = err?.statusCode;
              if (code === 404 || code === 410) {
                await repo.removePushSubscription(sub.endpoint);
              }
            }
          })
        );
      }
    } catch (e) {
      console.error('[push] delivery error:', e);
    }
  }

  return notification;
}
