# Pulse — setup

No URL, key, or project name of yours appears anywhere in this repository, and none should.

---

## Quickstart — public repo, hidden targets

**This is the mode this repo is set up for.** The code is public; your project list is not. Sections
00–6 below are reference; this is the part you follow.

### One-time

1. **Workflow permissions.** Settings → Actions → General → Workflow permissions →
   **Read and write permissions**. Without it the daily run cannot save history or open alert issues.
2. **Leave `PULSE_PUBLISH_DASHBOARD` unset.** Publishing the dashboard would republish the names you
   are hiding. You view status locally with `npm run dashboard`.
3. **Never edit `config/targets.json`.** It stays the empty stub it ships as. That is the point.

### Adding your projects

Everything goes in **one local file**, `my-targets.json`, which is git-ignored and can never be
committed. Start from the template:

```bash
cp config/targets.template.json my-targets.json
```

Fill it in — one entry per project. Which fields depend on the check type:

| Your project                                      | `type`     | Where the link goes                                           | Secret needed       |
| ------------------------------------------------- | ---------- | ------------------------------------------------------------- | ------------------- |
| Static frontend on Supabase (no backend of yours) | `supabase` | `supabaseUrl` = `https://<ref>.supabase.co`                   | anon key → `apiKey` |
| Anything with a deployed backend                  | `http`     | `url` = your health endpoint, e.g. `https://x.com/api/health` | usually none        |
| Atlas cluster with no app in front of it          | `mongo`    | nothing — the URI **is** the secret → `connectionString`      | Mongo URI           |
| Static site, no database (Vercel/Netlify)         | `http`     | `url` = the site URL. Monitoring only; nothing needs waking.  | none                |

`publicUrl` is optional on every type — it is only the link the dashboard card points at.

**Secrets never go in this file.** Write `"apiKey": "${MYAPP_SUPABASE_ANON_KEY}"`, list that name in
`requiredSecrets`, and add the real value as a repository secret.

### Check it before you paste it

```bash
npm run targets
```

That validates `my-targets.json` and prints exactly what would be pinged, without sending a request
or needing any secret set.

### Publish it as a secret

Settings → Secrets and variables → Actions → New repository secret:

- Name: **`PULSE_TARGETS_JSON`**
- Value: the entire contents of `my-targets.json`

Then add one secret per `${NAME}` you referenced (naming convention in §3).

Repeat those two steps — edit the file, re-paste the secret — whenever you add a project. Keep
`my-targets.json` on your machine; it is the editable copy.

### Verify

Actions → **heartbeat-daily** → Run workflow. Green tick = done. Then:

```bash
npm run dashboard
```

### What this mode guarantees

Pulse switches itself to a private posture as soon as the config comes from a secret:

- The `status` branch history, alert issues and job summaries carry the target **`id`** only — never
  the name, platform, URL, or notes.
- Every target URL and hostname is registered with `::add-mask::`, so public Actions logs show `***`.
- Failure text (`expected HTTP 200 but got 503`) is kept, so a red dashboard is still debuggable.

Pick ids that are not themselves revealing (`api-1`, not `client-acme-invoices`) — the id is the one
thing that is published.

---

## 00. Choose your mode

**Read this first.** It is the only decision here that is hard to change later, and it is entirely
about what you are willing to publish.

Secrets are never committed in any mode — keys live in GitHub Secrets and the config holds only
`${SECRET}` references. What differs is everything _around_ the keys: the URLs, project names,
history, alert issues, and workflow logs.

|                                           | **A — Private repo** _(recommended)_ | **B — Public repo** | **C — Public repo, hidden targets** |
| ----------------------------------------- | ------------------------------------ | ------------------- | ----------------------------------- |
| Who can see your URLs and project names   | Only you                             | Anyone              | Only you                            |
| Who can see run history and alert issues  | Only you                             | Anyone              | Only you                            |
| Who can read the workflow logs            | Only you                             | Anyone              | Only you (values are masked)        |
| Actions minutes                           | 2,000/month free                     | Unlimited           | Unlimited                           |
| Daily tier (Supabase, Atlas)              | ✅ ~34 min/month                     | ✅                  | ✅                                  |
| Frequent tier (Render, 10-min)            | ❌ needs ~4,320 min/month            | ✅                  | ✅                                  |
| Hosted dashboard on GitHub Pages          | ❌ not on the Free plan              | ✅                  | ⚠️ would republish the names        |
| Local dashboard (`npm run dashboard`)     | ✅                                   | ✅                  | ✅                                  |
| Edit targets in a diffable, reviewed file | ✅                                   | ✅                  | ❌ paste JSON into a secret         |
| Recruiter can read the code               | ❌                                   | ✅                  | ✅                                  |

### The arithmetic behind the frequent tier

