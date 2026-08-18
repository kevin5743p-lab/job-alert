-- 007_apply_memory.sql — what the engine remembers between applications.
--
-- ADDITIVE ONLY, like every migration here. Nothing existing is altered.
--
-- THE PROBLEM
--
-- Every application starts from zero. The engine has hit BMW's Workday tenant
-- eleven times; on the twelfth it still does not know that tenant wants an
-- account, that page 4 asks for a reference, or that "Kündigungsfrist" is the
-- notice-period question under a German label. `apply_runs.steps` recorded all
-- of it faithfully — and nothing ever read it back.
--
-- So the audit trail is a diary, not a memory. These three tables are the
-- difference:
--
--   apply_lessons      a problem, and the fix that worked, scoped to where it
--                      applies (this company / this ATS / everywhere)
--   company_playbooks  what applying to *this employer* actually involves
--   apply_outcomes     one row per finished run: what was tried, how far it
--                      got. The ledger that decides whether a remedy is
--                      earning its place or should be retired.
--
-- WHY THREE TABLES AND NOT ONE
--
-- A lesson is keyed on the problem, and gets updated. An outcome is keyed on
-- the run, and is immutable. Merging them gives a table that is neither: you
-- cannot ask "what do we know about BMW" without folding a thousand rows, and
-- you cannot ask "did that fix work" without mutating history.
--
-- Run this once in the Supabase SQL editor.

