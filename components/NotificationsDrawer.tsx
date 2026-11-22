'use client';

import React, { useState } from 'react';
import { Bell, BellRing, CheckCheck, Send, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { AppNotification } from '@/lib/cx-engine/types';
import { fmtAgo } from '@/lib/client/formatters';
import { subscribeWebPush, unsubscribeWebPush } from '@/lib/client/use-pwa';

interface NotificationsDrawerProps {
  open: boolean;
  onClose: () => void;
  notifications: AppNotification[];
  pushSubscribed: boolean;
  onPushChange: (subscribed: boolean) => void;
  onMarkAllRead: () => Promise<void>;
  onTestPush: () => Promise<void>;
}

const EVENT_LABELS: Record<string, string> = {
  TRADE_OPEN: 'فتح صفقة',
  TRADE_CLOSE: 'إغلاق صفقة',
  TP_HIT: 'تحقق هدف',
  SL_HIT: 'وقف خسارة',
  LIQ_WARNING: 'اقتراب تصفية',
  LIQUIDATED: 'تصفية',
  ENGINE_ERROR: 'عطل المحرك',
  TRADE_REJECTED: 'رفض حماية',
  EMERGENCY_STOP: 'إيقاف طارئ',
  FUNDING: 'تسوية تمويل',
  INFO: 'تنبيه',
};

export default function NotificationsDrawer({
  open,
  onClose,
  notifications,
  pushSubscribed,
  onPushChange,
  onMarkAllRead,
  onTestPush,
}: NotificationsDrawerProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const handleTogglePush = async () => {
    setBusy(true);
    setMsg('');
    try {
      if (pushSubscribed) {
        await unsubscribeWebPush();
        onPushChange(false);
        setMsg('تم إلغاء اشتراك إشعارات Push.');
      } else {
        const res = await subscribeWebPush();
        if (res.ok) {
          onPushChange(true);
          setMsg('تم تفعيل إشعارات Push في الخلفية ✔');
        } else {
          setMsg(res.error || 'تعذر التفعيل');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 75,
            background: 'rgba(2,4,8,.76)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
          onClick={onClose}
        >
          <motion.div
            initial={{ x: -30, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -30, opacity: 0 }}
            transition={{ duration: 0.18 }}
            style={{
              width: 'min(430px, 100vw)',
              height: '100%',
              background: 'var(--bg-deep)',
              borderInlineEnd: '1px solid var(--bd2)',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row sb">
              <div className="row" style={{ color: 'var(--cyan)', fontWeight: 700, fontSize: 15 }}>
                <Bell size={18} />
                <span>مركز الإشعارات والتنبيهات</span>
              </div>
              <button type="button" className="btn sm" onClick={onClose}>
                <X size={15} />
              </button>
            </div>

            <div className="card" style={{ marginBottom: 0 }}>
              <div className="row sb wrap">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>إشعارات Push (تصل حتى عند إغلاق التطبيق)</div>
                  <div className="hint">فتح/إغلاق الصفقة، الأهداف، الوقف، اقتراب التصفية، وعطل المحرك.</div>
                </div>
                <button
                  type="button"
                  className={`btn sm ${pushSubscribed ? 'red' : 'pri'}`}
                  disabled={busy}
                  onClick={handleTogglePush}
                >
                  <BellRing size={14} />
                  <span>{pushSubscribed ? 'إيقاف Push' : 'تفعيل Push'}</span>
                </button>
              </div>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={onTestPush}>
                  <Send size={13} />
                  <span>إرسال إشعار تجريبي</span>
                </button>
                <button type="button" className="btn sm" onClick={onMarkAllRead}>
                  <CheckCheck size={13} />
                  <span>تحديد الكل كمقروء</span>
                </button>
              </div>
              {msg && <div className="hint" style={{ color: 'var(--cyan)', marginTop: 6 }}>{msg}</div>}
            </div>

            {notifications.length === 0 ? (
              <div className="card empty">لا توجد إشعارات مسجلة بعد.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    className="card"
                    style={{
                      marginBottom: 0,
                      padding: 11,
                      borderInlineStart: `3px solid ${
                        n.severity === 'danger'
                          ? 'var(--red)'
                          : n.severity === 'warning'
                            ? 'var(--orange)'
                            : n.severity === 'success'
                              ? 'var(--green)'
                              : 'var(--cyan)'
                      }`,
                      opacity: n.isRead ? 0.78 : 1,
                    }}
                  >
                    <div className="row sb">
                      <span className="b b-watch">{EVENT_LABELS[n.eventType] || n.eventType}</span>
                      <span className="hint">{fmtAgo(n.createdAt)}</span>
                    </div>
                    <div style={{ fontWeight: 700, marginTop: 4 }}>{n.title}</div>
                    <div className="hint" style={{ color: 'var(--tx2)', marginTop: 2 }}>
                      {n.body}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