Every Actions job is billed **rounded up to the nearest minute**, so a schedule's cost is simply its
number of runs. A 10-minute cron is ~4,320 runs/month, which is ~4,320 minutes — free on a public
repo, and more than double a private repo's 2,000. No amount of making the check faster changes that.

Check it yourself at any time:

```bash
npm run estimate
```

Out of the box that reports **~34 minutes/month**, because the frequent tier ships **gated off**. It
fits a private repo's free budget about sixty times over.

### What you actually lose by picking A

Only this: **Render free services will cold-start** (~50 seconds) on their first visit instead of
being kept warm. That is the whole cost — and it is much smaller than it sounds, because **Render
wakes by itself**. Unlike Supabase (7-day pause, manual restore from the dashboard) and Atlas
(30-day pause, manual resume), a spun-down Render service is not paused, just cold. Nothing breaks,
nothing needs a manual restore, and the daily tier still protects the two platforms that genuinely
need protecting.

If you want the frequent tier anyway, mode B or C, or ping that one Render URL from any free external
cron you already trust.

### Setting up mode A (private)

1. Settings → General → Danger Zone → **Change visibility → private**.
2. Leave `PULSE_TIER_FREQUENT` unset. The frequent workflow's schedule still fires, but its job is
   skipped, and **a skipped job allocates no runner and costs nothing**.
3. Leave `PULSE_PUBLISH_DASHBOARD` unset. Skip the Pages steps in §1.
4. View status with `npm run dashboard` — the same page, reading the same `history.json` from the
   `status` branch, served on localhost and published nowhere.

### Setting up mode C (public code, hidden targets)

Use this if you want the repo readable as a portfolio piece but do not want to reveal what you run.

1. Keep `config/targets.json` as the empty stub it ships as. Nothing identifying is ever committed.
2. Put the entire config in one repository secret named **`PULSE_TARGETS_JSON`** — same JSON shape as
   `config/targets.json`, validated identically at run time.
3. Leave `PULSE_PUBLISH_DASHBOARD` unset. A published dashboard would republish exactly what you hid.

Pulse then switches itself to a private posture automatically, because you asked for one:

- `privacy.publishDetails` defaults to **false**, so the history file, alert issues and step
  summaries carry only the target **id** — never the name, platform, public URL or notes. Failure
  text is kept (`expected HTTP 200 but got 503`), because a red dashboard has to stay debuggable.
- Every target URL and hostname is registered with `::add-mask::`, so the Actions log shows `***`
  instead — even in output Pulse did not write itself.

Set `"privacy": { "publishDetails": true }` in the config to override that if you want the names back.

The honest cost of mode C: editing targets means pasting JSON into a textarea in the GitHub UI. No
diff, no pull request, no editor autocomplete. Draft the file locally, check it, then paste:

```bash
node src/run.js --dry-run --config ./my-targets.json
```

---

## 0. Fill in your repository slug

A few files reference `devVaradPatil/pulse` because it cannot be known ahead of time. Replace
it once, from the repository root:

```bash
grep -rl "devVaradPatil" --exclude-dir=node_modules --exclude-dir=.git . | xargs sed -i "s|devVaradPatil|your-github-username|g"
```

On Windows, run that in Git Bash. Also open `LICENSE` and replace `<YOUR NAME>`.

The dashboard does **not** need this — it derives the repository slug at deploy time. This only fixes
the README badge and links.

---

## 1. One-time setup checklist

Steps marked **(B/C)** are only for the public modes. On a private repo, skip them.

- [x] **Create the repository and push this code.** Name it whatever you like; `pulse` is assumed
      throughout.
- [ ] **Set the visibility you chose in §00.** Settings → General → Danger Zone → Change visibility.
      Private is the default recommendation; everything except the frequent tier and the hosted
      dashboard works identically.
- [ ] **Enable read/write workflow permissions.** Settings → Actions → General → Workflow permissions
      → **Read and write permissions**. Without this the daily run cannot push history and cannot open
      alert issues. Required in every mode.
- [ ] **Check the budget.** `npm run estimate` — it must fit whichever plan you are on. CI runs this
      too, so an over-eager cron change fails in review rather than mid-month.
- [ ] **(B/C) Enable GitHub Pages.** Settings → Pages → Source → **GitHub Actions**.
      Do not pick "Deploy from a branch". Pages needs a public repo on the Free plan.
- [ ] **(B) Turn the dashboard on.** Settings → Secrets and variables → Actions → **Variables** →
      `PULSE_PUBLISH_DASHBOARD` = `true`, then Actions → deploy-dashboard → Run workflow. It lands at
      `https://<your-github-username>.github.io/pulse/`. Leave this unset in modes A and C.
- [ ] **(B/C, optional) Turn the frequent tier on.** Variables → `PULSE_TIER_FREQUENT` = `enabled`.
      Only after `npm run estimate` says you can afford it. Never on a private free repo.
- [ ] **The `status` branch.** Nothing to do — the first daily run creates it as an orphan branch if
      it does not exist.
