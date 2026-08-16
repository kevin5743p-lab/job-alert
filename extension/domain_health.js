// domain_health.js — pacing, tiering, and the circuit breaker.
//
// WHAT THIS IS FOR
//
// Two jobs, both of them about restraint:
//
//   1. Don't hammer anyone. Per-domain daily caps and a spaced gap between
//      applications, so a batch of 40 queued jobs arrives as a trickle rather
//      than a burst against one employer's ATS.
//
//   2. Stop when a site says stop. If a page comes back as a challenge, a 403,
//      or a CAPTCHA, that domain is quarantined and we do not go near it again
//      for a day. We never attempt the challenge, never retry into it, and
//      never try to look like something we aren't.
//
// And the property the whole design exists for: quarantining one domain must
// not stop the others. The router asks this module per domain, so Indeed going
// dark cannot stall Greenhouse. There is no global pause flag anywhere, because
// a global flag is how one site's problem becomes every site's problem.
//
// TIERS
//
//   0  Plain DOM. Ordinary ATS application forms — the employer's own intended
//      channel. No debugger attach at all.
//   1  Trusted CDP input. Enterprise ATSes and LinkedIn: custom widgets that
//      only respond to real key events, and platforms where volume matters.
//   2  Never auto-applied. Aggregators behind bot protection. resolve_ats.js
//      reroutes the posting to the employer's real ATS (which is usually where
//      "Apply on company site" points anyway, and is the better application);
//      anything that exists nowhere else is handed to the user.

import {
  getDomainHealth, upsertDomainHealth, allDomainHealth, domainOf,
} from "./supabase.js";

export { domainOf };

// ── tiering ─────────────────────────────────────────────────────────────────

const TIER_1 = new Set([
  "myworkdayjobs.com", "myworkdaysite.com", "linkedin.com",
  "successfactors.eu", "successfactors.com",
  "icims.com", "taleo.net", "avature.net", "jobvite.com",
  "eightfold.ai", "bamboohr.com",
]);

// Aggregators we do not apply through directly. Not a difficulty rating — a
// decision. See REROUTE_ONLY below.
const TIER_2 = new Set(["indeed.com", "stepstone.de", "xing.com"]);

export function tierFor(domain) {
  if (TIER_2.has(domain)) return 2;
  if (TIER_1.has(domain)) return 1;
  return 0;
}

export function tierForUrl(url) { return tierFor(domainOf(url)); }

/**
 * Tier 2 is reroute-only.
 *
 * The router must send these through resolve_ats.js and apply on whatever real
 * ATS the posting points at. If it doesn't resolve, the run is handed to the
 * user rather than attempted here. This is not a limitation we're working
 * around — an application submitted through the employer's own ATS is the one
 * the recruiter actually reads.
 */
export function isRerouteOnly(domain) { return TIER_2.has(domain); }

// ── budgets ─────────────────────────────────────────────────────────────────
// Conservative on purpose. Volume is the thing that actually matters, both for
// being a good citizen and for keeping an account uneventful.

const DEFAULTS = {
  0: { cap: 40, gap: [45_000, 180_000] },        // 45s – 3m
  1: { cap: 15, gap: [240_000, 720_000] },       // 4m – 12m
  2: { cap: 0,  gap: [0, 0] },                   // never applied natively
};

export function defaultCap(tier) { return DEFAULTS[tier].cap; }

/**
 * How long to wait before the next application on this domain.
 *
 * Randomised inside the tier's window rather than a fixed interval — a fixed
 * interval would mean a queue of 40 arrives as a metronome, which is both
 * ruder and more fragile than spreading it out.
 */
export function nextGapMs(tier) {
  const [lo, hi] = DEFAULTS[tier].gap;
  return Math.round(lo + Math.random() * (hi - lo));
}

// A domain that blocks us twice gets a much longer rest — the second block
// means the first was not a fluke, and the answer to that is to back further
// off, not to try harder.
const QUARANTINE_MS = 24 * 60 * 60 * 1000;
const REPEAT_QUARANTINE_MS = 72 * 60 * 60 * 1000;
const FAILURES_BEFORE_QUARANTINE = 3;

// ── block-signal detection ──────────────────────────────────────────────────
// This is how we know to stop. Everything it matches ends a run.

