// tailor_core.js — the "Tailor" brain, ported from tailor.py.
//
// This is the SAME logic as the Python tailor.py: build a prompt from (job, CV),
// send it to Groq, normalise the JSON, and flag ungrounded bullets. Keeping the
// two in step matters — if you tune the prompt here, mirror it in tailor.py
// (or, later, extract the prompt to one shared template both load).
//
// Pure functions only (no chrome.* here) so this file stays testable and
// reusable by the background worker, a popup, or a future dashboard.

export const DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const MAX_TOKENS = 2200;
const CV_LIMIT = 4000;
const JD_LIMIT = 3000;
const LANG_NAME = { en: "English", de: "German" };

export function buildPrompt(job, cvText, language = "en") {
  const langName = LANG_NAME[language] || "English";
  const desc = (job.description || "").slice(0, JD_LIMIT);
  return `You are an expert career coach and CV writer. Tailor the candidate's \
application to ONE specific job.

=== JOB POSTING ===
Title: ${job.title || "N/A"}
Company: ${job.company || "N/A"}
Location: ${job.location || "N/A"}
Description:
${desc}

=== CANDIDATE CV (the ONLY source of truth about the candidate) ===
${(cvText || "").slice(0, CV_LIMIT)}

=== YOUR TASK ===
Produce a tailored application packet, written in ${langName}.

ABSOLUTE RULE — NO FABRICATION:
- Use ONLY facts present in the CV. Never invent employers, job titles, dates,
  degrees, tools, skills, certifications, or achievements.
- You MAY reorder, rephrase, quantify differently, and emphasize the parts of
  the CV most relevant to this job.
- If the job wants something the CV does not show, do NOT pretend the candidate
  has it. Put it in "missing_keywords" and, if useful, suggest an honest way to
  address it in "suggestions".
- Every item in "relevant_experience" MUST include "from_cv": a short quote or
  close paraphrase of the exact CV line it is based on. If you cannot ground a
  point in the CV, do not include it.

Return a JSON object in EXACTLY this shape:
{
  "fit_score": <int 0-100: how well this candidate fits THIS role — 85+ outstanding,
                70-84 strong, 50-69 worth a look, below 50 poor. Be strict, and
                score 0 if it is a different profession, needs years of experience
                the CV lacks, or demands fluent German the CV doesn't show>,
  "fit_summary": "<one honest sentence on overall fit, strengths and gaps>",
  "tailored_summary": "<3-4 sentence professional summary tuned to THIS role, grounded in the CV>",
  "relevant_experience": [
    {"from_cv": "<the CV line/fact this is based on>", "bullet": "<the same fact rephrased to emphasize this job's needs>"}
  ],
  "matched_keywords": ["<job requirement the CV genuinely supports>"],
  "missing_keywords": ["<job requirement the CV does NOT support>"],
  "suggestions": ["<honest positioning tip or gap-mitigation>"],
  "cover_letter": "<the BODY of the cover letter — see rules below>",
  "tailored_cv": {
    "headline": "<the candidate's current title or field, exactly as the CV states it>",
    "summary": "<2-3 sentences opening the CV, tuned to this role, grounded in the CV>",
    "sections": [
      {
        "title": "<Experience | Education | Projects — use the CV's own wording>",
        "entries": [
          {
            "role": "<VERBATIM from the CV: job title or degree>",
            "org": "<VERBATIM from the CV: employer or institution>",
            "dates": "<VERBATIM from the CV, e.g. 03/2024 - 09/2024>",
            "location": "<VERBATIM from the CV, or empty>",
            "bullets": ["<a fact from THIS entry, rephrased for this job>"]
          }
        ]
      },
      { "title": "Skills", "items": ["<a skill the CV genuinely shows>"] }
    ]
  }
}

TAILORED CV — the strictest part of this task.
A cover letter is an argument; a CV is a factual record, and an employer will
check it. Inventing a title, an employer, a date or a qualification is not a
weak answer, it is a false document in the candidate's name.
- "role", "org", "dates" and "location" must be copied VERBATIM from the CV.
  Do not tidy, translate, expand or standardise them. If the CV says
  "Werkstudent" do not write "Working Student". If a date is missing, use "".
- You may REORDER entries, DROP irrelevant ones, and REPHRASE bullets to
  emphasise what this job asks for. You may not add an entry, a skill, a tool
  or a number that is not in the CV.
- Every bullet must be traceable to the entry it sits under.
- Keep every "Skills" item to words that appear in the CV.
- Order sections the way this job would want them read, and put the entries
  that matter most to this posting first within each section.

COVER LETTER — this is the part candidates are judged on, so make it specific:
- Write the BODY ONLY: no letterhead, no date, no subject line, no "Dear ...",
  no sign-off and no name. Those are added around it automatically.
- 4 to 6 paragraphs, 300-450 words, separated by blank lines.
- Follow this arc:
  1. Who the candidate is right now (course/role and institution/employer) and
     what they are applying for.
  2. What specifically draws them to THIS role and company — tie it to the
     posting's actual responsibilities, not generic praise.
  3. One or two concrete projects or achievements from the CV, naming the real
     tools, methods and outcomes.
  4. Current or most recent experience and what it taught them.
  5. Working style plus language levels exactly as the CV states them.
  6. Practical close: availability/start date if the CV says, and an invitation
     to talk.
- Name real tools, methods and numbers from the CV. Specifics are what make it
  credible; adjectives are not.
- Never invent anything. No flattery ("your esteemed company"), no clichés
  ("I am a hard worker"), no repeating the job ad back.
- First person, warm but professional, plain language.

Aim for 4-7 items in "relevant_experience". Respond with ONLY the JSON object.`;
}

