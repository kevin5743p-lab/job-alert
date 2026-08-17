// supabase.js — tiny, dependency-free Supabase client for the extension.
//
// We talk to the REST + Auth endpoints directly instead of bundling supabase-js:
// MV3 service workers can't load remote scripts, and our needs are small
// (sign in/up, read+write a handful of rows).
//
// SECURITY MODEL
//  - SUPABASE_ANON_KEY is a *publishable* key and is meant to ship in clients.
//    It grants nothing on its own: every table has Row Level Security, so a
//    request only ever returns the signed-in user's own rows.
//  - The user's Groq API key is NEVER sent here — it stays in chrome.storage.
//  - The session (access + refresh token) lives in chrome.storage.local, on the
//    user's own machine.

import { jobKey } from "./job_key.js";

export const SUPABASE_URL = "https://jiryqdcmukmbflahtptv.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_G1Mf9PySGYmp2YLqfj4FWg_BzdAnHJ_";

const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;

// ── session storage ─────────────────────────────────────────────────────────
export async function getSession() {
  const { sbSession } = await chrome.storage.local.get("sbSession");
  return sbSession || null;
}

async function setSession(session) {
  await chrome.storage.local.set({ sbSession: session });
  return session;
}

export async function signOut() {
  await chrome.storage.local.remove("sbSession");
}

