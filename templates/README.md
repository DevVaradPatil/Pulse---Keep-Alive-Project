# Health endpoint templates

Copy-paste endpoints that genuinely touch the database. Each one returns:

```json
{ "ok": true, "db": "postgres", "latencyMs": 42 }
```

with `200` when the database answered, and `500` with an `error` string when it did not.

| Template                                                                       | Use it for                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [`nextjs-app-router-supabase/route.ts`](./nextjs-app-router-supabase/route.ts) | Next.js on Vercel with a Supabase backend                   |
| [`nextjs-app-router-prisma/route.ts`](./nextjs-app-router-prisma/route.ts)     | Next.js with Prisma against any SQL database                |
| [`express-mongoose/health.js`](./express-mongoose/health.js)                   | Express + Mongoose in front of MongoDB Atlas                |
| [`fastapi-sqlalchemy/health.py`](./fastapi-sqlalchemy/health.py)               | FastAPI + SQLAlchemy against any SQL database               |
| [`supabase-heartbeat-table.sql`](./supabase-heartbeat-table.sql)               | The one-time SQL for a Supabase project's `heartbeat` table |

## The rule these all follow

**A 200 must be impossible without the database having answered.** Three ways that quietly stops
being true, all of which these templates guard against:

1. **The response is cached.** A framework prerenders the route, or a CDN caches it at the edge, and
   from then on your health check never leaves the CDN. Every template sets `cache-control: no-store`
   and disables framework caching.
2. **The handler returns before the query resolves.** The response body has to depend on the query's
   result, not merely be issued after starting it.
3. **The check reports connection _state_ rather than querying.** `readyState === 1` or
   `pool.status()` can look healthy while every connection has gone stale.

That is also why the matching `targets.json` entry should always set `expectBodyContains`:

```jsonc
{
  "type": "http",
  "url": "https://your-app.example/api/health",
  "expectBodyContains": "\"ok\":true",
}
```

An endpoint that returns `{"ok": false}` with a 200 by mistake still fails the check, and so does a
cached HTML error page.

## Mobile and desktop apps (Flutter, React Native, Electron, …)

**The app itself needs nothing.** These clients are not the thing that goes to sleep — a Flutter app
sitting on a phone cannot keep anything awake, and an app store build cannot be pinged.

What sleeps is the **backend** the app talks to. Monitor that, using whichever template matches it:

- A Flutter app talking directly to Supabase → there is no backend of your own to add an endpoint to.
  Use Pulse's `supabase` check type, which calls PostgREST directly and needs nothing deployed. This
  is the same situation as a pure-static web frontend.
- A Flutter app talking to your own API on Render/Railway/Fly → add the endpoint matching that API's
  framework and monitor its URL with the `http` check type.

If your app has an existing `/version` or `/config` endpoint you are tempted to reuse: only do so if
it reads from the database on every request. Most of them are static and would produce exactly the
false green this project exists to prevent.
