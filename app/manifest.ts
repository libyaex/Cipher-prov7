import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'CIPHER X PRO',
    short_name: 'CIPHER X',
    description: 'منصة CIPHER X PRO لتحليل عقود Binance Futures والتداول التجريبي الآلي المحمي',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#020408',
    theme_color: '#020408',
    dir: 'rtl',
    lang: 'ar',
    icons: [
      {
        src: '/pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