-- ── apply_lessons ───────────────────────────────────────────────────────────
-- One row per distinct problem in a distinct place. NOT one row per occurrence:
-- the unique index below turns the second encounter into an increment, which is
-- what makes this a memory rather than a second log.
create table if not exists public.apply_lessons (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- WHERE the lesson applies. Widening scope is the whole value of the table:
  -- "Workday puts the CV upload behind an 'Autofill with Resume' button" is
  -- true of every Workday tenant, while "this company wants a photograph" is
  -- true of exactly one employer.
  --
  --   global   every application
  --   ats      one applicant-tracking system: workday, greenhouse, lever…
  --   company  one employer, by normalizeCompany() key: 'bmw', 'volkswagen'
  --   domain   one host: 'bmw.wd3.myworkdayjobs.com'
  scope         text not null check (scope in ('global','ats','company','domain')),
  scope_key     text not null default '',

  -- WHAT went wrong. Same vocabulary pause_help.js already classifies pauses
  -- with, so the taxonomy has exactly one definition in the codebase, plus the
  -- kinds only a post-run reading can see.
  problem_kind  text not null,
  -- The problem's fingerprint within its kind — a normalised field label, an
  -- error shape. Kind alone is too coarse: two different unanswerable
  -- questions at the same employer are two lessons, not one seen twice.
  signature     text not null,

  -- HOW to fix it, in a closed set of shapes the reader can actually act on.
  -- Prose alone would make this a notes field: something to show the user and
  -- paste at a model, but nothing autofill or the submit gate could execute.
  -- See REMEDY_KINDS in extension/learn.js — the enum lives there, not here,
  -- so adding a shape is a code change and not a migration.
  remedy        jsonb not null,
  -- The same thing in a sentence, for the dashboard. Written for someone
  -- deciding whether the engine has learned something true.
  remedy_note   text not null default '',

  -- Which run taught us, and the step within it. The apply agent may not enter
  -- a value it cannot source; a lesson may not exist without a step it came
  -- from. Same contract, applied to the thing that writes to the future.
  evidence      jsonb not null default '{}'::jsonb,

  times_seen    integer not null default 1,
  times_worked  integer not null default 0,
  times_failed  integer not null default 0,

  -- A remedy that stops working is retired, never deleted: deleting it means
  -- the next run rediscovers it, writes it again, and fails again. The
  -- tombstone is the point.
  status        text not null default 'active' check (status in ('active','retired')),
  retired_reason text,

  -- Set when the user edits or deletes a lesson by hand. Their correction
  -- outranks anything a run inferred, and must not be overwritten by the next
  -- run that hits the same problem.
  pinned        boolean not null default false,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The constraint that makes this a memory. Without it every run appends.
create unique index if not exists apply_lessons_identity
  on public.apply_lessons (user_id, scope, scope_key, problem_kind, signature);

-- The recall query: everything in scope for the job about to be applied to.
create index if not exists apply_lessons_recall
  on public.apply_lessons (user_id, status, scope, scope_key);

-- ── company_playbooks ───────────────────────────────────────────────────────
-- "At BMW I need this; at Volkswagen I need that."
--
-- Keyed on normalizeCompany() rather than the name as written, because the same
-- employer arrives as "BMW AG" from their careers site and "BMW Group" from
-- LinkedIn. job_key.js already collapses both to 'bmw'; reusing it here means
-- the playbook a Greenhouse application wrote is found by a Workday one.
create table if not exists public.company_playbooks (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_key       text not null,

  -- Last spelling actually seen, for display. The key is for matching; showing
  -- a user 'bmw' where they wrote "BMW AG" reads like a bug.
  company_name      text,
  ats               text,
  domains           text[] not null default '{}',

  -- Workday tenants that require a login are the single most common reason a
  -- run at a large employer cannot finish. Knowing before the run starts turns
  -- a four-minute dead end into an upfront "this one needs your account".
  account_required  boolean not null default false,
  account_note      text,

  -- Attachments this employer demands beyond a CV — a photo, a transcript, an
  -- Arbeitszeugnis. Read by the submit gate, so a missing one blocks the
  -- submit instead of sending an application that will be discarded.
  required_documents text[] not null default '{}',

  -- [{ question, answer, profile_key, worked, seen, last_at }]
  -- Screening questions this employer asks, and what was actually sent. The
  -- second application to the same company should not re-derive them.
  known_questions   jsonb not null default '[]'::jsonb,

  -- [{ note, kind, run_id, at }] — how the flow behaves here. "The apply form
  -- is in an iframe", "page 3 is references", "submit is a two-step confirm".
  flow_notes        jsonb not null default '[]'::jsonb,

  runs              integer not null default 0,
  submitted         integer not null default 0,
  paused            integer not null default 0,
  failed            integer not null default 0,
  -- Typical cost of an application here, against the 25-step budget. A company
  -- that habitually takes 22 is one worth raising the budget for rather than
  -- letting it run out on step 25 every time.
  typical_steps     integer,

  last_outcome      text,
  -- The furthest checkpoint any run here has reached (see apply_outcomes.reached).
  -- This is the bar the next run is measured against, and therefore the thing
  -- that decides whether the remedies it carried get credited or blamed.
  last_reached      smallint not null default 0,
  last_run_at       timestamptz,
  updated_at        timestamptz not null default now(),

  primary key (user_id, company_key)
);

-- ── apply_outcomes ──────────────────────────────────────────────────────────
-- One immutable row per finished run. Two jobs:
--
--   1. the input to learning — what happened, distilled once, so the model pass
--      never has to re-read a 200-entry step log
--   2. the confirmation loop — `applied_lessons` records which remedies this
--      run was carrying, and `reached` records how far it got. The next run at
--      the same problem compares the two, and that comparison is the only
--      evidence that a remedy works. A fix nobody checks is a guess with a
--      timestamp on it.
create table if not exists public.apply_outcomes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  run_id         uuid references public.apply_runs(id) on delete cascade,

  company_key    text,
  ats            text,
  domain         text,
  status         text not null,

  problem_kind   text,
  problem_signature text,

  -- Lesson ids in force during this run. uuid[] and not a join table: it is
  -- read whole, written once, and never queried by element.
  applied_lessons uuid[] not null default '{}',

  -- The furthest lifecycle checkpoint reached, as an ordinal. This is the
  -- yardstick the confirmation loop measures against, and it is deliberately
  -- coarse — "got to the submit gate and was refused" beats "paused on page 1"
  -- even though both are a pause, and a remedy that moves a run from 2 to 4 has
  -- earned its keep whether or not the application went out.
  --
  --   0 nothing  1 page_ready  2 form_filled  3 docs_attached
  --   4 gate_reached          5 submitted
  reached        smallint not null default 0,

  steps_used     smallint,
  duration_ms    integer,

  -- What the writer distilled, before it was folded into lessons and the
  -- playbook. Kept so the fold can be re-run after a change to the aggregation
  -- without re-reading every step log.
  learned        jsonb not null default '{}'::jsonb,

  created_at     timestamptz not null default now()
);

create index if not exists apply_outcomes_recent
  on public.apply_outcomes (user_id, company_key, created_at desc);

-- Serves the confirmation loop: "did this problem recur after we learned it?"
create index if not exists apply_outcomes_problem
  on public.apply_outcomes (user_id, problem_kind, problem_signature, created_at desc);

