// background.js — service worker (MV3 module).
//
// Holds the network + secrets boundary: the Groq API key and CV live in
// chrome.storage.local (this machine only) and the actual Groq call happens
// here, not in the content script — so the page's CSP can't block it and the
// key never touches the page context.

import { buildPrompt, buildAnswersPrompt, buildFieldMapPrompt,
         buildSearchProfilePrompt, buildBatchScorePrompt, normalize,
         groundingWarnings, DEFAULT_MODEL, MAX_TOKENS } from "./tailor_core.js";
import * as sb from "./supabase.js";
import { fetchAll, prefilter, validateTargets } from "./finder.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// One place for the Groq round-trip, so both tailoring and answer-drafting get
// the same error handling (quota vs. rate limit vs. transport).
async function groqJson(prompt, apiKey, model, maxTokens) {
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: maxTokens || MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
  });

  if (resp.status === 429) {
    const body = await resp.text();
    const daily = /tokens per day|tpd/i.test(body);
    throw new Error(daily
      ? "Groq daily quota reached — try again tomorrow."
      : "Groq rate limit — wait a moment and retry.");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Groq HTTP ${resp.status}: ${body.slice(0, 160)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty response.");
  return JSON.parse(content);
}

async function callGroq(job, cvText, apiKey, model, language) {
  const raw = await groqJson(buildPrompt(job, cvText, language), apiKey, model);
  return normalize(raw);
}

// Shared setup for any call that needs the user's key + CV.
async function loadKeyAndCv() {
  const { groqApiKey, cvText, language, model } = await chrome.storage.local.get(
    ["groqApiKey", "cvText", "language", "model"]);
  if (!groqApiKey) throw new Error("NO_KEY");

  let cv = cvText, lang = language, signedIn = false;
  try {
    if (await sb.getSession()) {
      signedIn = true;
      const profile = await sb.getProfile();
      if (profile?.cv_text?.trim()) cv = profile.cv_text;
      if (profile?.language) lang = profile.language;
    }
  } catch (e) {
    console.warn("Supabase profile fetch failed, using local CV:", e);
  }
  if (!cv || !cv.trim()) throw new Error("NO_CV");
  return { groqApiKey, cv, lang: lang || "en", model, signedIn };
}

// ── Find jobs ──────────────────────────────────────────────────────────────
// The whole "find" half, on demand, from the user's own browser. Progress is
// pushed to the dashboard as it goes, because a scan takes a while and silence
// looks like a hang.
const SCORE_BATCH = 8;        // postings per Groq call
const MAX_SCORED = 80;        // ceiling per scan, to protect a free-tier key

function progress(text, done = false, extra = {}) {
  chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", text, done, ...extra })
    .catch(() => {});          // nobody listening (dashboard closed) is fine
}

async function ensureSearchProfile(cv, apiKey, model, force) {
  const profile = await sb.getProfile();
  const existing = profile && profile.search_profile;
  // `validated` marks a profile whose employer boards were probed. Profiles
  // built before that check existed are rebuilt once, otherwise they keep
  // scanning boards that don't resolve and quietly return nothing.
  const usable = existing && (existing.search_queries || []).length && existing.validated;
  if (!force && usable) return existing;

  progress("Working out what to search for, from your CV…");
  const sp = await groqJson(buildSearchProfilePrompt(cv), apiKey, model, 2400);
  if (!sp || !(sp.search_queries || []).length) {
    throw new Error("Couldn't derive a search profile from your CV.");
  }

  // Verify the suggested boards before trusting them. The model names real
  // employers but often guesses the wrong ATS, and an unchecked list fails
  // silently — every board 404s and the scan simply finds nothing.
  const candidates = sp.company_targets || [];
  sp.company_targets = await validateTargets(candidates, (t) => progress(t));
  sp.validated = true;
  progress(`${sp.company_targets.length} of ${candidates.length} employer boards are live.`);

  await sb.saveSearchProfile(sp);
  return sp;
}

async function scoreJobs(jobs, cv, field, apiKey, model, language, baseLocation) {
  const scored = [];
  const batches = [];
  for (let i = 0; i < jobs.length; i += SCORE_BATCH) {
    batches.push(jobs.slice(i, i + SCORE_BATCH));
  }
  let n = 0;
  for (const batch of batches) {
    n++;
    progress(`Scoring matches… (${Math.min(n * SCORE_BATCH, jobs.length)}/${jobs.length})`);
    let raw;
    try {
      raw = await groqJson(
        buildBatchScorePrompt(batch, cv, field, language, baseLocation),
        apiKey, model, 1600);
    } catch (e) {
      // Out of quota or rate-limited: keep what we have rather than losing the scan.
      if (/quota|rate limit/i.test(e.message)) break;
      continue;
    }
    for (const s of (raw && raw.scores) || []) {
      const job = batch[s.i];
      if (!job) continue;
      const score = Math.max(0, Math.min(100, parseInt(s.score, 10) || 0));
      scored.push({ job, score, reason: String(s.reason || "").slice(0, 400) });
    }
  }
  return scored;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "FIND_JOBS") return;

  (async () => {
    try {
      const { groqApiKey, cv, lang, model } = await loadKeyAndCv();
      if (!(await sb.getSession())) throw new Error("NOT_SIGNED_IN");

      const sp = await ensureSearchProfile(cv, groqApiKey, model, msg.rebuildProfile);

      // Where they live, so a role on another continent isn't scored as a
      // great match. These boards are international; most postings aren't local.
      const prof = await sb.getProfile();
      const ap = (prof && prof.application_profile) || {};
      const baseLocation = [ap.city, ap.country].filter(Boolean).join(", ");

      const { jobs, stats } = await fetchAll(sp, (t) => progress(t));
      progress(`Found ${jobs.length} postings — filtering…`);

      const survivors = prefilter(jobs, sp).slice(0, MAX_SCORED);
      if (!survivors.length) {
        progress("No matching postings this time.", true, { added: 0, stats });
        sendResponse({ ok: true, added: 0, fetched: jobs.length, stats });
        return;
      }

      const scored = await scoreJobs(survivors, cv, sp.field, groqApiKey, model,
                                     lang, baseLocation);
      const keep = scored.filter((s) => s.score >= 50);

      progress(`Saving ${keep.length} match${keep.length === 1 ? "" : "es"}…`);
      const saved = await sb.upsertFoundJobs(keep);
      await sb.touchLastScan();

      progress(`Done — ${saved} job${saved === 1 ? "" : "s"} in your tracker.`, true,
               { added: saved, stats });
      sendResponse({ ok: true, added: saved, fetched: jobs.length,
                     considered: survivors.length, stats });
    } catch (e) {
      const m = String(e.message || e);
      progress(`Scan failed: ${m}`, true, { error: m });
      sendResponse({ ok: false, error: m });
    }
  })();

  return true;
});