// Draft answers to an application form's free-text questions ("Why do you want
// to work here?", "Describe a relevant project"). Same no-fabrication rule as
// the tailoring prompt: only facts from the CV, and say so when there are none.
export function buildAnswersPrompt(questions, job, cvText, packet, language = "en") {
  const langName = LANG_NAME[language] || "English";
  const list = questions
    .map((q) => `  {"id": "${q.id}", "question": ${JSON.stringify(q.question)}}`)
    .join(",\n");
  const tailored = packet && packet.tailored_summary
    ? `\n\nALREADY-TAILORED SUMMARY FOR THIS ROLE (reuse its angle):\n${packet.tailored_summary}`
    : "";

  return `You are helping a candidate answer the free-text questions on a job \
application form. Write in ${langName}.

=== JOB ===
Title: ${job.title || "N/A"}
Company: ${job.company || "N/A"}
Description:
${(job.description || "").slice(0, 1500)}

=== CANDIDATE CV (the ONLY source of truth) ===
${(cvText || "").slice(0, CV_LIMIT)}${tailored}

=== QUESTIONS ===
[
${list}
]

RULES:
- Answer ONLY from the CV. Never invent employers, tools, degrees or results.
- First person, specific, no filler and no flattery. 40-120 words per answer
  unless the question clearly wants one line (then one line).
- If the CV genuinely offers nothing for a question, return "" for it rather
  than inventing something — a human will write that one.
- Do not repeat the cover letter verbatim.

Return a JSON object mapping each id to its answer, and nothing else:
{"answers": {"q0": "…", "q1": "…"}}`;
}

