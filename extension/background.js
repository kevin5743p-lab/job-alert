// background.js — service worker (MV3 module).
//
// Holds the network + secrets boundary: the Groq API key and CV live in
// chrome.storage.local (this machine only) and the actual Groq call happens
// here, not in the content script — so the page's CSP can't block it and the
// key never touches the page context.

import { buildPrompt, buildAnswersPrompt, buildFieldMapPrompt, buildFieldFillPrompt,
         buildSearchProfilePrompt, buildBatchScorePrompt, buildSingleScorePrompt, normalize,
         groundingWarnings, DEFAULT_MODEL, MAX_TOKENS } from "./tailor_core.js";
import * as sb from "./supabase.js";
import { fetchAll, prefilter, prioritise, validateTargets, pickKnownBoards }
  from "./finder.js";
import { ruleScore, classifyWithRules, getDomain, applyDomainCap, candidateFamilies,
         buildMemory, matchesRejectedPattern } from "./matcher.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// One place for the Groq round-trip, so both tailoring and answer-drafting get
// the same error handling (quota vs. rate limit vs. transport).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Groq reports how long to wait, either in the retry-after header or in the
// message body ("try again in 12.5s"). Capped so a scan can't stall for minutes.
function retryAfterMs(resp, body) {
  const header = parseFloat(resp.headers.get("retry-after") || "");
  if (!Number.isNaN(header) && header > 0) return Math.min(45000, header * 1000);
  const m = /try again in ([\d.]+)\s*s/i.exec(body || "");
  if (m) return Math.min(45000, parseFloat(m[1]) * 1000 + 500);
  return 8000;
}

async function groqJson(prompt, apiKey, model, maxTokens, retries = 2) {
  // Groq rejects response_format:json_object unless the prompt itself contains
  // the word "json". A prompt that only shows the shape it wants gets a 400,
  // which is how batch scoring silently failed for every scan.
  if (!/json/i.test(prompt)) {
    throw new Error("Prompt must mention JSON when requesting a JSON response.");
  }

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
    if (/tokens per day|tpd/i.test(body)) {
      throw new Error("Groq daily quota reached — try again tomorrow.");
    }
    // Per-minute limit. Groq says how long to wait, so wait rather than giving
    // up: a scan that stops after one batch is worse than one that takes a
    // minute longer.
    if (retries > 0) {
      const wait = retryAfterMs(resp, body);
      await sleep(wait);
      return groqJson(prompt, apiKey, model, maxTokens, retries - 1);
    }
    throw new Error("Groq rate limit — wait a minute and retry.");
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
const SCORE_BATCH = 5;        // postings per Groq call
// The free tier's real ceiling is tokens per minute, so a scan is paced rather
// than fired as fast as it can go. 48 jobs at 6 per minute is about a minute of
// scoring — enough to surface the best matches without stalling the UI. The
// prefilter has already put the most relevant, most local postings first.
const MAX_SCORED = 48;
const SCORE_PACE_MS = 9000;
// How many get the careful, one-at-a-time treatment before the rest are
// batched. Individual calls cost more but judge far better, so they go to the
// postings the rules already rated highest.
const INDIVIDUAL_SCORED = 15;
const SINGLE_PACE_MS = 4000;
// Scoring is bulk work — a scan puts thousands of words through it — so it uses
// the small fast model regardless of what the user picked for tailoring. The
// large model's free-tier daily token budget is spent in a single scan
// otherwise, and every batch then fails. Tailoring, which runs once per job and
// is judged on writing quality, keeps the user's chosen model.
const SCORING_MODEL = "llama-3.1-8b-instant";

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
  // A profile with no boards left is not usable — it can only ever scan the
  // generic feed. Rebuilding is cheap next to a scan that finds nothing.
  // A profile without a domain block predates the grading rules and would be
  // graded on keywords alone — which is how plainly off-field work reached the
  // tracker. Rebuild those rather than let them keep scanning blind.
  const usable = existing
    && (existing.search_queries || []).length
    && existing.validated
    && (existing.company_targets || []).length
    && existing.domain
    && (existing.domain.reject_title_terms || []).length;
  if (!force && usable) return existing;

  progress("Working out what to search for, from your CV…");
  const sp = await groqJson(buildSearchProfilePrompt(cv), apiKey, model, 2400);
  if (!sp || !(sp.search_queries || []).length) {
    throw new Error("Couldn't derive a search profile from your CV.");
  }

  // Verify the suggested boards before trusting them. The model names real
  // employers but often guesses the wrong ATS, and an unchecked list fails
  // silently — every board 404s and the scan simply finds nothing.
  // Only the model's own suggestions are stored, and only the ones that
  // resolved. The verified registry is deliberately NOT saved here: it lives in
  // code and is merged at scan time, so adding boards benefits every existing
  // user immediately instead of only those who rebuild their profile.
  const candidates = sp.company_targets || [];
  sp.company_targets = await validateTargets(candidates, (t) => progress(t));
  sp.validated = true;
  progress(`${sp.company_targets.length} of ${candidates.length} suggested boards are live.`);

  await sb.saveSearchProfile(sp);
  return sp;
}

