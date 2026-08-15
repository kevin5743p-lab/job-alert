// router.js — decides what runs next, and makes sure one site's problem stays
// one site's problem.
//
// THE ISOLATION GUARANTEE
//
// This is the file that has to get it right. The pump walks the queue *per
// domain*: it asks domain_health whether a given domain may run, and if the
// answer is no — quarantined, capped, too soon — it moves to the next domain
// and keeps going. There is no global pause, no shared retry counter, and no
// early `return` on a domain-level failure.
//
// Concretely: if Indeed is quarantined and Greenhouse is healthy, a queue of
// twenty jobs across both drains every Greenhouse job at full speed.
//
// TIER 2 NEVER RUNS HERE
//
// Aggregator postings are resolved to the employer's own ATS at enqueue time,
// before anything is queued, so the queue only ever holds work we can actually
// do. A posting that doesn't resolve is parked for the user with one click to
// open it, rather than being attempted.

import { runApply } from "./apply_agent.js";
import { hold } from "./keepalive.js";
import {
  claimApplyRun, enqueueApply, updateApplyRun, appendApplyStep,
  activeApplyRuns, liveRunForUrl, domainOf, reclaimStaleRuns,
  getSession, aiAllowance,
} from "./supabase.js";
import {
  canRun, tierFor, isRerouteOnly, nextGapMs, healthSummary, resumeDomain,
} from "./domain_health.js";
import { resolve, isApplyableHost } from "./resolve_ats.js";
import { looksLikeAPosting } from "./posting_url.js";

let pumping = false;
let stopRequested = false;
let lastPumpAt = 0;
const listeners = new Set();

// The dashboard polls APPLY_STATUS every 2.5s while anything is in flight, and
// that same poll is what resumes a queue left behind by a reload. Those are two
// different jobs on two different clocks: resuming a stalled queue is worth
// doing every so often, not twenty-four times a minute.
const PUMP_MIN_GAP_MS = 20_000;

// One "skipped: pacing" line per domain is information. The same line every
// 2.5s buries everything else in the activity log, which is exactly what it did.
const SKIP_EMIT_GAP_MS = 60_000;
const lastSkipEmit = new Map();          // `${domain}:${reason}` -> timestamp

export function onProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * Broadcast one router event.
 *
 * The event goes in its own `event` key rather than being spread into the
 * envelope. Spreading looked tidier and was wrong: every event carries its own
 * `type` ("error", "running", …), which overwrote the `APPLY_PROGRESS` envelope
 * type, so nothing listening for APPLY_PROGRESS ever matched and every progress
 * message — including "you have no API key" — was silently dropped.
 */
function emit(ev) {
  for (const fn of listeners) { try { fn(ev); } catch { /* a bad listener isn't fatal */ } }
  chrome.runtime.sendMessage({ type: "APPLY_PROGRESS", event: ev }).catch(() => {});
}

/** A "we stood down on this domain" event, at most once a minute per reason. */
function emitSkip(ev) {
  const key = `${ev.domain}:${ev.reason}`;
  const now = Date.now();
  if (now - (lastSkipEmit.get(key) || 0) < SKIP_EMIT_GAP_MS) return;
  lastSkipEmit.set(key, now);
  emit(ev);
}

async function settings() {
  const s = await chrome.storage.local.get(["submitPolicy"]);
  return {
    // "confident" submits when every deterministic check passes.
    // "never" fills and attaches, then hands over. Recommended for the first
    // several runs — you want to see what it produces before it sends one.
    submitPolicy: s.submitPolicy || "confident",
  };
}

/**
 * Can this user start an apply run at all?
 *
 * There is no API key to check any more — the key lives in ai-proxy. What can
 * stop a run before it starts is the account: not signed in (the proxy has no
 * one to bill) or out of monthly allowance.
 *
 * Checked at the click rather than three layers down, because queuing work that
 * can never run leaves a row stuck at "Queued" with no explanation, which is
 * the worst possible way to tell someone their month is spent.
 */
async function applyPrecondition() {
  if (!(await getSession())) {
    return "Sign in from the JobCopilot toolbar icon to use auto-apply.";
  }
  try {
    const a = await aiAllowance();
    if (a && !a.enabled) {
      return "AI features are paused on this account right now.";
    }
    if (a && Number(a.remaining_micros) <= 0) {
      const resets = a.resets_at ? new Date(a.resets_at).toLocaleDateString() : "the 1st";
      return `You've used this month's AI allowance ($${(a.limit_micros / 1e6).toFixed(2)}). ` +
             `Scanning and manual autofill still work; auto-apply resumes ${resets}.`;
    }
  } catch (e) {
    // A backend hiccup must not block applying. The proxy re-checks the same
    // quota server-side on every call, so this is a nicety, not the guard.
    console.warn("Allowance check failed, continuing:", e);
  }
  return null;
}

// ── enqueueing ──────────────────────────────────────────────────────────────

