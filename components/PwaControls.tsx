'use client';

import React from 'react';
import { Download, Share, WifiOff, X } from 'lucide-react';
import { fmtDt } from '@/lib/client/formatters';
import { useOnlineStatus, usePWAInstall } from '@/lib/client/use-pwa';

export function PWAInstallButton() {
  const { isInstalled, canPrompt, promptInstall, showIOSGuide, setShowIOSGuide, isIOS } =
    usePWAInstall();

  if (isInstalled) return null;

  return (
    <>
      <button
        type="button"
        onClick={promptInstall}
        className="modebtn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          borderColor: canPrompt ? 'var(--cyan)' : 'var(--bd)',
          background: canPrompt ? 'rgba(0,245,255,.10)' : 'transparent',
        }}
        title="تثبيت التطبيق على الجهاز"
      >
        <Download size={13} />
        <span className="hidden sm:inline">تثبيت التطبيق</span>
      </button>

      {showIOSGuide && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 90,
            background: 'rgba(2,4,8,.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            className="card"
            style={{ maxWidth: 420, width: '100%', margin: 0, borderColor: 'var(--bd2)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              <Download size={16} /> تثبيت CIPHER X PRO على جهازك
              <button
                type="button"
                className="btn sm"
                style={{ marginInlineStart: 'auto' }}
                onClick={() => setShowIOSGuide(false)}
              >
                <X size={14} />
              </button>
            </h3>
            {isIOS ? (
              <div className="hint" style={{ color: 'var(--tx)', lineHeight: 1.9 }}>
                لتثبيت التطبيق على iPhone / iPad مع دعم الإشعارات والعمل دون اتصال:
                <br />
                1. اضغط على أيقونة المشاركة <Share size={13} style={{ display: 'inline' }} /> في شريط Safari.
                <br />
                2. اختر <b>«إضافة إلى الشاشة الرئيسية» (Add to Home Screen)</b>.
                <br />
                3. افتح التطبيق من الشاشة الرئيسية لتفعيل إشعارات Push.
              </div>
            ) : (
              <div className="hint" style={{ color: 'var(--tx)', lineHeight: 1.9 }}>
                يمكنك تثبيت التطبيق من شريط العنوان في المتصفح (أيقونة التثبيت) أو من قائمة المتصفح
                ← <b>تثبيت التطبيق (Install App)</b> للعمل كتطبيق مستقل على الهاتف والكمبيوتر.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineBanner({ lastUpdatedAt }: { lastUpdatedAt: string | null }) {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      className="warn"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        marginTop: 10,
        marginBottom: 4,
      }}
    >
      <div className="row">
        <WifiOff size={16} />
        <span>
          <b>وضع عدم الاتصال (Offline):</b> يتم عرض آخر البيانات المحفوظة محلياً.
        </span>
      </div>
      <span className="num" style={{ fontSize: 12 }}>
        {lastUpdatedAt ? `آخر تحديث: ${fmtDt(lastUpdatedAt)}` : 'لا توجد لقطة محفوظة بعد'}
      </span>
    </div>
  );
}
