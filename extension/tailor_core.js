// tailor_core.js — the "Tailor" brain, ported from tailor.py.
//
// This is the SAME logic as the Python tailor.py: build a prompt from (job, CV),
// send it to Groq, normalise the JSON, and flag ungrounded bullets. Keeping the
// two in step matters — if you tune the prompt here, mirror it in tailor.py
// (or, later, extract the prompt to one shared template both load).
//
// Pure functions only (no chrome.* here) so this file stays testable and
// reusable by the background worker, a popup, or a future dashboard.

export const DEFAULT_MODEL = "openai/gpt-oss-120b";
export const MAX_TOKENS = 2200;

/**
 * Output ceiling for the Claude tailoring path.
 *
 * Much higher than the Groq one, and it has to be. Groq is asked for
 * response_format:json_object, which makes the model close the object inside
 * whatever budget it is given — 2200 tokens produces a tighter packet, not a
 * broken one. Anthropic has no equivalent switch here, so the same 2200 simply
 * ran out mid-object: three live tailorings came back with output_tokens of
 * exactly 2200, unparseable, and billed in full.
 *
 * A packet is a rewritten CV plus a 300-450 word cover letter plus keyword and
 * suggestion lists — realistically 2,500-3,500 tokens. 8000 is headroom, not a
 * target: max_tokens is a ceiling the model does not try to reach, so raising
 * it costs nothing on a normal packet and only stops the pathological one from
 * being silently cut in half.
 */
export const TAILOR_MAX_TOKENS = 8000;
/**
 * How much of the CV reaches the model.
 *
 * Was 4000, which was under the length of a real two-page CV — a live one
 * measured 4233 characters, so the last 233 were dropped on every single call.
 * A CV ends with languages, availability and "what I'm looking for", which is
 * exactly the material the cover-letter prompt asks the model to quote in its
 * closing paragraphs. So the truncation removed the facts the letter needed and
 * the model filled the hole itself: one live letter claimed an availability
 * date and a language level the model had never been shown.
 *
 * 12000 covers a long two-page CV whole. It costs about 3000 input tokens on
 * Haiku — a third of a cent — and it is the cheapest fabrication fix available,
 * because a fact the model can see is a fact it does not have to guess.
 */
const CV_LIMIT = 12000;
const JD_LIMIT = 3000;
// The ranking pass reads far less of each posting than the judging pass. It
// only has to tell an engineering role from a marketing one, and the title plus
// the opening of the description carries that; paying for the full requirements
// section 120 times to decide reading order is what blows the daily budget.
const RANK_JD_LIMIT = 900;
const LANG_NAME = { en: "English", de: "German" };

/**
 * A cheap fingerprint of a CV, used everywhere the question is "is this still
 * the CV that produced this?".
 *
 * Two callers, one meaning. The search profile stores it so a changed CV can't
 * keep hunting the previous field — swap in a different person's CV and it
 * would otherwise still search for yours. Each tailored packet stores it so a
 * saved packet is only ever reused for the CV it was written from; serving one
 * built from a replaced CV is worse than serving none, because it is wrong in a
 * way the user cannot see.
 *
 * profiles.updated_at cannot answer this: a BEFORE UPDATE trigger bumps it on
 * every write to the row, and the scan writes last_scan_at after every run, so
 * it moves every two hours whether or not the CV changed.
 *
 * djb2, not a cryptographic hash — it only has to detect change, and it carries
 * the length so two different CVs would have to collide on both. Whitespace is
 * normalised first, so reformatting a CV is not treated as rewriting it. Lives
 * here rather than in background.js so it is testable without the chrome API;
 * the algorithm is unchanged, because altering it would invalidate every
 * fingerprint already stored in a search profile.
 */
export function cvFingerprint(cv) {
  const text = (cv || "").replace(/\s+/g, " ").trim();
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}:${h.toString(36)}`;
}

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
- KEEP EVERY SECTION THE CV HAS. Dropping entries inside a section is editing;
  dropping the section is deleting part of the candidate's record. Education in
  particular must always appear, as must their most recent role and their
  highest qualification, however little the posting asks for them. A CV that
  arrives with no Education section reads as a gap, not as focus.
- Every bullet must be traceable to the entry it sits under.
- Keep every "Skills" item to words that appear in the CV.
- Order sections the way this job would want them read, and put the entries
  that matter most to this posting first within each section.

${COVER_LETTER_RULES}

Aim for 4-7 items in "relevant_experience". Respond with ONLY the JSON object.`;
}

