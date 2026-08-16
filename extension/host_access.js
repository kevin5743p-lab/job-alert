// host_access.js — whether we are actually allowed to touch a page.
//
// THE PROBLEM THIS EXISTS FOR
//
// The manifest names every job board we know about. An employer's own careers
// site can be any domain in the world, which is what `optional_host_permissions`
// is for — but an optional permission is worth nothing until it has been asked
// for, and Chrome will only let it be asked for from a user gesture on an
// extension page. The worker cannot ask mid-run.
//
// So the old flow was: queue the job, render the CV and cover letter to PDF,
// open the posting, click through to the employer's site, try to inject — fail.
// Then tell the user to go and find a checkbox in Settings and start again. All
// of the work, every time, to arrive at a question that could have been asked
// before any of it.
//
// The rule here is: find out first, ask where the user already is, and never
// spend a run discovering something `permissions.contains` would have said
// instantly.
//
// WHY BOTH SCHEMES
//
// A surprising number of German careers sites (and most of the smaller Bewerber
// portals) are still served over plain http, or redirect through it. Asking for
// https alone meant those failed exactly like a missing grant, with a message
// telling the user to enable something they had already enabled.

export const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };

/**
 * The origin pattern covering one URL, or null when the URL is not a page we
 * could ever inject into (chrome://, about:, file://, a PDF viewer).
 */
export function originPatternFor(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return `${u.protocol}//${u.hostname}/*`;
}

/** Have we been granted the run-anywhere permission? */
export async function hasAllSites() {
  try { return await chrome.permissions.contains(ALL_SITES); }
  catch { return false; }
}

/**
 * Can we inject into this specific URL right now?
 *
 * Answers for static manifest grants and optional ones alike — `contains` does
 * not distinguish, which is exactly what a caller wants to know. Returns
 * { ok, reason, origin }.
 */
export async function canReach(url) {
  const origin = originPatternFor(url);
  if (!origin) {
    return { ok: false, origin: null, reason: "unsupported_scheme" };
  }
  try {
    const ok = await chrome.permissions.contains({ origins: [origin] });
    return { ok, origin, reason: ok ? null : "not_granted" };
  } catch (e) {
    // Older Chrome, or a malformed pattern. Assume reachable rather than
    // blocking a run on a permissions API quirk — the injection itself will
    // fail loudly enough if we are actually wrong.
    return { ok: true, origin, reason: null, uncertain: e.message };
  }
}

/**
 * Ask for the run-anywhere grant. MUST be called synchronously inside a click
 * handler on an extension page — from the worker, or after an await in a
 * handler, Chrome rejects it as gesture-less.
 */
export async function requestAllSites() {
  return chrome.permissions.request(ALL_SITES);
}

/** Ask for just the one site. Same gesture rule. */
export async function requestOrigin(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  return chrome.permissions.request({ origins: [origin] });
}

/**
 * The message a run pauses with when the grant is what's missing.
 *
 * Kept here rather than written inline at the throw site so pause_help.js can
 * match on it, and so the wording only exists once.
 */
export const NEEDS_GRANT =
  "This application is hosted on the employer's own site, and the extension " +
  "hasn't been given access to sites outside the job boards yet. It's one " +
  "click, and it only has to be done once.";