// Work out what to hunt for, from the CV alone. Runs once per user (and again
// whenever they rewrite their CV), so the search is theirs rather than a
// hard-coded field. Mirrors personalize.py's prompt on the Python side.
export function buildSearchProfilePrompt(cvText) {
  return `You are configuring an automated job search for the candidate whose CV \
follows.

=== CV ===
${(cvText || "").slice(0, CV_LIMIT)}
=== END ===

Infer their field, level and target market, then return a JSON object with
EXACTLY these keys:

- "field": one short phrase for their field, e.g. "corporate finance",
  "automotive sensor engineering", "clinical nursing"
- "search_queries": 10-18 short strings (1-3 words) to search job boards with,
  built from THEIR field. Mix English and German if the market is Germany.
  Shapes that work: "Werkstudent <field>", "Junior <role>", "Praktikum <field>".
- "target_titles": 15-30 job titles worth targeting, English and German. If the
  CV shows a student, include Working Student / Werkstudent / Intern / Praktikum
  / Masterarbeit / Thesis variants.
- "must_have_keywords": 10-20 words, at least one of which should appear in a
  genuinely relevant posting (bilingual).
- "exclude_keywords": 8-15 seniority or mismatch terms that make a posting wrong
  for them, e.g. Senior, Lead, Principal, "10+ years", mehrjährige Berufserfahrung.
- "skills": 15-30 skill keywords from the CV, adding the German equivalent where
  one matters.
- "career_level": "student", "graduate" or "professional".
- "language_preference": "english_only", "no_german_required" or "any". If the
  CV shows German below C1 and the market is Germany, use "no_german_required" —
  postings demanding fluent German are then rejected outright.
- "preferred_locations": cities or regions from the CV, plus the country.
- "domain": an object describing the candidate's FIELD, so obviously wrong work
  can be rejected without spending a model call on it:
  - "name": the field, e.g. "automotive engineering", "corporate finance"
  - "core_terms": 15-30 terms that strongly signal a posting is in this field
    (bilingual). Two of these appearing is treated as proof.
  - "supporting_terms": 5-10 relevant but ambiguous terms that could belong to
    another industry too.
  - "adjacent_terms": 5-12 terms from neighbouring industries with transferable
    skills.
  - "core_companies": 15-30 real employers central to this field in the target
    country, lowercase.
  - "adjacent_companies": 5-15 employers in neighbouring industries, lowercase.
  - "reject_title_terms": 20-40 job-title fragments that mean the posting is a
    DIFFERENT PROFESSION — for an engineer: "marketing manager", "sales
    manager", "account executive", "recruiter", "customer service", "nurse";
    for a lawyer: "software developer", "mechanical engineer". This is the list
    that keeps unrelated work out, so be thorough and concrete.
  - "bonus_terms": 5-10 of the candidate's strongest specialty terms.
- "company_targets": 15-30 objects {"name","ats","id"} for employers in this
  field whose jobs can actually be read from a public board. "ats" is one of:
  greenhouse, ashby, lever, recruitee, personio, smartrecruiters. "id" is their
  board identifier — usually the lowercase company name with no spaces (ashby
  often hyphenates; smartrecruiters is usually CamelCase).

  Choose realistically, because a wrong guess yields nothing:
  * This is a search within GERMANY — name employers that actually hire here.
  * These boards are used overwhelmingly by STARTUPS, SCALE-UPS and mid-sized
    companies. Personio in particular is a German SME product.
  * Large corporations and household-name manufacturers are almost always on
    Workday or SuccessFactors, which cannot be read — do NOT list them, however
    relevant they seem. Naming a famous employer with a guessed ATS is the most
    common way this list ends up empty.
  * Prefer smaller, specialised companies in the candidate's field, including
    ones in their region.
  Every entry is verified afterwards and dead ones are discarded, so offer a
  generous list of plausible candidates rather than a short cautious one.

Respond with ONLY the JSON object.`;
}