/**
 * The cover-letter half of the prompt, shared by both CV paths.
 *
 * Extracted when the .docx path arrived and needed the identical rules. Two
 * copies of a 40-line prompt is how the tailoring rules and tailor.py quietly
 * drifted apart in the first place, and the anti-fabrication clauses in here
 * are the ones it costs most to lose from one branch.
 */
const COVER_LETTER_RULES = `COVER LETTER — this is the part candidates are judged on, so make it specific:
- Write the BODY ONLY: no letterhead, no date, no subject line, no "Dear ...",
  no sign-off and no name. Those are added around it automatically.
- 5 or 6 paragraphs separated by blank lines, and BETWEEN 340 AND 450 WORDS.
  Count them before you answer. Letters written to this prompt come back at
  260-320 words far more often than not, which is a page half-filled: it reads
  as though the candidate had little to say. If your draft is under 340 words,
  the fix is more specifics from the CV — a named tool, a number, an outcome —
  not more adjectives.
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
- NOTHING IN "missing_keywords" MAY BE CLAIMED HERE, in any tense. You have
  just listed those as things the CV does not show, and the letter is the same
  document set — writing that the candidate is doing, pursuing, studying for,
  holding or about to obtain one of them contradicts your own analysis and puts
  a false claim in their name. A live letter did exactly this: it listed a
  licence under missing_keywords, then wrote "I am also pursuing" it. Saying
  they are willing to learn something is fine. Saying they have started is not.
- Do NOT turn "suggestions" into sentences. Those are advice for the candidate
  about what they could do next; the letter reports only what is already true.
- Availability, notice period and start date: state them ONLY if the CV states
  them. If it does not, say nothing about when they can start — do not write
  "available immediately", and do not infer a date from anything.
- Language levels: exactly as the CV writes them. If the CV says B1, do not
  write "working proficiency"; if the CV is silent on a language, omit it.
- First person, warm but professional, plain language.`;

/**
 * Tailoring for a candidate who uploaded their own Word CV.
 *
 * The other prompt asks the model to WRITE a CV, and the renderer then draws it
 * in our layout. This one asks it to EDIT the user's, and nothing is drawn at
 * all — their file comes back as their file, with different words in a handful
 * of paragraphs. See docx_edit.js for why that is both better and, once you
 * notice how small the edit surface is, easier.
 *
 * The model never sees XML and cannot create a paragraph. It is handed the
 * blocks that were classified as safe to rewrite and may return, for each, new
 * text or null. Everything else about the document is beyond its reach — which
 * is a stronger anti-fabrication guarantee than any instruction, because there
 * is physically nowhere to put an invented employer.
 */
