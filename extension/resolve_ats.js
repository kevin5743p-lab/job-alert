// resolve_ats.js — find the employer's own application page.
//
// Aggregator postings (Indeed, StepStone, Xing) are never applied to directly.
// Almost all of them are "Apply on company site" anyway — the listing is a
// pointer to a Greenhouse/Ashby/Lever/SmartRecruiters posting that the employer
// actually owns. This module finds that posting, and the engine applies there.
//
// That is the better application on its own terms, aside from anything else:
// it lands in the ATS the recruiter reads, it carries the real attachments
// rather than an aggregator's re-hosted copy, and it does not depend on a
// third party's apply flow staying the same from one week to the next.
//
// TWO ROUTES, IN ORDER
//
//   1. The public board APIs. Greenhouse, Ashby, Lever and SmartRecruiters all
//      publish a company's open roles as JSON, and those endpoints are already
//      in host_permissions because the finder uses them. We ask them by company
//      and match on title — the aggregator is never loaded at all.
//
//   2. Structured data on the posting itself. Every one of these boards emits a
//      schema.org JobPosting; where it names an external application URL, that
//      is the employer's page. Only used when the posting is already open in
//      front of the user.
//
// No match by either route means the user is told, with a one-click open. It
// does not mean trying harder.

import { domainOf } from "./supabase.js";

/** Hosts we know how to apply on. A resolution that lands elsewhere is no use. */
const ATS_HOSTS = [
  "greenhouse.io", "ashbyhq.com", "lever.co", "smartrecruiters.com",
  "personio.de", "recruitee.com", "workable.com", "teamtailor.com",
  "join.com", "softgarden.io", "softgarden.de", "factorialhr.com",
  "myworkdayjobs.com", "myworkdaysite.com", "successfactors.eu",
  "successfactors.com", "icims.com", "avature.net", "jobvite.com",
  "taleo.net", "eightfold.ai", "bamboohr.com", "concludis.de",
  "d-vinci.de", "rexx-systems.com",
];

export function isApplyableHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ATS_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
  } catch { return false; }
}

// ── title matching ──────────────────────────────────────────────────────────

const STOP = new Set(["m", "w", "d", "f", "x", "the", "a", "an", "and", "or",
                      "of", "in", "at", "für", "und", "der", "die", "das"]);

const titleTokens = (s) => String(s || "").toLowerCase()
  .replace(/\((?:m|w|d|f|x)[\/\s|]*(?:m|w|d|f|x)?[\/\s|]*(?:m|w|d|f|x)?\)/g, " ")
  .replace(/[^a-z0-9äöüß+#\s]/g, " ")
  .split(/\s+/).filter((t) => t && !STOP.has(t));

/**
 * How closely do two job titles match?
 *
 * Titles are never identical across boards — an aggregator appends the city,
 * the employer appends "(m/w/d)", one says "Senior" and the other "Sr.". What
 * stays constant is the content words, so this scores overlap against the
 * shorter title and leaves the threshold to the caller.
 */
export function titleSimilarity(a, b) {
  const ta = titleTokens(a), tb = new Set(titleTokens(b));
  if (!ta.length || !tb.size) return 0;
  const hits = ta.filter((t) => tb.has(t)).length;
  return hits / Math.min(ta.length, tb.size);
}

const MATCH_THRESHOLD = 0.7;

// ── company slug guessing ───────────────────────────────────────────────────

/** Board tokens are a slug of the company name, with a handful of shapes. */
function slugCandidates(company) {
  const base = String(company || "").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(gmbh|ag|se|inc|llc|ltd|limited|co|kg|mbh|bv|nv|sa|srl|oy|ab)\b/g, " ")
    .replace(/&/g, " and ")
    .trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  return [...new Set([
    words.join(""),          // acmecorp
    words.join("-"),         // acme-corp
    words[0],                // acme
  ])];
}

// ── route 1: the public board APIs ──────────────────────────────────────────

const BOARDS = [
  {
    name: "greenhouse",
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    jobs: (d) => (d.jobs || []).map((j) => ({ title: j.title, url: j.absolute_url })),
  },
  {
    name: "ashby",
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    jobs: (d) => (d.jobs || []).map((j) => ({ title: j.title, url: j.jobUrl || j.applyUrl })),
  },
  {
    name: "lever",
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    jobs: (d) => (Array.isArray(d) ? d : []).map((j) => ({ title: j.text, url: j.hostedUrl })),
  },
  {
    name: "smartrecruiters",
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings`,
    jobs: (d) => (d.content || []).map((j) => ({
      title: j.name,
      url: j.ref || `https://jobs.smartrecruiters.com/${j.company?.identifier}/${j.id}`,
    })),
  },
];

