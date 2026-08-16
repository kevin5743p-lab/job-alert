// settings.js — everything that used to be crammed into the popup, plus the
// document library.
//
// The popup was the settings screen: a 360px column you scrolled for the better
// part of a thousand pixels, with the API key, the permission grant, the submit
// policy, three dropdowns and the entire CV all at the same visual weight. It
// is now a status window, and this is the settings screen.
//
// Storage split is unchanged and deliberate: the Groq key, the Adzuna
// credentials, the model and a local CV copy live in chrome.storage.local and
// never leave the machine; the CV, the answers and the documents sync to the
// account so a second laptop picks them up.

import * as sb from "./supabase.js";
import { hasAllSites, requestAllSites } from "./host_access.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const els = {
  who: $("who"),
  email: $("email"), password: $("password"),
  signin: $("signin"), signup: $("signup"), signout: $("signout"),
  signedIn: $("signed-in"), signedOut: $("signed-out"),
  whoEmail: $("who-email"), authStatus: $("auth-status"), apps: $("apps"),
  key: $("key"), model: $("model"), lang: $("lang"), age: $("age"),
  autoScan: $("auto-scan"), submitPolicy: $("submitPolicy"),
  adzunaId: $("adzuna-id"), adzunaKey: $("adzuna-key"),
  grantHosts: $("grant-hosts"), grantHint: $("grant-hint"),
  allowance: $("allowance"), allowanceMeter: $("allowance-meter"),
  cv: $("cv"), cvCount: $("cv-count"),
  onboard: $("onboard"), profileState: $("profile-state"),
  save: $("save"), saveStatus: $("save-status"), version: $("version"),
  drop: $("drop"), docPick: $("doc-pick"), docFile: $("doc-file"),
  docKind: $("doc-kind"), docLabel: $("doc-label"),
  docStatus: $("doc-status"), docList: $("doc-list"), docNote: $("doc-note"),
};

function setStatus(el, text, tone = "ok") {
  el.textContent = text;
  el.style.color = tone === "ok" ? "var(--good)"
                 : tone === "warn" ? "var(--warn)"
                 : tone === "muted" ? "var(--text-2)" : "var(--bad)";
}

// ── which section am I looking at ───────────────────────────────────────────
// Purely so the index says where you are. Cheap, and without it a long page of
// similar-looking cards is disorienting.
const sections = [...document.querySelectorAll("section")];
const navLinks = new Map(
  [...document.querySelectorAll("nav a")].map((a) => [a.getAttribute("href").slice(1), a]));

const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    navLinks.forEach((a) => a.classList.remove("on"));
    navLinks.get(e.target.id)?.classList.add("on");
  }
}, { rootMargin: "-10% 0px -70% 0px" });
sections.forEach((s) => spy.observe(s));

// ── account ─────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function credentials() {
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email) {
    setStatus(els.authStatus, "Enter your email address first.", "bad");
    els.email.focus();
    return null;
  }
  // A typo here silently creates a SECOND account, and the user then can't sign
  // in with the address they think they used.
  if (!EMAIL_RE.test(email)) {
    setStatus(els.authStatus,
      `"${email}" doesn't look like a complete email address — check for a typo.`, "bad");
    els.email.focus();
    return null;
  }
  if (!password) {
    setStatus(els.authStatus, "Enter a password first.", "bad");
    els.password.focus();
    return null;
  }
  if (password.length < 6) {
    setStatus(els.authStatus, "Password must be at least 6 characters.", "bad");
    els.password.focus();
    return null;
  }
  return { email, password };
}

function openOnboarding() {
  chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
}

els.onboard.addEventListener("click", openOnboarding);
els.apps.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

els.signin.addEventListener("click", async () => {
  const creds = credentials();
  if (!creds) return;
  setStatus(els.authStatus, "Signing in…", "muted");
  try {
    await sb.signIn(creds.email, creds.password);
    await refreshAuthUI();
    setStatus(els.authStatus, "Signed in ✓");
    const profile = await sb.getProfile();
    if (profile?.cv_text?.trim()) { els.cv.value = profile.cv_text; countCv(); }
    showProfileState(profile?.application_profile);
    loadDocuments();
    if (!Object.keys(profile?.application_profile || {}).length) openOnboarding();
  } catch (e) {
    setStatus(els.authStatus, e.message, "bad");
  }
});

