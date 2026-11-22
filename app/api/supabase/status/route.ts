import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { getVapidStatus } from '@/lib/server/push-service';
import { repo } from '@/lib/server/repository';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await repo.inspectSupabase();
    const vapid = getVapidStatus();
    let schemaSql = '';
    try {
      schemaSql = fs.readFileSync(path.join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');
    } catch {
      schemaSql = '';
    }
    return NextResponse.json({ ok: true, status, vapid, schemaSql });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
