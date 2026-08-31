// Pulse health endpoint — Next.js App Router + Supabase.
//
// Copy to: app/api/health/route.ts
//
// WHAT MAKES THIS COUNT AS ACTIVITY
// The `select` below is executed by Postgres through PostgREST. That is what
// resets Supabase's ~7-day inactivity timer. Two things would silently break
// that and are deliberately avoided here:
//
//   1. Route caching. Next.js will happily cache a route handler's response at
//      build time or at the edge, after which your "health check" never reaches
//      the database again. `dynamic` and `revalidate` below prevent that. This
//      is the single most common reason a project gets paused despite a green
//      dashboard.
//   2. Returning before awaiting the query. The response must depend on the
//      query's result, or a cold start can answer 200 before the DB is touched.
//
// Requires: npm install @supabase/supabase-js
// Environment: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
//
// Then in config/targets.json (type "http", asserting on the body so a cached
// edge response cannot pass):
//   "url": "https://<your-app>/api/health",
//   "expectBodyContains": "\"ok\":true"

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Never prerender, never cache: this route must hit the database every time.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET() {
  const startedAt = Date.now();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.json(
      { ok: false, db: 'supabase', error: 'Supabase environment variables are not set' },
      { status: 500 }
    );
  }

  try {
    const supabase = createClient(url, anonKey, { auth: { persistSession: false } });

    // `head: true` asks for no rows back but still runs the statement, so the
    // response stays tiny while the database is genuinely touched.
    const { error } = await supabase
      .from('heartbeat')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    if (error) throw new Error(error.message);

    return NextResponse.json(
      { ok: true, db: 'supabase', latencyMs: Date.now() - startedAt },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        db: 'supabase',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}
