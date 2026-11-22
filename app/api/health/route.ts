import { NextRequest, NextResponse } from 'next/server';
import { resolveAuthenticatedUser } from '@/lib/server/auth-guard';
import { getBackgroundEngine } from '@/lib/server/background-engine';
import { binanceServer } from '@/lib/server/binance-client';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthenticatedUser(req, req.nextUrl.searchParams.get('userId'));
    const userId = auth.ok ? auth.userId : undefined;
    const engine = getBackgroundEngine();
    const [supabase, workerState] = await Promise.all([
      repo.inspectSupabase(),
      repo.getEngineState(userId),
    ]);
    return NextResponse.json({
      ok: true,
      serverTime: Date.now(),
      binanceTime: binanceServer.now(),
      engine: engine.status,
      workerState,
      supabase,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
