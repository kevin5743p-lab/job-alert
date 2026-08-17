// popup.js — status, not settings.
//
// This used to be the settings screen: the Groq key, the permission grant, the
// submit policy, three dropdowns, the Adzuna pair and the whole CV, stacked in
// a 360px column you scrolled for the better part of a thousand pixels. All of
// that now lives in settings.html, where there is room for it and room to say
// what each thing does.
//
// What is left is what a popup is actually good for: run here, who am I, is
// anything missing, and the two doors out.

import * as sb from "./supabase.js";
import { answeredCount, missingBlocking, isEmptyProfile } from "./profile_schema.js";

const $ = (id) => document.getElementById(id);
const els = {
  email: $("email"), password: $("password"),
  signin: $("signin"), signup: $("signup"), signout: $("signout"),
  signedIn: $("signed-in"), signedOut: $("signed-out"),
  whoEmail: $("who-email"), authStatus: $("auth-status"),
  apps: $("apps"), settings: $("settings"),
  ready: $("ready"), readyBox: $("ready-box"),
};

const openPage = (page) =>
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });

// Company career portals live on their own domains, so no fixed list of sites
// can cover them. Clicking this injects JobCopilot into whatever page is open —
// activeTab grants that only because the user asked for it, on that one page,
// which is why it needs no broad host permission.
$("run-here").addEventListener("click", async () => {
  const status = $("run-status");
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

els.apps.addEventListener("click", () => openPage("dashboard.html"));
els.settings.addEventListener("click", () => openPage("settings.html"));

function setStatus(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? "var(--good)" : "var(--bad)";
}

// ── auth ────────────────────────────────────────────────────────────────────
// Kept here because signing in is the first thing anyone does and the toolbar
// icon is where they'll look for it. Everything else about the account is one
// click away in Settings.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function credentials() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email) {
    setStatus(els.authStatus, "Enter your email address first.", false);
    els.email.focus();
    return null;
  }
  // A typo here silently creates a SECOND account, and the user then can't sign
  // in with the address they think they used.
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

els.signin.addEventListener("click", async () => {
  const creds = credentials();
  if (!creds) return;
  setStatus(els.authStatus, "Signing in…");
  try {
    await sb.signIn(creds.email, creds.password);
    await refreshAuthUI();
    setStatus(els.authStatus, "Signed in ✓");
    const profile = await sb.getProfile();
    // A signed-in account with no answers yet can't autofill anything — take
    // them straight there rather than leaving a tick missing on a list.
    // isEmptyProfile ignores keys that are settings rather than answers, which
    // is what stopped this firing once cover_template had been seeded.
    if (isEmptyProfile(profile?.application_profile)) {
      openPage("onboarding.html");
    }
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
      setStatus(els.authStatus, "Account created ✓");
      openPage("onboarding.html");
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

async function refreshAuthUI() {
  const session = await sb.getSession();
  const signedIn = Boolean(session?.access_token);
  els.signedIn.classList.toggle("hidden", !signedIn);
  els.signedOut.classList.toggle("hidden", signedIn);
  els.signout.classList.toggle("hidden", !signedIn);
  if (signedIn) els.whoEmail.textContent = session.user?.email || "";
  refreshReady(signedIn);
  return signedIn;
}

// ── is anything missing ─────────────────────────────────────────────────────
//
// Four things have to be true before any of this works, and when one of them
// wasn't, nothing said so: you found out when a scan died with "NO_CV" in the
// corner of another page, or when an application paused on an upload you had
// no file for. Each row links to the exact section that fixes it.
//
// What counts as "answered" is no longer a hardcoded six keys here and a
// different six in settings.js. It comes from profile_schema.js, derived from
// what the submit gate actually blocks on — so this row goes amber for exactly
// the questions that would stall a real application, rather than for a list
// written by hand before half of them existed.

function row({ ok, what, why, fix, page }) {
  const li = document.createElement("li");

  const mark = document.createElement("span");
  mark.className = `mark ${ok ? "ok" : "no"}`;
  mark.textContent = ok ? "✓" : "!";

  const grow = document.createElement("span");
  grow.className = "grow";
  const label = document.createElement("span");
  label.className = "what";
  label.textContent = what;
  grow.append(label);
  if (why) {
    const sub = document.createElement("span");
    sub.className = "why";
    sub.textContent = why;
    grow.append(sub);
  }

  li.append(mark, grow);

  if (!ok && fix) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = fix;
    a.addEventListener("click", (e) => { e.preventDefault(); openPage(page); });
    li.append(a);
  }
  return li;
}

async function refreshReady(signedIn) {
  els.readyBox.classList.toggle("hidden", !signedIn);
  if (!signedIn) return;

  // applicationProfile as well: the questionnaire autosaves there on every
  // keystroke and syncs to the account a beat later, so reading only the server
  // copy showed "unanswered" to someone who had just filled the whole thing in
  // — and shows it permanently to anyone not signed in.
  const local = await chrome.storage.local.get(
    ["groqApiKey", "cvText", "applicationProfile"]);

  let profile = null;
  let docs = [];
  // Both are nice-to-have detail on a checklist; neither is worth failing the
  // popup over if the network is down.
  try { profile = await sb.getProfile(); } catch { /* offline */ }
  try { docs = await sb.listUserDocuments(); } catch { /* offline */ }

  const cv = (profile?.cv_text || local.cvText || "").trim();
  const app = profile?.application_profile || local.applicationProfile || {};
  const answered = answeredCount(app);
  const missingAnswers = missingBlocking(app);
  const attachable = docs.filter((d) => d.kind !== "other" && d.is_primary);

  els.ready.replaceChildren(
    row({
      ok: Boolean(cv),
      what: cv ? "CV saved" : "No CV yet",
      why: cv ? "" : "Nothing can be tailored or scored without it.",
      fix: "Add", page: "settings.html#cv-section",
    }),
    row({
      ok: answered > 0 && !missingAnswers.length,
      what: !answered ? "Application questions unanswered"
        : missingAnswers.length ? `${missingAnswers.length} answer${
            missingAnswers.length === 1 ? "" : "s"} auto-apply will stall on`
        : "Application questions answered",
      // Naming the first one turns a count into an errand. "2 answers auto-apply
      // will stall on" is a number; "starting with: How much business travel…"
      // is something you can go and do.
      why: !answered ? "Autofill has nothing to work from."
        : missingAnswers.length
          ? `Starting with: ${missingAnswers[0].label}` : "",
      fix: "Answer", page: "onboarding.html",
    }),
    row({
      ok: Boolean(local.groqApiKey),
      what: local.groqApiKey ? "Groq key saved" : "No Groq key",
      why: local.groqApiKey ? "" : "\"Find jobs for me\" can't score postings.",
      fix: "Add", page: "settings.html#ai",
    }),
    row({
      ok: attachable.length > 0,
      what: attachable.length
        ? `${attachable.length} document${attachable.length === 1 ? "" : "s"} ready to attach`
        : "No documents uploaded",
      why: attachable.length ? ""
        : "Forms asking for a certificate or photo will pause for you.",
      fix: "Upload", page: "settings.html#documents",
    }),
  );
}

refreshAuthUI();
