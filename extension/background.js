// background.js — service worker (MV3 module).
//
// Holds the network + secrets boundary: the Groq API key and CV live in
// chrome.storage.local (this machine only) and the actual Groq call happens
// here, not in the content script — so the page's CSP can't block it and the
// key never touches the page context.

import { buildPrompt, buildAnswersPrompt, buildFieldMapPrompt, buildFieldFillPrompt,
         buildSearchProfilePrompt, buildBatchScorePrompt, buildSingleScorePrompt, normalize,
         groundingWarnings, cvGroundingWarnings, DEFAULT_MODEL, MAX_TOKENS }
         from "./tailor_core.js";
import * as sb from "./supabase.js";
import { fetchAll, prefilter, prioritise, locationRank, validateTargets,
         pickKnownBoards, enrichDescriptions } from "./finder.js";
import { ruleScore, classifyWithRules, getDomain, applyDomainCap, candidateFamilies,
         isOffProfession, buildMemory, matchesRejectedPattern } from "./matcher.js";

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
// Postings per Groq call. Dropped from 5 to 3 when the batch prompt went from
// 1200 characters per posting to 2500, so that the tail of a scan is judged on
// the same text as the top of it. Smaller batches are what make that affordable:
// at 5 postings the batch pass would have gone from ~71k to ~118k characters a
// minute, and this is the pass that once scored 8 of 80 and then hit a rate
// limit. At 3 it is ~78k — about a tenth more than today, rather than two
// thirds. The honest caveat is that the limit itself is inferred from that one
// failure, not measured; if scans start truncating, this constant is the dial.
//
// It is not free: the pass makes 19 calls instead of 11, so a full scan spends
// roughly 70 seconds longer and about twice the daily tokens.
const SCORE_BATCH = 3;
// How many postings the model judges per scan. The free tier's real ceiling is
// tokens per minute, so scoring is paced rather than fired as fast as it can go:
// the top INDIVIDUAL_SCORED go one at a time, 4s apart, and the rest in batches
// of SCORE_BATCH, 9s apart. At 120 that is about six minutes of pacing, against
// three and a half at 70 — the bulk of a scan either way.
//
// This used to say the cap decides only how fast the backlog is worked through
// and not what is eventually seen, because scored_jobs makes each scan take the
// next slice rather than re-rolling the same pool. That is true of the employer
// boards and Adzuna, which re-serve their whole list within the user's job-age
// setting, so a posting cut at the cap comes back next scan.
//
// It is NOT true of LinkedIn. LinkedIn is asked only for the incremental window
// — two hours on a normal run — so a posting dropped for placing 71st is never
// offered again. For the largest source in a scan, the cap is a permanent miss,
// not a deferral. That is what 120 buys, and why the cost is worth paying.
const MAX_SCORED = 120;
const SCORE_PACE_MS = 9000;
// Per-posting descriptions cost one request each, so they're capped, and the
// sources that need them share the cap. Well above MAX_SCORED: a posting has to
// be graded before it can be ranked, and grading it without its text is what
// this budget exists to stop.
//
// Raised from 80 because 80 was only a little above MAX_SCORED (70), and any
// scan that went past it handed the overflow to the scorer with no description
// — the title-only bug, back again and silent. The cost is time and nothing
// else: 120 more postings at DETAIL_PAUSE_MS is about 40 seconds on a scan that
// actually needs them, and scans that don't are unaffected. Kevin's call, on
// the grounds that scan length doesn't matter to him and bad matches do.
const DETAIL_BUDGET = 200;
// The rule score a posting needs before it's worth spending a model call on.
// Matches prefilter_min_score in the bot's profile.yaml.
const PREFILTER_MIN_SCORE = 15;

