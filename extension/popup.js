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
  allowance: $("allowance"), submitPolicy: $("submitPolicy"),
  grantHosts: $("grant-hosts"), grantHint: $("grant-hint"),
  adzunaId: $("adzuna-id"), adzunaKey: $("adzuna-key"), age: $("age"),
  autoScan: $("auto-scan"),
  save: $("save"), status: $("status"), apps: $("apps"),
  onboard: $("onboard"), profileState: $("profile-state"),
};

// Company career portals live on their own domains, so no fixed list of sites
// can cover them. Clicking this injects JobCopilot into whatever page is open —
// activeTab grants that only because the user asked for it, on that one page,
// which is why it needs no broad host permission.
document.getElementById("run-here").addEventListener("click", async () => {
  const status = document.getElementById("run-status");
  status.textContent = "Starting…";
  status.style.color = "var(--text-2)";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) {
      status.textContent = "Open a job or application page first.";
      status.style.color = "var(--warn)";
      return;
    }
    // Every frame, not just the top one. The declared content scripts run with
    // all_frames, and content.js is written to match — the tailor button belongs
    // to the top frame, the fill button to whichever frame actually holds the
    // form. Injecting only the top frame meant that on any ATS that embeds its
    // form in an iframe, the fill button could never appear however many times
    // this was clicked.
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.insertCSS({ target, files: ["content.css"] });
    await chrome.scripting.executeScript({
      target,
      files: ["print_doc.js", "cover_templates.js", "autofill.js", "content.js"],
    });

    // Don't claim success on the strength of the injection alone. It resolves
    // happily on a page where the buttons never appear — the form wasn't
    // recognised, the body wasn't ready — and the old message said "Ready"
    // regardless, which is what made this button look unreliable.
    // One result per frame; a button in any of them counts.
    const probes = await chrome.scripting.executeScript({
      target,
      func: () => Boolean(document.querySelector("#jobcopilot-fab, #jobcopilot-fill")),
    });
    if ((probes || []).some((p) => p && p.result)) {
      status.textContent = "Ready — look for the buttons at the bottom right.";
      status.style.color = "var(--good)";
      setTimeout(() => window.close(), 1200);
    } else {
      status.textContent = "Loaded, but no button appeared — the page may still " +
                           "be rendering. Wait a moment and try again.";
      status.style.color = "var(--warn)";
    }
  } catch (e) {
    status.textContent = `Couldn't run here: ${e.message}`;
    status.style.color = "var(--bad)";
  }
});

// The application questions live on their own page (too many for this popup).
function openOnboarding() {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
}
els.onboard.addEventListener("click", openOnboarding);

// Key answers worth having before autofill is much use.
const KEY_ANSWERS = ["first_name", "last_name", "email", "phone",
                     "work_authorization", "notice_period"];

function showProfileState(profile) {
  const answered = Object.keys(profile || {}).length;
  if (!answered) {
    els.profileState.textContent = "Not filled in yet — autofill needs this.";
    els.profileState.style.color = "var(--warn)";
    return;
  }
  const missing = KEY_ANSWERS.filter((k) => !profile[k]).length;
  els.profileState.textContent = missing
    ? `${answered} answers saved · ${missing} key question${missing === 1 ? "" : "s"} still open`
    : `${answered} answers saved ✓`;
  els.profileState.style.color = missing ? "var(--warn)" : "var(--good)";
}

els.apps.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

function setStatus(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? "var(--good)" : "var(--bad)";
}

