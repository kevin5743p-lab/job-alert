// ai-proxy — the only thing in this system that holds the Anthropic API key.
//
// WHY A PROXY AT ALL
//
// Twenty-five people share one paid Anthropic key. If that key ships inside the
// extension it is readable from chrome://extensions in about ten seconds, by
// anyone, and can then be spent on anything with no cap and no attribution.
// One curious user ends the month. So the key lives here, as a server secret,
// and the extension never sees it.
//
// Holding the key is only half the job. The other half is that a shared key
// with no accounting is drained by whoever is most active — so every call is
// priced, recorded against a user, and refused once that user has spent their
// monthly allowance. See sql/002_ai_proxy.sql for the tables.
//
// WHAT THE CLIENT MAY AND MAY NOT CHOOSE
//
// The client sends an ordinary Anthropic Messages request and gets the ordinary
// response back, so calling code barely changes. But it does not get to pick
// the model or the output ceiling: those are the two knobs that decide what a
// call costs, and a client that could set them could spend $25/MTok on Opus.
// The proxy pins the model per task and clamps max_tokens.
//
// DEPLOY
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy ai-proxy
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Published rates in US dollars per million tokens. Because a micro is a
// millionth of a dollar, cost_micros works out to tokens x rate exactly — no
// division, no rounding drift.
//
// Metered at STANDARD rates even while a model is on introductory pricing.
// Charging a user's allowance slightly more than the real invoice is the safe
// direction to be wrong in: the budget can only come in under, never over.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
};

const CACHE_WRITE_MULTIPLIER = 1.25; // writing a cache entry costs 1.25x input
const CACHE_READ_MULTIPLIER = 0.1; //  reading one costs a tenth

// Which model runs which job, decided here rather than by the caller.
//
// tailor — Haiku 4.5. One call, a few thousand tokens, and the output is
//   checked against the CV by tailor_core's grounding pass before anyone sees
//   it, so the cheaper model is not carrying the risk alone.
// apply_simple — Haiku 4.5. Tier-0 boards (Greenhouse, Lever, Ashby, Personio):
//   one or two pages of ordinary inputs. This is the majority of applications,
//   so it is where model choice moves the monthly bill most.
// apply  — Sonnet 5. Tier 1: Workday, LinkedIn, SuccessFactors — five pages of
//   conditional questions and custom widgets, where a wrong move gets submitted
//   under the user's name and cannot be recalled.
//
// Both apply tasks are gated by the same deterministic confidence.js check
// before any submit, so the cheaper model is not being trusted with the
// irreversible part — it is only being trusted to navigate a simple form.
//
// Opus is deliberately absent. It costs 5x Sonnet's input, and the only path
// that reached for it was "this job already failed twice" — the jobs least
// likely to be rescued by a bigger model and most likely to burn several
// users' allowance trying. Add it back only with its own smaller sub-budget.
const TASK_MODELS: Record<string, string> = {
  tailor: "claude-haiku-4-5",
  apply_simple: "claude-haiku-4-5",
  apply: "claude-sonnet-5",
};

// Ceilings, not targets — the model does not try to reach max_tokens, so a
// generous cap costs nothing on a normal call.
//
// tailor is the high one because the packet is a whole rewritten CV plus a
// cover letter: 2,500-3,500 tokens of output is normal, and a cap set near
// that truncates the JSON mid-object rather than producing a shorter packet.
// An apply step is a single tool call and never comes close to its cap.
const MAX_TOKENS_CAP: Record<string, number> = {
  tailor: 8192,
  apply_simple: 4096,
  apply: 4096,
};

// A tailoring prompt is ~10KB and an apply observation ~30KB. Anything an order
// of magnitude past that is a bug or an attempt to run up a bill on input
// tokens, and it costs nothing to refuse it before paying Anthropic to read it.
const MAX_BODY_BYTES = 512 * 1024;

const cors = (origin: string | null) => ({
  // The caller is a Chrome extension, whose origin is chrome-extension://<id>
  // and differs per install (unpacked builds get their own id). The request is
  // authenticated by Supabase JWT, so the origin is not what protects it.
  "Access-Control-Allow-Origin": origin ?? "*",
  // `apikey` is in the list because supabase.js sends it alongside the bearer
  // token on every call; omitting it here makes the browser fail the preflight
  // before the request is ever attempted.
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
});

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

