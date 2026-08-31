# Pulse — setup

Everything here is a placeholder. No URL, key, or project name of yours appears anywhere in this
repository, and none should: **this repo must be public**, and everything in it is world-readable.

Work top to bottom once. After that, [§4 "Add a new project in 60 seconds"](#4-add-a-new-project-in-60-seconds)
is the only section you will ever reopen.

---

## 0. Fill in your repository slug

A few files reference `<YOUR_GITHUB_USERNAME>/pulse` because it cannot be known ahead of time. Replace
it once, from the repository root:

```bash
grep -rl "<YOUR_GITHUB_USERNAME>" --exclude-dir=node_modules --exclude-dir=.git . | xargs sed -i "s|<YOUR_GITHUB_USERNAME>|your-github-username|g"
```

On Windows, run that in Git Bash. Also open `LICENSE` and replace `<YOUR NAME>`.

The dashboard does **not** need this — it derives the repository slug at deploy time. This only fixes
the README badge and links.

---

## 1. One-time setup checklist

- [ ] **Create the repository and push this code.** Name it whatever you like; `pulse` is assumed
      throughout.
- [ ] **Make it public.** Settings → General → Danger Zone → Change visibility.
      This is not cosmetic: **public repositories get unlimited GitHub Actions minutes**, while a
      private repository on the Free plan is capped at 2,000 minutes/month. The frequent tier alone
      (a run every 10 minutes, ~1 minute each) is roughly 4,300 minutes/month and would blow that cap
      in the first week. It is also why no secret may ever be committed — see §3.
- [ ] **Enable read/write workflow permissions.** Settings → Actions → General → Workflow permissions
      → **Read and write permissions**. Without this the daily run cannot push history and cannot open
      alert issues.
- [ ] **Enable GitHub Pages.** Settings → Pages → Source → **GitHub Actions**.
      Do not pick "Deploy from a branch".
- [ ] **Run `deploy-dashboard` once.** Actions → deploy-dashboard → Run workflow. Your dashboard is
      then at `https://<your-github-username>.github.io/pulse/`.
- [ ] **The `status` branch.** Nothing to do — the first daily run creates it as an orphan branch if
      it does not exist.
- [ ] **Check the Actions tab shows the four workflows** and that none say "This workflow was disabled".

Local development, entirely optional:

```bash
npm install
npm run verify
```

---

## 2. Your projects

Fill this in. The example rows use obviously fake values — delete them.

| Project name  | Slug (`id`)     | Platform          | DB       | Public URL                         | Health endpoint / DB URL                        | Tier       | Secrets needed                    |
| ------------- | --------------- | ----------------- | -------- | ---------------------------------- | ----------------------------------------------- | ---------- | --------------------------------- |
| Example Notes | `example-notes` | `vercel+supabase` | Postgres | `https://example-notes.vercel.app` | `https://exampleref.supabase.co` (REST, no app) | `daily`    | `EXAMPLE_NOTES_SUPABASE_ANON_KEY` |
| Example API   | `example-api`   | `render+postgres` | Postgres | `https://example-api.onrender.com` | `https://example-api.onrender.com/api/health`   | `frequent` | none                              |
| Example Chat  | `example-chat`  | `atlas-m0`        | MongoDB  | `https://example-chat.fly.dev`     | `https://example-chat.fly.dev/api/health`       | `daily`    | none                              |
|               |                 |                   |          |                                    |                                                 |            |                                   |
|               |                 |                   |          |                                    |                                                 |            |                                   |
|               |                 |                   |          |                                    |                                                 |            |                                   |

Choosing a tier:

- **`daily`** — everything, unless the platform sleeps in minutes. Supabase (7 days) and Atlas
  (30 days) need nothing faster.
- **`frequent`** — only for Render free web services (15-minute spin-down). **At most one.** See
  §5 for the instance-hours arithmetic that forces that choice.

Every enabled target, whatever its tier, is checked by the daily run — that is what records its
history, so every project gets a dashboard card with a real uptime strip.

---

## 3. Secrets

### Naming convention

`<SLUG_IN_CAPS>_<WHAT_IT_IS>`, with hyphens becoming underscores:

| Project slug    | Secret name                       |
| --------------- | --------------------------------- |
| `example-notes` | `EXAMPLE_NOTES_SUPABASE_ANON_KEY` |
| `example-chat`  | `EXAMPLE_CHAT_MONGO_URI`          |
| `example-api`   | `EXAMPLE_API_HEALTH_TOKEN`        |

Add them at **Settings → Secrets and variables → Actions → New repository secret**. Paste the raw
value only — no quotes, no `export`, no trailing newline.

Then reference it in `config/targets.json` as `${EXAMPLE_NOTES_SUPABASE_ANON_KEY}` and list it in
that target's `requiredSecrets`. You do **not** need to touch any workflow file: the workflows pass
every repository secret to the pinger as one JSON blob, which is what keeps adding a project to a
single-file change.

### What is safe to put in the public config file, and what is not

| Value                                   | In `targets.json`? | Why                                                                                                                                           |
| --------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Public site URLs, health endpoint URLs  | ✅ Yes             | Already public. That is what a URL is.                                                                                                        |
| `https://<ref>.supabase.co`             | ✅ Yes             | Public by design; it is in your frontend bundle.                                                                                              |
| Supabase **anon** key                   | ⚠️ Use a secret    | Designed to be public and safe under RLS, but committing it makes rotation a code change and invites scraping. Pulse warns if you inline one. |
| Supabase **service_role** key           | ❌ **Never**       | Bypasses RLS entirely. Full read/write on your database. Pulse never needs it.                                                                |
| Mongo connection string                 | ❌ **Never**       | Contains a password. Validation **fails the build** if this is not a `${SECRET}` reference.                                                   |
| Any `Authorization` / `x-api-key` value | ❌ **Never**       | Validation fails the build on a literal value in those headers.                                                                               |
| Database passwords, JWT signing secrets | ❌ **Never**       | Pulse has no use for them.                                                                                                                    |

If you ever paste a secret into a committed file: rotate it. Deleting the commit is not enough —
public repository content is scraped and archived within minutes.

### Optional secrets

| Secret        | Effect                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| `WEBHOOK_URL` | Discord or Slack incoming webhook. Posts failures. Silently skipped if unset. |

`GITHUB_TOKEN` is provided automatically by Actions. Do not create one.

---

## 4. Add a new project in 60 seconds

This is the section you will reread in a year. It is self-contained.

**1. Give the project a health endpoint that touches the database.**
Copy the right file from [`templates/`](./templates/), deploy it, and confirm in a browser that
`https://your-app/api/health` returns `{"ok":true,...}`.

_Skip this step entirely_ if the project is a static frontend on top of Supabase — use `type:
"supabase"` instead, which calls the database's REST API directly and needs nothing deployed. Run
[`templates/supabase-heartbeat-table.sql`](./templates/supabase-heartbeat-table.sql) once in the
Supabase SQL editor first.

**2. Add any secret.** Settings → Secrets and variables → Actions → New repository secret, named per
§3. Skip if the check needs no credentials.

**3. Add one entry to `config/targets.json`.** No other file changes. No code changes.

```jsonc
// Static frontend + Supabase — talks to Postgres directly:
{
  "id": "your-slug",
  "name": "Your Project",
  "type": "supabase",
  "tier": "daily",
  "platform": "vercel+supabase",
  "publicUrl": "https://your-project.example",
  "supabaseUrl": "https://yourprojectref.supabase.co",
  "apiKey": "${YOUR_SLUG_SUPABASE_ANON_KEY}",
  "table": "heartbeat",
  "requiredSecrets": ["YOUR_SLUG_SUPABASE_ANON_KEY"],
  "notes": "Static frontend, so the check hits PostgREST directly.",
}
```

```jsonc
// Anything with a deployed backend and a health endpoint:
{
  "id": "your-slug",
  "name": "Your Project",
  "type": "http",
  "tier": "daily",
  "platform": "render+postgres",
  "url": "https://your-project.example/api/health",
  "publicUrl": "https://your-project.example",
  "expectStatus": 200,
  "expectBodyContains": "\"ok\":true",
  "notes": "Health endpoint runs SELECT 1.",
}
```

Full field reference: [`config/targets.schema.json`](./config/targets.schema.json) — your editor
reads it and will autocomplete as you type. More examples:
[`config/targets.example.json`](./config/targets.example.json).

**4. Check it locally before pushing** (optional but 5 seconds):

```bash
npm run validate
```

**5. Push, and verify with a real run.** Actions → **heartbeat-daily** → Run workflow → put your slug
in the `target` box → Run. Green tick and a job summary showing your project = done. Red = read the
summary; the error message names the cause.

The dashboard picks the new project up on the next daily run. No redeploy needed.

---

## 5. Per-platform notes

### Supabase

Pauses a free project after **~7 days of insufficient database activity**. Frontend traffic does not
count — the request must reach Postgres.

1. Run [`templates/supabase-heartbeat-table.sql`](./templates/supabase-heartbeat-table.sql) in the
   SQL editor (Dashboard → SQL Editor → New query).
2. Copy the **anon** key from Settings → API. Not the `service_role` key.
3. Add it as a secret and use `type: "supabase"`.

RLS is fine and should stay on. With RLS enabled and no anon policy, PostgREST answers `200 []` — the
query still executed in Postgres, which is all that matters. Pulse treats an empty array as healthy
for exactly this reason.

A paused project must be restored by hand from the dashboard; Pulse cannot wake it.

### MongoDB Atlas

Auto-pauses an idle **M0** cluster after ~30 days with no driver connections.

**Preferred:** deploy [`templates/express-mongoose/health.js`](./templates/express-mongoose/health.js)
(or the equivalent for your stack) and use `type: "http"`. Your app already holds a connection, your
IP access list stays locked down, and Pulse stays dependency-free.

**Fallback**, only for a cluster with no app in front of it — use `type: "mongo"`, and understand the
trade-off:

> GitHub-hosted runners have **dynamic IPs**. There is no published stable range you can allowlist for
> Actions egress, so the Atlas IP access list has to contain **`0.0.0.0/0`** — open to the entire
> internet. Atlas will warn you about this, and it is right to.
>
> That makes two things mandatory, not optional:
>
> 1. A **long random password** (30+ characters, generated, never reused). The cluster's auth is now
>    the only thing between your data and the internet.
> 2. A **dedicated read-only user** for Pulse — Atlas → Database Access → Add New Database User →
>    built-in role **"Only read any database"**. Pulse only ever runs `ping`.
>
> Put the connection string in a secret. Validation refuses a literal one.

### Render

Free web services **spin down after 15 minutes** without inbound HTTP traffic, and take ~30–60
seconds to cold start on the next request.

**The instance-hours arithmetic, which decides how many you can keep awake:**

- The free tier gives **750 instance-hours per month, per account** — not per service.
- A month is ~730 hours. A single service kept awake 24/7 therefore consumes **~730 of your 750
  hours**, leaving ~20 for everything else.
- Two services kept permanently awake would need ~1,460 hours. You would exhaust the allowance around
  the **15th of the month**, and Render suspends free services until the next cycle.

So: **exactly one Render service can hold `tier: "frequent"`.** Pick the one that matters — the one a
recruiter or user might actually open cold. Everything else stays `daily`, which means it will be
asleep when first visited and take ~50 seconds to answer. `npm run validate` warns if more than one
target is on the frequent tier.

Also worth knowing: **Render states there is no supported way to keep a free service permanently
awake** and that the answer is a paid instance. The frequent tier is a workaround, it is
best-effort, and it can stop working. See "This is a workaround" in the README.

### Neon, Turso, Cloudflare D1, Vercel/Netlify static

**No keep-alive needed.** They either auto-wake on the first query with no manual restore, or have no
sleep concept at all. Adding one as a target is harmless — it is monitoring rather than keep-alive,
and the dashboard is nicer when it shows everything — just do not put them on the frequent tier.

---

## 6. Troubleshooting

### "A project got paused anyway"

Work down this list; it is ordered by how often each one is the cause.

1. **The ping never reached the database.** By far the most common. A `type: "http"` check got a 200
   from a CDN edge, a prerendered route, or a health endpoint that returns a static `{"ok":true}`
   without querying anything.
   _Check:_ open the health endpoint in a browser twice a few seconds apart. Does `latencyMs` change?
   If it is identical every time, the response is cached and no query is happening.
   _Fix:_ use the templates as written (`cache-control: no-store`, `dynamic = 'force-dynamic'`), or
   switch to `type: "supabase"`, which cannot be cached because it talks to PostgREST directly.

2. **The workflow was disabled at 60 days.** GitHub disables scheduled workflows in a repository with
   no commit activity for 60 days.
   _Check:_ Actions tab. A disabled workflow shows a banner and an "Enable workflow" button.
   _Fix:_ re-enable it, then check that `keepalive.yml` is itself enabled and green — it exists to
   prevent this and can only do so while it is running.

3. **A secret expired, was rotated, or was never added.** A rotated Supabase key gives 401; a missing
   one fails the run before any request with the variable named.
   _Check:_ the failed run's job summary names the exact secret.
   _Fix:_ update the repository secret. No code change.

4. **The health endpoint returns 200 without touching the DB.** The 200 is real, the database work is
   not — a `try/catch` that swallows the error and still answers 200 is the usual shape.
   _Fix:_ set `expectBodyContains: "\"ok\":true"` so a degraded response cannot pass, and make sure
   the endpoint returns 500 on a query error, as every template does.

5. **The target was disabled or the tier was wrong.** `"enabled": false`, or a Render service left on
   `daily` and therefore only pinged once a day.
   _Check:_ `npm run validate` lists disabled targets as warnings.

6. **The run was hours late.** Scheduled workflows are best-effort and routinely run 5–30 minutes
   late; occasionally a scheduled run is dropped entirely under load. Harmless against a 7-day
   window, fatal against Render's 15 minutes. This is a real limitation with no free fix.

### Other failures

| Symptom                                                             | Cause and fix                                                                                                                                |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Run fails immediately with "secrets ... not set in the environment" | The secret is not in repository secrets, or the name differs from `requiredSecrets`. Names are case-sensitive.                               |
| Supabase check returns 404                                          | The `heartbeat` table does not exist in the exposed schema. Run the SQL template.                                                            |
| Supabase check returns 401                                          | Wrong or rotated anon key, or a key from a different project.                                                                                |
| Supabase check returns 400                                          | The `column` (default `id`) does not exist on that table.                                                                                    |
| Mongo check times out with "server selection timed out"             | Atlas IP access list does not include `0.0.0.0/0`.                                                                                           |
| Dashboard says "Could not load the status data"                     | The daily run has not succeeded yet (no `status` branch), the repo is private, or Pages was deployed before the first heartbeat.             |
| Dashboard is stale                                                  | It reads `raw.githubusercontent.com`, which caches for a few minutes. Hard-refresh.                                                          |
| Twenty issues for one outage                                        | Should be impossible — issues are deduplicated by a hidden marker. If it happens, check whether the `pulse-alert` label was removed by hand. |
| `validate` fails on a PR with "unknown property"                    | A typo, or a field from a different check type. The message names the field and which type owns it.                                          |

### Re-checking one project by hand

Actions → **heartbeat-daily** → Run workflow → `target`: `your-slug`. Or locally:

```bash
YOUR_SLUG_SUPABASE_ANON_KEY='...' node src/run.js --target your-slug
```

Validate the config without sending any request or setting any secret:

```bash
node src/run.js --dry-run --skip-secrets
```
