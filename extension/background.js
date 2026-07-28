// background.js — service worker (MV3 module).
//
// Holds the network + secrets boundary: the Groq API key and CV live in
// chrome.storage.local (this machine only) and the actual Groq call happens
// here, not in the content script — so the page's CSP can't block it and the
// key never touches the page context.

import { buildPrompt, normalize, groundingWarnings, DEFAULT_MODEL, MAX_TOKENS } from "./tailor_core.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(job, cvText, apiKey, model, language) {
  const prompt = buildPrompt(job, cvText, language);
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
      max_tokens: MAX_TOKENS,
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
  return normalize(JSON.parse(content));
}

// Content script asks us to tailor; we answer with {ok, result} or {ok:false, error}.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "TAILOR") return;

  (async () => {
    try {
      const { groqApiKey, cvText, language, model } =
        await chrome.storage.local.get(["groqApiKey", "cvText", "language", "model"]);

      if (!groqApiKey) throw new Error("NO_KEY");
      if (!cvText || !cvText.trim()) throw new Error("NO_CV");

      const result = await callGroq(msg.job, cvText, groqApiKey,
                                    model, language || "en");
      const warnings = groundingWarnings(result, cvText);
      sendResponse({ ok: true, result, warnings });
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
