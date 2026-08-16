// onboarding.js — the "things your CV doesn't say" questionnaire.
//
// Writes into profiles.application_profile (with a local fallback), which is
// exactly what autofill.js reads. Every key here should have a matching entry
// in autofill's FIELD_SPECS, otherwise the answer is stored but never used.

import * as sb from "./supabase.js";
import { hasAllSites, requestAllSites } from "./host_access.js";

// Field id === key in the saved application profile.
const KEYS = [
  "first_name", "last_name", "email", "phone", "city", "country",
  "linkedin_url", "website_url", "github_url",
  "work_authorization", "requires_sponsorship", "notice_period", "languages",
  "remote_preference", "willing_to_relocate", "salary_expectation",
  "hours_per_week", "driving_licence", "how_heard",
];

const $ = (id) => document.getElementById(id);

// ── Cover-letter template picker ────────────────────────────────────────────
// Each card previews the real template rendered with the user's own details and
// sample letter text, so the choice is made on what it actually looks like.
let selectedTemplate = "modern";

const SAMPLE_LETTER = [
  "I am currently completing my Master's degree and am writing to express my",
  "interest in this role, where I can build on the analysis and simulation work",
  "that has shaped my studies so far.",
  "",
  "In a recent project I analysed sensor degradation under adverse weather,",
  "using Python for the time-series work and Grafana for the dashboards. That",
  "work taught me how much careful data handling matters to a reliable result.",
  "",
  "I work comfortably both independently and in cross-functional teams, and I",
  "would be glad to discuss how I could contribute to yours.",
].join("\n");

function previewProfile() {
  const p = {};
  for (const k of KEYS) {
    const el = $(k);
    if (el && el.value.trim()) p[k] = el.value.trim();
  }
  // Placeholders so an empty form still previews as a real letter.
  p.first_name = p.first_name || "Your";
  p.last_name = p.last_name || "Name";
  p.email = p.email || "you@example.com";
  p.phone = p.phone || "+49 000 000000";
  p.city = p.city || "Munich";
  p.country = p.country || "Germany";
  return p;
}

function templateHtml(id) {
  const T = window.JobCopilotCoverTemplates;
  const profile = { ...previewProfile(), cover_template: id };
  return T.buildCoverLetter(
    { title: "Finance Analyst", company: "Example GmbH" },
    { cover_letter: SAMPLE_LETTER }, profile, "en");
}

function renderTemplates() {
  const T = window.JobCopilotCoverTemplates;
  $("templates").innerHTML = T.TEMPLATES.map((t) => `
    <div class="tpl${t.id === selectedTemplate ? " sel" : ""}" data-tpl="${t.id}">
      <h3>${t.name}</h3>
      <p>${t.blurb}</p>
      <div class="thumb"><iframe data-frame="${t.id}" sandbox=""></iframe></div>
      <span class="preview-link" data-full="${t.id}">Open full preview →</span>
    </div>`).join("");

  // srcdoc rather than innerHTML: the preview is a whole document, and the
  // sandboxed frame keeps its styles from leaking into this page.
  T.TEMPLATES.forEach((t) => {
    const f = document.querySelector(`iframe[data-frame="${t.id}"]`);
    if (f) f.srcdoc = templateHtml(t.id);
  });

  document.querySelectorAll(".tpl").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.dataset.full) {
        const w = window.open("", "_blank");
        if (w) { w.document.open(); w.document.write(templateHtml(e.target.dataset.full)); w.document.close(); }
        return;
      }
      selectedTemplate = card.dataset.tpl;
      document.querySelectorAll(".tpl").forEach((c) => c.classList.toggle("sel", c === card));
    });
  });
}

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.style.color = ok ? "#1a7f37" : "#bc4c00";
}

function read() {
  const out = { cover_template: selectedTemplate };
  for (const k of KEYS) {
    const v = ($(k).value || "").trim();
    if (v) out[k] = v;
  }
  return out;
}

function write(profile) {
  if (!profile) return;
  for (const k of KEYS) {
    if (profile[k] !== undefined && profile[k] !== null) $(k).value = profile[k];
  }
  if (profile.cover_template) selectedTemplate = profile.cover_template;
}

async function load() {
  // Local first so the form is never empty, then let the account's copy win.
  const { applicationProfile } = await chrome.storage.local.get("applicationProfile");
  write(applicationProfile);

  try {
    if (await sb.getSession()) {
      const profile = await sb.getProfile();
      write(profile?.application_profile);
    } else {
      setStatus("Not signed in — answers will be saved on this computer only.", false);
    }
  } catch (e) {
    setStatus(`Couldn't load your saved answers: ${e.message}`, false);
  } finally {
    // Render after loading so previews use the user's real name and contact.
    renderTemplates();
  }
}

$("save").addEventListener("click", async () => {
  const applicationProfile = read();
  await chrome.storage.local.set({ applicationProfile });

  const answered = Object.keys(applicationProfile).length;
  try {
    if (await sb.getSession()) {
      await sb.saveProfile({ application_profile: applicationProfile });
      setStatus(`Saved to your account ✓ (${answered} answers)`);
    } else {
      setStatus(`Saved on this computer ✓ (${answered} answers)`);
    }
  } catch (e) {
    setStatus(`Saved locally, but syncing failed: ${e.message}`, false);
  }
});

$("skip").addEventListener("click", () => window.close());

// ── the all-sites grant ─────────────────────────────────────────────────────

async function refreshGrant() {
  const granted = await hasAllSites();
  $("grantHosts").textContent = granted
    ? "Enabled ✓ — auto-apply works on any employer's site"
    : "Enable auto-apply on all sites";
  $("grantHosts").disabled = granted;
  $("grantHint").textContent = granted
    ? "Revoke any time from chrome://extensions → JobCopilot → Site access."
    : "";
}

$("grantHosts").addEventListener("click", async () => {
  // First statement: chrome.permissions.request has to see the user gesture,
  // and anything awaited before it spends that gesture.
  let granted = false;
  try { granted = await requestAllSites(); }
  catch (e) { $("grantHint").textContent = `Chrome wouldn't ask: ${e.message}`; return; }

  await refreshGrant();
  if (!granted) {
    $("grantHint").textContent =
      "Not granted. Auto-apply will still work on LinkedIn and the major job " +
      "boards; anything on an employer's own site will be handed back to you " +
      "to finish. You can turn this on later in Settings.";
  }
});

refreshGrant();
load();