async function scoreJobs(jobs, cv, sp, apiKey, model, language, baseLocation,
                         klassOf = new Map()) {
  const scored = [];
  let error = null;                  // surfaced, so a silent failure can't look
                                     // like "no jobs matched"

  // The most promising postings are judged one at a time, with the full CV and
  // 1500 characters of the posting — the way the Python bot does it. Batching
  // is cheaper but gives each job a fraction of the context, and the scores
  // showed it. The rest are batched, which is fine: they're the long tail.
  const individual = jobs.slice(0, INDIVIDUAL_SCORED);
  const batched = jobs.slice(INDIVIDUAL_SCORED);

  for (let i = 0; i < individual.length; i++) {
    const job = individual[i];
    if (i) await sleep(SINGLE_PACE_MS);
    progress(`Scoring the strongest matches… (${i + 1}/${individual.length})`);
    try {
      const raw = await groqJson(
        buildSingleScorePrompt(job, cv, sp, language, baseLocation,
                               klassOf.get(job.url || job.id) || ""),
        apiKey, SCORING_MODEL, 300);
      const score = Math.max(0, Math.min(100, parseInt(raw.score, 10) || 0));
      scored.push({ job, score, reason: String(raw.reason || "").slice(0, 400) });
    } catch (e) {
      error = e.message || String(e);
      if (/quota|rate limit/i.test(error)) break;
    }
  }

  const batches = [];
  for (let i = 0; i < batched.length; i += SCORE_BATCH) {
    batches.push(batched.slice(i, i + SCORE_BATCH));
  }
  let n = 0;
  for (const batch of batches) {
    n++;
    // Pace the calls. The free tier's ceiling is tokens-per-minute, not just
    // requests, and firing batches back to back trips it after the first one —
    // which is exactly what happened: 8 of 80 scored, then a rate limit.
    if (n > 1) await sleep(SCORE_PACE_MS);
    progress(`Scoring the rest… (${Math.min(n * SCORE_BATCH, batched.length)}/${batched.length})`);
    let raw;
    try {
      raw = await groqJson(
        buildBatchScorePrompt(batch, cv, sp, language, baseLocation),
        apiKey, SCORING_MODEL, 1600);
    } catch (e) {
      error = e.message || String(e);
      // Out of quota or rate-limited: keep what we have rather than losing the scan.
      if (/quota|rate limit/i.test(error)) break;
      continue;
    }
    for (const s of (raw && raw.scores) || []) {
      const job = batch[s.i];
      if (!job) continue;
      const score = Math.max(0, Math.min(100, parseInt(s.score, 10) || 0));
      scored.push({ job, score, reason: String(s.reason || "").slice(0, 400) });
    }
  }
  return { scored, error };
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

      // Merge the code-side registry with the user's validated suggestions here,
      // so registry updates apply to everyone on their very next scan.
      const known = pickKnownBoards(sp);
      const seen = new Set(known.map((b) => `${b.ats}:${b.id}`));
      const boards = known.concat(
        (sp.company_targets || []).filter((c) => !seen.has(`${c.ats}:${c.id}`)));

      progress(`Scanning ${boards.length} employer boards + job feeds…`);
      const { jobs, stats } = await fetchAll(
        { ...sp, company_targets: boards, location: baseLocation || "Germany" },
        (t) => progress(t));
      progress(`Found ${jobs.length} postings — filtering…`);

      // Grade the way the Telegram bot does: hard filters and a rule score
      // first, then a domain check, and only then the model. Without these two
      // stages plainly off-field work (marketing, customer service) reached the
      // scorer and sometimes survived it.
      const keyworded = prefilter(jobs, sp);
      const domain = getDomain(sp);
      // Worked out once per scan: which professions this person is actually
      // looking for, so postings from another line of work are rejected even
      // when the generated domain block is thin.
      const families = candidateFamilies(sp);

      // What the user has already turned down. Showing someone a job they've
      // dismissed twice before is how a tracker loses their trust.
      let memory = null;
      try {
        memory = buildMemory(await sb.getDecisionHistory());
      } catch (e) {
        console.warn("Couldn't read decision history:", e);
      }

      const graded = [];
      let cutOffField = 0, cutRules = 0, cutMemory = 0;

      for (const job of keyworded) {
        const [rScore, rReason] = ruleScore(job, sp, families);
        if (rScore === 0) { cutRules++; continue; }        // language, seniority, off-field
        if (matchesRejectedPattern(job, memory)) { cutMemory++; continue; }
        const [klass] = classifyWithRules(job, domain);
        if (klass === "out_of_domain") { cutOffField++; continue; }
        graded.push({ job, rScore, rReason, klass });
      }

      // Best rule score first, then location — so the model's budget goes to
      // the most promising local postings rather than whatever came back first.
      graded.sort((a, b) => b.rScore - a.rScore);
      const matched = prioritise(graded.map((g) => g.job), baseLocation);
      const klassOf = new Map(graded.map((g) => [g.job.url || g.job.id, g.klass]));
      const survivors = matched.slice(0, MAX_SCORED);
      progress(`${matched.length} relevant (${cutRules} filtered, ` +
               `${cutOffField} off-field${cutMemory ? `, ${cutMemory} like ones you dismissed` : ""})` +
               ` — scoring the best ${survivors.length}…`);
      if (!survivors.length) {
        progress("No matching postings this time.", true, { added: 0, stats });
        sendResponse({ ok: true, added: 0, fetched: jobs.length, stats });
        return;
      }

      const { scored, error: scoreError } =
        await scoreJobs(survivors, cv, sp, groqApiKey, model, lang, baseLocation, klassOf);

      // The domain class caps the final score, so anything the rules judged
      // out-of-field can't be rescued by an over-generous model score.
      for (const s of scored) {
        s.score = applyDomainCap(s.score, klassOf.get(s.job.url || s.job.id) || "core_field");
      }
      const keep = scored.filter((s) => s.score >= 50);

      // Report the whole funnel. When a scan ends with nothing, this says which
      // stage swallowed the jobs — sources, keyword filter, or scoring — instead
      // of leaving "0 jobs" to be guessed at.
      const best = scored.reduce((m, s) => Math.max(m, s.score), 0);
      let funnel = `${jobs.length} found → ${matched.length} relevant → ` +
        `${scored.length} scored → ${keep.length} kept`;
      if (!scored.length && scoreError) {
        funnel += ` — scoring failed: ${scoreError}`;
      } else if (scored.length && !keep.length) {
        funnel += ` (best score ${best}, needs 50)`;
      } else if (scoreError) {
        funnel += ` — scoring stopped early: ${scoreError}`;
      }
      progress(funnel);

      progress(`Saving ${keep.length} match${keep.length === 1 ? "" : "es"}…`);
      const saved = await sb.upsertFoundJobs(keep);
      await sb.touchLastScan();

      progress(`Done — ${saved} job${saved === 1 ? "" : "s"} added. ${funnel}`, true,
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
// Value generation runs in small batches with a pause between them: forms can
// carry dozens of unusual fields, and accuracy matters more here than speed.
const FILL_BATCH = 6;
const FILL_PACE_MS = 4000;

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

      const fills = {};
      if (unknown.length) {
        const { groqApiKey, model } = await chrome.storage.local.get(["groqApiKey", "model"]);
        if (groqApiKey) {
          const allowed = new Set(msg.keys || []);
          const asked = new Map(unknown.map((f) => [f.id, f.label]));

          // Pass 1 — map the fields that correspond to a stored answer. These
          // are cached by label, so a form seen before fills instantly.
          try {
            const raw = await groqJson(
              buildFieldMapPrompt(unknown, msg.keys || []), groqApiKey, model, 800);
            for (const [id, key] of Object.entries(raw.map || raw || {})) {
              // Only ids we asked about, only keys we offered.
              if (!asked.has(id) || !allowed.has(key)) continue;
              map[id] = key;
              learned[labelKey(asked.get(id))] = key;
            }
          } catch (e) {
            console.warn("Field mapping failed:", e);
          }

          // Pass 2 — ask for actual values for whatever is still unplaced, in
          // small batches so a long form doesn't hit the rate limit. Slower by
          // design: a field left blank or filled wrongly costs the user more
          // than a few seconds of waiting.
          const remaining = unknown.filter((f) => !map[f.id]);
          for (let i = 0; i < remaining.length; i += FILL_BATCH) {
            const batch = remaining.slice(i, i + FILL_BATCH);
            if (i) await sleep(FILL_PACE_MS);
            try {
              const raw = await groqJson(
                buildFieldFillPrompt(batch, msg.profile || {}, msg.cv || ""),
                groqApiKey, model, 900);
              for (const [id, val] of Object.entries(raw.fills || raw || {})) {
                if (asked.has(id) && typeof val === "string" && val.trim()) {
                  fills[id] = val.trim();
                }
              }
            } catch (e) {
              console.warn("Field fill failed:", e);
              break;                       // out of quota — keep what we have
            }
          }

          // Keep the cache from growing without bound.
          const keys = Object.keys(learned);
          if (keys.length > LEARNED_MAX) {
            for (const k of keys.slice(0, keys.length - LEARNED_MAX)) delete learned[k];
          }
          await chrome.storage.local.set({ [LEARNED_KEY]: learned });
        }
      }

      sendResponse({ ok: true, map, fills, learned: fromCache, asked: unknown.length });
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
      const { language, cvText } = await chrome.storage.local.get(["language", "cvText"]);
      // A slice of the CV goes with the fill request so the model can answer
      // fields the saved details don't cover (studies, tools, experience).
      let cv = cvText || "";
      try {
        if (await sb.getSession()) {
          const profile = await sb.getProfile();
          if (profile?.cv_text?.trim()) cv = profile.cv_text;
        }
      } catch { /* local copy is fine */ }

      sendResponse({ ok: true, applicationProfile, packet,
                     language: language || "en", cvSummary: cv.slice(0, 2000) });
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
