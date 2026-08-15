// job_key.js — a stable identity for a posting that survives the site change.
//
// THE PROBLEM
//
// The same job has more than one URL. A candidate finds it on LinkedIn, tailors
// a CV there, clicks Apply, and lands on the employer's Greenhouse page — a
// different URL for the same role. Keying saved work on the URL alone means the
// system treats that as a brand-new job: it pays to tailor a second time, and
// the apply engine, which looks up the packet by the rerouted URL, finds
// nothing and refuses to start on a job the user already prepared.
//
// THE APPROACH
//
// Derive a key from the two things that stay the same across sites: the company
// and the role title. Neither is a database id, so this is deliberately a
// *hint*, not an identity guarantee — callers try the exact URL first and fall
// back to this. That ordering matters: a URL match is always right, whereas a
// key match is a judgement call about two strings.
//
// Normalisation is kept conservative on purpose. Every rule that strips more
// text raises the chance of merging two genuinely different roles ("Data
// Engineer" and "Senior Data Engineer" are not the same job), and a wrong merge
// is worse than a missed one: a missed match costs a few cents to re-tailor,
// while a wrong match sends a CV written for another role to an employer.
//
// Pure functions, no chrome.* and no imports, so both the worker and the
// Supabase layer can use it and it stays testable on its own.

// German postings almost always carry a gender marker in the title, and which
// variant appears differs between the aggregator and the employer's own board:
// "(m/w/d)", "(w/m/x)", "(all genders)", "(d/m/w)". Same role either way.
const GENDER_MARKERS = [
  /\(\s*[mwfdxagn](?:\s*[\/|,·]\s*[mwfdxagn])+\s*\)/gi, // (m/w/d), (f/m/x), (w|m|d)
  /\(\s*all\s+genders?\s*\)/gi,
  /\(\s*divers?\s*\)/gi,
  /\(\s*gn\s*\)/gi,
  /\bm\s*\/\s*w\s*\/\s*[dx]\b/gi, // the same thing without brackets
];

// Applicant-tracking systems tack their own requisition number onto the title;
// the aggregator's copy usually doesn't have it. "(JR0091234)", "Req 55812".
const REQ_IDS = [
  /\(?\b(?:job|jobs|req|requisition|jr|id|ref)[-_\s#]*\d{3,}\)?/gi,
  /\(\s*\d{4,}\s*\)/g,
];

// Legal form and group suffixes vary by which entity posted the ad — "BMW AG"
// on the careers site, "BMW Group" on LinkedIn. Stripped from the company only,
// never from the title, where a word like "Group" can be part of the role.
const COMPANY_SUFFIXES =
  /\b(?:gmbh\s*&\s*co\.?\s*kga?|gmbh|mbh|ag|se|kgaa|kg|ohg|gbr|e\.?\s?v|inc|llc|ltd|limited|plc|corp|corporation|company|co|bv|nv|s\.?a|s\.?r\.?l|oy|ab|as|group|holding|deutschland|germany|international|global)\b/gi;

/** Lowercase, strip punctuation, collapse whitespace. The shared final step. */
function flatten(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")           // é → e + combining accent, so ü and u agree
    .replace(/[\u0300-\u036f]/g, "") // then drop the combining accents
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(title) {
  let t = String(title || "");
  for (const re of GENDER_MARKERS) t = t.replace(re, " ");
  for (const re of REQ_IDS) t = t.replace(re, " ");
  return flatten(t);
}

export function normalizeCompany(company) {
  // Suffixes are stripped after flattening so "Co. KG" and "co kg" behave the
  // same, and repeatedly, because "GmbH & Co. KG" leaves a trailing "kg".
  let c = flatten(company);
  let prev;
  do {
    prev = c;
    c = c.replace(COMPANY_SUFFIXES, " ").replace(/\s+/g, " ").trim();
  } while (c !== prev && c.length);
  return c;
}

/**
 * A cross-site key for a posting, or null when there isn't enough to be safe.
 *
 * Returns null rather than a weak key whenever company or title is missing or
 * too short to be distinctive. A null key simply means "no cross-site match
 * available" and the caller falls back to URL matching — which is the old
 * behaviour, so a null is never worse than not having this function at all.
 * A key built from "" would match every other empty-keyed row, which is how
 * you send the wrong CV to an employer.
 */
export function jobKey(job) {
  const company = normalizeCompany(job?.company);
  const title = normalizeTitle(job?.title);

  if (company.length < 2) return null;
  if (title.length < 4) return null;

  return `${company}|${title}`;
}
