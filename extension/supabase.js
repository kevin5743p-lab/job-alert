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
export async function saveTailoredResult(job, packet, warnings) {
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
    },
    headers: { Prefer: "return=representation" },
  });
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
  return rest(`/applications?select=*&order=updated_at.desc&limit=${limit}`);
}

// The tracker view: newly-found jobs ranked by fit first, then everything the
// user has already acted on, most recent first.
export async function listTrackedJobs(limit = 300) {
  return rest(`/applications?select=*` +
              `&order=status.asc,score.desc.nullslast,updated_at.desc` +
              `&limit=${limit}`);
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
  const rows = await rest(
    `/tailored_results?job_url=eq.${encodeURIComponent(url)}` +
    `&select=packet&order=created_at.desc&limit=1`);
  return rows && rows[0] ? rows[0].packet : null;
}

// The full tailored packet for one application (used to re-open / re-print it).
export async function getTailoredResult(id) {
  const rows = await rest(
    `/tailored_results?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}