- [ ] **Check the Actions tab shows the five workflows** and that none say "This workflow was
      disabled".

Viewing your status:

```bash
npm run dashboard          # every mode: local, private, nothing published
```

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
that target's `requiredSecrets`. You do **not** need to touch any workflow file: the heartbeat
workflows pass every repository secret to the pinger as one JSON blob (`PULSE_SECRETS_JSON:
${{ toJSON(secrets) }}`), which is what keeps adding a project to a single-file change.

**The trade-off in that line, stated plainly:** the pinger process can read every repository secret,
not only the ones its targets use. It is the same code, from your own default branch, that would have
read them from individual `env:` entries anyway, and Actions never hands secrets to a pull request
from a fork — but if you keep unrelated high-value secrets in this repo, that is a reason not to.
To opt out, delete the `PULSE_SECRETS_JSON` line from both heartbeat workflows and list what you
need explicitly instead:

```yaml
env:
  EXAMPLE_NOTES_SUPABASE_ANON_KEY: ${{ secrets.EXAMPLE_NOTES_SUPABASE_ANON_KEY }}
```

You then have to add a line there for each new project, which is the cost of the least-privilege
version. Validation still catches a reference you forgot to wire up.

### What may go in the config file, and what must never

The last two columns are the whole point of §00: what is safe depends on who can read the repo.

| Value                                   | Private repo (A) | Public repo (B/C) | Why                                                                                                            |
| --------------------------------------- | ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Public site URLs, health endpoint URLs  | ✅ Yes           | ⚠️ Your call      | Not a secret, but it is a public inventory of what you run and where. Mode C hides it; mode B publishes it.    |
| Project names, platform labels, notes   | ✅ Yes           | ⚠️ Your call      | Same. Harmless to you, or an unwanted map of your side projects — only you can decide.                         |
| `https://<ref>.supabase.co`             | ✅ Yes           | ⚠️ Your call      | Public by design; already in your frontend bundle. Still identifying.                                          |
| Supabase **anon** key                   | ⚠️ Use a secret  | ⚠️ Use a secret   | Safe under RLS, but inlining makes rotation a code change and invites scraping. Pulse warns if you inline one. |
| Supabase **service_role** key           | ❌ **Never**     | ❌ **Never**      | Bypasses RLS entirely. Full read/write on your database. Pulse never needs it.                                 |
| Mongo connection string                 | ❌ **Never**     | ❌ **Never**      | Contains a password. Validation **fails the build** if this is not a `${SECRET}` reference.                    |
| Any `Authorization` / `x-api-key` value | ❌ **Never**     | ❌ **Never**      | Validation fails the build on a literal value in those headers.                                                |
| Database passwords, JWT signing secrets | ❌ **Never**     | ❌ **Never**      | Pulse has no use for them.                                                                                     |

The four ❌ rows never change with visibility. A private repo is not a safe place for a password
either: every collaborator can read it, so can anyone who gets a token, and a repo that starts
private can be made public by one click years later.

If you ever paste a secret into a committed file: **rotate it**. Deleting the commit is not enough —
public repository content is scraped and archived within minutes, and a private repo's history keeps
the value for anyone who later gains access.

### What leaks where, in each mode

Worth knowing precisely, because "the repo has no secrets in it" is not the same as "nothing is
exposed":

| Surface                     | What it contains                        | Private (A) | Public (B) | Public + hidden (C)       |
| --------------------------- | --------------------------------------- | ----------- | ---------- | ------------------------- |
| `config/targets.json`       | URLs, names, platforms                  | Private     | Public     | Empty — lives in a secret |
| `status` branch history     | Names, URLs, response times, error text | Private     | Public     | Ids and error text only   |
| Alert issues                | Name, URL, platform, error              | Private     | Public     | Id and error only         |
| Actions logs & step summary | Whatever the run printed                | Private     | Public     | URLs and hosts masked     |
| GitHub Pages dashboard      | Everything on the cards                 | Unavailable | Public     | Keep it off               |

### Optional secrets and variables

| Secret               | Effect                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `WEBHOOK_URL`        | Discord or Slack incoming webhook. Posts failures. Silently skipped if unset.                    |
| `PULSE_TARGETS_JSON` | Mode C only. The whole target list, keeping it out of the repo. Overrides `config/targets.json`. |

Repository **variables** (Settings → Secrets and variables → Actions → **Variables**, not Secrets):

| Variable                  | Set it to | Effect                                                                                   |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `PULSE_TIER_FREQUENT`     | `enabled` | Turns on the 10-minute tier. ~4,320 minutes/month — public repos only.                   |
| `PULSE_PUBLISH_DASHBOARD` | `true`    | Turns on the GitHub Pages deploy. Public repos only, and it publishes your project list. |

Both are unset by default, and both workflows are **skipped entirely** while they are — a skipped job
allocates no runner, so an unused schedule costs nothing at all.

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