async function tryBoard(board, slug, wantedTitle) {
  const resp = await fetch(board.url(slug), { credentials: "omit" }).catch(() => null);
  if (!resp?.ok) return null;
  const data = await resp.json().catch(() => null);
  if (!data) return null;

  let best = null;
  for (const j of board.jobs(data)) {
    if (!j.url || !j.title) continue;
    const score = titleSimilarity(wantedTitle, j.title);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { url: j.url, title: j.title, score };
    }
  }
  return best ? { ...best, source: `${board.name}:${slug}` } : null;
}

/**
 * Look the posting up on the employer's own board.
 *
 * Tries a handful of slug shapes across four ATSes. Requests go straight to the
 * board's public API — the aggregator is never contacted, so this works even
 * when its domain is quarantined.
 */
export async function resolveViaBoardApi(job) {
  const slugs = slugCandidates(job.company);
  if (!slugs.length || !job.title) return null;

  for (const slug of slugs) {
    const results = await Promise.all(
      BOARDS.map((b) => tryBoard(b, slug, job.title).catch(() => null)));
    const hit = results.filter(Boolean).sort((a, b) => b.score - a.score)[0];
    if (hit) return hit;
  }
  return null;
}

// ── route 2: structured data on the posting ─────────────────────────────────

/**
 * Pull an external application URL out of a posting's schema.org JobPosting.
 *
 * `html` is the page source — supplied by the content script when the user
 * already has the posting open. We only trust a URL that lands on a host we
 * know how to apply on; an aggregator's own tracking redirect is not a result.
 */
export function extractApplyUrl(html) {
  const scripts = String(html || "")
    .match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const block of scripts) {
    const json = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let data;
    try { data = JSON.parse(json); } catch { continue; }

    for (const node of flatten(data)) {
      if (node?.["@type"] !== "JobPosting") continue;
      const candidates = [
        node.applyUrl,
        node.url,
        node.hiringOrganization?.sameAs,
        node.potentialAction?.target?.urlTemplate,
        node.potentialAction?.target,
      ].filter((v) => typeof v === "string");
      for (const url of candidates) if (isApplyableHost(url)) return url;
    }
  }
  return null;
}

function flatten(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === "object") {
    out.push(node);
    if (node["@graph"]) flatten(node["@graph"], out);
  }
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Where should we actually apply for this job?
 *
 *   { url, source, title? }   apply here instead
 *   null                      hand it to the user
 *
 * `pageHtml` is optional and only present when the posting happens to be open.
 */
export async function resolve(job, { pageHtml = null } = {}) {
  // Already on a board we can apply to — nothing to resolve.
  if (isApplyableHost(job.url)) {
    return { url: job.url, source: "direct", title: job.title };
  }

  const viaApi = await resolveViaBoardApi(job).catch(() => null);
  if (viaApi) return viaApi;

  if (pageHtml) {
    const url = extractApplyUrl(pageHtml);
    if (url) return { url, source: "jsonld", title: job.title };
  }
  return null;
}

/** Convenience for the router: the domain a resolution will run against. */
export function resolvedDomain(resolution) {
  return resolution ? domainOf(resolution.url) : null;
}