export function buildDocxPrompt(job, blocks, cvText, language = "en") {
  const langName = LANG_NAME[language] || "English";
  const desc = (job.description || "").slice(0, JD_LIMIT);

  const editable = blocks.filter((b) => b.editable);
  const list = editable.map((b) =>
    `  {"id": "${b.id}", "kind": "${b.kind}", "max_chars": ${budgetFor(b.chars)}, ` +
    `"text": ${JSON.stringify(b.text)}}`).join(",\n");

  // Locked blocks are shown, without ids, purely as context. The model writes
  // better bullets when it can see which employer they sit under, and showing
  // them with no id is the clearest possible way to say "read, do not touch".
  const context = blocks.filter((b) => !b.editable && b.text)
    .map((b) => `  [${b.kind}] ${b.text}`).join("\n");

  return `You are an expert career coach editing a candidate's existing CV for \
ONE specific job. Write in ${langName}.

=== JOB POSTING ===
Title: ${job.title || "N/A"}
Company: ${job.company || "N/A"}
Location: ${job.location || "N/A"}
Description:
${desc}

=== THE CANDIDATE'S CV (the ONLY source of truth about them) ===
${(cvText || "").slice(0, CV_LIMIT)}

=== BLOCKS YOU MAY EDIT ===
[
${list}
]

=== BLOCKS YOU MAY NOT EDIT (context only — they have no id for a reason) ===
${context}

=== YOUR TASK ===
Rewrite the editable blocks so this CV argues for THIS job, then write a cover
letter.

HOW EDITING WORKS:
- Return new text for a block, or null to remove it. You cannot add a block,
  and you cannot touch anything not in the editable list.
- MAX_CHARS IS A HARD LIMIT, not a suggestion. This is the candidate's real
  document with their real page breaks; a block that grows pushes their
  one-page CV onto a second page, which is a worse outcome than not tailoring
  at all. An edit over its limit is discarded and the original kept, so going
  long does not get you a longer bullet — it gets you no edit.
- Leave a block out of your answer entirely if it is already right for this
  job. Rewriting for the sake of it makes a CV worse.
- Drop a block (null) only when it is genuinely irrelevant here AND its entry
  keeps at least one bullet. Never leave an employer or a degree with nothing
  underneath it — that reads as a gap, not as focus.

WHAT YOU MAY AND MAY NOT CHANGE:
- You MAY re-emphasise, re-order the words within a bullet, lead with the part
  this job cares about, and use the posting's vocabulary where the CV genuinely
  supports it.
- You MAY NOT introduce a tool, a technology, a number, a result, a client, a
  responsibility or a qualification that is not already in this CV. Not one.
  Every word of every rewrite must be traceable to the block you are rewriting
  or to the entry it sits under.
- Do not translate. Do not "standardise" job titles or company names. If the
  block is in German, the rewrite is in German.
- Keep the same grammatical shape: a bullet that starts with a past-tense verb
  still starts with a past-tense verb.

Return a JSON object in EXACTLY this shape:
{
  "fit_score": <int 0-100 — 85+ outstanding, 70-84 strong, 50-69 worth a look,
                below 50 poor. Be strict, and score 0 if it is a different
                profession, needs years of experience the CV lacks, or demands
                fluent German the CV doesn't show>,
  "fit_summary": "<one honest sentence on overall fit, strengths and gaps>",
  "tailored_summary": "<3-4 sentence summary tuned to THIS role, from the CV>",
  "cv_edits": {"<block id>": "<new text, within max_chars>", "<block id>": null},
  "matched_keywords": ["<job requirement the CV genuinely supports>"],
  "missing_keywords": ["<job requirement the CV does NOT support>"],
  "suggestions": ["<honest positioning tip or gap-mitigation>"],
  "cover_letter": "<the BODY of the cover letter — see rules below>"
}

${COVER_LETTER_RULES}

Respond with ONLY the JSON object.`;
}

/**
 * The character budget for one block.
 *
 * Mirrors docx_edit.js's GROWTH and GROWTH_SLACK, which is where the limit is
 * actually enforced. Telling the model a number the validator disagrees with
 * would produce edits that are silently discarded and a CV that came back
 * untailored for no visible reason.
 */
function budgetFor(chars) {
  return Math.floor(chars * 1.08) + 12;
}

/**
 * The same tailoring prompt, shaped for the Anthropic Messages API.
 *
 * Deliberately a thin wrapper over buildPrompt rather than a reordered copy.
 * The obvious move would be to split the rules and the CV into cached system
 * blocks with the job posting last — but the cheapest model that can do this
 * job, Haiku 4.5, only caches prefixes of 4096 tokens or more, and the whole
 * prompt is around 1,500. Reordering would buy nothing today and would leave
 * two copies of a 100-line prompt to keep in step, which is how the tailoring
 * rules and tailor.py quietly drift apart.
 *
 * If tailoring ever moves to a model with a lower cache minimum, this is the
 * function to split — buildPrompt stays as the Groq/Python-mirrored original.
 */
export function buildTailorMessages(job, cvText, language = "en") {
  return {
    system: "You are an expert career coach and CV writer. You answer with a " +
            "single JSON object and nothing else — no prose, no code fences.",
    messages: [
      { role: "user", content: buildPrompt(job, cvText, language) },
    ],
  };
}

