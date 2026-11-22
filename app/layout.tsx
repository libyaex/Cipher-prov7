import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Orbitron, Rajdhani, Tajawal } from 'next/font/google';
import './globals.css';

const tajawal = Tajawal({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '700'],
  variable: '--font-tajawal',
  display: 'swap',
});

const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-rajdhani',
  display: 'swap',
});

const orbitron = Orbitron({
  subsets: ['latin'],
  weight: ['700', '900'],
  variable: '--font-orbitron',
  display: 'swap',
});

const ibmMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CIPHER X PRO — إشارات Binance Futures والتداول التجريبي',
  description: 'منصة CIPHER X PRO لتحليل عقود Binance Futures والتداول التجريبي الآلي المحمي',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'CIPHER X PRO',
  },
  icons: {
    icon: [
      { url: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'CIPHER X PRO',
    description: 'منصة CIPHER X PRO لتحليل عقود Binance Futures والتداول التجريبي الآلي المحمي',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CIPHER X PRO',
    description: 'منصة CIPHER X PRO لتحليل عقود Binance Futures والتداول التجريبي الآلي المحمي',
  },
};

export const viewport: Viewport = {
  themeColor: '#020408',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="ar"
      dir="rtl"
      className={`${tajawal.variable} ${rajdhani.variable} ${orbitron.variable} ${ibmMono.variable}`}
    >
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
