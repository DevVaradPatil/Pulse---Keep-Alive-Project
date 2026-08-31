// Pulse health endpoint — Next.js App Router + Prisma.
//
// Copy to: app/api/health/route.ts
//
// WHAT MAKES THIS COUNT AS ACTIVITY
// `$queryRaw` sends a real statement over a real connection. A Prisma client
// that is merely *constructed* connects lazily and would touch nothing, so the
// query has to be awaited before responding.
//
// `SELECT 1` is enough for any pooled Postgres or MySQL provider. If your
// provider counts "activity" as reads of actual tables rather than any
// statement, swap it for a cheap count against a real table - the comment on
// the query below shows where.
//
// Runtime note: this must run on the Node.js runtime. Prisma's default engine
// does not work on the edge runtime, and a route that silently falls back to
// the edge is a route that stops touching your database.
//
// Then in config/targets.json:
//   "url": "https://<your-app>/api/health",
//   "expectBodyContains": "\"ok\":true"

import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

// One client per process. In dev, Next's hot reload would otherwise exhaust the
// connection pool with a new client per reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function GET() {
  const startedAt = Date.now();

  try {
    // Cheapest statement that proves the connection is live.
    // For a provider that only counts table reads, use something like:
    //   await prisma.heartbeat.findFirst({ select: { id: true } });
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      { ok: true, db: 'postgres', latencyMs: Date.now() - startedAt },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        db: 'postgres',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}
