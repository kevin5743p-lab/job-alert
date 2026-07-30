// background.js — service worker (MV3 module).
//
// Holds the network + secrets boundary: the Groq API key and CV live in
// chrome.storage.local (this machine only) and the actual Groq call happens
// here, not in the content script — so the page's CSP can't block it and the
// key never touches the page context.

import { buildPrompt, buildAnswersPrompt, normalize, groundingWarnings,
         DEFAULT_MODEL, MAX_TOKENS } from "./tailor_core.js";
import * as sb from "./supabase.js";

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
      sendResponse({ ok: true, applicationProfile, packet });
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
