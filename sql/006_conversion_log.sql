-- 006 — the counter behind the hosted .docx to PDF converter.
--
-- The converter (supabase/functions/docx-to-pdf) runs LibreOffice on our
-- infrastructure so that end users install nothing. That means we pay for it,
-- and anything we pay for on behalf of whoever is signed in needs a bound —
-- otherwise one runaway loop, or one person who scripts it, spends the budget
-- for everybody. Same reasoning as the ai_usage table in 002.
--
-- Deliberately records nothing about the document. Only that a conversion
-- happened, for whom, and how many bytes went in and out — enough to enforce a
-- daily cap and to see what the thing costs, and nothing that would make this
-- table worth reading if it leaked. The CV itself passes through the function
-- in memory and is never stored.

create table if not exists public.conversion_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  in_bytes    integer,
  out_bytes   integer,
  created_at  timestamptz not null default now()
);

-- The only query this table serves: "how many conversions has this user made
-- since <timestamp>". Both columns, in that order, so the count is an index
-- scan rather than a scan of every row the user has ever made.
create index if not exists conversion_log_user_time
  on public.conversion_log (user_id, created_at desc);

alter table public.conversion_log enable row level security;

-- Users may read their own rows, which is what lets a "conversions used today"
-- indicator exist later without another endpoint. Nobody may write: the only
-- writer is the edge function, and it uses the service role, which bypasses
-- RLS. An insert policy would let a client forge or, worse, delete usage.
drop policy if exists conversion_log_select_own on public.conversion_log;
create policy conversion_log_select_own
  on public.conversion_log for select
  using (auth.uid() = user_id);

-- PostgREST caches the schema and will 404 a brand-new table until it reloads.
-- A missing 'mime' column did exactly this in 005 and killed an application
-- mid-run, so every migration here ends the same way.
notify pgrst, 'reload schema';