// Check the fields before calling Supabase. Without this, an empty email makes
// the API read the request as an anonymous sign-in and reply "Anonymous
// sign-ins are disabled" — technically true, but baffling to the user.
// Rejects the near-misses that actually happen — "name@gmai", a missing dot,
// a stray space. A typo here silently creates a SECOND account, and the user
// then can't sign in with the address they think they used.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function credentials() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email) {
    setStatus(els.authStatus, "Enter your email address first.", false);
    els.email.focus();
    return null;
  }
  if (!EMAIL_RE.test(email)) {
    setStatus(els.authStatus,
      `"${email}" doesn't look like a complete email address — check for a typo.`,
      false);
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

// ── the all-sites permission ────────────────────────────────────────────────
//
// The manifest covers LinkedIn and the thirty-odd applicant-tracking systems by
// name, which is most job boards but not most employers: a company can host its
// application form on any domain it likes, and Chrome will not let the apply
// engine read a page it has no permission for. Asking for every https site at
// install would put "read and change all your data on all websites" in front of
// someone who has not yet decided to trust this, so it is an optional
// permission requested here, once, with Chrome's own dialog doing the asking.
//
// chrome.permissions.request must be called from a user gesture, which is why
// this lives on a button in the popup and cannot be done from the worker
// mid-run.
const ALL_SITES = { origins: ["https://*/*"] };

async function hasAllSites() {
  try {
    return await chrome.permissions.contains(ALL_SITES);
  } catch {
    return false;
  }
}

async function refreshGrantUI() {
  if (!els.grantHosts) return;
  const granted = await hasAllSites();

  els.grantHosts.textContent = granted
    ? "Enabled ✓ — auto-apply works on any employer site"
    : "Enable auto-apply on all sites";
  els.grantHosts.disabled = granted;
  els.grantHint.textContent = granted
    ? "Granted. Revoke any time from chrome://extensions → JobCopilot → Site access."
    : "Job boards work already. Many employers host their application form on " +
      "their own website instead, and Chrome needs your permission for those. " +
      "This asks once; nothing is sent anywhere.";
}

els.grantHosts?.addEventListener("click", async () => {
  try {
    const granted = await chrome.permissions.request(ALL_SITES);
    await refreshGrantUI();
    if (!granted) {
      els.grantHint.textContent =
        "Not granted. Auto-apply will still work on LinkedIn and the major job " +
        "boards, but jobs hosted on an employer's own site will be handed back " +
        "to you to finish.";
    }
  } catch (e) {
    els.grantHint.textContent = `Couldn't request permission: ${e.message}`;
  }
});

// ── initial paint ───────────────────────────────────────────────────────────
async function refreshAuthUI() {
  const session = await sb.getSession();
  const signedIn = Boolean(session?.access_token);
  els.signedIn.classList.toggle("hidden", !signedIn);
  els.signedOut.classList.toggle("hidden", signedIn);
  if (signedIn) els.whoEmail.textContent = session.user?.email || "";
  refreshAllowance(signedIn);
  return signedIn;
}

// The month's AI spend, in plain money. Shown because "auto-apply stopped
// working" and "you've used this month's allowance" feel identical from the
// outside, and only one of them is a bug worth reporting.
//
// Not awaited by the caller: a slow or failing backend must not hold up the
// popup's first paint, and the hint it replaces is already a true sentence.
async function refreshAllowance(signedIn) {
  if (!els.allowance) return;
  if (!signedIn) {
    els.allowance.textContent =
      "Tailoring and auto-apply run on the shared JobCopilot AI account — " +
      "sign in above and they just work, with no second key to paste.";
    return;
  }
  try {
    const a = await sb.aiAllowance();
    if (!a) return;
    const spent = (a.spent_micros / 1e6).toFixed(2);
    const limit = (a.limit_micros / 1e6).toFixed(2);
    const resets = a.resets_at ? new Date(a.resets_at).toLocaleDateString() : "";
    els.allowance.textContent = Number(a.remaining_micros) > 0
      ? `AI allowance: $${spent} of $${limit} used this month` +
        (resets ? `, resets ${resets}.` : ".")
      : `AI allowance used ($${limit}). Scanning and autofill still work` +
        (resets ? `; tailoring and auto-apply resume ${resets}.` : ".");
  } catch {
    // Leave whatever text is already there rather than showing an error for
    // something the user cannot act on.
  }
}

async function init() {
  refreshGrantUI();          // not awaited: it must not delay the first paint

  const local = await chrome.storage.local.get(
    ["groqApiKey", "language", "model", "cvText", "applicationProfile",
     "adzunaAppId", "adzunaAppKey", "maxJobAge", "autoScan", "submitPolicy"]);

  // Any Anthropic key saved by an older build is now both useless and a
  // liability: nothing reads it, and a real key sitting in browser storage is
  // one extension audit away from being someone else's problem. Clear it.
  chrome.storage.local.remove("anthropicApiKey");
  els.autoScan.checked = local.autoScan !== false;   // on unless turned off
  els.age.value = String(local.maxJobAge || 7);
  // Defaults to hand-submit. Auto-submit is something you turn on once you've
  // watched a few applications go through, not something you inherit silently.
  els.submitPolicy.value = local.submitPolicy || "never";
  if (local.groqApiKey) els.key.value = local.groqApiKey;
  if (local.adzunaAppId) els.adzunaId.value = local.adzunaAppId;
  if (local.adzunaAppKey) els.adzunaKey.value = local.adzunaAppKey;
  if (local.language) els.lang.value = local.language;
  if (local.model) els.model.value = local.model;
  if (local.cvText) els.cv.value = local.cvText;
  showProfileState(local.applicationProfile);

  const signedIn = await refreshAuthUI();
  if (!signedIn) return;

  // The account's CV is the source of truth — pull it in.
  try {
    const profile = await sb.getProfile();
    if (profile?.cv_text?.trim()) els.cv.value = profile.cv_text;
    if (profile?.language) els.lang.value = profile.language;
    showProfileState(profile?.application_profile);
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
    showProfileState(profile?.application_profile);
    // A signed-in account with no answers yet can't autofill — prompt now.
    if (!Object.keys(profile?.application_profile || {}).length) openOnboarding();
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
    if (session) {
      // Straight into the questionnaire — it's the one thing a new account
      // can't work without, and it's easy to forget it exists.
      setStatus(els.authStatus, "Account created ✓ — let's fill in your details.");
      openOnboarding();
    } else {
      setStatus(els.authStatus,
        "Account created — check your email to confirm, then sign in.");
    }
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
  // The application answers are owned by the onboarding page, so they're not
  // touched here — writing {} would wipe them.
  // Adzuna is optional and local-only, like the Groq key: never sent to
  // Supabase, and an empty pair simply means the source is skipped.
  await chrome.storage.local.set(
    { groqApiKey, cvText, language, model: els.model.value,
      adzunaAppId: els.adzunaId.value.trim(),
      adzunaAppKey: els.adzunaKey.value.trim(),
      maxJobAge: Number(els.age.value) || 7,
      autoScan: els.autoScan.checked,
      submitPolicy: els.submitPolicy.value });

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
