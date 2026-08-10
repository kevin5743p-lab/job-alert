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
export async function listTrackedJobs(limit = 300) {
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