// ── auth ────────────────────────────────────────────────────────────────────
async function authRequest(path, body) {
  const resp = await fetch(`${AUTH}${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error_description || data.msg || data.message ||
                    `Auth failed (HTTP ${resp.status})`);
  }
  return data;
}

export async function signIn(email, password) {
  const data = await authRequest("/token?grant_type=password", { email, password });
  return setSession(data);
}

export async function signUp(email, password) {
  const data = await authRequest("/signup", { email, password });
  // With email confirmation ON, signup returns a user but no session.
  if (data.access_token) return setSession(data);
  return null;
}

async function refreshSession(session) {
  const data = await authRequest("/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token,
  });
  return setSession(data);
}

// ── REST helper ─────────────────────────────────────────────────────────────
// Runs an authenticated PostgREST call, transparently refreshing an expired
// access token once (access tokens are short-lived; refresh tokens are not).
async function rest(path, { method = "GET", body, headers = {} } = {}, retry = true) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${REST}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (resp.status === 401 && retry) {
    try {
      await refreshSession(session);
    } catch {
      await signOut();
      throw new Error("NOT_SIGNED_IN");
    }
    return rest(path, { method, body, headers }, false);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (resp.status === 204) return null;
  return resp.json().catch(() => null);
}

async function currentUserId() {
  const session = await getSession();
  return session?.user?.id;
}

// ── Edge Functions ──────────────────────────────────────────────────────────
// Same shape and same one-shot token refresh as rest(), pointed at the
// Functions endpoint instead of PostgREST. This is how the extension reaches
// ai-proxy, which is the only holder of the shared Anthropic key.
//
// Unlike rest(), a non-2xx is not flattened into a generic Error: the caller
// needs the status and the parsed body to tell "you are out of allowance"
// (402) from "Anthropic is rate limiting" (429), and to react differently.
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export async function callFunction(name, body, retry = true) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401 && retry) {
    try {
      await refreshSession(session);
    } catch {
      await signOut();
      throw new Error("NOT_SIGNED_IN");
    }
    return callFunction(name, body, false);
  }

  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data, headers: resp.headers };
}

/**
 * This user's month-to-date Anthropic spend against their allowance.
 *
 * Reads through the ai_allowance() function rather than summing ai_usage in
 * the client: the limit itself lives in ai_settings, which RLS hides from
 * clients entirely, so the arithmetic has to happen server-side.
 */
export async function aiAllowance() {
  const rows = await rest("/rpc/ai_allowance", { method: "POST", body: {} });
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── profile (the CV lives here) ─────────────────────────────────────────────
export async function getProfile() {
  const rows = await rest("/profiles?select=*&limit=1");
  return rows && rows[0] ? rows[0] : null;
}

export async function saveProfile({ cv_text, language, full_name,
                                    application_profile }) {
  const payload = { id: await currentUserId() };
  if (cv_text !== undefined) payload.cv_text = cv_text;
  if (language !== undefined) payload.language = language;
  if (full_name !== undefined) payload.full_name = full_name;
  if (application_profile !== undefined) {
    payload.application_profile = application_profile;
  }

  // Upsert: the signup trigger normally creates the row, but this keeps the
  // popup working even if that row is somehow missing.
  const rows = await rest("/profiles", {
    method: "POST",
    body: payload,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

// ── tailored results + application tracking ─────────────────────────────────
export async function saveTailoredResult(job, packet, warnings, cvFingerprint = null) {
  const rows = await rest("/tailored_results", {
    method: "POST",
    body: {
      user_id: await currentUserId(),
      job_title: job.title || "",
      job_company: job.company || "",
      job_location: job.location || "",
      job_url: job.url || "",
      job_source: job.source || "",
      // Cross-site identity, so this packet is still findable after the user
      // follows an aggregator's "Apply on company site" link. Null for
      // postings too sparse to key safely — see job_key.js.
      job_key: jobKey(job),
      packet,
      warnings: warnings || [],
      // Which CV this was written from, so it can be reused later without
      // risking a packet built from a CV the user has since replaced.
      cv_fingerprint: cvFingerprint || null,
    },
    headers: { Prefer: "return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

/**
 * The most recent tailored packet for a posting, with everything needed to
 * decide whether it can be reused instead of paying for the model again.
 * Returns null when there is nothing saved for this URL.
 */
export async function latestTailoredForUrl(url) {
  if (!url) return null;
  const rows = await rest(
    `/tailored_results?job_url=eq.${encodeURIComponent(url)}` +
    `&select=id,packet,warnings,cv_fingerprint,created_at` +
    `&order=created_at.desc&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

// A packet reused across sites has to be recent as well as written from the
// current CV. cv_fingerprint already catches "the user replaced their CV"; this
// catches the other staleness — a role reposted months later under the same
// title, whose text has moved on since the packet was written.
const JOB_KEY_MAX_AGE_DAYS = 60;

/**
 * The saved packet for a posting, found by whichever identity still works.
 *
 * Tried in descending order of certainty:
 *   1. the exact URL          — always correct when it hits
 *   2. the pre-reroute URL    — the aggregator link this run came from
 *   3. company + title        — the cross-site fallback, recent rows only
 *
 * The result carries `matched_by` so a surprising reuse can be traced to the
 * rule that caused it rather than guessed at.
 *
 * @param {object} job  { url, originalUrl?, company?, title? }
 */
export async function tailoredForJob(job = {}) {
  const { url, originalUrl = null } = job;

  if (url) {
    const row = await latestTailoredForUrl(url);
    if (row) return { ...row, matched_by: "url" };
  }

  // resolve_ats.js rewrites job_url to the employer's own ATS and keeps the
  // aggregator link in original_job_url. The user tailored against that one.
  if (originalUrl && originalUrl !== url) {
    const row = await latestTailoredForUrl(originalUrl);
    if (row) return { ...row, matched_by: "original_url" };
  }

  const key = jobKey(job);
  if (!key) return null;

  const since = new Date(Date.now() - JOB_KEY_MAX_AGE_DAYS * 86400000)
    .toISOString();
  const rows = await rest(
    `/tailored_results?job_key=eq.${encodeURIComponent(key)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&select=id,packet,warnings,cv_fingerprint,created_at,job_url` +
    `&order=created_at.desc&limit=1`);

  return rows && rows[0] ? { ...rows[0], matched_by: "job_key" } : null;
}

// Track the job in the application pipeline. Upserts on (user_id, job_url) so
// re-tailoring the same posting updates that row instead of duplicating it.
export async function upsertApplication(job, tailoredResultId, packet) {
  // The URL is the dedup key. Without one we skip tracking entirely: job_url
  // would be NULL, and NULLs are distinct in the unique index, so every re-tailor
  // would pile up another row instead of updating one.
  if (!job.url) return null;

  // The tailoring call already judged the fit, so a job tailored by hand gets
  // the same score as one a scan found instead of a blank in the tracker.
  const body = {
    user_id: await currentUserId(),
    job_title: job.title || "",
    job_company: job.company || "",
    job_location: job.location || "",
    job_url: job.url,
    job_source: job.source || "",
    status: "tailored",
    tailored_result_id: tailoredResultId || null,
  };
  if (packet && typeof packet.fit_score === "number") {
    body.score = packet.fit_score;
    body.tier = packet.fit_score >= 75 ? "strong" : "worth_look";
    if (packet.fit_summary) body.reason = String(packet.fit_summary).slice(0, 500);
  }

  const rows = await rest("/applications?on_conflict=user_id,job_url", {
    method: "POST",
    body,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

export async function listApplications(limit = 100) {
  return rest(`/applications?select=*&archived_at=is.null` +
              `&order=updated_at.desc&limit=${limit}`);
}

// The tracker view: newly-found jobs ranked by fit first, then everything the
// user has already acted on, most recent first.
//
// The cap used to be 300, which is not a display limit — it is a data limit,
// and it was silent. Someone with 500 tracked jobs simply never saw 200 of
// them and nothing said so. The dashboard paginates now, so the fetch can be
// generous; and when the ceiling really is reached the dashboard says so
// rather than presenting a truncated list as the whole list.
export const TRACKED_JOBS_LIMIT = 1000;

export async function listTrackedJobs(limit = TRACKED_JOBS_LIMIT) {
  return rest(`/applications?select=*&archived_at=is.null` +
              `&order=status.asc,score.desc.nullslast,updated_at.desc` +
              `&limit=${limit}`);
}

// Everything already in the tracker, so a scan doesn't pay to score the same
// posting twice. Boards return their whole open list every time, so without
// this most of a scan's budget goes on jobs it graded yesterday.
export async function getTrackedUrls(limit = 2000) {
  const rows = await rest(
    `/applications?select=job_url&job_url=not.is.null&limit=${limit}`);
  return new Set((rows || []).map((r) => r.job_url).filter(Boolean));
}

// Postings already judged by the scorer, kept or not.
//
// getTrackedUrls only knows the ones that survived the keep threshold, because
// those are the only ones written to `applications`. Everything scored below it
// vanished, so the next scan re-fetched its description and paid to score it
// again — to the same number. This is the memory that stops that.
//
// Re-scored after RESCORE_AFTER_DAYS anyway: a posting judged against an older
// CV, or before the grading rules changed, deserves a fresh look eventually.
const RESCORE_AFTER_DAYS = 30;

export async function getScoredUrls(limit = 5000) {
  const since = new Date(Date.now() - RESCORE_AFTER_DAYS * 86400000).toISOString();
  const rows = await rest(
    `/scored_jobs?select=job_url&scored_at=gte.${encodeURIComponent(since)}` +
    `&order=scored_at.desc&limit=${limit}`);
  return new Set((rows || []).map((r) => r.job_url).filter(Boolean));
}

/** Remember every posting this scan judged, whatever it scored. */
export async function recordScored(scored) {
  const uid = await currentUserId();
  const seen = new Set();
  const rows = [];
  for (const s of scored || []) {
    const url = s.job && s.job.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({ user_id: uid, job_url: url,
                score: Number.isFinite(s.score) ? s.score : null,
                // Kept so the pre-filter can be tuned against what the model
                // actually turned down. Three quarters of every scan scores 0,
                // and a URL tells you nothing about why.
                job_title: (s.job.title || "").slice(0, 300),
                job_company: (s.job.company || "").slice(0, 200),
                job_source: (s.job.source || "").slice(0, 100),
                // Free to keep: the model already wrote it for every posting,
                // and it was being discarded for everything below the keep
                // threshold — which is precisely where an unexplained score
                // needs explaining.
                reason: (s.reason || "").slice(0, 400),
                scored_at: new Date().toISOString() });
  }
  if (!rows.length) return 0;

  for (let i = 0; i < rows.length; i += 100) {
    await rest("/scored_jobs?on_conflict=user_id,job_url", {
      method: "POST",
      body: rows.slice(i, i + 100),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }
  return rows.length;
}

/** Forget everything, so a new CV is judged from scratch. */
export async function clearScoredMemory() {
  const uid = await currentUserId();
  await rest(`/scored_jobs?user_id=eq.${uid}`, { method: "DELETE" });
}

// What the user has done with jobs so far — the signal the scan learns from.
export async function getDecisionHistory(limit = 400) {
  return rest(`/applications?select=job_title,job_company,status` +
              `&status=in.(rejected,dismissed,applied,interview,offer,tailored)` +
              `&order=updated_at.desc&limit=${limit}`);
}

export const APPLICATION_STATUSES =
  ["new", "saved", "tailored", "applied", "interview", "offer", "rejected", "dismissed"];

export async function updateApplicationStatus(id, status) {
  const rows = await rest(`/applications?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
    headers: { Prefer: "return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

// Remove untouched finds only. Anything the user tailored, applied to or moved
// along the pipeline is theirs and is never deleted by this.
export async function clearUntouchedFinds() {
  return rest(`/applications?status=eq.new&tailored_result_id=is.null`,
              { method: "DELETE" });
}

export async function deleteApplication(id) {
  return rest(`/applications?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function saveSearchProfile(searchProfile) {
  return rest("/profiles", {
    method: "POST",
    body: { id: await currentUserId(), search_profile: searchProfile },
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

// ── Scan window and retention ──────────────────────────────────────────────

// How far back the next scan should look. The answer is always "since the last
// successful scan", never a fixed interval — that is what makes an unreliable
// scheduler safe. A browser closed for three days asks for three days; a run
// two hours after the last asks for two hours; a user who has never scanned
// asks for the full backfill. One rule, no special cases.
export const BACKFILL_DAYS = 7;
const MIN_WINDOW_DAYS = 10 / (24 * 60);        // 10 minutes, against clock skew

export async function scanWindowDays() {
  let last = null;
  try {
    const profile = await getProfile();
    last = profile && profile.last_scan_at;
  } catch { /* offline or not signed in: fall back to the backfill */ }
  if (!last) return BACKFILL_DAYS;             // never scanned

  const days = (Date.now() - Date.parse(last)) / 86400000;
  if (!Number.isFinite(days) || days <= 0) return MIN_WINDOW_DAYS;
  // Capped, because beyond the backfill the postings are stale anyway and the
  // sources stop being able to answer usefully.
  return Math.min(BACKFILL_DAYS, Math.max(MIN_WINDOW_DAYS, days));
}

/**
 * Age untouched finds out of the dashboard. Only status 'new' is eligible:
 * anything saved, tailored or applied to is the user's work, and anything
 * rejected or dismissed is the signal buildMemory() learns from. Sets a
 * timestamp rather than deleting or restating the status, so it is reversible
 * and nothing masquerades as a decision the user didn't make.
 */
export async function archiveStaleFinds(days = BACKFILL_DAYS) {
  const before = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await rest(
    `/applications?status=eq.new&archived_at=is.null` +
    `&discovered_at=lt.${encodeURIComponent(before)}&select=id`,
    { method: "PATCH", body: { archived_at: new Date().toISOString() },
      headers: { Prefer: "return=representation" } });
  return Array.isArray(rows) ? rows.length : 0;
}

export async function touchLastScan() {
  return rest("/profiles", {
    method: "POST",
    body: { id: await currentUserId(), last_scan_at: new Date().toISOString() },
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

// Write a scan's results into the tracker. Upserting on (user_id, job_url)
// means a re-scan refreshes a posting rather than duplicating it — and because
// status is only set on insert, a job already marked applied stays applied.
export async function upsertFoundJobs(scored) {
  const rows = scored
    .filter((s) => s.job && s.job.url)
    .map((s) => ({
      user_id: null,                       // filled in below
      job_title: (s.job.title || "").slice(0, 300),
      job_company: (s.job.company || "").slice(0, 200),
      job_location: (s.job.location || "").slice(0, 200),
      job_url: s.job.url,
      job_source: (s.job.source || "").slice(0, 100),
      description: (s.job.description || "").slice(0, 4000),
      posted_at: s.job.published || null,
      score: s.score,
      tier: s.score >= 75 ? "strong" : "worth_look",
      reason: s.reason || "",
    }));
  if (!rows.length) return 0;

  const uid = await currentUserId();
  rows.forEach((r) => { r.user_id = uid; });

  let saved = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    try {
      await rest("/applications?on_conflict=user_id,job_url", {
        method: "POST",
        body: chunk,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
      saved += chunk.length;
    } catch (e) {
      console.warn("Saving a batch of found jobs failed:", e);
    }
  }
  return saved;
}

// The most recent tailored packet for a posting — used to fill a cover-letter
// box on that job's application form.
export async function latestPacketForUrl(url) {
  const row = await latestTailoredForUrl(url);
  return row ? row.packet : null;
}

// The full tailored packet for one application (used to re-open / re-print it).
export async function getTailoredResult(id) {
  const rows = await rest(
    `/tailored_results?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

// ════════════════════════════════════════════════════════════════════════════
// AUTO-APPLY ENGINE
//
// Everything below backs the tables in sql/001_apply_engine.sql. It is additive
// in exactly the same way that migration is: nothing above this line changed,
// so the frozen extension/ copy keeps talking to the same project unaffected.
// ════════════════════════════════════════════════════════════════════════════

const STORAGE = `${SUPABASE_URL}/storage/v1`;
const APPLY_BUCKET = "apply-docs";

// ── the queue ───────────────────────────────────────────────────────────────

/** Registrable-ish domain. The circuit-breaker key, so it must be stable. */
export function domainOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    // Collapse per-tenant subdomains to one bucket. A Workday tenant blocking
    // us says nothing about another tenant, but they do share infrastructure
    // and rate limits, so one health row per platform is the useful grain.
    for (const suffix of ["myworkdayjobs.com", "myworkdaysite.com", "greenhouse.io",
                          "ashbyhq.com", "lever.co", "recruitee.com",
                          "smartrecruiters.com", "personio.de", "successfactors.eu",
                          "successfactors.com", "workable.com", "teamtailor.com",
                          "icims.com", "avature.net", "jobvite.com", "taleo.net",
                          "eightfold.ai", "softgarden.io", "softgarden.de"]) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
    }
    return host;
  } catch { return "unknown"; }
}

/**
 * Queue a job for the apply engine.
 *
 * The partial unique index in the migration means a second click on a job
 * that's already queued/running/paused is a conflict, not a duplicate
 * application. We swallow that and return the existing run.
 */
export async function enqueueApply(job, { tier = 0, originalJobUrl = null } = {}) {
  const body = {
    user_id: await currentUserId(),
    job_url: job.url,
    job_title: job.title || "",
    job_company: job.company || "",
    domain: domainOf(job.url),
    tier,
    status: "queued",
    original_job_url: originalJobUrl,
  };
  if (job.applicationId) body.application_id = job.applicationId;

  try {
    const rows = await rest("/apply_runs", {
      method: "POST", body, headers: { Prefer: "return=representation" },
    });
    return rows && rows[0] ? rows[0] : null;
  } catch (e) {
    if (/duplicate key|23505/i.test(e.message)) return liveRunForUrl(job.url);
    throw e;
  }
}

export async function liveRunForUrl(url) {
  const rows = await rest(
    `/apply_runs?job_url=eq.${encodeURIComponent(url)}` +
    `&status=in.(queued,running,paused_needs_human)&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Claim the next runnable job.
 *
 * Delegates to the claim_apply_run() function so the skip-quarantined and
 * respect-the-cap logic lives in one place the extension and the Phase 3
 * daemon share — and so FOR UPDATE SKIP LOCKED keeps them from both grabbing
 * the same row.
 */
export async function claimApplyRun() {
  const row = await rest("/rpc/claim_apply_run", { method: "POST", body: {} });
  return row && row.id ? row : null;
}

export async function updateApplyRun(id, patch) {
  const rows = await rest(`/apply_runs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", body: patch, headers: { Prefer: "return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Append one action to a run's audit trail.
 *
 * Read-modify-write rather than a jsonb append, because PostgREST can't express
 * `steps || $1` without a stored function and the volume here is tiny (tens of
 * steps per run, one writer at a time — the row is already claimed).
 */
export async function appendApplyStep(id, step) {
  const rows = await rest(`/apply_runs?id=eq.${encodeURIComponent(id)}&select=steps`);
  const steps = (rows && rows[0]?.steps) || [];
  steps.push({ at: new Date().toISOString(), ...step });
  return updateApplyRun(id, { steps });
}

export async function listApplyRuns(limit = 100) {
  return rest(`/apply_runs?select=*&order=created_at.desc&limit=${limit}`);
}

// A run can only ever be claimed out of `queued`, so anything left sitting in
// `running` is stranded — the worker that owned it is gone (browser closed,
// extension reloaded, service worker torn down mid-await). Nothing will ever
// pick it up again and the dashboard shows "Applying…" forever.
//
// The agent's own ceiling is 4 minutes plus document generation, so a run older
// than this by a wide margin is definitely not still working.
const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * Put stranded runs back in the queue.
 *
 * `attempts` is already incremented by the claim, so a job that strands
 * repeatedly escalates to the stronger model and eventually gives up rather
 * than looping forever.
 */
export async function reclaimStaleRuns() {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  return rest(
    `/apply_runs?status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`,
    { method: "PATCH",
      body: { status: "queued", error: "interrupted — requeued automatically" },
      headers: { Prefer: "return=representation" } }) || [];
}

export async function activeApplyRuns() {
  return rest("/apply_runs?select=*" +
              "&status=in.(queued,running,paused_needs_human)" +
              "&order=created_at.asc");
}

// ── domain health / the circuit breaker ─────────────────────────────────────

export async function getDomainHealth(domain) {
  const rows = await rest(
    `/domain_health?domain=eq.${encodeURIComponent(domain)}&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

export async function allDomainHealth() {
  return rest("/domain_health?select=*&order=domain.asc");
}

/** Upsert one domain's health row. */
export async function upsertDomainHealth(domain, patch) {
  const rows = await rest("/domain_health?on_conflict=user_id,domain", {
    method: "POST",
    body: { user_id: await currentUserId(), domain, ...patch },
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

// ── documents ───────────────────────────────────────────────────────────────

export async function getApplyDocuments(jobUrl) {
  return rest(`/apply_documents?job_url=eq.${encodeURIComponent(jobUrl)}&select=*`) || [];
}

/**
 * Columns this row can do without.
 *
 * Everything here is metadata about a document that has already been rendered
 * and uploaded — losing it costs a nicety, not the application.
 */
const OPTIONAL_DOC_COLUMNS = new Set(["mime", "bytes", "filename", "disk_path"]);

/** PostgREST's "that column isn't in my schema cache", and the name it names. */
function unknownColumn(message) {
  if (!/PGRST204/.test(message)) return null;
  const m = message.match(/Could not find the '([^']+)' column/);
  return m ? m[1] : null;
}

export async function recordApplyDocument(row) {
  const body = { user_id: await currentUserId(), ...row };

  // Retry without whichever optional column the database has not been migrated
  // for yet, rather than failing the run.
  //
  // This is bookkeeping that happens BEFORE the job tab is even opened, so a
  // schema drift here killed the whole application at its first step — on a job
  // the engine had already paid a model to tailor. A missing `mime` column did
  // exactly that. The migration is the real fix (sql/005); this makes the class
  // of mistake survivable, because the next column added will drift too.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rows = await rest("/apply_documents?on_conflict=user_id,job_url,kind", {
        method: "POST",
        body,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      });
      return rows && rows[0] ? rows[0] : null;
    } catch (e) {
      const col = unknownColumn(String(e?.message || e));
      if (!col || !OPTIONAL_DOC_COLUMNS.has(col) || !(col in body)) throw e;
      console.warn(
        `apply_documents has no '${col}' column — recording the document ` +
        `without it. Run the migrations in sql/ to restore it.`);
      delete body[col];
    }
  }
  return null;
}

// ── the user's own document library ─────────────────────────────────────────
//
// apply_documents above is what the engine *generates* per job. This is what
// the user already has: certificates, transcripts, a portfolio, the photo a
// German application asks for. Autofill has always been able to recognise those
// slots on a form; until this existed there was simply nothing to put in them,
// so the run paused and handed the job back.

/** Every stored document, current one of each kind first. */
export async function listUserDocuments() {
  return rest("/user_documents?select=*" +
              "&order=kind.asc,is_primary.desc,created_at.desc") || [];
}

/**
 * Store one file and record it.
 *
 * `bytes` is a Uint8Array — settings.js reads the File the user picked. The
 * object path keeps the row id in it so a file in the bucket can always be
 * traced back to its row, and so two uploads of "CV.pdf" don't collide.
 */
export async function uploadUserDocument({ kind, label, filename, mime, bytes,
                                           makePrimary = true }) {
  const uid = await currentUserId();
  const id = crypto.randomUUID();
  const safe = String(filename || "document")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")   // drop diacritics
    .replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60) || "document";
  const storage_path = `${uid}/library/${id}-${safe}`;

  await storagePut(storage_path, bytes, mime || "application/octet-stream");

  // Clear the old current file *before* inserting, or the partial unique index
  // rejects the insert rather than the write silently winning.
  if (makePrimary) await clearPrimary(kind);

  const rows = await rest("/user_documents", {
    method: "POST",
    body: { id, user_id: uid, kind, label: label || null, filename: safe,
            mime: mime || null, bytes: bytes.length, storage_path,
            is_primary: makePrimary },
    headers: { Prefer: "return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

async function clearPrimary(kind) {
  await rest(`/user_documents?kind=eq.${encodeURIComponent(kind)}&is_primary=is.true`,
             { method: "PATCH", body: { is_primary: false } });
}

/** Promote one file to be the one the engine attaches for its kind. */
export async function setPrimaryDocument(id, kind) {
  await clearPrimary(kind);
  await rest(`/user_documents?id=eq.${encodeURIComponent(id)}`,
             { method: "PATCH", body: { is_primary: true } });
}

export async function deleteUserDocument(id, storagePath) {
  // Row first: an orphaned object costs a few kilobytes, whereas a row pointing
  // at a deleted object would have the engine try to attach a file that isn't
  // there and fail mid-application.
  await rest(`/user_documents?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  if (storagePath) await storageDelete(storagePath).catch(() => {});
}

/**
 * The current file of each kind, shaped like docgen's output so the apply
 * engine can merge the two without caring where a document came from.
 *
 *   { certificate: { storagePath, filename }, … }
 *
 * No `diskPath`: these were never rendered locally, so they attach over the
 * DataTransfer path from their stored bytes — see upload.js.
 */
export async function primaryDocuments() {
  const rows = await rest("/user_documents?select=kind,filename,mime,storage_path" +
                          "&is_primary=is.true") || [];
  const out = {};
  for (const r of rows) {
    out[r.kind] = { storagePath: r.storage_path, filename: r.filename,
                    mime: r.mime || "application/pdf" };
  }
  return out;
}

// ── Storage ─────────────────────────────────────────────────────────────────
// Every object path starts with the user id, which is what the bucket policy
// in the migration checks. Keep that first segment or the upload 403s.

async function storagePut(objectPath, bytes, contentType) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${STORAGE}/object/${APPLY_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!resp.ok) {
    throw new Error(`Storage ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return objectPath;
}

async function storageDelete(objectPath) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${STORAGE}/object/${APPLY_BUCKET}/${objectPath}`, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  // 404 means it is already gone, which is the state we were asking for.
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Storage delete ${resp.status}`);
  }
}

function b64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Short, stable, filesystem-safe key for a job URL. */
async function urlKey(url) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("").slice(0, 16);
}

/**
 * `tailoredId` is the tailored_results row this PDF was rendered from, and it
 * belongs in the object path: the stored document then carries its own
 * provenance. docgen can tell a current PDF from one rendered before the job was
 * re-tailored just by reading the path it already has — no extra column, no
 * migration to run — and after the fact any file in the bucket traces back to
 * the exact packet that produced it.
 */
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Store a generated document.
 *
 * `mime` exists because a tailored CV is no longer always a PDF: when the user
 * keeps their CV in Word we edit that file and, if no converter is available,
 * send the .docx itself. This used to hardcode both the extension and the
 * content type, so a Word file was stored as `…-cv.pdf` labelled
 * `application/pdf`. On the machine that rendered it nothing noticed, because
 * the local copy on disk was correct — but upload.js falls back to these stored
 * bytes whenever the disk copy is gone (a second computer, a cleared Downloads
 * folder), and it builds the File from this name and type. An upload widget
 * that checks `file.type`, and many do, would have rejected a "PDF" that is
 * really a zip.
 */
export async function uploadApplyDoc(jobUrl, kind, base64, tailoredId,
                                     mime = "application/pdf") {
  const uid = await currentUserId();
  const ext = mime === DOCX_MIME ? "docx" : "pdf";
  const path =
    `${uid}/docs/${await urlKey(jobUrl)}/${tailoredId || "untracked"}-${kind}.${ext}`;
  return storagePut(path, b64ToBytes(base64), mime);
}

/** Screenshot of the page a run paused on, so the dashboard can show it. */
export async function uploadPauseScreenshot(runId, base64) {
  const uid = await currentUserId();
  const path = `${uid}/shots/${runId}.png`;
  return storagePut(path, b64ToBytes(base64), "image/png");
}

/** Time-limited URL for a private object — for showing a screenshot in the UI. */
export async function signedUrl(objectPath, expiresIn = 3600) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${STORAGE}/object/sign/${APPLY_BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!resp.ok) throw new Error(`Storage sign ${resp.status}`);
  const { signedURL } = await resp.json();
  return `${STORAGE}${signedURL}`;
}

/**
 * Fetch a stored PDF as base64 — the Tier 0 upload path builds its File from
 * this when the local copy is gone (different machine, cleared Downloads).
 */
export async function downloadApplyDoc(objectPath) {
  const session = await getSession();
  if (!session?.access_token) throw new Error("NOT_SIGNED_IN");

  const resp = await fetch(`${STORAGE}/object/${APPLY_BUCKET}/${objectPath}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (!resp.ok) throw new Error(`Storage get ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