els.signup.addEventListener("click", async () => {
  const creds = credentials();
  if (!creds) return;
  setStatus(els.authStatus, "Creating account…", "muted");
  try {
    const session = await sb.signUp(creds.email, creds.password);
    await refreshAuthUI();
    if (session) {
      setStatus(els.authStatus, "Account created ✓ — let's fill in your details.");
      openOnboarding();
    } else {
      setStatus(els.authStatus,
        "Account created — check your email to confirm, then sign in.");
    }
  } catch (e) {
    setStatus(els.authStatus, e.message, "bad");
  }
});

els.signout.addEventListener("click", async () => {
  await sb.signOut();
  await refreshAuthUI();
  renderDocuments(null);
  setStatus(els.authStatus, "Signed out.", "muted");
});

async function refreshAuthUI() {
  const session = await sb.getSession();
  const signedIn = Boolean(session?.access_token);
  els.signedIn.classList.toggle("hidden", !signedIn);
  els.signedOut.classList.toggle("hidden", signedIn);
  const email = session?.user?.email || "";
  if (signedIn) els.whoEmail.textContent = email;
  els.who.textContent = signedIn ? `Signed in as ${email}` : "Not signed in.";
  refreshAllowance(signedIn);
  return signedIn;
}

// The month's AI spend, in plain money. "Auto-apply stopped working" and
// "you've used this month's allowance" feel identical from the outside, and
// only one of them is a bug worth reporting.
async function refreshAllowance(signedIn) {
  if (!signedIn) {
    els.allowanceMeter.classList.add("hidden");
    els.allowance.textContent =
      "Runs on the shared JobCopilot account — sign in and it just works, " +
      "with no key to paste.";
    return;
  }
  try {
    const a = await sb.aiAllowance();
    if (!a) return;
    const spent = a.spent_micros / 1e6;
    const limit = a.limit_micros / 1e6;
    const resets = a.resets_at ? new Date(a.resets_at).toLocaleDateString() : "";
    const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;

    els.allowanceMeter.classList.remove("hidden");
    els.allowanceMeter.querySelector("i").style.width = `${pct}%`;
    els.allowanceMeter.classList.toggle("full", Number(a.remaining_micros) <= 0);

    els.allowance.textContent = Number(a.remaining_micros) > 0
      ? `$${spent.toFixed(2)} of $${limit.toFixed(2)} used this month` +
        (resets ? `, resets ${resets}.` : ".")
      : `Used up ($${limit.toFixed(2)}). Scanning and autofill still work` +
        (resets ? `; tailoring and auto-apply resume ${resets}.` : ".");
  } catch {
    // Leave the existing sentence rather than showing an error for something
    // the user can't act on.
  }
}

// ── the all-sites permission ────────────────────────────────────────────────
// chrome.permissions.request must be called from a user gesture, which is why
// it lives on a button and can't be done from the worker mid-run.
//
// The pattern set lives in host_access.js so this page, onboarding, the
// dashboard banner and the worker's pre-flight all ask the same question. They
// did not: this page asked about https only, while a run could be sent to an
// http careers site, fail, and be told to enable something already enabled.

async function refreshGrantUI() {
  const granted = await hasAllSites();

  els.grantHosts.textContent = granted
    ? "Enabled ✓ — auto-apply works on any employer site"
    : "Enable auto-apply on all sites";
  els.grantHosts.disabled = granted;
  els.grantHosts.classList.toggle("primary", !granted);
  els.grantHint.textContent = granted
    ? "Granted. Revoke any time from chrome://extensions → JobCopilot → Site access."
    : "Job boards work already. Many employers host their application form on " +
      "their own website instead, and Chrome needs your permission for those. " +
      "This asks once; nothing is sent anywhere.";
}