// Score ONE posting, with the room to judge it properly: the full CV and 1500
// characters of the posting, as matchers/ai.py does. Batching is cheaper but
// gives each job a fraction of the context, and the difference shows — a
// committee-management role at a car company came back as a strong engineering
// match under batch scoring. The most promising postings get this treatment;
// the rest fall back to batches.
export function buildSingleScorePrompt(job, cvText, sp = {}, language = "en",
                                       baseLocation = "", domainClass = "") {
  const field = (sp.domain && sp.domain.name) || sp.field || "";
  const langPref = sp.language_preference || "any";
  const level = sp.career_level || "";
  const persona = sp.persona || "";

  // 1500 cut real requirements off the end. An employer board's role text — the
  // duties, the qualifications and the practical conditions — measured 1742,
  // 2117, 2354 and 2528 characters on live Bosch postings, so the
  // qualifications section, the part that decides the fit, was the part being
  // dropped. 2500 covers them whole. This is the individually-scored pass, 15
  // postings a scan, so it costs a few thousand tokens; the batched pass stays
  // at 1200, because that one is 55 postings and it is where the
  // tokens-per-minute ceiling actually bites.
  const description = (job.description || "").slice(0, 2500);

  return `You are a strict but fair job-matching assistant.

=== CANDIDATE CV ===
${(cvText || "").slice(0, 3000)}

Their field: ${field || "as shown in the CV"}
${persona ? `About them: ${persona}` : ""}
${level ? `Career level: ${level}` : ""}
${baseLocation ? `Based in: ${baseLocation}` : ""}
${domainClass ? `Already classified relative to their field: ${domainClass}` : ""}

=== POSTING ===
Title: ${job.title || ""}
Company: ${job.company || ""}
Location: ${job.location || ""}
Description: ${description}

Score this posting 0-100 for this candidate and give one short, specific reason.
- 85-100 outstanding · 70-84 strong · 50-69 worth a look · below 50 poor.
- Be strict. Most postings are not a good fit; say so.
- SCORE 0, no exceptions, when any of these hold:
  * it is a DIFFERENT PROFESSION from ${field || "their field"}. Working at a
    company in the right industry does not make an off-field role a fit. To
    reject for this you MUST quote, word for word, the part of the posting's
    own title that names its profession. If no words in that title name a
    profession outside ${field || "their field"}, this rule does not apply —
    score the posting on its merits instead.
  * it requires several years of professional experience the CV doesn't show.${
  langPref === "no_german_required" ? `
  * it requires fluent or business German ("verhandlungssicheres Deutsch",
    "Deutsch C1/C2", "fließend", "Muttersprache"), which this candidate lacks.
    ("Grundkenntnisse", B1/B2 or "von Vorteil" are fine.)` : ""}${
  langPref === "english_only" ? `
  * it is written in German or expects German at work; this candidate needs an
    English-speaking role.` : ""}
- LOCATION IS NOT YOURS TO JUDGE. This is a Germany-wide search and everything
  outside Germany has already been removed before you see it. ANY German
  location is equally acceptable — Munich, Hamburg, Salzgitter, anywhere. Never
  lower a score, and never mention distance from the candidate's home city,
  because the search was national on purpose. Judge the work, not the map.
- Judge on real overlap of experience, not keyword coincidence. Being at a
  well-known employer counts for nothing on its own.
- The reason must cite something concrete from the CV or the posting, in one
  sentence, in ${LANG_NAME[language] || "English"}.

Respond with ONLY a JSON object: {"score": <int 0-100>, "reason": "<one sentence>"}`;
}