/**
 * Pull a JSON object out of a model's reply.
 *
 * Groq is asked for response_format:json_object and answers with bare JSON.
 * Anthropic has no equivalent switch here, so however firmly the prompt says
 * "ONLY the JSON object", the reply can arrive wrapped in ```json fences or
 * with a sentence in front of it. Both are easy to recover from and neither is
 * worth failing a paid call over.
 */
export function extractJson(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch { /* not bare JSON — keep going */ }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* fenced but still malformed */ }
  }

  // Last resort: the outermost {...}. Slicing between the first brace and the
  // last is enough for a preamble or a trailing sign-off, which is all we have
  // ever seen; anything more broken than that should fail loudly.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }

  throw new Error("The model did not return JSON.");
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

/**
 * Stage one of scoring: order a batch of postings, cheaply.
 *
 * This runs on the small fast model, whose free-tier budget is five times
 * larger than the big one's — a separate pool, so spending it costs the careful
 * pass nothing. Three things keep it cheap: a one-line profile instead of the
 * CV, a short slice of each posting, and scores with no reasons (the reason is
 * most of the output tokens, and nothing reads a rank's reason).
 *
 * IT RANKS, IT DOES NOT REJECT. The small model's failure mode is documented
 * and specific: it rejects good postings confidently and wrongly — an FEM
 * engineering role read as marketing, with FEM on the candidate's CV. That is
 * survivable when its only job is deciding what the big model looks at first,
 * and unacceptable if it can drop a posting outright. Every posting it ranks is
 * still recorded; the ranking only decides who gets judged properly.
 */
export function buildRankPrompt(jobs, sp = {}, baseLocation = "") {
  const field = (sp.domain && sp.domain.name) || sp.field || "";
  const level = sp.career_level || "";
  const persona = sp.persona || "";

  const list = jobs.map((j, i) =>
    `  {"i": ${i}, "title": ${JSON.stringify(j.title || "")}, ` +
    `"company": ${JSON.stringify(j.company || "")}, ` +
    `"description": ${JSON.stringify((j.description || "").slice(0, RANK_JD_LIMIT))}}`
  ).join(",\n");

  return `Rank how relevant each posting is to this candidate.

CANDIDATE
Field: ${field || "as implied by the postings"}
${level ? `Career level: ${level}` : ""}
${persona ? `About them: ${persona}` : ""}
${baseLocation ? `Based in: ${baseLocation}` : ""}

POSTINGS
[
${list}
]

Give each posting a relevance score from 0 to 100.
- Judge on profession and level. A posting in a different profession scores low.
- Do not judge location. Every posting shown has already passed a location filter.
- This is a first pass to decide reading order, not a final verdict. When you
  are unsure, score in the middle rather than at either extreme.

Respond with ONLY a JSON object in exactly this form, and no reasons:
{"ranks": [{"i": 0, "score": 72}]}`;
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

/**
 * The .docx path's answer: a map of block id to replacement text, or null to
 * drop the block.
 *
 * Shape-only, like normalizeCv. Whether an edit is ALLOWED (is that block
 * editable? is it within its character budget?) is decided in docx_edit.js,
 * against the document itself — this function has never seen the CV and is in
 * no position to judge. All it does is throw away entries that aren't
 * "id → string | null" so the applier can trust what it iterates.
 *
 * Returns null rather than {} when there is nothing usable, so callers can tell
 * "this is a docx packet with no edits" from "this is not a docx packet".
 */
function normalizeEdits(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^p\d+$/.test(id)) continue;
    if (value === null) { out[id] = null; continue; }
    const text = typeof value === "string" ? value.trim() : "";
    // An empty string means the same thing as null coming from a model that
    // dislikes nulls, and the applier already treats the two alike.
    out[id] = text || null;
  }
  return Object.keys(out).length ? out : null;
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
  out.cv_edits = normalizeEdits(result.cv_edits);

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

