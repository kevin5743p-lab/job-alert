// onboarding.js — the "things your CV doesn't say" questionnaire.
//
// Writes into profiles.application_profile (with a local fallback), which is
// exactly what autofill.js reads. Every key here should have a matching entry
// in autofill's FIELD_SPECS, otherwise the answer is stored but never used.

import * as sb from "./supabase.js";

// Field id === key in the saved application profile.
const KEYS = [
  "first_name", "last_name", "email", "phone", "city", "country",
  "linkedin_url", "website_url", "github_url",
  "work_authorization", "requires_sponsorship", "notice_period", "languages",
  "remote_preference", "willing_to_relocate", "salary_expectation",
  "hours_per_week", "driving_licence", "how_heard",
];

const $ = (id) => document.getElementById(id);

function setStatus(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.style.color = ok ? "#1a7f37" : "#bc4c00";
}

function read() {
  const out = {};
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

load();
