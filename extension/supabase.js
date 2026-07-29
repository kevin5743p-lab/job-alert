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

export async function saveProfile({ cv_text, language, full_name }) {
  const payload = { id: await currentUserId() };
  if (cv_text !== undefined) payload.cv_text = cv_text;
  if (language !== undefined) payload.language = language;
  if (full_name !== undefined) payload.full_name = full_name;

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
export async function upsertApplication(job, tailoredResultId) {
  // The URL is the dedup key. Without one we skip tracking entirely: job_url
  // would be NULL, and NULLs are distinct in the unique index, so every re-tailor
  // would pile up another row instead of updating one.
  if (!job.url) return null;
  const rows = await rest("/applications?on_conflict=user_id,job_url", {
    method: "POST",
    body: {
      user_id: await currentUserId(),
      job_title: job.title || "",
      job_company: job.company || "",
      job_location: job.location || "",
      job_url: job.url,
      job_source: job.source || "",
      status: "tailored",
      tailored_result_id: tailoredResultId || null,
    },
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows && rows[0] ? rows[0] : null;
}

export async function listApplications(limit = 50) {
  return rest(`/applications?select=*&order=updated_at.desc&limit=${limit}`);
}