// The country the search runs across. LinkedIn wants an English country name
// and treats anything it doesn't recognise as no filter at all, so the handful
// of ways people write their own country are normalised rather than passed
// through. A country that isn't listed is sent as typed; Germany is the default
// because everything downstream — isReachable, GERMAN_HINTS, the German
// fluency filter — is written for a German search.
const COUNTRY_NAMES = [
  ["Germany", ["germany", "deutschland", "de", "deu", "ger"]],
  ["Austria", ["austria", "österreich", "oesterreich", "at", "aut"]],
  ["Switzerland", ["switzerland", "schweiz", "suisse", "svizzera", "ch", "che"]],
  ["Netherlands", ["netherlands", "nederland", "holland", "nl", "nld"]],
  ["France", ["france", "frankreich", "fr", "fra"]],
];

// How much German the user actually has, from the "Languages & levels" answer
// they gave during onboarding ("English C1, German B1").
//
// This used to be the model's call, re-guessed from the CV on every profile
// rebuild, and it kept landing on "any" — which switches the fluency filter off
// completely and silently. A setting that decides whether German-only postings
// are filtered should not be re-derived by a model that never sees the user's
// own statement of their level; the onboarding answer does, and it survives
// rebuilds because it lives in application_profile rather than search_profile.
//
// "english_only" is never chosen automatically. In Germany it would reject
// almost every posting, and that is a choice for the user to make, not a
// default to be inferred.
// The answer is a list — "English C1, German B1, Hindi native" — so it's split
// into its entries and only the German one is read. Scanning the whole string
// for a level near the word "German" looks simpler and is wrong: in "German
// native, English B2" it finds English's B2.
const GERMAN_NAME_RE = /deutsch|german/i;
const FLUENT_RE =
  /\bc1\b|\bc2\b|native|muttersprache|mother ?tongue|fluent|flie(?:ß|ss)end|verhandlungssicher|bilingual/i;

export function germanPolicy(languages) {
  const answer = String(languages || "").trim();
  // Unanswered is not the same as "no German". Someone who never filled the
  // onboarding box — a native speaker most of all — would otherwise have every
  // posting that asks for fluent German quietly removed, which is the exact
  // opposite of what they need. An empty answer filters nothing; only a stated
  // level below C1, or a list of languages that doesn't include German, does.
  if (!answer) return "any";

  for (const entry of answer.split(/[,;\n\/|]|\band\b|\bund\b/i)) {
    if (!GERMAN_NAME_RE.test(entry)) continue;
    return FLUENT_RE.test(entry) ? "any" : "no_german_required";
  }
  // No German claimed at all, or claimed below C1: postings that demand fluent
  // German are not worth showing.
  return "no_german_required";
}

// Optional, and kept on this machine only — same rule as the Groq key, which is
// why it isn't in the Supabase profile. Absent means Adzuna is simply skipped.
// How far back a scan looks. Kept with the other local settings rather than in
// the search profile, so changing it takes effect on the next scan instead of
// waiting for the profile to be rebuilt.
// "2 hours", "3 days" — for the progress line, so the window a scan chose is
// visible rather than implied.
function humanGap(days) {
  const mins = Math.round(days * 24 * 60);
  if (mins < 90) return `${Math.max(1, mins)} min`;
  const hours = Math.round(days * 24);
  return hours < 48 ? `${hours} h` : `${Math.round(days)} days`;
}

