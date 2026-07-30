// popup.js — settings + account.
//
// Split by sensitivity: the Groq key, model and a local CV copy live in
// chrome.storage.local (never leave this machine); the CV also syncs to the
// user's Supabase profile when signed in, so it follows them across devices.

import * as sb from "./supabase.js";

const $ = (id) => document.getElementById(id);
const els = {
  email: $("email"), password: $("password"),
  signin: $("signin"), signup: $("signup"), signout: $("signout"),
  signedIn: $("signed-in"), signedOut: $("signed-out"),
  whoEmail: $("who-email"), authStatus: $("auth-status"),
  key: $("key"), lang: $("lang"), model: $("model"), cv: $("cv"),
  save: $("save"), status: $("status"), apps: $("apps"),
};

els.apps.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

function setStatus(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? "#1a7f37" : "#bc4c00";
}

// Check the fields before calling Supabase. Without this, an empty email makes
// the API read the request as an anonymous sign-in and reply "Anonymous
// sign-ins are disabled" — technically true, but baffling to the user.
function credentials() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email) {
    setStatus(els.authStatus, "Enter your email address first.", false);
    els.email.focus();
    return null;
  }
  if (!password) {
    setStatus(els.authStatus, "Enter a password first.", false);
    els.password.focus();
    return null;
  }
  if (password.length < 6) {
    setStatus(els.authStatus, "Password must be at least 6 characters.", false);
    els.password.focus();
    return null;
  }
  return { email, password };
}

// ── initial paint ───────────────────────────────────────────────────────────
async function refreshAuthUI() {
  const session = await sb.getSession();
  const signedIn = Boolean(session?.access_token);
  els.signedIn.classList.toggle("hidden", !signedIn);
  els.signedOut.classList.toggle("hidden", signedIn);
  if (signedIn) els.whoEmail.textContent = session.user?.email || "";
  return signedIn;
}

async function init() {
  const local = await chrome.storage.local.get(
    ["groqApiKey", "language", "model", "cvText"]);
  if (local.groqApiKey) els.key.value = local.groqApiKey;
  if (local.language) els.lang.value = local.language;
  if (local.model) els.model.value = local.model;
  if (local.cvText) els.cv.value = local.cvText;

  const signedIn = await refreshAuthUI();
  if (!signedIn) return;

  // The account's CV is the source of truth — pull it in.
  try {
    const profile = await sb.getProfile();
    if (profile?.cv_text?.trim()) els.cv.value = profile.cv_text;
    if (profile?.language) els.lang.value = profile.language;
  } catch (e) {
    setStatus(els.authStatus, `Couldn't load your profile: ${e.message}`, false);
  }
}

// ── auth actions ────────────────────────────────────────────────────────────
els.signin.addEventListener("click", async () => {
  const creds = credentials();
  if (!creds) return;
  setStatus(els.authStatus, "Signing in…");
  try {
    await sb.signIn(creds.email, creds.password);
    await refreshAuthUI();
    setStatus(els.authStatus, "Signed in ✓");
    const profile = await sb.getProfile();
    if (profile?.cv_text?.trim()) els.cv.value = profile.cv_text;
  } catch (e) {
    setStatus(els.authStatus, e.message, false);
  }
});

els.signup.addEventListener("click", async () => {
  const creds = credentials();
  if (!creds) return;
  setStatus(els.authStatus, "Creating account…");
  try {
    const session = await sb.signUp(creds.email, creds.password);
    await refreshAuthUI();
    setStatus(els.authStatus, session
      ? "Account created ✓ — now add your CV below and Save."
      : "Account created — check your email to confirm, then sign in.");
  } catch (e) {
    setStatus(els.authStatus, e.message, false);
  }
});

els.signout.addEventListener("click", async () => {
  await sb.signOut();
  await refreshAuthUI();
  setStatus(els.authStatus, "Signed out.");
});

// ── save ────────────────────────────────────────────────────────────────────
els.save.addEventListener("click", async () => {
  const groqApiKey = els.key.value.trim();
  const cvText = els.cv.value.trim();
  const language = els.lang.value;

  // Always keep a local copy: it's the offline / signed-out fallback.
  await chrome.storage.local.set(
    { groqApiKey, cvText, language, model: els.model.value });

  let msg = "Saved locally ✓";
  let ok = true;
  if (await sb.getSession()) {
    try {
      await sb.saveProfile({ cv_text: cvText, language });
      msg = "Saved to your account ✓";
    } catch (e) {
      msg = `Saved locally, but syncing failed: ${e.message}`;
      ok = false;
    }
  }

  const missing = [];
  if (!groqApiKey) missing.push("API key");
  if (!cvText) missing.push("CV");
  if (missing.length) {
    setStatus(els.status, `${msg} — still need: ${missing.join(", ")}.`, false);
  } else {
    setStatus(els.status, `${msg}  Open a LinkedIn job and click “Tailor this job”.`, ok);
  }
});

init();
