-- 002_ai_proxy.sql — metering and budgets for the shared Anthropic key.
--
-- ADDITIVE ONLY, same rule as 001. Nothing here alters a table the extension
-- or the Python bot already reads.
--
-- WHY THIS EXISTS
--
-- One Anthropic key is shared by every user, and the key lives only in the
-- ai-proxy Edge Function — never in a browser. That solves key theft, but it
-- creates a second problem: with a shared key and no accounting, the two
-- heaviest users spend the whole month's budget in a week and everyone else
-- gets errors. These tables are the accounting.
--
-- Money is stored in MICROS — millionths of one US dollar. $3.00 is 3000000.
-- Integers, so no floating-point drift over tens of thousands of rows, and the
-- arithmetic stays exact when a single call costs a fraction of a cent.
--
-- Run once in the Supabase SQL editor.

-- ── ai_settings ─────────────────────────────────────────────────────────────
-- One row, ever. The global kill switch and the defaults every user inherits.
--
-- Kept as a table rather than function constants so the budget can be changed
-- from the Supabase dashboard at 2am without a redeploy.
create table if not exists public.ai_settings (
  id                        boolean primary key default true check (id),

  -- Master switch. False = the proxy refuses every request, for everyone.
  enabled                   boolean not null default true,

  -- What one user may spend per calendar month before the proxy cuts them off.
  -- $3.00. Scanning and form-filling run on the user's own free Groq key, so a
  -- user at their ceiling still has a working product — they lose tailoring and
  -- auto-apply, not the extension.
  default_user_limit_micros bigint  not null default 3000000,

  -- What everyone together may spend per calendar month. The backstop against
  -- a bug that bypasses the per-user check: even if every individual limit
  -- were wrong, the month cannot exceed this. $80.
  monthly_pool_micros       bigint  not null default 80000000,

  updated_at                timestamptz not null default now()
);

insert into public.ai_settings (id) values (true) on conflict (id) do nothing;

-- ── ai_budgets ──────────────────────────────────────────────────────────────
-- Per-user OVERRIDES only. A user with no row here inherits
-- ai_settings.default_user_limit_micros, so onboarding writes nothing and
-- there is no row to forget to create.
create table if not exists public.ai_budgets (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  limit_micros  bigint,          -- null = inherit the default
  enabled       boolean not null default true,   -- false = this user only, off
  note          text,            -- why they were raised or suspended
  updated_at    timestamptz not null default now()
);

-- ── ai_usage ────────────────────────────────────────────────────────────────
-- One row per Anthropic call the proxy makes. Written by the Edge Function
-- with the service-role key; never by a client.
--
-- Token counts are stored as four separate columns rather than one total
-- because they are priced differently: a cache read costs a tenth of fresh
-- input and a cache write costs a quarter more. Keeping them apart means a
-- price change can be replayed over history instead of guessed at.
create table if not exists public.ai_usage (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,

  -- 'apply_simple' is the tier-0 apply path (plain-DOM boards, cheaper model);
  -- 'apply' is tier 1. Kept apart so a month's bill can be split by which kind
  -- of site consumed it, which is the number that decides whether the
  -- cheap/careful split is worth keeping.
  task               text not null
                     check (task in ('tailor', 'apply', 'apply_simple', 'other')),
  model              text not null,

  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_write_tokens integer not null default 0,
  cache_read_tokens  integer not null default 0,

  -- Computed by the proxy at call time from the model's published rates.
  cost_micros        bigint  not null default 0,

  -- Which posting this was spent on, so a surprising month can be traced to
  -- actual jobs rather than an unexplained number.
  job_url            text,

  -- Populated when Anthropic returned an error; cost is then 0 but the attempt
  -- is still recorded, because a user hammering a failing endpoint is a thing
  -- worth being able to see.
  error              text,

  created_at         timestamptz not null default now()
);

-- The spend query runs on every single proxy call, so it gets its own index.
create index if not exists ai_usage_user_month_idx
  on public.ai_usage (user_id, created_at desc);

create index if not exists ai_usage_month_idx
  on public.ai_usage (created_at desc);

-- ── quota ───────────────────────────────────────────────────────────────────
-- The billing period is the calendar month in UTC. Simple to reason about and
-- simple to explain to a user: "your allowance resets on the 1st."
create or replace function public.ai_month_start()
returns timestamptz
language sql
immutable
as $$
  select date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