// Classify form fields the rules missed.
//
// Answers are cached by label text: the same wording means the same thing on any
// site, so a label only ever costs one AI call — after that it fills instantly
// and for free. That also means the tool quietly gets better the more forms it
// sees.
const LEARNED_KEY = "learnedFieldMap";
const LEARNED_MAX = 400;

const labelKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 90);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "MAP_FIELDS") return;

  (async () => {
    try {
      const fields = msg.fields || [];
      if (!fields.length) { sendResponse({ ok: true, map: {}, learned: 0, asked: 0 }); return; }

      const store = await chrome.storage.local.get(LEARNED_KEY);
      const learned = store[LEARNED_KEY] || {};

      const map = {};
      const unknown = [];
      for (const f of fields) {
        const hit = learned[labelKey(f.label)];
        if (hit) map[f.id] = hit; else unknown.push(f);
      }
      const fromCache = Object.keys(map).length;

      if (unknown.length) {
        const { groqApiKey, model } = await chrome.storage.local.get(["groqApiKey", "model"]);
        if (groqApiKey) {
          const raw = await groqJson(
            buildFieldMapPrompt(unknown, msg.keys || []), groqApiKey, model, 700);
          const allowed = new Set(msg.keys || []);
          const asked = new Map(unknown.map((f) => [f.id, f.label]));
          for (const [id, key] of Object.entries(raw.map || raw || {})) {
            // Only ids we asked about, only keys we offered.
            if (!asked.has(id) || !allowed.has(key)) continue;
            map[id] = key;
            learned[labelKey(asked.get(id))] = key;
          }
          // Keep the cache from growing without bound.
          const keys = Object.keys(learned);
          if (keys.length > LEARNED_MAX) {
            for (const k of keys.slice(0, keys.length - LEARNED_MAX)) delete learned[k];
          }
          await chrome.storage.local.set({ [LEARNED_KEY]: learned });
        }
      }

      sendResponse({ ok: true, map, learned: fromCache, asked: unknown.length });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true;
});

// Draft answers to a form's free-text questions.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "DRAFT_ANSWERS") return;

  (async () => {
    try {
      const { groqApiKey, cv, lang, model } = await loadKeyAndCv();
      const packet = msg.job?.url ? await sb.latestPacketForUrl(msg.job.url)
                                     .catch(() => null) : null;
      const raw = await groqJson(
        buildAnswersPrompt(msg.questions, msg.job || {}, cv, packet, lang),
        groqApiKey, model, 1600);

      // Keep only non-empty strings for ids we actually asked about.
      const asked = new Set((msg.questions || []).map((q) => q.id));
      const answers = {};
      for (const [id, text] of Object.entries(raw.answers || raw || {})) {
        if (asked.has(id) && typeof text === "string" && text.trim()) {
          answers[id] = text.trim();
        }
      }
      sendResponse({ ok: true, answers });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true;
});

// Autofill data: the saved application details plus, if this job was tailored
// before, its packet (so the cover-letter box can be filled too).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_FILL_DATA") return;

  (async () => {
    try {
      const { applicationProfile: local } =
        await chrome.storage.local.get("applicationProfile");
      let applicationProfile = local || {};
      let packet = null;

      if (await sb.getSession()) {
        try {
          const profile = await sb.getProfile();
          if (profile?.application_profile &&
              Object.keys(profile.application_profile).length) {
            applicationProfile = profile.application_profile;
          }
          if (msg.url) packet = await sb.latestPacketForUrl(msg.url);
        } catch (e) {
          console.warn("Supabase fetch failed, using local details:", e);
        }
      }
      const { language } = await chrome.storage.local.get("language");
      sendResponse({ ok: true, applicationProfile, packet, language: language || "en" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true;
});

// Content script asks us to tailor; we answer with {ok, result} or {ok:false, error}.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "TAILOR") return;

  (async () => {
    try {
      const { groqApiKey, cvText, language, model } =
        await chrome.storage.local.get(["groqApiKey", "cvText", "language", "model"]);

      if (!groqApiKey) throw new Error("NO_KEY");

      // The CV comes from Supabase when signed in (so it follows the user
      // across devices); the locally-stored copy is the offline/signed-out
      // fallback so the extension keeps working without an account.
      let cv = cvText;
      let lang = language;
      let signedIn = false;
      try {
        if (await sb.getSession()) {
          signedIn = true;
          const profile = await sb.getProfile();
          if (profile?.cv_text?.trim()) cv = profile.cv_text;
          if (profile?.language) lang = profile.language;
        }
      } catch (e) {
        // Never let a backend hiccup block tailoring — fall back to local.
        console.warn("Supabase profile fetch failed, using local CV:", e);
      }

      if (!cv || !cv.trim()) throw new Error("NO_CV");

      const result = await callGroq(msg.job, cv, groqApiKey, model, lang || "en");
      const warnings = groundingWarnings(result, cv);

      // Persist the run + track the job. Best-effort: a save failure must not
      // lose the result the user is waiting for.
      let saved = false;
      if (signedIn) {
        try {
          const row = await sb.saveTailoredResult(msg.job, result, warnings);
          await sb.upsertApplication(msg.job, row?.id);
          saved = true;
        } catch (e) {
          console.warn("Supabase save failed:", e);
        }
      }

      sendResponse({ ok: true, result, warnings, saved, signedIn });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
