// matcher.js — the grading pipeline, ported from the Python bot.
//
// The extension originally graded jobs with a keyword check and one AI score,
// which let through work that was plainly in the wrong field — marketing and
// customer-service roles for an automotive engineer — and ignored language
// requirements entirely. The Telegram bot has never had that problem because it
// grades in three stages, and this is that logic:
//
//   1. rule score  — hard filters (off-field titles, excluded terms, German
//                    fluency) and a weighted score; free, instant.
//   2. domain class — is this even in the candidate's field? out_of_domain is
//                    rejected outright and never reaches the model.
//   3. AI score    — only for what survives, with the domain class in hand.
//
// Mirrors matchers/rules.py, matchers/domain_classifier.py and matchers/tier.py.
// Keep the two in step when changing either.

// ── Domain classification ──────────────────────────────────────────────────
export function getDomain(profile) {
  return (profile && profile.domain) || {};
}

const COMPANY_SUFFIX_RE =
  /\s+(gmbh|ag|se|kg|co|inc|ltd|llc|group|holding|usa|deutschland)\b/g;

const norm = (s) => (s || "").toLowerCase().trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function companyMatches(companyNorm, list) {
  for (const known of list || []) {
    const k = norm(known);
    if (!k) continue;
    if (k === companyNorm) return true;
    if (new RegExp(`\\b${escapeRe(k)}\\b`).test(companyNorm)) return true;
  }
  return false;
}

/**
 * Decide whether a job is in the candidate's field. Returns [class, reason],
 * or [null, ""] when the signals are too weak to say — the caller then leaves
 * the judgement to the model rather than guessing.
 */
export function classifyWithRules(job, domain) {
  const title = norm(job.title);
  const company = norm(job.company);
  const text = `${title} ${norm(job.description)}`;
  const companyNorm = company.replace(COMPANY_SUFFIX_RE, "").trim();

  const isCoreCompany = companyMatches(companyNorm, domain.core_companies);
  const isAdjacentCompany = companyMatches(companyNorm, domain.adjacent_companies);

  const hits = (list) =>
    (list || []).reduce((n, t) => (t && text.includes(norm(t)) ? n + 1 : n), 0);
  const coreHits = hits(domain.core_terms);
  const supportHits = hits(domain.supporting_terms);
  const adjacentHits = hits(domain.adjacent_terms);

  // A title from another profession settles it, whatever the company —
  // "Marketing Manager at Mercedes" is still marketing.
  for (const bad of domain.reject_title_terms || []) {
    const b = norm(bad);
    if (!b) continue;
    if (new RegExp(`\\b${escapeRe(b)}\\b`).test(title)) {
      return isCoreCompany
        ? ["adjacent_in_company", `off-field role at core company '${company}'`]
        : ["out_of_domain", `title contains out-of-field term: '${bad}'`];
    }
  }

  if (isCoreCompany && coreHits + supportHits >= 1) {
    return ["core_field",
            `core company '${company}' with ${coreHits} field terms`];
  }
  if (coreHits >= 2) {
    return ["core_field", `strong field context (${coreHits} field terms)`];
  }
  if (isCoreCompany && coreHits === 0 && supportHits === 0) {
    return ["adjacent_in_company",
            `core company '${company}' but the role lacks field context`];
  }
  if (isAdjacentCompany || adjacentHits >= 1) {
    return ["skill_adjacent", "adjacent industry"];
  }
  return [null, ""];
}

// ── Rule score ─────────────────────────────────────────────────────────────
// Phrases that mean the employer wants genuinely fluent German. Casual mentions
// ("Grundkenntnisse", "B1", "von Vorteil") deliberately don't count.
const GERMAN_FLUENCY_RE = new RegExp([
  "verhandlungssicheres? deutsch", "deutsch\\s*c1", "deutsch\\s*c2",
  "flie(ß|ss)end(e|es)? deutsch", "muttersprache deutsch",
  "sehr gute deutschkenntnisse", "fluent german", "native german",
  "german.{0,20}(c1|c2|native|fluent)",
].join("|"), "i");

const GERMAN_TEXT_RE =
  /\b(und|oder|für|mit|wir|sie|ihre|aufgaben|kenntnisse|erfahrung)\b/i;

