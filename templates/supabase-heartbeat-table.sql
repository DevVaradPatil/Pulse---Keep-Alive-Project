-- Pulse: the heartbeat table for a Supabase project.
--
-- Run this once per project in the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> Run).
--
-- WHY THIS COUNTS AS ACTIVITY
-- Supabase pauses a free project after ~7 days of insufficient *database*
-- activity. Traffic to your frontend does not count, and neither does anything
-- answered from a CDN edge. A `select` executed by Postgres does.
--
-- Pulse's `supabase` check calls PostgREST:
--   GET https://<ref>.supabase.co/rest/v1/heartbeat?select=id&limit=1
-- which PostgREST turns into a real SELECT against this table. That is the
-- whole mechanism - the table's contents are irrelevant, only that a statement
-- runs.

create table if not exists public.heartbeat (
  id bigint generated always as identity primary key,
  noted_at timestamptz not null default now(),
  note text
);

-- One row so the select has something to return. Not required (an empty result
-- is still a query that executed), but it makes a successful check visibly
-- distinguishable from a permissions problem.
insert into public.heartbeat (note)
select 'created for pulse keep-alive'
where not exists (select 1 from public.heartbeat);

-- RLS ON, with no policy for the anon role.
--
-- This is the safe default and it does NOT break the check: with RLS enabled
-- and no policy, PostgREST returns `200 []`. The statement still ran inside
-- Postgres, which is all the keep-alive needs. Pulse treats an empty array as
-- healthy for exactly this reason.
alter table public.heartbeat enable row level security;

-- OPTIONAL. Uncomment only if you want the check to return an actual row, and
-- understand that it makes the table's contents readable by anyone holding the
-- anon key (which is a public value). Never put anything sensitive in here.
--
-- create policy "heartbeat is readable by anon"
--   on public.heartbeat
--   for select
--   to anon
--   using (true);

-- Then in config/targets.json:
--
-- {
--   "id": "your-slug",
--   "name": "Your Project",
--   "type": "supabase",
--   "tier": "daily",
--   "supabaseUrl": "https://<project-ref>.supabase.co",
--   "apiKey": "${YOUR_SLUG_SUPABASE_ANON_KEY}",
--   "table": "heartbeat",
--   "requiredSecrets": ["YOUR_SLUG_SUPABASE_ANON_KEY"]
-- }
