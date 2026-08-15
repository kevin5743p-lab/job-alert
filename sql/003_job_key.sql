-- 003_job_key.sql — a cross-site identity for a tailored posting.
--
-- ADDITIVE ONLY, same rule as 001 and 002.
--
-- WHY
--
-- tailored_results was looked up by exact job_url. The same job has more than
-- one URL — LinkedIn's copy and the employer's own Greenhouse page — so a
-- packet tailored on the aggregator was invisible from the careers site. Two
-- consequences, both live before this migration:
--
--   1. Re-opening the same job on the employer's site paid to tailor it again.
--   2. resolve_ats.js reroutes an aggregator posting to the employer's ATS and
--      queues the run under the NEW url, so apply_agent's packet lookup missed
--      and the run died with "this job hasn't been tailored yet" — on a job the
--      user had, in fact, already tailored.
--
-- job_key is company+title, normalised. See extension/job_key.js for the rules
-- and for why they are deliberately conservative.
--
-- NO BACKFILL, ON PURPOSE
--
-- Existing rows keep job_key null. Backfilling would mean reimplementing the
-- JS normaliser in PL/pgSQL and keeping two copies in step forever — and the
-- moment they drift, the database starts matching postings the extension
-- wouldn't. Old rows lose nothing: URL matching is still the first thing every
-- lookup tries, so they behave exactly as they did before. They simply don't
-- gain cross-site matching, and they earn it the next time they are tailored.
--
-- Run once in the Supabase SQL editor, after 001 and 002.

alter table public.tailored_results
  add column if not exists job_key text;

-- Lookups are always "this user's most recent packet for this key", so the
-- index carries user_id and orders by recency to keep it an index-only scan.
create index if not exists tailored_results_job_key_idx
  on public.tailored_results (user_id, job_key, created_at desc)
  where job_key is not null;

comment on column public.tailored_results.job_key is
  'Normalised company|title, written by extension/job_key.js. A cross-site '
  'lookup hint, not an identity: callers match job_url first and fall back to '
  'this. Null on rows written before migration 003 and on postings too sparse '
  'to key safely.';