/**
 * Queue one job.
 *
 * `job` needs { url, title, company } and optionally applicationId. Returns the
 * run row, or a { parked, reason } object when the posting can't be applied to
 * automatically.
 */
export async function enqueue(job) {
  const blocked = await applyPrecondition();
  if (blocked) throw new Error(blocked);

  if (!looksLikeAPosting(job.url)) {
    throw new Error(
      "This listing's link points at the company's careers home page, not at " +
      "the job itself, so there is nothing to apply to. Open the posting on " +
      "the employer's site and use Tailor + Apply from there.");
  }

  const existing = await liveRunForUrl(job.url);
  if (existing) return { run: existing, alreadyQueued: true };

  const domain = domainOf(job.url);

  // Not an aggregator — queue it as-is.
  if (!isRerouteOnly(domain)) {
    const run = await enqueueApply(job, { tier: tierFor(domain) });
    emit({ type: "queued", runId: run?.id, job: job.title, domain });
    return { run };
  }

  // Aggregator. Find the employer's own posting before queuing anything.
  emit({ type: "resolving", job: job.title, domain });
  const found = await resolve(job).catch(() => null);

  if (found && isApplyableHost(found.url)) {
    const target = domainOf(found.url);
    const run = await enqueueApply(
      { ...job, url: found.url },
      { tier: tierFor(target), originalJobUrl: job.url });
    if (run) {
      await appendApplyStep(run.id, {
        kind: "rerouted", from: job.url, to: found.url,
        via: found.source, matchedTitle: found.title,
      });
    }
    emit({ type: "rerouted", runId: run?.id, job: job.title, from: domain, to: target });
    return { run, rerouted: { from: job.url, to: found.url, via: found.source } };
  }

  // Nothing found. Park it so it shows up in the dashboard as "needs you"
  // rather than silently disappearing.
  const run = await enqueueApply(job, { tier: 2 });
  if (run) {
    await updateApplyRun(run.id, {
      status: "paused_needs_human",
      pause_reason:
        `This one only exists on ${domain}, which we don't apply through. ` +
        `Open it and apply directly — your tailored CV and cover letter are ready.`,
      finished_at: new Date().toISOString(),
    });
  }
  emit({ type: "parked", runId: run?.id, job: job.title, domain });
  return { run, parked: true, reason: `no ${domain}-independent posting found` };
}

/** Queue several, reporting per-job outcomes rather than failing as a batch. */
export async function enqueueMany(jobs) {
  const out = [];
  for (const job of jobs) {
    try { out.push({ job: job.url, ...(await enqueue(job)) }); }
    catch (e) { out.push({ job: job.url, error: e.message }); }
  }
  pump();
  return out;
}

// ── the pump ────────────────────────────────────────────────────────────────

/**
 * Drain the queue until nothing is runnable.
 *
 * `skip` holds domains that said "not now" during this pass. It is what keeps
 * one blocked domain from being re-claimed in a tight loop, and — because it is
 * scoped to this function rather than to the module — it is also what keeps a
 * blocked domain from being remembered as blocked forever.
 */
export async function pump() {
  if (pumping) return;
  pumping = true;
  stopRequested = false;
  lastPumpAt = Date.now();

  // Hold the service worker open for the whole pass. Without this the worker is
  // torn down mid-run — see keepalive.js. It is the first thing done and the
  // last thing released, because everything below is `await`-heavy.
  const release = hold();

  const skip = new Map();          // domain -> reason, for this pass only
  try {
    const { submitPolicy } = await settings();
    const blocked = await applyPrecondition();
    if (blocked) {
      emit({ type: "error", text: blocked });
      return;
    }

    // A run left `running` by a worker that died can never be claimed again —
    // claim_apply_run only looks at `queued`. Put those back before claiming so
    // one crash doesn't strand a job permanently.
    const reclaimed = await reclaimStaleRuns().catch(() => []);
    if (reclaimed.length) {
      emit({ type: "reclaimed", count: reclaimed.length,
             text: `Requeued ${reclaimed.length} run(s) interrupted by a browser restart.` });
    }

    // Ask domain_health *before* claiming anything.
    //
    // Claiming is not free and it is not read-only: claim_apply_run sets the row
    // `running` and bumps `attempts`. Handing it straight back because the
    // domain is paced therefore costs two writes and one wasted attempt — and
    // with the dashboard resuming the pump every 2.5s, a single job waiting out
    // a LinkedIn pacing gap collected dozens of attempts in a minute, flipped
    // itself between queued and running the whole time, and pushed itself past
    // the `attempts > 2` line that switches the agent to the expensive model.
    // None of that work was ever going to run. So don't claim it.
    if (!(await gateQueuedDomains(skip))) return;

    for (;;) {
      if (stopRequested) { emit({ type: "stopped" }); break; }

      const run = await claimApplyRun();
      if (!run) break;                                  // queue empty

      // A domain can go from runnable to paced *during* a pass — the gap starts
      // when the previous run on it finished. The pre-gate above can't see that,
      // so the per-run check stays. `attempts` is given back: a run that was
      // claimed and immediately requeued was never actually attempted.
      const reason = skip.get(run.domain) ||
        await canRun(run.domain).then((g) => (g.ok ? null : g.reason));

      if (reason) {
        skip.set(run.domain, reason);
        await updateApplyRun(run.id, {
          status: "queued", attempts: Math.max(0, (run.attempts || 1) - 1),
        });
        emitSkip({ type: "skipped", runId: run.id, domain: run.domain, reason });
        // Nothing else to claim on this domain right now; look for another.
        if (skip.size && !(await anyRunnableOutside(skip))) break;
        continue;                                        // ← other domains carry on
      }

      emit({ type: "running", runId: run.id, job: run.job_title,
             company: run.job_company, domain: run.domain });

      // A failure inside one run must not escape and stop the pump. runApply
      // already records its own outcome; this is the backstop.
      let status = "failed";
      try {
        status = await runApply(run, {
          submitPolicy,
          onProgress: (p) => emit({ type: "step", ...p }),
        });
      } catch (e) {
        emit({ type: "error", runId: run.id, text: e.message });
      }

      emit({ type: "finished", runId: run.id, status, domain: run.domain });

      // A domain that just blocked us is done for this pass regardless of what
      // its health row says — no point claiming its next job to find out again.
      if (status === "blocked") skip.set(run.domain, "blocked during this pass");

      await sleep(nextGapMs(run.tier));
    }
  } finally {
    pumping = false;
    emit({ type: "idle", health: await healthSummary().catch(() => []) });
    await scheduleRetry(skip);
    release();
  }
}

