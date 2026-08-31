// Pulse health endpoint — Express + Mongoose.
//
// Copy into your Express app and mount it:
//   import healthRouter from './health.js';
//   app.use(healthRouter);
//
// WHAT MAKES THIS COUNT AS ACTIVITY
// MongoDB Atlas auto-pauses an idle free (M0) cluster after ~30 days with no
// *driver connections*. HTTP traffic to this service is irrelevant on its own -
// what counts is that the process holds a connection and issues a command.
//
// So this runs an actual `ping` admin command over the existing Mongoose
// connection rather than just reporting `readyState`. A cached `readyState === 1`
// can be reported by a process whose connection has silently gone stale, which
// is exactly the false green this is meant to avoid.
//
// This endpoint is the *preferred* way to keep an Atlas cluster awake: it means
// Pulse can use a plain `http` check and your Atlas IP access list can stay
// locked down, instead of the `mongo` check type which requires 0.0.0.0/0.
//
// Then in config/targets.json:
//   "type": "http",
//   "url": "https://<your-service>/api/health",
//   "expectBodyContains": "\"ok\":true"

import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

router.get('/api/health', async (_req, res) => {
  const startedAt = Date.now();

  try {
    const connection = mongoose.connection;

    // 1 === connected. Anything else means there is no live connection to ping,
    // and reporting healthy here would be a lie.
    if (connection.readyState !== 1 || !connection.db) {
      throw new Error(`mongoose connection is not ready (readyState ${connection.readyState})`);
    }

    // The command that actually reaches the cluster.
    const result = await connection.db.admin().command({ ping: 1 });
    if (result?.ok !== 1) {
      throw new Error(`ping returned ${JSON.stringify(result)}`);
    }

    res.set('cache-control', 'no-store');
    res.status(200).json({ ok: true, db: 'mongodb', latencyMs: Date.now() - startedAt });
  } catch (error) {
    res.set('cache-control', 'no-store');
    res.status(500).json({
      ok: false,
      db: 'mongodb',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
