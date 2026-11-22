/* ============================================================================
   CIPHER X PRO — Standalone 24/7 Background Worker Process
   Run via: bun run worker  (or npx tsx worker.ts)
   Designed for persistent execution on Railway / Fly.io / Render / VPS
   while persisting heartbeats, positions, logs, and analytics into Supabase.
   ============================================================================ */
import { binanceServer } from './lib/server/binance-client';
import { getBackgroundEngine } from './lib/server/background-engine';
import { DEFAULT_USER_ID, repo } from './lib/server/repository';

async function main() {
  console.log('[CIPHER-WORKER] Booting standalone 24/7 trading worker...');
  await binanceServer.syncTime().catch((e) => {
    console.warn('[CIPHER-WORKER] initial Binance time sync warning:', e?.message || e);
  });

  const supa = await repo.inspectSupabase();
  console.log('[CIPHER-WORKER] Storage mode:', supa.mode, 'schemaReady:', supa.schemaReady);

  const engine = getBackgroundEngine();
  await engine.monitorLoop().catch(() => undefined);
  await engine.scanLoop(true).catch(() => undefined);

  const shutdown = async (sig: string) => {
    console.log(`[CIPHER-WORKER] Received ${sig}, saving final worker state...`);
    try {
      const cur = await repo.getEngineState(DEFAULT_USER_ID);
      await repo.saveEngineState({
        ...cur,
        workerStatus: 'STOPPED',
        workerConnected: false,
        updatedAt: new Date().toISOString(),
      });
      await repo.appendEngineLog({
        userId: DEFAULT_USER_ID,
        level: 'WARN',
        category: 'WORKER',
        symbol: null,
        message: `تم إيقاف العامل الخلفي المستقل (${sig}) بأمان بعد حفظ الحالة.`,
      });
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[CIPHER-WORKER] Fatal startup error:', err);
  process.exit(1);
});