/** Cost of one call in micros, from the usage block Anthropic returns. */
function costMicros(model: string, usage: Record<string, number> = {}) {
  const price = PRICES[model];
  if (!price) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  return Math.round(
    input * price.input +
      cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * price.input * CACHE_READ_MULTIPLIER +
      output * price.output,
  );
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return json({ error: "not_configured" }, 500, origin);
  }

  // ── who is calling ────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "not_signed_in" }, 401, origin);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: "not_signed_in" }, 401, origin);

  // ── what they asked for ───────────────────────────────────────────────────
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413, origin);
  }

  let body: { task?: string; payload?: Record<string, unknown>; job_url?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400, origin);
  }

  const task = body.task ?? "";
  const model = TASK_MODELS[task];
  if (!model) {
    return json(
      { error: "unknown_task", detail: `task must be one of: ${Object.keys(TASK_MODELS).join(", ")}` },
      400,
      origin,
    );
  }

  const payload = body.payload;
  if (!payload || !Array.isArray(payload.messages)) {
    return json({ error: "invalid_payload", detail: "payload.messages is required" }, 400, origin);
  }

  // ── may they spend ────────────────────────────────────────────────────────
  // Checked before the call, not after, so a user at their ceiling costs
  // nothing. A single call can still overshoot the limit slightly — the cost
  // is only known once Anthropic answers — which is why the pool backstop in
  // ai_settings exists a long way above the sum of the individual limits.
  const { data: quotaRows, error: quotaErr } = await admin.rpc("ai_quota", {
    p_user: user.id,
  });
  if (quotaErr) {
    console.error("ai_quota failed", quotaErr);
    return json({ error: "quota_check_failed" }, 500, origin);
  }

  const quota = Array.isArray(quotaRows) ? quotaRows[0] : quotaRows;
  if (!quota?.allowed) {
    return json(
      {
        error: "quota_exceeded",
        reason: quota?.reason ?? "unknown",
        limit_micros: quota?.limit_micros ?? 0,
        spent_micros: quota?.spent_micros ?? 0,
      },
      402, // Payment Required — distinguishable from a 429 the client retries
      origin,
    );
  }

  // ── call Anthropic ────────────────────────────────────────────────────────
  // The client's payload is forwarded as-is apart from the two fields that
  // decide the price. Everything that makes the request good — the cached
  // system prefix, the tool contract, tool_choice — is the caller's business.
  const requestedMax = Number(payload.max_tokens) || MAX_TOKENS_CAP[task];
  const anthropicBody = {
    ...payload,
    model,
    max_tokens: Math.min(requestedMax, MAX_TOKENS_CAP[task]),
  };

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (e) {
    await admin.from("ai_usage").insert({
      user_id: user.id,
      task,
      model,
      job_url: body.job_url ?? null,
      error: `network: ${String(e).slice(0, 200)}`,
    });
    return json({ error: "upstream_unreachable" }, 502, origin);
  }

  const text = await resp.text();

  if (!resp.ok) {
    // Record the failure with zero cost. A user stuck in a retry loop against
    // a 400 shows up here as a row count, which is the only way to notice it.
    await admin.from("ai_usage").insert({
      user_id: user.id,
      task,
      model,
      job_url: body.job_url ?? null,
      error: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
    });
    // Status is passed through so the client's existing 429 backoff still works.
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": "application/json", ...cors(origin) },
    });
  }

  // ── record what it cost ───────────────────────────────────────────────────
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fall through: usage stays zero, the body is still returned verbatim */
  }

  const usage = parsed.usage ?? {};
  const cost = costMicros(model, usage);

  // A truncated packet is unusable to the caller but still billable, so it is
  // worth being able to find these in the usage table later rather than seeing
  // an ordinary-looking row. Three of these cost $0.04 and looked like clean
  // successes until the output_tokens column was read closely.
  const truncated = parsed.stop_reason === "max_tokens";

  // Deliberately not awaited-and-failed: if the insert fails, the user has
  // already had a good answer and swallowing their response to report a
  // bookkeeping error would be the wrong trade. It is logged instead.
  const { error: insertErr } = await admin.from("ai_usage").insert({
    user_id: user.id,
    task,
    model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cost_micros: cost,
    job_url: body.job_url ?? null,
    error: truncated
      ? `truncated at max_tokens (${usage.output_tokens ?? "?"} output tokens)`
      : null,
  });
  if (insertErr) console.error("ai_usage insert failed", insertErr, { cost });

  // The Anthropic response is returned untouched, plus a small header the
  // dashboard can use to show a live allowance figure without a second query.
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Allowance-Remaining-Micros": String(
        Math.max((quota.remaining_micros ?? 0) - cost, 0),
      ),
      ...cors(origin),
    },
  });
});