async function maxJobAgeDays() {
  const { maxJobAge } = await chrome.storage.local.get("maxJobAge");
  const n = Number(maxJobAge);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

async function adzunaCreds() {
  const { adzunaAppId, adzunaAppKey } =
    await chrome.storage.local.get(["adzunaAppId", "adzunaAppKey"]);
  return { appId: adzunaAppId || "", appKey: adzunaAppKey || "" };
}

function searchCountry(country) {
  const c = String(country || "").trim().toLowerCase();
  if (!c) return "Germany";
  for (const [name, aliases] of COUNTRY_NAMES) if (aliases.includes(c)) return name;
  return String(country).trim();
}
// How many get the careful, one-at-a-time treatment before the rest are
// batched. Individual calls cost more but judge far better, so they go to the
// postings the rules already rated highest.
const INDIVIDUAL_SCORED = 15;
const SINGLE_PACE_MS = 4000;
// Scoring follows the user's chosen model.
//
// It used to be pinned to the small fast one, because a scan put seventy
// postings through it and the large model's daily budget went in a single run.
// Incremental scanning removed that: a scan now judges ten to forty, and the
// arithmetic that justified the small model no longer holds.
//
// The evidence that it mattered is in the stored reasons. The 8b model rejected
// "BERECHNUNGSINGENIEUR FEM" as "a different profession (marketing)" — with FEM
// on the candidate's CV — and had scored the same kind of role 85 an hour
// earlier. Around eight of twenty-seven rejections in one scan were plainly
// wrong, always confidently phrased. A cheap wrong answer is not cheap: it
// throws away a job the candidate would have wanted, silently.
//
// Anyone who does hit a quota can still pick the 8b model in the popup.
function scoringModel(userModel) {
  return userModel || DEFAULT_MODEL;
}

// An MV3 service worker is shut down after ~30 seconds without an extension
// API call, and a scan now spends much longer than that inside fetch() —
// LinkedIn paging, per-posting descriptions, employer boards. Being torn down
// mid-scan loses the run silently. Calling an extension API on a timer resets
// that countdown, which is the documented way to hold a worker open for a long
// job. Started only for the duration of a scan: an always-on keepalive would
// defeat the point of the worker sleeping at all.
const keepAlive = {
  timer: null,
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  },
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },
};

function progress(text, done = false, extra = {}) {
  chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", text, done, ...extra })
    .catch(() => {});          // nobody listening (dashboard closed) is fine
}

// A cheap fingerprint of the CV the search profile was built from. Without it a
// changed CV keeps the old profile and the scan hunts the previous field
// entirely — swap in a different person's CV and it still searches for yours.
function cvFingerprint(cv) {
  const text = (cv || "").replace(/\s+/g, " ").trim();
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

async function ensureSearchProfile(cv, apiKey, model, force) {
  const profile = await sb.getProfile();
  const existing = profile && profile.search_profile;
  const fingerprint = cvFingerprint(cv);
  const cvChanged = existing && existing.cv_fingerprint
    && existing.cv_fingerprint !== fingerprint;
  if (cvChanged) {
    progress("Your CV has changed — working out the search again…");
  }
  // `validated` marks a profile whose employer boards were probed. Profiles
  // built before that check existed are rebuilt once, otherwise they keep
  // scanning boards that don't resolve and quietly return nothing.
  // A profile with no boards left is not usable — it can only ever scan the
  // generic feed. Rebuilding is cheap next to a scan that finds nothing.
  // A profile without a domain block predates the grading rules and would be
  // graded on keywords alone — which is how plainly off-field work reached the
  // tracker. Rebuild those rather than let them keep scanning blind.
  const usable = existing
    && !cvChanged
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
  sp.cv_fingerprint = fingerprint;
  progress(`${sp.company_targets.length} of ${candidates.length} suggested boards are live.`);

  await sb.saveSearchProfile(sp);
  // Flagged so the scan can tell the user that anything already in the tracker
  // was found for the previous CV and no longer reflects what they're after.
  sp.rebuiltFromNewCv = Boolean(cvChanged);
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
        apiKey, scoringModel(model), 300);
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
        apiKey, scoringModel(model), 1600);
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

// Which build the worker is running. An open dashboard tab keeps running the
// code it was loaded with, so after the extension is reloaded or updated the
// page is a different version from the worker answering it — and the symptom is
// a dead message port rather than anything that names the cause.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "PING") return;
  sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
  return false;                 // answered synchronously; nothing to keep open
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "FIND_JOBS") return;
  runScan(msg, sendResponse);
  return true;
});