/**
 * Check every domain with queued work, before a single row is claimed.
 *
 * Returns true when at least one of them may run. Domains that may not are put
 * in `skip` with their reason, so the pass never claims them at all.
 *
 * This is the same per-domain question canRun already answers — asked once up
 * front rather than once per wasted claim. It keeps the isolation guarantee
 * intact: a paced or quarantined domain lands in `skip`, and every other domain
 * still drains at full speed.
 */
async function gateQueuedDomains(skip) {
  const runs = (await activeApplyRuns()) || [];
  const domains = [...new Set(
    runs.filter((r) => r.status === "queued").map((r) => r.domain))];
  if (!domains.length) return false;

  let runnable = 0;
  for (const domain of domains) {
    if (skip.has(domain)) continue;
    const gate = await canRun(domain).catch(() => ({ ok: true }));
    if (gate.ok) { runnable++; continue; }
    skip.set(domain, gate.reason);
    emitSkip({ type: "skipped", domain, reason: gate.reason, retryAt: gate.retryAt });
  }
  return runnable > 0;
}

/** Is there queued work on any domain we haven't skipped? */
async function anyRunnableOutside(skip) {
  const active = (await activeApplyRuns()) || [];
  return active.some((r) => r.status === "queued" && !skip.has(r.domain));
}

/**
 * If we stood down on pacing or a cap, come back when it expires.
 *
 * The alarm is set from the soonest retryAt across the skipped domains, so a
 * 24h Indeed quarantine doesn't delay a Greenhouse job that's only waiting out
 * a 90-second gap.
 */
async function scheduleRetry(skip) {
  if (!skip.size) return;
  const summary = await healthSummary().catch(() => []);
  const soonest = summary
    .filter((h) => skip.has(h.domain) && h.retryAt)
    .map((h) => new Date(h.retryAt).getTime())
    .sort((a, b) => a - b)[0];

  const when = soonest || Date.now() + 5 * 60 * 1000;    // pacing: check back in 5m
  chrome.alarms.create(PUMP_ALARM, { when: Math.max(when, Date.now() + 60_000) });
}

export const PUMP_ALARM = "jca-pump";

/**
 * Pump, but no more often than PUMP_MIN_GAP_MS.
 *
 * For the callers whose job is "make sure the queue isn't stalled" — the
 * dashboard's status poll — rather than "something just changed, go now", which
 * should still call pump() directly.
 */
export function pumpSoon() {
  if (pumping || Date.now() - lastPumpAt < PUMP_MIN_GAP_MS) return;
  pump();
}

export function requestStop() { stopRequested = true; }

/** Lift a domain's quarantine on the user's say-so. */
export async function resumeSite(domain) {
  const health = await resumeDomain(domain);
  emit({ type: "resumed", domain, health: await healthSummary().catch(() => []) });
  return health;
}

/** Abort one queued or paused run. A running one stops at its next step. */
export async function abort(runId) {
  await updateApplyRun(runId, {
    status: "aborted", finished_at: new Date().toISOString(),
  });
  emit({ type: "aborted", runId });
}

/** Put a paused or failed run back in the queue. */
export async function retry(runId) {
  await updateApplyRun(runId, {
    status: "queued", pause_reason: null, error: null, finished_at: null,
  });
  emit({ type: "queued", runId });
  pump();
}

export async function status() {
  return {
    pumping,
    runs: (await activeApplyRuns()) || [],
    health: await healthSummary().catch(() => []),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