/**
 * The cover letter's own guardrail — the one that was missing.
 *
 * groundingWarnings checks relevant_experience and cvGroundingWarnings checks
 * the CV, so between them every structured field was verified. The letter, the
 * one part of the packet written as free prose and the part an employer
 * actually reads, was checked by nothing at all. A live packet went out saying
 * "I am also pursuing the Prototypenführerschein" — a licence the CV never
 * mentions, which the model had itself listed under missing_keywords and
 * recommended under suggestions one field earlier.
 *
 * That failure is what makes this checkable without a second model call. The
 * model has already written down what the candidate lacks; we only have to
 * notice when the letter contradicts it. Three checks, in falling order of
 * confidence:
 *
 *   1. a gap named in missing_keywords turning up in the letter
 *   2. an availability or start-date claim the CV does not support
 *   3. a language level the CV does not state
 *
 * These are ADVISORY. A letter may legitimately mention a gap — "I am keen to
 * learn Vector tools" is honest and good — so this cannot be an auto-reject
 * without throwing away decent letters. It surfaces the sentence and lets a
 * human decide, which is the same contract as every other warning here.
 */

// Words too common to identify anything. A missing keyword of "Experience in
// automotive testing" must not match the letter on "experience" alone.
const COMMON = new Set([
  "experience", "knowledge", "skills", "years", "tools", "work", "working",
  "professional", "technical", "systems", "system", "development", "engineering",
  "management", "analysis", "design", "testing", "documented", "related",
  "relevant", "strong", "good", "with", "and", "the", "for", "erfahrung",
  "kenntnisse", "jahre", "gute", "sehr", "und", "oder", "mit",
  // Added after the first run over live packets flagged all of these. They are
  // the words a gap phrase and an honest sentence share by coincidence: the gap
  // "delta testing workflows" matched a letter describing "repair workflows",
  // which is a real thing the candidate did and no claim about the gap at all.
  "workflow", "workflows", "process", "processes", "measurement", "driving",
  "vehicle", "prozess", "prozesse", "erfahrungen",
  // Advice vocabulary. suggestions are whole sentences of it, and every one of
  // these words turns up in an ordinary cover letter without meaning anything.
  "consider", "obtaining", "before", "after", "immediately", "concrete",
  "achievable", "credential", "employers", "explicitly", "position",
  "positioning", "mention", "clarify", "include", "including", "interview",
  "interviews", "willingness", "express", "frame", "framing", "highlight",
  "emphasise", "emphasize", "demonstrate", "consider", "should", "could",
  "would", "which", "their", "there", "these", "those", "about", "candidate",
]);

