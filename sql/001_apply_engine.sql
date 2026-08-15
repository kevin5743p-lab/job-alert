-- 001_apply_engine.sql — the auto-apply engine's tables.
--
-- ADDITIVE ONLY. Every statement here is CREATE or ADD COLUMN; nothing the old
-- extension/ reads is altered or dropped. Both extensions and the Python bot
-- keep pointing at this same project and keep working. That is the whole point
-- of running the new system out of AutoApply/ instead of editing in place.
--
-- Run this once in the Supabase SQL editor.

-- ── apply_runs ──────────────────────────────────────────────────────────────
-- The work queue: one row per apply attempt, plus its audit trail.
--
-- `steps` is append-only. Every action the agent takes lands there with the
-- grounding it claimed, so a submitted application can be reconstructed after
-- the fact — which matters because a submit cannot be recalled.
create table if not exists public.apply_runs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  application_id    uuid references public.applications(id) on delete set null,

  job_url           text not null,
  job_title         text,
  job_company       text,

  -- Registrable domain. The circuit-breaker key, and the reason one site
  -- getting blocked cannot stall the others.
  domain            text not null,
  -- 0 = plain DOM (no debugger attach at all)
  -- 1 = CDP trusted input (Workday, LinkedIn)
  -- 2 = guarded (Indeed, StepStone, Xing) — evasion + tight caps + breaker
  tier              smallint not null default 0 check (tier between 0 and 2),

  status            text not null default 'queued'
                    check (status in ('queued','running','paused_needs_human',
                                      'submitted','failed','blocked','aborted')),

  steps             jsonb not null default '[]'::jsonb,
  pause_reason      text,
  screenshot_path   text,                       -- object path inside apply-docs
  error             text,
  attempts          smallint not null default 0,

  -- Set when resolve_ats.js rerouted an Indeed/StepStone/Xing posting to the
  -- company's real ATS. Keeping the original makes the reroute auditable.
  original_job_url  text,

  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One live run per job. A second Apply click on a job already queued or running
-- is a no-op rather than a duplicate application.
create unique index if not exists apply_runs_one_live_per_job
  on public.apply_runs (user_id, job_url)
  where status in ('queued','running','paused_needs_human');

create index if not exists apply_runs_claim_idx
  on public.apply_runs (user_id, status, domain, created_at);

-- ── domain_health ───────────────────────────────────────────────────────────
-- The isolation boundary. The router reads this before every claim, so a
-- quarantined domain's jobs are skipped while every other domain keeps running.
create table if not exists public.domain_health (
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  domain               text not null,

  state                text not null default 'healthy'
                       check (state in ('healthy','degraded','quarantined')),
  tier                 smallint not null default 0 check (tier between 0 and 2),

  consecutive_failures smallint not null default 0,
  applied_today        smallint not null default 0,
  daily_cap            smallint not null default 20,
  -- Randomised per user so the counter doesn't reset at a suspiciously round
  -- midnight boundary.
  day_resets_at        timestamptz,

  quarantined_until    timestamptz,
  -- What tripped the breaker, verbatim: 'http_403', 'cloudflare_challenge',
  -- 'captcha_iframe', 'datadome', 'consecutive_failures', …
  last_signal          text,
  last_signal_at       timestamptz,
  last_applied_at      timestamptz,

  updated_at           timestamptz not null default now(),
  primary key (user_id, domain)
);

-- ── apply_documents ─────────────────────────────────────────────────────────
-- Generated CV / cover-letter PDFs, so re-running a job doesn't re-render them.
-- `disk_path` is the absolute local path chrome.downloads wrote to; CDP's
-- DOM.setFileInputFiles takes paths, not blobs, so we need both.
create table if not exists public.apply_documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_url       text not null,
  kind          text not null check (kind in ('cv','cover_letter')),
  storage_path  text not null,
  disk_path     text,
  filename      text,
  bytes         integer,
  created_at    timestamptz not null default now()
);

create unique index if not exists apply_documents_job_kind
  on public.apply_documents (user_id, job_url, kind);

-- ── applications: one additive column ───────────────────────────────────────
-- The old extension selects `*` but never reads this, so it is unaffected.
alter table public.applications
  add column if not exists apply_run_id uuid references public.apply_runs(id) on delete set null;

-- ── updated_at triggers ─────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists apply_runs_touch on public.apply_runs;
create trigger apply_runs_touch before update on public.apply_runs
  for each row execute function public.touch_updated_at();

drop trigger if exists domain_health_touch on public.domain_health;
create trigger domain_health_touch before update on public.domain_health
  for each row execute function public.touch_updated_at();

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Same shape as the existing tables: an account can only ever see its own rows.
alter table public.apply_runs      enable row level security;
alter table public.domain_health   enable row level security;
alter table public.apply_documents enable row level security;

drop policy if exists apply_runs_own on public.apply_runs;
create policy apply_runs_own on public.apply_runs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists domain_health_own on public.domain_health;
create policy domain_health_own on public.domain_health
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists apply_documents_own on public.apply_documents;
create policy apply_documents_own on public.apply_documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Storage bucket for the generated PDFs and pause screenshots ─────────────
-- Private. Objects are namespaced by user id in their path, and the policies
-- below enforce that the first path segment matches the caller.
insert into storage.buckets (id, name, public)
values ('apply-docs', 'apply-docs', false)
on conflict (id) do nothing;

drop policy if exists apply_docs_own on storage.objects;
create policy apply_docs_own on storage.objects
  for all
  using      (bucket_id = 'apply-docs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'apply-docs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── Claim one queued run, skipping quarantined and capped domains ───────────
-- Runs server-side so the extension and the Phase 3 daemon can poll the same
-- queue concurrently without handing the same job to both. FOR UPDATE SKIP
-- LOCKED is what makes that safe.
create or replace function public.claim_apply_run()
returns public.apply_runs
language plpgsql security invoker as $$
declare
  claimed public.apply_runs;
begin
  select r.* into claimed
    from public.apply_runs r
    left join public.domain_health h
      on h.user_id = r.user_id and h.domain = r.domain
   where r.user_id = auth.uid()
     and r.status  = 'queued'
     -- Skip quarantined domains. Everything else keeps flowing.
     and (h.state is null or h.state <> 'quarantined'
          or (h.quarantined_until is not null and h.quarantined_until < now()))
     -- Respect the per-domain daily cap.
     and (h.applied_today is null or h.applied_today < h.daily_cap)
   order by r.tier asc, r.created_at asc   -- safest sites first
   limit 1
     for update of r skip locked;

  if claimed.id is null then
    return null;
  end if;

  update public.apply_runs
     set status     = 'running',
         attempts   = attempts + 1,
         started_at = coalesce(started_at, now())
   where id = claimed.id
   returning * into claimed;

  return claimed;
end $$;
