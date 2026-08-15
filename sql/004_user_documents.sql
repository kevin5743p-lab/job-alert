-- 004_user_documents.sql — the user's own document library.
--
-- apply_documents holds what the engine *generates* for one job: a tailored CV
-- and cover letter, keyed by (job_url, kind). This table is the other half —
-- the files the user already has and the engine could never produce. A degree
-- certificate, an Arbeitszeugnis, a transcript, a portfolio PDF, the photo a
-- German application still asks for.
--
-- Why it matters: autofill.js already classifies a form's file inputs into
-- cv / cover_letter / portfolio / certificate / photo. Until now only the first
-- two could ever be satisfied, so every form asking for a Zeugnis paused the
-- run and handed it back. The documents exist; they just had nowhere to live.
--
-- Storage reuses the existing private `apply-docs` bucket under
-- `{uid}/library/…`, so the policy from 001 (first path segment must equal the
-- caller's uid) already covers these objects and no new bucket is needed.

create table if not exists public.user_documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Same vocabulary as autofill's FILE_KINDS, plus 'other' for things worth
  -- keeping but never worth attaching without being asked for by name.
  kind          text not null check (kind in
                  ('cv','cover_letter','certificate','portfolio','photo','other')),
  label         text,
  filename      text not null,
  mime          text,
  bytes         integer,
  storage_path  text not null,
  -- Which file of this kind is the current one. A user accumulates three CVs
  -- and two Zeugnisse; the engine must never have to guess which is newest.
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists user_documents_owner
  on public.user_documents (user_id, kind, created_at desc);

-- At most one current file per kind, enforced by the database rather than by
-- whichever client wrote last.
create unique index if not exists user_documents_one_primary
  on public.user_documents (user_id, kind) where is_primary;

drop trigger if exists user_documents_touch on public.user_documents;
create trigger user_documents_touch before update on public.user_documents
  for each row execute function public.touch_updated_at();

alter table public.user_documents enable row level security;

drop policy if exists user_documents_own on public.user_documents;
create policy user_documents_own on public.user_documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