els.grantHosts.addEventListener("click", async () => {
  try {
    const granted = await requestAllSites();
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

// ── documents ───────────────────────────────────────────────────────────────
//
// The order here is the order they appear on the page, and it is deliberately
// the order of how often a form asks for them.
const KINDS = [
  { key: "certificate",  label: "Certificates & transcripts",
    note: "Attached when a form asks for a Zeugnis, a diploma or a transcript." },
  { key: "cv",           label: "CV",
    note: "Only used if a job was never tailored — the tailored CV always wins." },
  { key: "cover_letter", label: "Cover letter",
    note: "Same: the letter written for the posting is preferred over this one." },
  { key: "portfolio",    label: "Portfolio & work samples",
    note: "Attached when a form asks for a portfolio or writing sample." },
  { key: "photo",        label: "Photo",
    note: "German applications still ask for one surprisingly often." },
  { key: "other",        label: "Everything else",
    note: "Kept here for you, never attached automatically." },
];

const MAX_BYTES = 10 * 1024 * 1024;

const fmtBytes = (n) =>
  !n ? "" : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB`
                            : `${(n / (1024 * 1024)).toFixed(1)} MB`;

const fmtDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

let documents = [];

async function loadDocuments() {
  try {
    documents = await sb.listUserDocuments();
    renderDocuments(documents);
  } catch (e) {
    if (e.message === "NOT_SIGNED_IN") { renderDocuments(null); return; }
    setStatus(els.docStatus, `Couldn't load your documents: ${e.message}`, "bad");
  }
}

function renderDocuments(rows) {
  if (rows === null) {
    els.docList.innerHTML =
      `<div class="empty">Sign in to keep documents — they're stored with your
       account so they're there on every machine you use.</div>`;
    els.drop.classList.add("hidden");
    return;
  }
  els.drop.classList.remove("hidden");

  if (!rows.length) {
    els.docList.innerHTML =
      `<div class="empty">Nothing uploaded yet. A degree certificate and your
       most recent Arbeitszeugnis cover most of what German forms ask for.</div>`;
    return;
  }

  // Grouped by kind rather than listed flat: "which of my three CVs is the one
  // being sent" is the only question this list has to answer well.
  els.docList.innerHTML = KINDS.map((k) => {
    const mine = rows.filter((r) => r.kind === k.key);
    if (!mine.length) return "";
    return `
      <div class="kindhead">${esc(k.label)}
        <span class="caption">${esc(k.note)}</span></div>
      <ul class="docs">${mine.map(docHtml).join("")}</ul>`;
  }).join("");

  els.docList.querySelectorAll("[data-primary]").forEach((b) => {
    b.addEventListener("click", () => makePrimary(b.dataset.primary, b.dataset.kind, b));
  });
  els.docList.querySelectorAll("[data-del]").forEach((b) => {
    b.addEventListener("click", () => removeDocument(b.dataset.del, b.dataset.path, b));
  });
}

function docHtml(r) {
  // 'other' is never attached, so a "current" badge there would be a lie about
  // what the engine does with it.
  const badge = r.kind === "other" ? ""
    : r.is_primary
      ? `<span class="pill">In use</span>`
      : `<button class="tiny" data-primary="${esc(r.id)}" data-kind="${esc(r.kind)}">Use this one</button>`;

  return `<li>
    <div class="grow">
      <div class="name">${esc(r.label || r.filename)}</div>
      <div class="meta">${r.label ? esc(r.filename) + " · " : ""}${
        esc(fmtBytes(r.bytes))} · added ${esc(fmtDay(r.created_at))}</div>
    </div>
    <div class="acts">
      ${badge}
      <button class="tiny danger" data-del="${esc(r.id)}"
              data-path="${esc(r.storage_path)}">Delete</button>
    </div>
  </li>`;
}

async function makePrimary(id, kind, btn) {
  btn.disabled = true;
  try {
    await sb.setPrimaryDocument(id, kind);
    setStatus(els.docStatus, "Updated ✓");
    await loadDocuments();
  } catch (e) {
    setStatus(els.docStatus, `Couldn't update that: ${e.message}`, "bad");
    btn.disabled = false;
  }
}

async function removeDocument(id, storagePath, btn) {
  if (!confirm("Delete this document? It won't be attached to anything again.")) return;
  btn.disabled = true;
  try {
    await sb.deleteUserDocument(id, storagePath);
    setStatus(els.docStatus, "Deleted.", "muted");
    await loadDocuments();
  } catch (e) {
    setStatus(els.docStatus, `Couldn't delete that: ${e.message}`, "bad");
    btn.disabled = false;
  }
}

async function uploadFiles(files) {
  const kind = els.docKind.value;
  const label = els.docLabel.value.trim();

  if (!(await sb.getSession())) {
    setStatus(els.docStatus, "Sign in first — documents are stored with your account.", "warn");
    return;
  }

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      setStatus(els.docStatus,
        `${file.name} is ${fmtBytes(file.size)} — the limit is 10 MB. ` +
        `Most employers cap uploads well below that anyway.`, "bad");
      continue;
    }
    setStatus(els.docStatus, `Uploading ${file.name}…`, "muted");
    try {
      await sb.uploadUserDocument({
        kind,
        // Naming several files at once with one label would produce three
        // identical rows, so the label only applies to a single pick.
        label: files.length === 1 ? label : "",
        filename: file.name,
        mime: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      setStatus(els.docStatus, `${file.name} uploaded ✓`);
    } catch (e) {
      setStatus(els.docStatus, `Couldn't upload ${file.name}: ${e.message}`, "bad");
    }
  }
  els.docLabel.value = "";
  await loadDocuments();
}

els.docPick.addEventListener("click", () => els.docFile.click());
els.docFile.addEventListener("change", async () => {
  const files = [...els.docFile.files];
  els.docFile.value = "";                 // so picking the same file twice works
  if (files.length) await uploadFiles(files);
});

for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  });
}
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  els.drop.classList.remove("over");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await uploadFiles(files);
});