-- What the PROXY calls before every request. Service-role only: it takes a
-- user id as an argument, so letting a signed-in client call it would leak
-- other users' spend.
create or replace function public.ai_quota(p_user uuid)
returns table (
  allowed          boolean,
  reason           text,
  limit_micros     bigint,
  spent_micros     bigint,
  remaining_micros bigint,
  pool_micros      bigint,
  pool_spent       bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  s   public.ai_settings%rowtype;
  b   public.ai_budgets%rowtype;
  lim bigint;
  spent bigint;
  pool_used bigint;
begin
  select * into s from public.ai_settings where id = true;
  select * into b from public.ai_budgets where user_id = p_user;

  lim := coalesce(b.limit_micros, s.default_user_limit_micros);

  select coalesce(sum(u.cost_micros), 0) into spent
    from public.ai_usage u
   where u.user_id = p_user
     and u.created_at >= public.ai_month_start();

  select coalesce(sum(u.cost_micros), 0) into pool_used
    from public.ai_usage u
   where u.created_at >= public.ai_month_start();

  allowed          := true;
  reason           := null;
  limit_micros     := lim;
  spent_micros     := spent;
  remaining_micros := greatest(lim - spent, 0);
  pool_micros      := s.monthly_pool_micros;
  pool_spent       := pool_used;

  -- Checked most-specific first so the message the user sees names the real
  -- cause: "your allowance" reads very differently from "service paused".
  if not s.enabled then
    allowed := false; reason := 'service_disabled';
  elsif b.user_id is not null and not b.enabled then
    allowed := false; reason := 'user_disabled';
  elsif spent >= lim then
    allowed := false; reason := 'user_limit_reached';
  elsif pool_used >= s.monthly_pool_micros then
    allowed := false; reason := 'pool_exhausted';
  end if;

  return next;
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and both anon
-- and authenticated inherit that. Revoking from those two roles by name is a
-- no-op — the privilege is held by PUBLIC, not by them. Revoke from PUBLIC.
revoke execute on function public.ai_quota(uuid) from public;
grant  execute on function public.ai_quota(uuid) to service_role;

-- What the EXTENSION calls to render "allowance used" in the dashboard. Takes
-- no argument and reads auth.uid(), so it can only ever report the caller.
create or replace function public.ai_allowance()
returns table (
  limit_micros     bigint,
  spent_micros     bigint,
  remaining_micros bigint,
  enabled          boolean,
  resets_at        timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid   uuid := auth.uid();
  s     public.ai_settings%rowtype;
  b     public.ai_budgets%rowtype;
  lim   bigint;
  spent bigint;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  select * into s from public.ai_settings where id = true;
  select * into b from public.ai_budgets where user_id = uid;

  lim := coalesce(b.limit_micros, s.default_user_limit_micros);

  select coalesce(sum(u.cost_micros), 0) into spent
    from public.ai_usage u
   where u.user_id = uid
     and u.created_at >= public.ai_month_start();

  limit_micros     := lim;
  spent_micros     := spent;
  remaining_micros := greatest(lim - spent, 0);
  enabled          := s.enabled and coalesce(b.enabled, true);
  resets_at        := public.ai_month_start() + interval '1 month';

  return next;
end;
$$;

-- Same PUBLIC default as ai_quota above. ai_allowance raises on a null
-- auth.uid() so an anonymous call already fails, but there is no reason to
-- leave it reachable from the unauthenticated API at all.
revoke execute on function public.ai_allowance() from public;
grant  execute on function public.ai_allowance() to authenticated, service_role;

-- ── row level security ──────────────────────────────────────────────────────
alter table public.ai_settings enable row level security;
alter table public.ai_budgets  enable row level security;
alter table public.ai_usage    enable row level security;

-- ai_settings gets RLS and deliberately NO policy: with RLS on and no policy,
-- every client request returns nothing. Only the service role (which bypasses
-- RLS) can see the kill switch and the pool size.

-- Users may read their own budget and their own usage — that is what powers
-- the "you've used X of your allowance" panel. Writes are service-role only,
-- which is also why there is no insert/update/delete policy anywhere here:
-- a user must not be able to raise their own limit or delete their own spend.
create policy ai_budgets_own_read on public.ai_budgets
  for select using (auth.uid() = user_id);

create policy ai_usage_own_read on public.ai_usage
  for select using (auth.uid() = user_id);