/** The words in a phrase that actually identify it. */
function distinctive(phrase) {
  return (String(phrase || "").toLowerCase().match(/[a-zäöüß][a-zäöüß0-9-]{4,}/g) || [])
    .filter((w) => !COMMON.has(w));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word containment, not substring.
 *
 * Substring matching read "signal processing" as a claim about the gap
 * "Automotive SPICE ... process experience", because "processing" contains
 * "process". German compounds are the reason this still works for the case that
 * matters: "Prototypenführerschein" appears in the letter as its own word, so a
 * word-boundary test finds it without needing to match its parts.
 */
function mentions(haystack, term) {
  return new RegExp(`\\b${escapeRe(term)}\\b`, "i").test(haystack);
}

/**
 * The sentence a term appears in, windowed around the term itself.
 *
 * Truncating from the start of the sentence hid the very word being flagged —
 * the letter joins clauses with semicolons, so the sentence carrying "Vector"
 * ran past 120 characters before reaching it and the excerpt showed none of
 * the relevant half.
 */
function sentenceWith(text, term, width = 130) {
  for (const s of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    const at = s.toLowerCase().indexOf(term);
    if (at === -1) continue;
    const sentence = s.trim();
    if (sentence.length <= width) return sentence;
    const from = Math.max(0, at - Math.floor(width / 3));
    return (from ? "…" : "") + sentence.slice(from, from + width).trim() +
           (from + width < sentence.length ? "…" : "");
  }
  return "";
}

const AVAILABILITY = /\b(available|availability|start(ing)? (date|immediately|from)|immediate(ly)?|notice period|verf(ü|ue)gbar|ab sofort|kündigungsfrist|eintrittstermin)\b/i;
const CV_STATES_AVAILABILITY = /\b(available|availability|start(ing)? date|notice period|from \d|verf(ü|ue)gbar|ab sofort|kündigungsfrist|eintrittstermin|immediately)\b/i;
const LANG_CLAIM_G = /\b(fluent|native|mother ?tongue|business[- ]level|working proficiency|conversational|[ABC][12])\b/gi;

export function coverLetterWarnings(result, cvText) {
  const letter = String(result?.cover_letter || "");
  if (!letter.trim()) return [];

  const lower = letter.toLowerCase();
  const cv = String(cvText || "").toLowerCase();

  // Warnings carry the sentence they came from so duplicates can be collapsed
  // at the end. One bad sentence can trip several checks at once — "available
  // to start immediately" is both an availability claim and, if a suggestion
  // used the word, a gap mention — and three warnings pointing at one sentence
  // read as three problems.
  const found = [];
  const warn = (message, sentence) => found.push({ message, sentence });

  // 1. Gaps the model named, then wrote about anyway.
  //
  // Both lists, not just missing_keywords. suggestions is the other half of the
  // same leak and arguably the more dangerous one, because a suggestion is by
  // definition something the candidate has NOT done yet — "consider obtaining
  // the Prototypenführerschein" is advice, and the letter turned it into "I am
  // also pursuing the Prototypenführerschein". Checking only missing_keywords
  // caught the live case by luck, because that packet happened to list the
  // licence in both; a packet that mentions it in one would have gone out clean.
  //
  // One warning per phrase, keyed on its longest matching term. Per-term would
  // be noisier and mostly duplicated: German compounds contain their own parts,
  // so "Prototypenführerschein" matches on "prototype", "prototypen" and the
  // whole word, and three warnings about one sentence is a wall to scroll past.
  const seen = new Set();
  const claims = [...(result?.missing_keywords || []),
                  ...(result?.suggestions || [])];
  for (const gap of claims) {
    // A term already in the CV is not a gap the letter invented, whatever the
    // model put in missing_keywords — the CV is the source of truth.
    const hits = distinctive(gap)
      .filter((t) => !mentions(cv, t) && mentions(lower, t))
      .sort((a, b) => b.length - a.length);
    if (!hits.length || seen.has(hits[0])) continue;
    seen.add(hits[0]);
    const sentence = sentenceWith(letter, hits[0]);
    warn(
      `the letter mentions "${hits[0]}", which you listed as a gap — check it ` +
      `reads as willingness, not as a claim` +
      (sentence ? `: "${sentence}"` : ""), sentence);
  }

  // 2. An availability claim needs a CV that says something about availability.
  if (AVAILABILITY.test(letter) && !CV_STATES_AVAILABILITY.test(cv)) {
    const sentence = sentenceWith(letter, "available") ||
                     sentenceWith(letter, "immediately");
    warn(
      `the letter states when you can start, but your CV doesn't say` +
      (sentence ? `: "${sentence}"` : ""), sentence);
  }

  // 3. Language levels are checked verbatim, because "B1" and "working
  //    proficiency" are different claims and only one of them may be yours.
  const levels = new Set();
  for (const m of letter.matchAll(LANG_CLAIM_G)) {
    const level = m[0].toLowerCase();
    if (levels.has(level) || cv.includes(level)) continue;
    levels.add(level);
    warn(`the letter describes a language level as "${m[0]}", which is not how ` +
         `your CV words it`, sentenceWith(letter, level));
  }

  // Collapse to one warning per offending sentence, keeping the first — the
  // checks run in falling order of confidence, so the first is the most useful
  // description of what is wrong with it.
  const bySentence = new Set();
  return found.filter(({ sentence }) => {
    if (!sentence) return true;
    if (bySentence.has(sentence)) return false;
    bySentence.add(sentence);
    return true;
  }).map((w) => w.message);
}

/**
 * A letter far under the target length reads as a page half-filled.
 *
 * Separate from the fabrication checks because it is a quality signal rather
 * than a correctness one, but it shares their delivery: the panel already shows
 * a warnings list, and this belongs in it. The prompt asks for 340-450 words;
 * live packets came back at 261, 270, 287, 296, 304, 309 and 318. 300 is the
 * floor for complaining, so a letter that lands just under target doesn't nag.
 */
export function coverLetterLengthWarning(result) {
  const letter = String(result?.cover_letter || "").trim();
  if (!letter) return null;
  const words = letter.split(/\s+/).filter(Boolean).length;
  if (words >= 300) return null;
  return `the cover letter is ${words} words — short for a full letter (aim ` +
         `340-450); re-tailor if it reads thin`;
}
