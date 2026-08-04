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

// ── Profession guard ───────────────────────────────────────────────────────
// The domain block is written by a model from each CV, so how thorough its
// reject_title_terms list turns out to be varies from user to user. Relying on
// it alone means the next person gets what Meet got: marketing and
// customer-service roles in an engineering search. This is the floor underneath
// it — a fixed map of professions that applies to everybody, so a posting from
// a different line of work is rejected whatever the model happened to generate.
//
// Built in code rather than per-user on purpose: it must not be possible to fix
// one person's results and leave the next person's broken.
const PROFESSION_FAMILIES = {
  engineering: ["engineer", "ingenieur", "ingenieurin", "konstrukteur", "techniker",
    "technician", "mechanic", "mechatronik", "elektronik", "hardware", "embedded",
    "simulation", "cad", "fertigung", "produktion", "manufacturing", "maintenance",
    "instandhaltung", "qualitätsingenieur", "prüftechnik", "versuch"],
  software: ["software", "developer", "entwickler", "programmer", "backend",
    "frontend", "full-stack", "fullstack", "devops", "sre", "data scientist",
    "data engineer", "machine learning", "ml engineer", "qa engineer", "tester",
    "informatiker", "it-", "cloud", "cyber security", "systemadministrator",
    "softwareentwicklung", "anwendungsentwicklung", "webentwicklung"],
  finance: ["accountant", "buchhalter", "controller", "controlling", "auditor",
    "wirtschaftsprüfer", "steuer", "tax", "financial analyst", "finanzanalyst",
    "treasury", "investment", "banker", "bilanz", "credit risk", "actuary",
    "steuerberater", "steuerfachangestellte", "finanzbuchhaltung", "rechnungswesen"],
  marketing: ["marketing", "brand", "seo", "sea", "content manager", "copywriter",
    "social media", "kommunikation", "communications", "public relations",
    "growth manager", "campaign", "redakteur"],
  sales: ["sales", "vertrieb", "account executive", "account manager",
    "business development", "key account", "kundenberater", "verkauf",
    "verkäufer", "verkäuferin", "retail", "einzelhandel", "shop assistant",
    "vertriebsmitarbeiter", "vertriebsassistenz", "verkaufsberater",
    "verkaufsleiter", "vertriebsinnendienst"],
  support: ["customer support", "customer service", "kundenservice", "kundenbetreuer",
    "call center", "helpdesk", "service desk", "community management",
    "customer success", "reklamation"],
  hr: ["recruiter", "recruiting", "talent acquisition", "human resources",
    "personalreferent", "personalwesen", "hr manager", "hr business partner",
    "lohnbuchhaltung", "payroll"],
  legal: ["lawyer", "anwalt", "rechtsanwalt", "jurist", "legal counsel",
    "paralegal", "compliance officer", "notar"],
  health: ["nurse", "krankenpfleger", "pflegekraft", "pflegefachkraft", "doctor",
    "arzt", "ärztin", "physician", "therapist", "therapeut", "apotheker",
    "pharmacist", "medizinische", "zahnarzt"],
  education: ["teacher", "lehrer", "erzieher", "dozent", "lecturer", "professor",
    "tutor", "kindergarten", "nachhilfe"],
  logistics: ["logistik", "lagerist", "warehouse", "kommissionierer", "kommissionierung", "fahrer",
    "driver", "kurier", "spedition", "supply chain", "disponent",
    // Compound forms, since markers now match whole words only.
    "kraftfahrer", "berufskraftfahrer", "lkw-fahrer", "staplerfahrer",
    "lagermitarbeiter", "lagerarbeiter", "lagerhelfer", "logistikmitarbeiter",
    "auslieferungsfahrer", "paketzusteller", "zusteller"],
  hospitality: ["chef", "koch", "köchin", "barista", "kellner", "waiter",
    "housekeeping", "rezeptionist", "receptionist", "hotel", "gastronomie"],
  trades: ["elektriker", "installateur", "klempner", "plumber", "carpenter",
    "schreiner", "maler", "dachdecker", "bauleiter", "maurer"],
  design: ["ux designer", "ui designer", "graphic designer", "grafiker",
    "produktdesigner", "art director", "illustrator"],
  admin: ["office manager", "assistenz", "sekretär", "sekretärin", "sachbearbeiter",
    "empfang", "verwaltung", "data entry",
    "teamassistenz", "projektassistenz", "vorstandsassistenz", "büroassistenz",
    "bürokaufmann", "bürokauffrau", "verwaltungsangestellte",
    "empfangsmitarbeiter", "empfangskraft"],
};

// Families whose work genuinely overlaps, so a posting from one is not treated
// as foreign to the other.
const FAMILY_NEIGHBOURS = {
  engineering: ["software", "design"],
  software: ["engineering"],
  design: ["software", "marketing"],
  finance: ["admin"],
};

// Matching these markers as plain substrings read German compounds backwards.
// "Fahrerassistenz" contains "fahrer" and "assistenz", and "Steuergerät"
// contains "steuer", so ADAS work was filed under logistics, admin and finance
// at once — and because the same function builds the candidate's own family
// set, those three families were added to it, which switched the guard off for
// every warehouse and back-office posting that came after. A marker found in
// the middle of a compound means nothing and must not count.
//
// German does compound left to right, though, so the profession noun lands at
// the end: Entwicklungs|ingenieur, Berufskraft|fahrer, Elektro|techniker. Those
// are real and have to be caught, which is what COMPOUND_TAILS allows for —
// nouns that name a profession wherever they appear at the end of a word.
// "assistenz" is deliberately not among them: "Fahrerassistenz" is the ADAS
// term, not an office job. Everything else matches as a whole word, allowing
// for the usual inflected endings ("Verkäuferin", "engineering").
const WORD_CHAR = "a-zäöüß0-9";
const INFLECTION = "(?:e|en|er|s|es|in|innen|ing)?";
const STARTS_WORD = new RegExp(`^[${WORD_CHAR}]`);
const ENDS_WORD = new RegExp(`[${WORD_CHAR}]$`);