const tokenize = (s) => (norm(s).match(/[a-zäöüß0-9]+/g) || []);

/**
 * Score a job 0-100 on rules alone. Returns [score, reason].
 * A zero means a hard filter rejected it and the model should never see it.
 */
export function ruleScore(job, profile) {
  const domain = getDomain(profile);
  const title = norm(job.title);
  const desc = norm(job.description);
  const location = norm(job.location);
  const company = norm(job.company);
  const text = `${title} ${desc}`;

  // Off-field title — unless it's at a company central to the field, where the
  // domain classifier files it as adjacent instead.
  for (const bad of domain.reject_title_terms || []) {
    const b = norm(bad);
    if (b && title.includes(b)) {
      const atCore = (domain.core_companies || []).some((c) => company.includes(norm(c)));
      if (!atCore) return [0, `title contains out-of-field term '${bad}'`];
      break;
    }
  }

  for (const excl of profile.exclude_keywords || []) {
    const e = norm(excl);
    if (e && text.includes(e)) return [0, `excluded — contains '${excl}'`];
  }

  // Language. This is why the Telegram bot's results felt right: a posting that
  // demands fluent German is useless to someone who doesn't have it, however
  // well the skills match.
  const langPref = profile.language_preference || "any";
  if (langPref === "english_only" && GERMAN_TEXT_RE.test(desc)) {
    return [0, "posting is in German"];
  }
  if (langPref === "no_german_required" && GERMAN_FLUENCY_RE.test(desc)) {
    return [0, "fluent German required"];
  }

  let score = 0;
  const reasons = [];

  // Title fit. Single-word targets like "Werkstudent" match every working-
  // student posting in any field, so they're capped lower — enough to survive
  // the pre-filter for the model to judge, not enough to rank on their own.
  const titleWords = new Set(tokenize(title));
  let bestPoints = 0, bestTitle = null;
  for (const tt of profile.target_titles || []) {
    const ttWords = new Set(tokenize(tt));
    if (!ttWords.size) continue;
    let overlap = 0;
    ttWords.forEach((w) => { if (titleWords.has(w)) overlap++; });
    const ratio = overlap / ttWords.size;
    const points = Math.round(ratio * (ttWords.size === 1 ? 25 : 40));
    if (points > bestPoints && ratio >= 0.4) bestTitle = tt;
    bestPoints = Math.max(bestPoints, points);
  }
  score += bestPoints;
  if (bestTitle) reasons.push(`title fits '${bestTitle}'`);

  const matchedSkills = (profile.skills || []).filter((s) => s && text.includes(norm(s)));
  score += Math.min(30, matchedSkills.length * 5);
  if (matchedSkills.length) reasons.push(`skills: ${matchedSkills.slice(0, 3).join(", ")}`);

  const present = (profile.must_have_keywords || []).filter((k) => k && text.includes(norm(k)));
  if (present.length) {
    score += Math.min(10, present.length * 2);
    reasons.push(`${present.length} keyword hits`);
  }

  if ((profile.preferred_locations || []).some((l) => l && location.includes(norm(l)))) {
    score += 10;
    reasons.push("preferred location");
  }

  if (profile.career_level === "student") {
    const senior = ["senior", "lead", "principal", "staff engineer", "head of",
                    "5+ years", "7+ years", "10+ years", "mehrjährige"];
    if (senior.some((s) => title.includes(s))) {
      score -= 30;
      reasons.push("too senior");
    }
  }

  const bonus = (domain.bonus_terms || []).filter((t) => t && text.includes(norm(t)));
  if (bonus.length) score += Math.min(10, bonus.length * 3);

  return [Math.max(0, Math.min(100, score)), reasons.join("; ") || "no strong signals"];
}

// ── Tier ───────────────────────────────────────────────────────────────────
// Only out_of_domain is hard-capped; for everything else the model's judgement
// stands, exactly as in the Python tier router.
const DOMAIN_CAP = {
  core_field: 100,
  adjacent_in_company: 100,
  skill_adjacent: 100,
  broader_field: 100,
  out_of_domain: 0,
};

export function applyDomainCap(score, domainClass) {
  const cap = DOMAIN_CAP[domainClass];
  return Math.min(score, cap === undefined ? 100 : cap);
}