const CHALLENGE_TEXT = [
  /verify (that )?you (are|'re) (a )?human/i,
  /unusual (activity|traffic)/i,
  /ungew(ö|oe)hnliche aktivit(ä|ae)t/i,
  /are you a robot/i,
  /checking your browser/i,
  /access denied/i,
  /zugriff verweigert/i,
  /rate limit(ed)?/i,
];

const CHALLENGE_MARKUP = [
  [/cf-challenge|__cf_chl|cf_chl_opt|cdn-cgi\/challenge/i, "cloudflare_challenge"],
  [/challenges\.cloudflare\.com\/turnstile/i, "cloudflare_turnstile"],
  [/captcha-delivery\.com|datadome/i, "datadome"],
  [/perimeterx|_pxhd|px-captcha/i, "perimeterx"],
  [/recaptcha\/api|hcaptcha\.com/i, "captcha"],
];

/**
 * Inspect a page observation for a "we're not welcome here" signal.
 * Returns a signal name, or null when the page looks like an ordinary form.
 *
 * `obs` is the serialised page state from apply_engine.js plus the
 * navigation's HTTP status where we have it.
 */
export function detectBlockSignal(obs = {}) {
  const { httpStatus, url = "", title = "", text = "", html = "" } = obs;

  if (httpStatus === 403) return "http_403";
  if (httpStatus === 429) return "http_429";
  if (httpStatus === 503 && /cloudflare/i.test(html)) return "cloudflare_503";

  for (const [re, name] of CHALLENGE_MARKUP) {
    if (re.test(html) || re.test(url)) return name;
  }
  // Title and body text separately: a challenge page usually renders almost no
  // body content, so the title is often the only thing there is to match on.
  const haystack = `${title}\n${text}`.slice(0, 4000);
  for (const re of CHALLENGE_TEXT) {
    if (re.test(haystack)) return "challenge_text";
  }
  return null;
}

// ── state transitions ───────────────────────────────────────────────────────

function nextResetAt() {
  // Early tomorrow morning. Spread across a window rather than exactly midnight
  // so a queue that's been waiting on the cap doesn't all fire at once.
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(6 + Math.floor(Math.random() * 3),
             Math.floor(Math.random() * 60), 0, 0);
  return d.toISOString();
}

async function row(domain) {
  const existing = await getDomainHealth(domain);
  if (existing) return existing;
  const tier = tierFor(domain);
  return upsertDomainHealth(domain, {
    state: "healthy", tier, daily_cap: defaultCap(tier),
    applied_today: 0, consecutive_failures: 0,
    day_resets_at: nextResetAt(),
  });
}

/** Roll the daily counter over if its window has passed. */
async function rollDay(h) {
  if (!h.day_resets_at || new Date(h.day_resets_at) > new Date()) return h;
  return upsertDomainHealth(h.domain, {
    applied_today: 0, day_resets_at: nextResetAt(),
  });
}

/**
 * May we attempt this domain right now?
 *
 *   { ok: true, health }
 *   { ok: false, reason, retryAt? }
 *
 * The router calls this per domain and moves straight on to the next domain
 * when the answer is no. Nothing here can stall the queue as a whole — that
 * separation is the isolation guarantee, and it is worth keeping intact.
 */
export async function canRun(domain) {
  if (isRerouteOnly(domain)) {
    return { ok: false, reason: "reroute_only",
             hint: "resolve to the employer's ATS, or hand to the user" };
  }

  let h = await rollDay(await row(domain));
  const now = Date.now();

  if (h.state === "quarantined") {
    const until = h.quarantined_until ? new Date(h.quarantined_until).getTime() : 0;
    if (until > now) {
      return { ok: false, reason: `quarantined (${h.last_signal || "unknown"})`,
               retryAt: h.quarantined_until };
    }
    // Cooled off. Come back at half throttle and prove it with clean runs
    // before returning to full speed.
    h = await upsertDomainHealth(domain, {
      state: "degraded", quarantined_until: null, consecutive_failures: 0,
      daily_cap: Math.max(1, Math.floor(defaultCap(h.tier) / 2)),
    });
  }

  if (h.applied_today >= h.daily_cap) {
    return { ok: false, reason: `daily cap reached (${h.applied_today}/${h.daily_cap})`,
             retryAt: h.day_resets_at };
  }

  if (h.last_applied_at) {
    const gap = nextGapMs(h.tier);
    const elapsed = now - new Date(h.last_applied_at).getTime();
    if (elapsed < gap) {
      return { ok: false, reason: "pacing",
               retryAt: new Date(now + (gap - elapsed)).toISOString() };
    }
  }
  return { ok: true, health: h };
}

/** A run finished cleanly. Walk the domain back toward healthy. */
export async function recordSuccess(domain) {
  const h = await row(domain);
  const patch = {
    consecutive_failures: 0,
    applied_today: (h.applied_today || 0) + 1,
    last_applied_at: new Date().toISOString(),
  };
  // A full clean day at half throttle earns full speed back.
  if (h.state === "degraded" && (h.applied_today || 0) + 1 >= h.daily_cap) {
    patch.state = "healthy";
    patch.daily_cap = defaultCap(h.tier);
  }
  return upsertDomainHealth(domain, patch);
}

/**
 * We were told to stop. Quarantine this domain — and only this domain.
 *
 * Called the moment detectBlockSignal fires. The run is abandoned. We do not
 * retry, do not back off and try again inside the same session, and do not go
 * anywhere near the challenge itself. If a site has put up a bot check, the
 * correct response is to leave.
 */
export async function recordBlock(domain, signal) {
  const h = await row(domain);
  const repeat = h.state === "quarantined" || h.state === "degraded";
  return upsertDomainHealth(domain, {
    state: "quarantined",
    last_signal: signal,
    last_signal_at: new Date().toISOString(),
    quarantined_until: new Date(
      Date.now() + (repeat ? REPEAT_QUARANTINE_MS : QUARANTINE_MS)).toISOString(),
    consecutive_failures: (h.consecutive_failures || 0) + 1,
  });
}

/**
 * Failures that are OURS, not the site's.
 *
 * The breaker exists to answer one question: is this site pushing back on us?
 * Three strikes and the domain rests for a day — the right response to a
 * captcha or a rate limit, and completely the wrong response to a bug on our
 * side.
 *
 * That distinction was missing and it cost a real day of LinkedIn. A missing
 * host permission failed three runs in a row, and the breaker read our own
 * misconfiguration as LinkedIn blocking us. Nothing the user could have done
 * would have made a 24-hour quarantine the correct call there.
 *
 * These are still recorded — the reason shows in the dashboard — but they do
 * not count toward the breaker. Anything NOT on this list counts, which is the
 * safe default: over-counting rests a domain that was fine, under-counting
 * keeps hammering one that is actively blocking us.
 */
const OUR_FAULT = [
  /couldn't inject/i,              // missing host permission, or an untouchable page
  /cannot access contents/i,
  /must request permission/i,
  // The friendly version of the same thing, raised by ensureEngine once it has
  // confirmed with chrome.permissions that the grant is what's missing. Listed
  // separately because it shares no wording with Chrome's own message — and it
  // is the one users will hit most, so leaving it out would have left the
  // original bug in place behind a nicer error string.
  /one extra permission|auto-apply on all sites/i,
  // host_access.js's current wording, which shares no phrase with the line
  // above. A list of strings drifts every time a message is reworded, which is
  // why runApply now also attributes failures structurally — see
  // `contactedDomain` there. This stays as the second line of defence.
  /access to sites outside the job boards/i,
  /the tab was closed/i,           // the user stopped the run, or closed the tab
  /hasn't been tailored yet/i,     // the packet is missing on our side
  /allowance|quota_exceeded/i,     // out of budget; nothing to do with the site
  /not_signed_in/i,
  /claude call failed|ai-proxy|upstream_unreachable/i,
  /took too long/i,                // our step budget, not their server
  /gave up after \d+ steps/i,
  /stopped without choosing an action/i,
  /cut short at \d+ tokens/i,
];

export function isOurFault(reason) {
  const text = String(reason || "");
  return OUR_FAULT.some((re) => re.test(text));
}

/**
 * An ordinary failure — timeout, unexpected DOM, the agent gave up.
 *
 * Not a block, but three in a row on one domain usually means something
 * changed there that we can't see. Better to stand down than grind the rest of
 * the queue through the same wall.
 */
export async function recordFailure(domain, reason) {
  const h = await row(domain);
  const patch = {
    last_signal: reason ? String(reason).slice(0, 200) : null,
    last_signal_at: new Date().toISOString(),
  };

  // Our bug, our problem. Log it against the domain so it stays visible, but
  // leave the strike count alone: a run that failed because we forgot a
  // permission says nothing about whether the site wants us there.
  if (isOurFault(reason)) return upsertDomainHealth(domain, patch);

  const n = (h.consecutive_failures || 0) + 1;
  if (n >= FAILURES_BEFORE_QUARANTINE) return recordBlock(domain, "consecutive_failures");
  return upsertDomainHealth(domain, { ...patch, consecutive_failures: n });
}

/**
 * Lift a quarantine by hand.
 *
 * The breaker is deliberately cautious and will sometimes be wrong. A user who
 * knows why it tripped — they granted the permission, they closed the tab
 * themselves — should not have to wait out a day they know is unnecessary.
 *
 * Comes back at half throttle rather than full speed, exactly like a quarantine
 * that expired on its own, so that clicking Resume on a site that really is
 * unhappy does not immediately hammer it again.
 */
export async function resumeDomain(domain) {
  const h = await row(domain);
  return upsertDomainHealth(domain, {
    state: "degraded",
    quarantined_until: null,
    consecutive_failures: 0,
    daily_cap: Math.max(1, Math.floor(defaultCap(h.tier) / 2)),
    last_signal: "resumed by you",
    last_signal_at: new Date().toISOString(),
  });
}

/** For the dashboard's health strip. */
export async function healthSummary() {
  const rows = (await allDomainHealth()) || [];
  return rows.map((h) => ({
    domain: h.domain,
    tier: h.tier,
    state: h.state,
    used: h.applied_today,
    cap: h.daily_cap,
    signal: h.last_signal,
    retryAt: h.quarantined_until,
  }));
}