const COMPOUND_TAILS = new Set([
  "ingenieur", "ingenieurin", "konstrukteur", "techniker", "entwickler",
  "informatiker", "fahrer", "disponent", "buchhalter", "arzt", "ärztin",
  "apotheker", "elektriker", "installateur", "klempner", "schreiner",
  "dachdecker", "maurer", "koch", "köchin", "kellner", "lehrer", "erzieher",
  "verkäufer", "verkäuferin", "sekretär", "sachbearbeiter", "kundenberater",
]);
// Left off on purpose: "controller" would turn every Mikrocontroller and domain
// controller posting into a finance job.

const markerCache = new Map();

function markerRe(marker) {
  let re = markerCache.get(marker);
  if (!re) {
    const left = STARTS_WORD.test(marker) && !COMPOUND_TAILS.has(marker)
      ? `(?<![${WORD_CHAR}])` : "";
    const right = ENDS_WORD.test(marker)
      ? `${INFLECTION}(?![${WORD_CHAR}])` : "";
    re = new RegExp(`${left}${escapeRe(marker)}${right}`);
    markerCache.set(marker, re);
  }
  return re;
}

function familiesIn(text) {
  const t = norm(text);
  const found = new Set();
  for (const [family, markers] of Object.entries(PROFESSION_FAMILIES)) {
    if (markers.some((m) => markerRe(m).test(t))) found.add(family);
  }
  return found;
}

/** The professions this candidate is actually looking for. */
export function candidateFamilies(profile) {
  const domain = getDomain(profile);
  const text = [
    domain.name || "", profile.field || "",
    (profile.target_titles || []).join(" "),
    (domain.core_terms || []).join(" "),
    (profile.skills || []).join(" "),
  ].join(" ");

  const fams = familiesIn(text);
  for (const f of Array.from(fams)) {
    (FAMILY_NEIGHBOURS[f] || []).forEach((n) => fams.add(n));
  }
  return fams;
}

/**
 * True when a posting's title belongs to a different profession from the
 * candidate's. Titles that also match the candidate's own field are kept —
 * "Sales Engineer" is engineering to an engineer.
 */
export function isOffProfession(title, myFamilies) {
  if (!myFamilies || !myFamilies.size) return false;   // unknown field: don't guess
  const theirs = familiesIn(title);
  if (!theirs.size) return false;                      // no signal either way
  for (const f of theirs) if (myFamilies.has(f)) return false;
  return true;
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
export function ruleScore(job, profile, myFamilies) {
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

  // The same check, from the built-in profession map, so a thin or missing
  // reject list can't let another line of work through. Applies to every user.
  const fams = myFamilies || candidateFamilies(profile);
  if (isOffProfession(title, fams)) {
    return [0, "a different profession from the candidate's field"];
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

// ── Learning from what the user rejected ───────────────────────────────────
// The bot has a memory file that suppresses postings resembling ones already
// turned down. The tracker records the same thing far more directly — every job
// the user set to "rejected" or "dismissed" — and it was sitting there unused.
//
// Two guards against over-learning: a pattern must appear at least twice before
// it counts, and anything that also shows up in a job the user pursued is
// ignored. One dismissal should never blacklist an employer, and a word that
// appears in roles they applied to is clearly not the reason they said no.
const NEGATIVE = new Set(["rejected", "dismissed"]);
const POSITIVE = new Set(["applied", "interview", "offer", "tailored"]);
const STOPWORDS = new Set([
  "und", "der", "die", "das", "für", "mit", "the", "and", "for", "with", "von",
  "bei", "aus", "job", "jobs", "stelle", "position", "role", "team", "gmbh",
  "senior", "junior", "werkstudent", "praktikum", "intern", "internship",
  "student", "manager", "engineer", "ingenieur", "developer",
]);

export function buildMemory(rows) {
  const negCompanies = new Map(), negTerms = new Map();
  const posCompanies = new Set(), posTerms = new Set();

  for (const r of rows || []) {
    const company = norm(r.job_company).replace(COMPANY_SUFFIX_RE, "").trim();
    const words = (norm(r.job_title).match(/[a-zäöüß]{4,}/g) || [])
      .filter((w) => !STOPWORDS.has(w));

    if (NEGATIVE.has(r.status)) {
      if (company) negCompanies.set(company, (negCompanies.get(company) || 0) + 1);
      for (const w of new Set(words)) negTerms.set(w, (negTerms.get(w) || 0) + 1);
    } else if (POSITIVE.has(r.status)) {
      if (company) posCompanies.add(company);
      words.forEach((w) => posTerms.add(w));
    }
  }

  const keep = (counts, positives) =>
    new Set([...counts.entries()]
      .filter(([k, n]) => n >= 2 && !positives.has(k))
      .map(([k]) => k));

  return {
    rejectedCompanies: keep(negCompanies, posCompanies),
    rejectedTerms: keep(negTerms, posTerms),
  };
}

/** A reason string when this job looks like one already turned down. */
export function matchesRejectedPattern(job, memory) {
  if (!memory) return null;
  const company = norm(job.company).replace(COMPANY_SUFFIX_RE, "").trim();
  if (company && memory.rejectedCompanies.has(company)) {
    return `you previously dismissed roles at ${job.company}`;
  }
  const title = norm(job.title);
  for (const term of memory.rejectedTerms) {
    if (new RegExp(`\\b${escapeRe(term)}`).test(title)) {
      return `you previously dismissed roles like "${term}"`;
    }
  }
  return null;
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
