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
  "fit_summary": "<one honest sentence on overall fit, strengths and gaps>",
  "tailored_summary": "<3-4 sentence professional summary tuned to THIS role, grounded in the CV>",
  "relevant_experience": [
    {"from_cv": "<the CV line/fact this is based on>", "bullet": "<the same fact rephrased to emphasize this job's needs>"}
  ],
  "matched_keywords": ["<job requirement the CV genuinely supports>"],
  "missing_keywords": ["<job requirement the CV does NOT support>"],
  "suggestions": ["<honest positioning tip or gap-mitigation>"],
  "cover_letter": "<the BODY of the cover letter — see rules below>"
}

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

// Score a batch of postings in one call. Batching matters: scoring each job
// individually would exhaust a free-tier key in a single scan.
export function buildBatchScorePrompt(jobs, cvText, field, language = "en",
                                      baseLocation = "") {
  // Kept tight on purpose: a scan pushes thousands of words through this, and
  // the opening of a posting carries the role and requirements — the rest is
  // usually company boilerplate that costs budget without changing the score.
  const list = jobs.map((j, i) =>
    `  {"i": ${i}, "title": ${JSON.stringify(j.title || "")}, ` +
    `"company": ${JSON.stringify(j.company || "")}, ` +
    `"location": ${JSON.stringify(j.location || "")}, ` +
    `"description": ${JSON.stringify((j.description || "").slice(0, 450))}}`
  ).join(",\n");

  return `You are a strict but fair job-matching assistant. Score how well each \
posting fits the candidate.

=== CANDIDATE CV ===
${(cvText || "").slice(0, 1600)}

Their field: ${field || "as shown in the CV"}
${baseLocation ? `They are based in: ${baseLocation}` : ""}

=== POSTINGS ===
[
${list}
]

For each posting give a score from 0 to 100 and one short, specific reason.
- 85-100 outstanding fit · 70-84 strong · 50-69 worth a look · below 50 poor.
- Be strict. Most postings are not a good fit; say so.
- SCORE 0 if the role requires several years of professional experience the CV
  doesn't show, if it demands fluent/business German (C1/C2, "verhandlungssicher")
  and the CV doesn't have it, or if it is simply a different profession.
  ("Grundkenntnisse", B1/B2 or "von Vorteil" are fine.)
- This is a search within GERMANY. Postings elsewhere have already been
  filtered out, so judge on fit rather than distance — but if one slips through
  and is clearly outside Germany (and not remote), score it 0 and say so.
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
  the field if none genuinely applies. This covers radio buttons too.
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
export function normalize(result) {
  const out = {};
  for (const key of ["fit_summary", "tailored_summary", "cover_letter"]) {
    const v = result[key];
    out[key] = typeof v === "string" ? v.trim() : String(v || "");
  }
  for (const key of ["matched_keywords", "missing_keywords", "suggestions"]) {
    out[key] = asStrList(result[key]);
  }
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

function wordSet(text) {
  const words = (text || "").toLowerCase().match(/[a-zäöüß0-9]+/g) || [];
  return new Set(words.filter((w) => w.length > 2));
}