// Score a batch of postings in one call. Batching matters: scoring each job
// individually would exhaust a free-tier key in a single scan.
export function buildBatchScorePrompt(jobs, cvText, sp = {}, language = "en",
                                      baseLocation = "") {
  const field = (sp.domain && sp.domain.name) || sp.field || "";
  const persona = sp.persona || "";
  const level = sp.career_level || "";
  const langPref = sp.language_preference || "any";
  // Enough of each posting to judge it properly. An earlier version passed 450
  // characters to keep the batch cheap, and the scores showed it — committee
  // management at a car company came back as a strong engineering match. The
  // Python bot reads 1500 characters per job and grades far better for it.
  const list = jobs.map((j, i) =>
    `  {"i": ${i}, "title": ${JSON.stringify(j.title || "")}, ` +
    `"company": ${JSON.stringify(j.company || "")}, ` +
    `"location": ${JSON.stringify(j.location || "")}, ` +
    `"description": ${JSON.stringify((j.description || "").slice(0, 1200))}}`
  ).join(",\n");

  return `You are a strict but fair job-matching assistant. Score how well each \
posting fits the candidate.

=== CANDIDATE CV ===
${(cvText || "").slice(0, 2200)}

Their field: ${field || "as shown in the CV"}
${persona ? `About them: ${persona}` : ""}
${level ? `Career level: ${level}` : ""}
${baseLocation ? `They are based in: ${baseLocation}` : ""}

=== POSTINGS ===
[
${list}
]

For each posting give a score from 0 to 100 and one short, specific reason.
- 85-100 outstanding fit · 70-84 strong · 50-69 worth a look · below 50 poor.
- Be strict. Most postings are not a good fit; say so.
- SCORE 0, no exceptions, when any of these hold:
  * the posting is a DIFFERENT PROFESSION from ${field || "the candidate's field"}.
    Working at a company in the right industry does not make an off-field role a
    fit. To reject for this you MUST quote, word for word, the part of the
    posting's own title that names its profession. If no words in that title
    name a profession outside ${field || "the candidate's field"}, this rule
    does not apply — score the posting on its merits instead.
  * it requires several years of professional experience the CV doesn't show.${
  langPref === "no_german_required" ? `
  * it requires fluent or business German — "verhandlungssicheres Deutsch",
    "Deutsch C1/C2", "fließend Deutsch", "Muttersprache" — which this candidate
    does not have. ("Grundkenntnisse", B1/B2 or "von Vorteil" are fine.)` : ""}${
  langPref === "english_only" ? `
  * it is written in German or expects German at work; this candidate needs an
    English-speaking role.` : ""}
- A posting only scores above 70 if it is genuinely in their field and at their
  level. Being at a well-known employer counts for nothing on its own.
- LOCATION IS NOT YOURS TO JUDGE. This is a Germany-wide search and everything
  outside Germany has already been removed before you see it. ANY German
  location is equally acceptable — Munich, Hamburg, Salzgitter, anywhere. Never
  lower a score, and never mention distance from the candidate's home city,
  because the search was national on purpose. Judge the work, not the map.
- Judge on real overlap of skills and experience, not keyword coincidence.
- The reason must cite something concrete from the CV or the posting, in one
  sentence, written in ${LANG_NAME[language] || "English"}.

Respond with ONLY a JSON object in exactly this form:
{"scores": [{"i": 0, "score": 82, "reason": "…"}, …]}`;
}

