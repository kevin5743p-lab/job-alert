// ai_client.js — how the extension reaches Claude.
//
// There is no Anthropic API key in this file, or anywhere else in the
// extension. Every call goes through the ai-proxy Edge Function, which holds
// the shared key, pins the model, and meters the spend against the signed-in
// user's monthly allowance. See supabase/functions/ai-proxy/index.ts.
//
// The response is Anthropic's, verbatim — `content`, `usage`, `stop_reason`
// and all — so code that used to call api.anthropic.com directly only has to
// change where it points, not how it reads the answer.

import { callFunction } from "./supabase.js";

/**
 * Thrown when the user has spent their month. Carries `reason` so the UI can
 * say something true: a user at their own ceiling ("allowance used, resets on
 * the 1st") is in a different situation from one hitting a paused service.
 */
export class QuotaError extends Error {
  constructor(reason, detail) {
    super(detail || `Monthly AI allowance reached (${reason})`);
    this.name = "QuotaError";
    this.reason = reason;
  }
}

// One Anthropic organisation serves all users, so its rate limits are shared:
// two people applying at the same moment can collide even though neither is
// doing anything unusual. A 429 here is therefore normal traffic, not abuse —
// wait and retry rather than surfacing it.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Claude call.
 *
 * @param {object}  opts
 * @param {"tailor"|"apply"} opts.task  Decides the model, server-side. The
 *   client cannot pick it — that is the knob that decides the price.
 * @param {Array}   opts.messages
 * @param {string|Array} [opts.system]  Pass an array of blocks with
 *   cache_control on the last stable one to get the cached-prefix discount.
 * @param {Array}   [opts.tools]
 * @param {object}  [opts.tool_choice]
 * @param {object}  [opts.output_config]
 * @param {number}  [opts.max_tokens]   Clamped server-side.
 * @param {string}  [opts.jobUrl]       Recorded with the spend, so a costly
 *   month can be traced back to actual postings.
 * @returns {Promise<object>} the Anthropic message response
 */
export async function callClaude({
  task,
  messages,
  system,
  tools,
  tool_choice,
  output_config,
  max_tokens = 4096,
  jobUrl = null,
}) {
  const payload = { messages, max_tokens };
  if (system !== undefined) payload.system = system;
  if (tools !== undefined) payload.tools = tools;
  if (tool_choice !== undefined) payload.tool_choice = tool_choice;
  if (output_config !== undefined) payload.output_config = output_config;

  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { ok, status, data } = await callFunction("ai-proxy", {
      task,
      payload,
      job_url: jobUrl,
    });

    if (ok) return data;

    // Out of allowance. Never retried: waiting does not create budget, and a
    // retry loop against a 402 would burn the user's battery to no end.
    if (status === 402) {
      throw new QuotaError(data?.reason || "unknown", quotaMessage(data));
    }

    lastError = data?.error?.message || data?.error || `HTTP ${status}`;

    if (!RETRY_STATUSES.has(status) || attempt === MAX_RETRIES) break;

    // Exponential, and jittered so 25 clients that collided once do not all
    // wake at the same instant and collide again.
    const wait = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 1000;
    await sleep(wait);
  }

  throw new Error(`Claude call failed: ${String(lastError).slice(0, 300)}`);
}

/** A sentence the user can act on, rather than an error code. */
function quotaMessage(data) {
  const spent = ((data?.spent_micros ?? 0) / 1e6).toFixed(2);
  const limit = ((data?.limit_micros ?? 0) / 1e6).toFixed(2);

  switch (data?.reason) {
    case "user_limit_reached":
      return `You've used your monthly AI allowance ($${spent} of $${limit}). ` +
             `Job scanning and manual autofill still work — they run on your own ` +
             `Groq key. Tailoring and auto-apply resume on the 1st.`;
    case "user_disabled":
      return "AI features are switched off for this account.";
    case "pool_exhausted":
      return "This month's shared AI budget is used up for everyone. " +
             "Scanning and autofill still work.";
    case "service_disabled":
      return "AI features are paused right now. Scanning and autofill still work.";
    default:
      return "Monthly AI allowance reached.";
  }
}