// The scan itself, callable from the dashboard button and from the timer.
// sendResponse defaults to a no-op: a scheduled run has nobody waiting on a
// reply, and everything it reports goes over SCAN_PROGRESS anyway.
async function runScan(msg = {}, sendResponse = () => {}) {
  {
    let acked = false;
    // Answer the dashboard as soon as the quick checks pass, and report
    // everything after that over SCAN_PROGRESS instead.
    //
    // A scan runs for minutes. Holding the sendResponse channel open for the
    // whole of it is what produced "the message channel closed before a
    // response was received": Chrome tears the channel down long before the
    // scan finishes, the dashboard's await rejects, and it shows "Scan failed"
    // for a scan that is still running perfectly well and will go on to save
    // its results. The only thing the channel is needed for is the three
    // setup errors below, which are decided in milliseconds.
    const ack = (payload) => { if (!acked) { acked = true; sendResponse(payload); } };

    try {
      const { groqApiKey, cv, lang, model } = await loadKeyAndCv();
      if (!(await sb.getSession())) throw new Error("NOT_SIGNED_IN");
      ack({ ok: true, started: true });
      keepAlive.start();

      const sp = await ensureSearchProfile(cv, groqApiKey, model, msg.rebuildProfile);

      // Where they live, so a role on another continent isn't scored as a
      // great match. These boards are international; most postings aren't local.
      const prof = await sb.getProfile();
      const ap = (prof && prof.application_profile) || {};
      const baseLocation = [ap.city, ap.country].filter(Boolean).join(", ");

      // Applied per scan rather than baked into the stored profile, so editing
      // the onboarding answer takes effect on the next scan instead of waiting
      // for a CV change to trigger a rebuild.
      sp.language_preference = germanPolicy(ap.languages);

      // How far back to look. Two limits, and the tighter one wins: the user's
      // "Job age" setting is a ceiling on how old a posting may be, and the gap
      // since the last successful scan is how much ground is actually new.
      //
      // Asking for a fixed two hours would be wrong — a browser closed for three
      // days would search two hours and silently skip the rest. Asking "what has
      // appeared since I last looked" heals its own gaps, and a user who has
      // never scanned gets the full backfill from the same line of code.
      const sinceLast = await sb.scanWindowDays();
      const scanWindow = Math.min(await maxJobAgeDays(), sinceLast);
      progress(sinceLast >= sb.BACKFILL_DAYS
        ? `Looking back ${Math.round(scanWindow)} days…`
        : `Looking for anything new since your last scan (${humanGap(sinceLast)})…`);

      // A new CV means every past judgement was made about someone else's
      // experience, so the scoring memory has to go with it — otherwise the
      // postings that mattered most under the old CV are the very ones never
      // looked at again.
      if (sp.rebuiltFromNewCv) {
        try {
          await sb.clearScoredMemory();
          progress("Your CV changed — every posting will be judged again.");
        } catch (e) {
          console.warn("Couldn't clear scoring memory:", e);
        }
      }
      // Searching and ranking want different places. Ranking wants the city, so
      // a nearby role outranks a distant one. Searching must not: LinkedIn takes
      // the location as a hard filter, so asking it for "Ingolstadt, Germany"
      // means Munich, Stuttgart and Berlin are never fetched at all — they can't
      // be ranked low, they're simply absent. Search the country and let
      // locationRank sort out the distance afterwards.
      const searchRegion = searchCountry(ap.country);

      // Merge the code-side registry with the user's validated suggestions here,
      // so registry updates apply to everyone on their very next scan.
      const known = pickKnownBoards(sp);
      const seen = new Set(known.map((b) => `${b.ats}:${b.id}`));
      const boards = known.concat(
        (sp.company_targets || []).filter((c) => !seen.has(`${c.ats}:${c.id}`)));

      progress(`Scanning ${boards.length} employer boards + job feeds…`);
      const { jobs, stats } = await fetchAll(
        { ...sp, company_targets: boards, location: searchRegion, home_city: ap.city || "",
          adzuna: await adzunaCreds(),
          // How old a posting may be — the user's own setting, unchanged by
          // how recently they last scanned.
          max_age_days: await maxJobAgeDays(),
          // How far back to ask the sources that can filter server-side.
          search_window_days: scanWindow },
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
      let tracked = new Set();
      try {
        memory = buildMemory(await sb.getDecisionHistory());
        // Both halves of "already dealt with": what reached the tracker, and
        // what the scorer judged and turned down. Only the first used to be
        // remembered, so everything rejected was re-fetched and re-scored on
        // every scan, for ever, to the same answer.
        const [trackedUrls, scoredUrls] =
          await Promise.all([sb.getTrackedUrls(), sb.getScoredUrls()]);
        tracked = new Set([...trackedUrls, ...scoredUrls]);
      } catch (e) {
        console.warn("Couldn't read tracker history:", e);
      }

      const graded = [];
      let cutOffField = 0, cutRules = 0, cutMemory = 0, cutSeen = 0;

      // Grading happens in two passes because the description has to be there
      // before most of it means anything. First the cuts that need only the
      // title and the tracker.
      const contenders = [];
      for (const job of keyworded) {
        // Already graded on an earlier scan. Boards hand back their entire open
        // list every time, so without this most of the scoring budget — and most
        // of the tokens — would go on jobs that are already in the tracker.
        if (job.url && tracked.has(job.url)) { cutSeen++; continue; }
        if (isOffProfession(job.title, families)) { cutRules++; continue; }
        if (matchesRejectedPattern(job, memory)) { cutMemory++; continue; }
        contenders.push(job);
      }

      // LinkedIn search cards and SmartRecruiters list entries both carry no
      // body text, so until now the German filter, the domain classifier and
      // the model itself were all reading an empty description for every one of
      // them — LinkedIn being the largest source in a scan, and SmartRecruiters
      // being Bosch. Fetch the real text, for the postings still in the running
      // and in the order the budget is best spent.
      const reachable = prioritise(contenders, baseLocation);
      const enriched = await enrichDescriptions(
        reachable, DETAIL_BUDGET, (t) => progress(t));
      if (enriched.requested) {
        // Worth surfacing: if a source starts refusing these, its postings are
        // graded on titles again and the only visible symptom is worse matches.
        stats.push(`job text ${enriched.filled}/${enriched.fetched}` +
                   (enriched.requested > enriched.fetched
                     ? ` (${enriched.requested} wanted)` : ""));
      }

      // Second pass: everything that needed the description.
      let cutWeak = 0;
      for (const job of reachable) {
        const [rScore, rReason] = ruleScore(job, sp, families);
        if (rScore === 0) { cutRules++; continue; }        // language, seniority, off-field
        // The bot's prefilter_min_score. Only rejecting a hard zero meant a
        // posting matching one stray keyword and nothing else still took a place
        // in the scoring queue ahead of nothing at all — and there are always
        // more of those than there is budget.
        if (rScore < PREFILTER_MIN_SCORE) { cutWeak++; continue; }
        const [klass] = classifyWithRules(job, domain);
        if (klass === "out_of_domain") { cutOffField++; continue; }
        graded.push({ job, rScore, rReason, klass });
      }

      // Best rule score first, nearest first among equals. The sort used to be
      // done twice — by score, then immediately re-done by location — and the
      // second pass overwrote the first completely, so the postings that got
      // scored were the nearest ones rather than the best ones. Distance is a
      // tie-breaker here, not the ordering; anything unreachable was already
      // dropped by prioritise() further up.
      const rankOf = new Map(
        graded.map((g) => [g, locationRank(g.job, baseLocation)]));
      graded.sort((a, b) =>
        b.rScore - a.rScore || rankOf.get(a) - rankOf.get(b));

      const matched = graded.map((g) => g.job);
      const klassOf = new Map(graded.map((g) => [g.job.url || g.job.id, g.klass]));
      const survivors = matched.slice(0, MAX_SCORED);
      progress(`${matched.length} new & relevant (${cutSeen} already tracked, ` +
               `${cutRules} filtered, ${cutWeak} too weak, ${cutOffField} off-field` +
               `${cutMemory ? `, ${cutMemory} like ones you dismissed` : ""})` +
               ` — scoring the best ${survivors.length}…`);
      if (!survivors.length) {
        progress("No matching postings this time.", true, { added: 0, stats });
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
      // How many relevant postings this scan did not get to. Without it a run
      // that adds ten jobs looks the same whether there are four hundred left
      // or none, so a queue that is nearly drained is indistinguishable from a
      // tool that drips results forever — which is exactly how it felt.
      const queued = Math.max(0, matched.length - survivors.length);
      let funnel = `${jobs.length} found → ${matched.length} relevant → ` +
        `${scored.length} scored → ${keep.length} kept` +
        (queued ? ` · ${queued} still queued for the next scan`
                : " · nothing left queued");
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
      // Remember everything judged, not just what was kept — that is the whole
      // point. Never fatal: a scan that found jobs must not be reported as
      // failed because the memory write didn't land.
      try {
        await sb.recordScored(scored);
      } catch (e) {
        console.warn("Couldn't record scoring memory:", e);
      }
      // Only on a scan that finished. If it died halfway — quota, network — the
      // timestamp stays put and the next run covers the same ground again. A
      // failed scan must never be allowed to skip a day of postings.
      await sb.touchLastScan();

      // Age out untouched finds. Never deletes, never restates a status: an
      // archived row keeps status 'new' and gains a date, so it can come back.
      try {
        const archived = await sb.archiveStaleFinds();
        if (archived) stats.push(`${archived} older finds archived`);
      } catch (e) {
        console.warn("Couldn't archive stale finds:", e);
      }

      progress(`Done — ${saved} job${saved === 1 ? "" : "s"} added. ${funnel}`, true,
               { added: saved, stats, cvChanged: Boolean(sp.rebuiltFromNewCv) });
    } catch (e) {
      const m = String(e.message || e);
      // Setup errors still travel back over the channel, because the dashboard
      // is still waiting on it at that point. Anything later has to go by
      // SCAN_PROGRESS — the channel is gone by then.
      ack({ ok: false, error: m });
      progress(`Scan failed: ${m}`, true, { error: m });
    } finally {
      keepAlive.stop();
    }
  }
}

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

// A field whose label couldn't be read is not a field we can fill.
//
// labelKey("") is "", which is a perfectly good object key — so every
// unlabelled input on every site shared one entry in the learned map. Learn one
// of them wrongly and the answer comes back for all of them: on a Cornerstone
// form that meant First Name receiving an email address and a phone number, and
// Last Name receiving a city and country. Worse, an unreadable label was still
// handed to the model to invent a value for, which is guesswork dressed up as
// an answer. Both paths now require a label of real substance, and a blank one
// is reported as skipped so the gap is visible rather than silently wrong.
const MIN_LABEL_LEN = 3;
const usableLabel = (s) => labelKey(s).length >= MIN_LABEL_LEN;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "MAP_FIELDS") return;

  (async () => {
    try {
      const fields = msg.fields || [];
      if (!fields.length) { sendResponse({ ok: true, map: {}, learned: 0, asked: 0 }); return; }

      const store = await chrome.storage.local.get(LEARNED_KEY);
      const learned = store[LEARNED_KEY] || {};
      // Drop entries poisoned before the guard below existed — the blank key
      // above all, which is the one that filled names with contact details.
      let purged = 0;
      for (const k of Object.keys(learned)) {
        if (k.length < MIN_LABEL_LEN) { delete learned[k]; purged++; }
      }
      if (purged) await chrome.storage.local.set({ [LEARNED_KEY]: learned });

      const map = {};
      const unknown = [];
      let unlabelled = 0;
      for (const f of fields) {
        if (!usableLabel(f.label)) { unlabelled++; continue; }
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
              // Only labels substantial enough to identify a field again.
              if (usableLabel(asked.get(id))) learned[labelKey(asked.get(id))] = key;
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

      sendResponse({ ok: true, map, fills, learned: fromCache,
                     asked: unknown.length, unlabelled });
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
      // The CV's facts are checked separately and more strictly than the
      // letter's claims: an employer verifies a CV, so a title or employer that
      // isn't in the source has to be surfaced, not smoothed over.
      const warnings = groundingWarnings(result, cv)
        .concat(cvGroundingWarnings(result.tailored_cv, cv));

      // Persist the run + track the job. Best-effort: a save failure must not
      // lose the result the user is waiting for.
      let saved = false;
      if (signedIn) {
        try {
          const row = await sb.saveTailoredResult(msg.job, result, warnings);
          await sb.upsertApplication(msg.job, row?.id, result);
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

// ── Scheduled scanning ─────────────────────────────────────────────────────
// A browser extension cannot be always-on: the alarm only ticks while Chrome is
// running, so a machine that is off scans nothing. What makes that acceptable is
// the window — every run asks "what has appeared since I last looked", so a gap
// of any length is covered by the next run rather than skipped. The schedule is
// best-effort; correctness does not depend on it.
//
// Chrome persists alarms and fires a missed one ONCE shortly after startup, not
// once per interval missed. Three days closed gives one catch-up scan asking for
// three days, which is exactly right.
const SCAN_ALARM = "jobcopilot-scan";
const SCAN_PERIOD_MIN = 120;

// Borrowed from the Python bot, which enforces the same window in code rather
// than in its cron so that daylight saving can't shift it. Nothing worth finding
// is posted at 4am, and skipping those runs halves the work for no loss.
const QUIET_FROM = 23, QUIET_TO = 6;

function inQuietHours(d = new Date()) {
  const h = d.getHours();
  return QUIET_FROM > QUIET_TO ? (h >= QUIET_FROM || h < QUIET_TO)
                               : (h >= QUIET_FROM && h < QUIET_TO);
}

async function autoScanEnabled() {
  const { autoScan } = await chrome.storage.local.get("autoScan");
  return autoScan !== false;           // on unless explicitly turned off
}

async function ensureScanAlarm() {
  const existing = await chrome.alarms.get(SCAN_ALARM);
  if (existing) return;
  chrome.alarms.create(SCAN_ALARM, { periodInMinutes: SCAN_PERIOD_MIN,
                                     delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { ensureScanAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureScanAlarm(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SCAN_ALARM) return;
  try {
    if (!(await autoScanEnabled())) return;
    if (inQuietHours()) return;
    // A scheduled scan must never interrupt a manual one, and must never run
    // for someone who hasn't finished setting up — loadKeyAndCv throws for a
    // missing key or CV and that is not worth surfacing on a timer.
    if (keepAlive.timer) return;
    await loadKeyAndCv();
    if (!(await sb.getSession())) return;
    await runScan({ scheduled: true });
  } catch (e) {
    // Silent by design. A timer that pops errors at someone every two hours is
    // worse than one that quietly retries in two more.
    console.warn("Scheduled scan skipped:", e && e.message);
  }
});

// A count on the toolbar icon, so a background scan that found something says
// so without a notification permission or a popup stealing focus. Cleared when
// the dashboard is opened, which is the moment they have been seen.
function setBadge(n) {
  try {
    chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  } catch { /* action API unavailable: the badge is a nicety, not a feature */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SCAN_PROGRESS" && msg.done && msg.added > 0) setBadge(msg.added);
  if (msg?.type === "DASHBOARD_OPENED") setBadge(0);
});