// Fill the form fields the rules couldn't place.
//
// This asks for the VALUE rather than just which stored field a box maps to.
// Mapping alone can only copy an answer verbatim, so it fails whenever a form
// wants the same fact in a different shape — "3 months" rather than "from 1
// October", a dropdown's exact wording, a yes/no where the profile holds a
// sentence, or a number where it holds prose.
//
// The model is still not free to invent: it may only restate what the profile
// or CV already says, and is told to omit a field rather than guess. Anything
// sensitive is filtered out before it ever reaches here.
export function buildFieldFillPrompt(fields, profile, cvText) {
  const known = Object.entries(profile || {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim())
    .map(([k, v]) => `  "${k}": ${JSON.stringify(String(v).slice(0, 200))}`)
    .join(",\n");

  const list = fields.map((f) => {
    const bits = [`"id": "${f.id}"`, `"label": ${JSON.stringify(f.label)}`,
                  `"type": "${f.type}"`];
    if (f.options && f.options.length) {
      bits.push(`"options": ${JSON.stringify(f.options)}`);
    }
    if (f.maxLength) bits.push(`"max_length": ${f.maxLength}`);
    return `  {${bits.join(", ")}}`;
  }).join(",\n");

  return `You are filling in a job-application form on behalf of a candidate, \
using only what they have already told us.

=== WHAT THE CANDIDATE HAS TOLD US ===
{
${known}
}

=== THEIR CV (for facts not in the list above) ===
${(cvText || "").slice(0, 2000)}

=== FORM FIELDS TO FILL ===
[
${list}
]

For each field, give the exact text to type into it. Rules:
- Use ONLY facts from the details above or the CV. Never invent an employer,
  date, number, qualification or preference that is not there.
- Restate a fact in whatever shape the field asks for. If the field wants a
  notice period in months and the candidate said "from 1 October", work out the
  months only if the CV or details make that unambiguous — otherwise omit it.
- When "options" are given, answer with one of them EXACTLY as written, or omit
  the field if none genuinely applies. This covers radio buttons and dropdowns.
- A field of type "checkbox-group" may take SEVERAL options: list the ones that
  genuinely apply, separated by commas, each written exactly as given. Choose
  only what the details or CV support — leave it out rather than padding it.
- Interpret rather than copy when the options demand it, provided the fact is
  already known. If the candidate says "English C1, German B1" and the field
  asks "What is your German level?" with options "A1 - A2 (Beginner) /
  B1 - B2 (Intermediate) / C1 - C2 (Fluent to Native)", the answer is
  "B1 - B2 (Intermediate)". Answer each language field about THAT language only.
- A notice period or start date can likewise be expressed as the option that
  matches — "none or less than 1 month", "1 - 2 months", "3 or more months" —
  but only when the stored answer makes it unambiguous.
- Yes/no questions: answer "Yes" or "No" only when the details clearly support
  it. Never guess on eligibility, sponsorship or authorisation.
- Respect "max_length" when given.
- OMIT any field you are not confident about. A blank the person fills in
  themselves is much better than a plausible-looking wrong answer.
- Never answer anything asking for a password, government ID, bank or card
  details, tax number or date of birth — omit those entirely.
- Do not write cover letters or long essays here; those are handled elsewhere.

Return only a JSON object mapping field id to the text to enter, e.g.:
{"fills": {"f3": "Munich", "f7": "Yes"}}`;
}

// Classify form fields the rule-based matcher didn't recognise.
//
// Deliberately a CLASSIFICATION task, not a generation one: the model maps each
// field to one of our known profile keys, and the value is then taken from the
// user's own saved profile. It is never asked to produce a value, so it cannot
// invent personal data.
export function buildFieldMapPrompt(fields, keys) {
  const list = fields.map((f) => {
    const opts = f.options && f.options.length
      ? `, "options": ${JSON.stringify(f.options)}` : "";
    return `  {"id": "${f.id}", "label": ${JSON.stringify(f.label)}, "type": "${f.type}"${opts}}`;
  }).join(",\n");

  return `You are mapping fields on a job-application form to a candidate's \
stored profile.

FORM FIELDS:
[
${list}
]

AVAILABLE PROFILE KEYS (the only allowed values):
${keys.join(", ")}

For each field, decide which profile key it is asking for. Rules:
- Use ONLY the keys listed above.
- The field must be asking for THAT THING, not merely something of the same kind.
  A box asking for a link to a video, a portfolio piece or a specific document is
  not the LinkedIn field just because both hold a URL; a box asking how many years
  of experience is not the salary field just because both hold a number. When the
  match is by category rather than by meaning, omit it.
- If a field matches none of them, or you are unsure, OMIT it entirely.
  Leaving a field blank is always better than filling it wrongly.
- Never map anything asking for a password, government ID (passport, national
  id, social security), bank/card details, tax number or date of birth — omit
  those, they are handled elsewhere.
- Labels may be in English or German.

Return only a JSON object mapping field id to profile key, e.g.:
{"map": {"f3": "city", "f7": "notice_period"}}`;
}

// Coerce the model's output into the stable shape the UI expects. Mirrors
// tailor.py's _normalize: tolerates a string where a list is expected and
// fills every key so the renderer never trips on a missing field.
const str = (v) => (typeof v === "string" ? v.trim() : "");

// Shape-only. Nothing here judges whether a fact is true — that is
// cvGroundingWarnings' job, and it needs the CV text this function never sees.
function normalizeCv(raw) {
  if (!raw || typeof raw !== "object") return null;
  const sections = [];
  for (const sec of Array.isArray(raw.sections) ? raw.sections : []) {
    if (!sec || typeof sec !== "object") continue;
    const entries = [];
    for (const e of Array.isArray(sec.entries) ? sec.entries : []) {
      if (!e || typeof e !== "object") continue;
      const entry = {
        role: str(e.role), org: str(e.org), dates: str(e.dates),
        location: str(e.location),
        bullets: asStrList(e.bullets),
      };
      // An entry naming nothing is not an entry.
      if (entry.role || entry.org) entries.push(entry);
    }
    const items = asStrList(sec.items);
    if (entries.length || items.length) {
      sections.push({ title: str(sec.title), entries, items });
    }
  }
  if (!sections.length) return null;
  return { headline: str(raw.headline), summary: str(raw.summary), sections };
}

export function normalize(result) {
  const out = {};
  for (const key of ["fit_summary", "tailored_summary", "cover_letter"]) {
    const v = result[key];
    out[key] = typeof v === "string" ? v.trim() : String(v || "");
  }
  for (const key of ["matched_keywords", "missing_keywords", "suggestions"]) {
    out[key] = asStrList(result[key]);
  }
  // Comes back with the packet, so a job tailored by hand carries the same fit
  // number as one found by a scan rather than showing "—" in the tracker.
  const fit = parseInt(result.fit_score, 10);
  out.fit_score = Number.isFinite(fit) ? Math.max(0, Math.min(100, fit)) : null;
  out.tailored_cv = normalizeCv(result.tailored_cv);

  const exp = [];
  for (const item of result.relevant_experience || []) {
    if (item && typeof item === "object") {
      const bullet = String(item.bullet || "").trim();
      if (bullet) exp.push({ from_cv: String(item.from_cv || "").trim(), bullet });
    } else if (typeof item === "string" && item.trim()) {
      exp.push({ from_cv: "", bullet: item.trim() });
    }
  }
  out.relevant_experience = exp;
  return out;
}

function asStrList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.replace(/\n/g, ",").split(",").map((p) => p.trim()).filter(Boolean);
  }
  return [];
}