// ── CV ──────────────────────────────────────────────────────────────────────
function countCv() {
  const text = els.cv.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  els.cvCount.textContent = words
    ? `${words.toLocaleString()} words. Everything written on your behalf has to be traceable to this.`
    : "Empty — tailoring and scoring can't run without it.";
  els.cvCount.style.color = words ? "var(--text-3)" : "var(--warn)";
}
els.cv.addEventListener("input", countCv);

const KEY_ANSWERS = ["first_name", "last_name", "email", "phone",
                     "work_authorization", "notice_period"];

function showProfileState(profile) {
  const answered = Object.keys(profile || {}).length;
  if (!answered) {
    els.profileState.textContent =
      "Not filled in yet — autofill has nothing to work from until this is done.";
    els.profileState.style.color = "var(--warn)";
    return;
  }
  const missing = KEY_ANSWERS.filter((k) => !profile[k]).length;
  els.profileState.textContent = missing
    ? `${answered} answers saved · ${missing} key question${missing === 1 ? "" : "s"} still open`
    : `${answered} answers saved ✓`;
  els.profileState.style.color = missing ? "var(--warn)" : "var(--good)";
}

// ── save ────────────────────────────────────────────────────────────────────
els.save.addEventListener("click", async () => {
  const groqApiKey = els.key.value.trim();
  const cvText = els.cv.value.trim();
  const language = els.lang.value;

  els.save.disabled = true;
  try {
    // The application answers are owned by the onboarding page and are not
    // touched here — writing {} would wipe them.
    await chrome.storage.local.set({
      groqApiKey, cvText, language,
      model: els.model.value,
      adzunaAppId: els.adzunaId.value.trim(),
      adzunaAppKey: els.adzunaKey.value.trim(),
      maxJobAge: Number(els.age.value) || 7,
      autoScan: els.autoScan.checked,
      submitPolicy: els.submitPolicy.value,
    });

    let msg = "Saved on this machine ✓";
    let tone = "ok";
    if (await sb.getSession()) {
      try {
        await sb.saveProfile({ cv_text: cvText, language });
        msg = "Saved to your account ✓";
      } catch (e) {
        msg = `Saved locally, but syncing failed: ${e.message}`;
        tone = "bad";
      }
    }

    const missing = [];
    if (!groqApiKey) missing.push("a Groq API key");
    if (!cvText) missing.push("your CV");
    setStatus(els.saveStatus,
      missing.length ? `${msg} — still missing: ${missing.join(" and ")}.` : msg,
      missing.length ? "warn" : tone);
  } finally {
    els.save.disabled = false;
  }
});

// Ctrl/Cmd+S, because this is a form with a save button at the bottom of a long
// page and people type it out of habit.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    els.save.click();
  }
});

// ── first paint ─────────────────────────────────────────────────────────────
async function init() {
  refreshGrantUI();                  // not awaited: must not delay first paint

  const v = chrome.runtime.getManifest().version;
  els.version.textContent = `JobCopilot ${v}`;

  const local = await chrome.storage.local.get(
    ["groqApiKey", "language", "model", "cvText", "applicationProfile",
     "adzunaAppId", "adzunaAppKey", "maxJobAge", "autoScan", "submitPolicy"]);

  // Any Anthropic key saved by an older build is both useless and a liability:
  // nothing reads it, and a real key sitting in browser storage is one
  // extension audit away from being someone else's problem.
  chrome.storage.local.remove("anthropicApiKey");

  els.autoScan.checked = local.autoScan !== false;      // on unless turned off
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
  countCv();

  const signedIn = await refreshAuthUI();
  if (!signedIn) { renderDocuments(null); return; }

  loadDocuments();

  // The account's copy is the source of truth — pull it in over the local one.
  try {
    const profile = await sb.getProfile();
    if (profile?.cv_text?.trim()) { els.cv.value = profile.cv_text; countCv(); }
    if (profile?.language) els.lang.value = profile.language;
    showProfileState(profile?.application_profile);
  } catch (e) {
    setStatus(els.authStatus, `Couldn't load your profile: ${e.message}`, "bad");
  }
}

// Deep links from the popup and the dashboard: settings.html#documents should
// land on the documents card, not the top of the page.
if (location.hash) {
  const target = document.getElementById(location.hash.slice(1));
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

init();