-- ── updated_at ──────────────────────────────────────────────────────────────
-- touch_updated_at() is created by 001. Reused, not redefined.
drop trigger if exists apply_lessons_touch on public.apply_lessons;
create trigger apply_lessons_touch before update on public.apply_lessons
  for each row execute function public.touch_updated_at();

drop trigger if exists company_playbooks_touch on public.company_playbooks;
create trigger company_playbooks_touch before update on public.company_playbooks
  for each row execute function public.touch_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every table here is written by the extension under the user's own JWT, so
-- unlike conversion_log these need full CRUD policies and not select-only.
-- Delete matters in particular: a wrong lesson the user throws away must
-- actually go.
alter table public.apply_lessons     enable row level security;
alter table public.company_playbooks enable row level security;
alter table public.apply_outcomes    enable row level security;

drop policy if exists apply_lessons_own on public.apply_lessons;
create policy apply_lessons_own on public.apply_lessons
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists company_playbooks_own on public.company_playbooks;
create policy company_playbooks_own on public.company_playbooks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists apply_outcomes_own on public.apply_outcomes;
create policy apply_outcomes_own on public.apply_outcomes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── the increment ───────────────────────────────────────────────────────────
-- Recording a lesson is upsert-or-increment, and doing it client-side is a
-- read, a decision and a write with a race in the middle: two runs finishing
-- together at the same employer both read times_seen = 3 and both write 4.
--
-- ON CONFLICT makes it one atomic statement. The remedy is only overwritten
-- when the row is not pinned — a user's own correction outranks a fresh
-- inference, which is the whole reason `pinned` exists.
create or replace function public.record_apply_lesson(
  p_scope       text,
  p_scope_key   text,
  p_problem_kind text,
  p_signature   text,
  p_remedy      jsonb,
  p_remedy_note text,
  p_evidence    jsonb
) returns uuid
language plpgsql security invoker as $$
declare
  v_id uuid;
begin
  insert into public.apply_lessons as l
    (user_id, scope, scope_key, problem_kind, signature, remedy, remedy_note, evidence)
  values
    (auth.uid(), p_scope, coalesce(p_scope_key, ''), p_problem_kind, p_signature,
     p_remedy, coalesce(p_remedy_note, ''), coalesce(p_evidence, '{}'::jsonb))
  on conflict (user_id, scope, scope_key, problem_kind, signature) do update
    set times_seen   = l.times_seen + 1,
        last_seen_at = now(),
        remedy       = case when l.pinned then l.remedy      else excluded.remedy      end,
        remedy_note  = case when l.pinned then l.remedy_note else excluded.remedy_note end,
        evidence     = case when l.pinned then l.evidence    else excluded.evidence    end,
        -- Seeing a retired problem again does NOT revive its remedy: it was
        -- retired because that remedy failed repeatedly, and reviving it here
        -- would rebuild the loop this table exists to break. The count still
        -- climbs, so a problem that keeps recurring stays visible.
        status       = l.status
  returning l.id into v_id;

  return v_id;
end;
$$;

-- Credit or blame the remedies a finished run was carrying.
--
-- Split from record_apply_lesson because it happens at a different time and
-- for a different reason: recording is "we saw this", crediting is "and it
-- turned out to help". Conflating them is how a system convinces itself that
-- everything it ever wrote down is working.
create or replace function public.settle_apply_lessons(
  p_ids     uuid[],
  p_worked  boolean,
  p_retire_at integer default 3
) returns void
language plpgsql security invoker as $$
begin
  if p_ids is null or array_length(p_ids, 1) is null then return; end if;

  update public.apply_lessons
     set times_worked = times_worked + (case when p_worked then 1 else 0 end),
         times_failed = times_failed + (case when p_worked then 0 else 1 end)
   where user_id = auth.uid() and id = any(p_ids);

  -- Retire what has stopped earning its place. Pinned rows are exempt: the
  -- user asserted those, and a run failing for an unrelated reason must not
  -- quietly undo an instruction they gave.
  update public.apply_lessons
     set status = 'retired',
         retired_reason = format('failed %s times after last success', times_failed)
   where user_id = auth.uid()
     and id = any(p_ids)
     and status = 'active'
     and not pinned
     and times_failed >= p_retire_at
     and times_failed > times_worked;
end;
$$;

-- PostgREST caches the schema and will 404 a brand-new table until it reloads.
-- A missing 'mime' column did exactly this in 005 and killed an application
-- mid-run, so every migration here ends the same way.
notify pgrst, 'reload schema';