// The anti-fabrication guardrail (mirrors tailor.py's grounding_warnings):
// flag any experience bullet whose cited CV source barely overlaps the CV text.
export function groundingWarnings(result, cvText, minOverlap = 0.5) {
  const cvWords = wordSet(cvText);
  const warnings = [];
  for (const item of result.relevant_experience || []) {
    const srcWords = wordSet(item.from_cv || "");
    if (srcWords.size === 0) {
      warnings.push(`no CV source cited for: ${item.bullet.slice(0, 60)}`);
      continue;
    }
    let hit = 0;
    for (const w of srcWords) if (cvWords.has(w)) hit++;
    const overlap = hit / srcWords.size;
    if (overlap < minOverlap) {
      warnings.push(`weak CV grounding (${Math.round(overlap * 100)}%) for: ${item.bullet.slice(0, 60)}`);
    }
  }
  return warnings;
}

// A CV's facts are checked differently from a cover letter's claims. A letter
// argues, and word overlap is a fair test of whether the argument is grounded.
// A CV asserts — this employer, this title, these dates — and an employer will
// verify it. So role, org and dates must appear in the source CV almost
// literally, not merely resemble it. "Werkstudent" quietly becoming "Working
// Student" is a small edit and a different claim.
//
// Compared with punctuation, case and spacing removed, because a model
// reformatting "03/2024 – 09/2024" as "03/2024 - 09/2024" is not fabrication.
const flatten = (s) => (s || "").toLowerCase().replace(/[^a-zäöüß0-9]+/g, "");

export function cvGroundingWarnings(cv, cvText) {
  const warnings = [];
  if (!cv || !cvText) return warnings;
  const flatCv = flatten(cvText);

  // Verbatim-required fields, checked by containment.
  const mustAppear = (value, what, where) => {
    const v = flatten(value);
    if (!v) return;
    if (!flatCv.includes(v)) {
      warnings.push(`${what} not found in your CV: "${String(value).slice(0, 48)}"${where}`);
    }
  };

  for (const section of cv.sections || []) {
    const title = section.title ? ` (${section.title})` : "";
    for (const entry of section.entries || []) {
      mustAppear(entry.org, "employer/institution", title);
      mustAppear(entry.role, "title", title);
      mustAppear(entry.dates, "dates", title);
      mustAppear(entry.location, "location", title);
    }
    // A skill on a CV is a claim about the candidate, so it gets the same test.
    for (const item of section.items || []) {
      mustAppear(item, "skill", title);
    }
  }
  return warnings;
}

function wordSet(text) {
  const words = (text || "").toLowerCase().match(/[a-zäöüß0-9]+/g) || [];
  return new Set(words.filter((w) => w.length > 2));
}
