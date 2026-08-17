// profile_schema.js — the single description of what we ask the applicant.
//
// WHY THIS FILE EXISTS
//
// The questionnaire used to be 250 lines of hand-written HTML in
// onboarding.html plus a parallel KEYS array in onboarding.js, and two more
// hardcoded KEY_ANSWERS lists in popup.js and settings.js. Four places had to
// agree about what a complete profile is, and they didn't: the popup checked
// six keys, settings checked the same six, and the engine blocked on nine
// questions that had no field anywhere.
//
// Everything about a question now lives here once — its label, its control, its
// options, whether the submit gate blocks without it, and whether it is
// sensitive enough that we must not answer it without explicit consent. The
// wizard renders from this, and the completeness meters count from it.
//
// THE CONTRACT WITH THE ENGINE
//
// A key here is only worth asking if something downstream reads it. Each entry
// carries `proof`: the file that consumes the answer. Two consumers matter:
//
//   autofill.js FIELD_SPECS   the free rule pass — fills the field with no
//                             model turn at all, if a spec matches the key
//   confidence.js COMMITMENT_RE
//                             the submit gate — for a legal or contractual
//                             question the value MUST come from the saved
//                             profile verbatim, or the run pauses
//
// The second is why this file grew. COMMITMENT_RE blocks on criminal record,
// disability, veteran status, ethnicity, gender, race and business travel, and
// the old questionnaire could not hold a single one of those answers — so a
// standard Greenhouse EEO page ended every otherwise-complete run in a pause
// that told the user to "fill in the answer named above" on a page with no
// field for it. Adding the question is the whole fix.

/** Marks a question the submit gate (confidence.js) refuses to proceed without. */
const BLOCKS = "blocks";
/** Marks a question that is genuinely optional — nothing stalls without it. */
const NICE = "nice";

// ── Repeating-group column sets ─────────────────────────────────────────────
// Workday, Greenhouse, SmartRecruiters and Taleo all render work history and
// education as repeating groups. Retyping five jobs into five separate forms is
// the single largest chunk of manual work left in an "automatic" apply, and it
// is the same five jobs every time.

const WORK_COLUMNS = [
  { key: "employer", label: "Employer", control: "text", width: 2 },
  { key: "job_title", label: "Job title", control: "text", width: 2 },
  { key: "location", label: "Location", control: "text", width: 1 },
  { key: "start", label: "From", control: "month", width: 1 },
  { key: "end", label: "To", control: "month", width: 1,
    hint: "leave blank if this is your current role" },
  { key: "description", label: "What you did", control: "textarea", width: 4,
    hint: "one or two lines — the engine quotes this, it does not invent" },
];

const EDUCATION_COLUMNS = [
  { key: "school", label: "School or university", control: "text", width: 2 },
  { key: "degree", label: "Degree", control: "select", width: 1,
    options: ["High school", "Bachelor's", "Master's", "MBA", "PhD",
              "Ausbildung", "Other"] },
  { key: "field_of_study", label: "Field of study", control: "text", width: 2 },
  { key: "start", label: "From", control: "month", width: 1 },
  { key: "end", label: "To", control: "month", width: 1,
    hint: "expected date is fine" },
  { key: "grade", label: "Grade", control: "text", width: 1,
    hint: "e.g. 1.7, or 3.8 GPA" },
];

const REFERENCE_COLUMNS = [
  { key: "full_name", label: "Name", control: "text", width: 2 },
  { key: "relationship", label: "How they know you", control: "text", width: 2 },
  { key: "job_title", label: "Their job title", control: "text", width: 2 },
  { key: "company", label: "Company", control: "text", width: 2 },
  { key: "email", label: "Email", control: "email", width: 2 },
  { key: "phone", label: "Phone", control: "text", width: 2 },
];

const EMPLOYER_COLUMNS = [
  { key: "company_name", label: "Company", control: "text", width: 2 },
  { key: "relationship", label: "Your history with them", control: "select", width: 2,
    options: ["I worked there", "I applied before", "I interned there",
              "A relative works there"] },
  { key: "from", label: "From", control: "month", width: 1 },
  { key: "to", label: "To", control: "month", width: 1 },
];

const OTHER_COLUMNS = [
  { key: "question", label: "The question, as the form words it", control: "text", width: 3 },
  { key: "answer", label: "Your answer", control: "textarea", width: 3 },
];

// ── The flow ────────────────────────────────────────────────────────────────
// Ordered by decision, not by storage shape. Each step is 3–7 fields, which is
// what keeps a 40-question form from reading as a wall.

export const STEPS = [
  {
    id: "you",
    title: "You",
    blurb: "The block at the top of every application form, and the letterhead " +
           "on your cover letters.",
    fields: [
      { key: "first_name", label: "First name", control: "text", need: BLOCKS,
        proof: "autofill.js FIELD_SPECS first_name" },
      { key: "last_name", label: "Last name", control: "text", need: BLOCKS,
        proof: "autofill.js FIELD_SPECS last_name" },
      { key: "email", label: "Email", control: "email", need: BLOCKS,
        proof: "autofill.js FIELD_SPECS email" },
      { key: "phone", label: "Phone", control: "tel", need: BLOCKS,
        placeholder: "+49 …",
        hint: "With the country code. It is pasted into forms exactly as typed.",
        proof: "autofill.js FIELD_SPECS phone" },
      // New. autofill.js has matched these two since the beginning — patterns,
      // autocomplete mappings and a validator — but nothing could ever set
      // them, so resolveValue returned undefined and the box was left blank
      // without a word about it. cover_templates.js:47 builds the letterhead
      // from them too, so every exported letter has had an empty address.
      { key: "address", label: "Street address", control: "text", need: BLOCKS,
        isNew: true, proof: "autofill.js FIELD_SPECS address + cover_templates.js:47" },
      { key: "postal_code", label: "Postal code", control: "text", need: BLOCKS,
        isNew: true, proof: "autofill.js FIELD_SPECS postal_code + cover_templates.js:47" },
      { key: "city", label: "City", control: "text", need: BLOCKS,
        proof: "autofill.js FIELD_SPECS city" },
      { key: "country", label: "Country", control: "text", need: BLOCKS,
        proof: "autofill.js FIELD_SPECS country" },
    ],
  },

  {
    id: "links",
    title: "Links",
    blurb: "Asked by name on Lever, Ashby and SmartRecruiters.",
    fields: [
      { key: "linkedin_url", label: "LinkedIn profile", control: "url", need: NICE,
        placeholder: "https://linkedin.com/in/…",
        hint: "Paste the full address — a bare linkedin.com/in/you is submitted verbatim.",
        proof: "autofill.js FIELD_SPECS linkedin_url" },
      { key: "github_url", label: "GitHub", control: "url", need: NICE,
        proof: "autofill.js FIELD_SPECS github_url" },
      { key: "website_url", label: "Website or portfolio", control: "url", need: NICE,
        proof: "autofill.js FIELD_SPECS website_url" },
    ],
  },

  {
    id: "right-to-work",
    title: "Right to work",
    blurb: "Legal questions. The engine is forbidden from reasoning its way to " +
           "an answer here — it uses what you save below, or it stops and asks you.",
    fields: [
      { key: "work_authorization", control: "select", need: BLOCKS,
        label: "Are you legally authorised to work in the country you are applying in?",
        options: [
          "Yes — citizen or permanent resident",
          "Yes — EU/EEA freedom of movement",
          "Yes — I hold a work permit or visa",
          "Yes — Blue Card holder",
          "Yes — student visa (limited hours)",
          "No, not yet",
        ],
        proof: "confidence.js COMMITMENT_RE 'work authori|right to work'" },
      // Deliberately a separate question. It is commonly the inverse of the one
      // above — someone on a student visa is authorised now and will need
      // sponsorship later — and inferring one from the other is exactly the
      // reasoning the gate exists to forbid.
      { key: "requires_sponsorship", control: "select", need: BLOCKS,
        label: "Will you now or in the future need visa sponsorship?",
        options: ["No", "Yes", "Not sure — ask me each time"],
        hint: "This is the knock-out question on most US forms. It is asked " +
              "separately from the one above on purpose.",
        proof: "confidence.js COMMITMENT_RE 'sponsor|visa'" },
      // New. COMMITMENT_RE has always blocked on this and there was no field.
      { key: "criminal_record", control: "select", need: BLOCKS, isNew: true,
        label: "Have you ever been convicted of a criminal offence?",
        options: ["No", "Yes", "I will answer this myself each time"],
        hint: "Many US forms make this a required radio. Choosing the last " +
              "option keeps auto-apply running everywhere else and hands you " +
              "just this question.",
        proof: "confidence.js COMMITMENT_RE 'criminal|conviction|vorstraf'" },
    ],
  },

  {
    id: "availability",
    title: "Availability and pay",
    blurb: "The two questions most likely to stop a run, because a blank is not " +
           "an answer the engine is allowed to invent.",
    fields: [
      // Changed from free text to a select. setSelect (autofill.js:487) matches
      // a stored value against the form's own option list; free prose like
      // "immediately, or from 1 October" matches nothing on a dropdown.
      { key: "notice_period", control: "select", need: BLOCKS,
        label: "Notice period",
        options: ["Immediately available", "2 weeks", "1 month", "2 months",
                  "3 months", "More than 3 months"],
        proof: "confidence.js COMMITMENT_RE 'notice period|kündigungsfrist'" },
      { key: "notice_period_reference", control: "select", need: NICE, isNew: true,
        label: "Counted to",
        options: ["No fixed reference", "End of month", "15th of the month",
                  "End of quarter"],
        hint: "German statutory notice (§622 BGB) runs to the 15th or the end " +
              "of a month, so \"3 months\" on its own is an incomplete answer here.",
        proof: "emitted into the Anschreiben by tailor_core.js" },
      // New. notice_period absorbs "start date" as free text, but an
      // <input type=date> accepts nothing but yyyy-mm-dd.
      { key: "earliest_start_date", control: "date", need: NICE, isNew: true,
        label: "Earliest start date",
        hint: "Used when the form insists on a real date picker rather than a " +
              "sentence.",
        proof: "apply_engine.js date-input handling" },
      { key: "salary_expectation", control: "number", need: BLOCKS,
        label: "Salary expectation",
        placeholder: "55000",
        // The old form marked this "optional". It is the opposite of optional:
        // COMMITMENT_RE matches "salary", so a blank guarantees a paused run
        // the moment any form asks.
        hint: "Not optional in practice — the gate blocks a submit without it. " +
              "Tick \"negotiable\" below if you would rather not commit to a figure.",
        proof: "confidence.js COMMITMENT_RE 'salary|gehalt|compensation'" },
      { key: "salary_expectation_period", control: "select", need: NICE, isNew: true,
        label: "Per", options: ["Year", "Month", "Day", "Hour"],
        proof: "prevents a European annual figure landing in a US hourly box" },
      { key: "salary_expectation_basis", control: "select", need: NICE, isNew: true,
        label: "Gross or net", options: ["Gross (brutto)", "Net"],
        proof: "German convention is brutto; stating it makes the answer correct" },
      { key: "salary_negotiable", control: "checkbox", need: NICE, isNew: true,
        label: "Treat this figure as negotiable",
        hint: "Saves an explicit \"negotiable\" alongside the number, which " +
              "satisfies the gate instead of leaving it blank.",
        proof: "writes a citable sentinel rather than dropping the key" },
    ],
  },

  {
    id: "where",
    title: "Where and how you work",
    blurb: "",
    fields: [
      { key: "remote_preference", control: "select", need: NICE,
        label: "Preferred work setup",
        options: ["On-site", "Hybrid", "Remote", "Flexible — any"],
        proof: "autofill.js FIELD_SPECS remote_preference" },
      { key: "willing_to_relocate", control: "select", need: BLOCKS,
        label: "Are you willing to relocate?",
        options: ["Yes", "No", "For the right role", "Within the country"],
        proof: "confidence.js COMMITMENT_RE 'relocat|umzug'" },
      { key: "relocation_targets", control: "textarea", need: NICE, isNew: true,
        label: "Places you would move to",
        placeholder: "Munich, Stuttgart, Berlin — anywhere in Bavaria",
        hint: "Relocation is rarely a global yes or no. Naming the places lets " +
              "the engine answer honestly instead of guessing.",
        proof: "grounds a yes/no the user would actually stand behind" },
      // New. COMMITMENT_RE matches "willing to travel", but the nearest
      // existing key — willing_to_relocate — only matches relocation wording,
      // so "Are you willing to travel up to 30%?" fired the gate and hit nothing.
      { key: "willing_to_travel", control: "select", need: BLOCKS, isNew: true,
        label: "How much business travel are you willing to do?",
        options: ["None", "Occasionally", "Up to 25%", "Up to 50%", "Frequently"],
        proof: "confidence.js COMMITMENT_RE 'willing to travel'" },
      { key: "hours_per_week", control: "select", need: NICE,
        label: "Hours per week you are looking for",
        options: ["Full time (40)", "Part time (20–30)",
                  "Working student (max 20)", "Internship", "Contract"],
        proof: "autofill.js FIELD_SPECS hours_per_week" },
      { key: "driving_licence", control: "select", need: NICE,
        label: "Driving licence",
        options: ["None", "Class B (car)", "Class B + own vehicle", "Other"],
        proof: "autofill.js FIELD_SPECS driving_licence" },
      { key: "languages", control: "textarea", need: NICE,
        label: "Languages and levels",
        placeholder: "English C1, German B1, Hindi native",
        hint: "German level matters a lot for the German market — be specific.",
        proof: "autofill.js FIELD_SPECS languages" },
    ],
  },

  {
    id: "history",
    title: "History",
    blurb: "Workday and Greenhouse rebuild your CV as a form, one entry at a " +
           "time. Filled in once here, the engine types them in for you.",
    fields: [
      { key: "work_history", control: "repeating", need: NICE, isNew: true,
        label: "Work history", itemName: "role", columns: WORK_COLUMNS,
        proof: "Greenhouse employments[], Workday My Experience, Taleo Work Experience" },
      { key: "education", control: "repeating", need: NICE, isNew: true,
        label: "Education", itemName: "qualification", columns: EDUCATION_COLUMNS,
        proof: "Greenhouse educations[], SmartRecruiters education[]" },
    ],
  },

  {
    id: "voluntary",
    title: "Voluntary questions",
    blurb: "Employers are required to ask some of these and you are never " +
           "required to answer them. They are stored only if you fill them in, " +
           "and used only if you tick the box below.",
    // The whole step is behind one explicit consent. The gate blocks on
    // gender, ethnicity, veteran and disability, so without an answer every
    // Greenhouse and Workday EEO page ends in a pause — but the legal basis for
    // these questions is that answering is voluntary, so silently filling them
    // from a stored value is the one thing we must not do by default.
    consentKey: "eeo_autofill_consent",
    fields: [
      { key: "eeo_autofill_consent", control: "checkbox", need: NICE, isNew: true,
        label: "Let JobCopilot fill these in for me",
        hint: "Off by default. With it off, every answer below is still saved " +
              "for your own reference, but the engine hands the section back " +
              "to you instead of answering it.",
        proof: "gates every sensitive key below" },
      { key: "eeo_gender", control: "select", need: BLOCKS, sensitive: true, isNew: true,
        label: "Gender",
        options: ["Prefer not to say", "Male", "Female", "Non-binary"],
        proof: "confidence.js COMMITMENT_RE 'gender'" },
      { key: "eeo_race_ethnicity", control: "select", need: BLOCKS, sensitive: true, isNew: true,
        label: "Race or ethnicity (US EEO-1 categories)",
        options: ["Prefer not to say", "Hispanic or Latino", "White",
                  "Black or African American", "Asian",
                  "Native Hawaiian or Other Pacific Islander",
                  "American Indian or Alaska Native", "Two or more races"],
        proof: "confidence.js COMMITMENT_RE 'ethnicity|race'" },
      { key: "eeo_veteran_status", control: "select", need: BLOCKS, sensitive: true, isNew: true,
        label: "Veteran status (US, VEVRAA)",
        options: ["Prefer not to say", "I am not a protected veteran",
                  "Disabled veteran", "Recently separated veteran",
                  "Active duty wartime or campaign badge veteran",
                  "Armed Forces service medal veteran"],
        proof: "confidence.js COMMITMENT_RE 'veteran'" },
      { key: "eeo_disability_status", control: "select", need: BLOCKS, sensitive: true, isNew: true,
        label: "Disability self-identification (US Form CC-305)",
        options: ["Prefer not to say", "No, I do not have a disability",
                  "Yes, I have or have had a disability"],
        hint: "Health data. Held to a stricter rule than the rest: the engine " +
              "never re-words the employer's own form, and never answers this " +
              "without the tick above.",
        proof: "confidence.js COMMITMENT_RE 'disability'" },
      { key: "date_of_birth", control: "date", need: NICE, sensitive: true, isNew: true,
        label: "Date of birth",
        hint: "Asked by German forms (Personio, softgarden) and by the " +
              "tabellarischer Lebenslauf convention. Unlawful to require in " +
              "most US contexts — leave it blank if you would rather not.",
        proof: "German ATS forms; autofill.js BLOCKED still refuses ID numbers" },
      { key: "de_anrede", control: "select", need: NICE, sensitive: true, isNew: true,
        label: "Anrede (German forms)",
        options: ["Keine Angabe", "Herr", "Frau", "Divers"],
        hint: "Looks like a mundane salutation, but it is gender data under " +
              "AGG §1 — so it lives here rather than up in Contact.",
        proof: "near-universal on German application forms" },
    ],
  },

  {
    id: "finishing",
    title: "Finishing touches",
    blurb: "",
    fields: [
      { key: "how_heard", control: "select", need: NICE,
        label: "\"How did you hear about us?\"",
        options: ["Job board", "Company website", "LinkedIn", "Recruiter",
                  "Referral", "Event", "University", "Other"],
        hint: "Required often enough on Workday to block a submit.",
        proof: "autofill.js FIELD_SPECS how_heard" },
      { key: "employer_relationships", control: "repeating", need: NICE, isNew: true,
        label: "Companies you have worked for or applied to before",
        itemName: "company", columns: EMPLOYER_COLUMNS,
        hint: "Workday asks \"Have you ever worked for us?\" on nearly every " +
              "posting. It is the one question whose right answer depends on " +
              "which company is asking, so a single stored yes or no is wrong " +
              "somewhere — name the companies instead.",
        proof: "Workday tenant question; answer is a property of (you, company)" },
      { key: "references", control: "repeating", need: NICE, sensitive: true, isNew: true,
        label: "References", itemName: "reference", columns: REFERENCE_COLUMNS,
        hint: "Saved for your convenience and never submitted automatically — " +
              "handing over someone else's contact details is their decision, " +
              "not yours or ours.",
        proof: "Taleo References block, Workday optional references" },
      // The escape hatch. pause_help.js tells the user to "fill in the answer
      // named above", but the model may cite any key and this list is fixed —
      // so for anything not on it that instruction was unfollowable and Retry
      // landed on the identical wall. keyFromGrounding (apply_agent.js:1542)
      // already accepts any key present on the object, so a free-form pair is
      // immediately usable by the engine with no code change.
      { key: "other_answers", control: "repeating", need: NICE, isNew: true,
        label: "Other saved answers", itemName: "answer", columns: OTHER_COLUMNS,
        hint: "When a run pauses asking for something not on this form, add it " +
              "here and press Retry. The engine reads anything you put here.",
        proof: "apply_agent.js:1542 keyFromGrounding accepts any profile key" },
      { key: "cover_template", control: "template", need: NICE,
        label: "Cover letter style",
        proof: "cover_templates.js:227" },
    ],
  },
];

// ── Derived views ───────────────────────────────────────────────────────────

export const ALL_FIELDS = STEPS.flatMap((s) => s.fields);

/** Every storage key the wizard can write. */
export const ALL_KEYS = ALL_FIELDS.map((f) => f.key);

/** Keys whose absence stalls a real application, in the order they are asked. */
export const BLOCKING_KEYS = ALL_FIELDS
  .filter((f) => f.need === BLOCKS)
  .map((f) => f.key);

/** Keys the engine must not answer without eeo_autofill_consent. */
export const SENSITIVE_KEYS = ALL_FIELDS
  .filter((f) => f.sensitive)
  .map((f) => f.key);

export const fieldFor = (key) => ALL_FIELDS.find((f) => f.key === key) || null;

// Keys that are settings rather than answers. cover_template is the reason the
// "have they filled anything in?" gate in popup.js and settings.js silently
// stopped working: the old save seeded it unconditionally, so a profile with
// zero real answers had one key, counted as non-empty, and the questionnaire
// never opened itself again.
const NOT_AN_ANSWER = new Set(["cover_template", "eeo_autofill_consent"]);

const filled = (v) =>
  Array.isArray(v) ? v.length > 0
    : typeof v === "boolean" ? v
      : v !== undefined && v !== null && String(v).trim() !== "";

/** How many real questions this profile actually answers. */
export function answeredCount(profile) {
  const p = profile || {};
  return ALL_KEYS.filter((k) => !NOT_AN_ANSWER.has(k) && filled(p[k])).length;
}

/** Total number of real questions, for "11 of 34 answered". */
export const ANSWERABLE_TOTAL =
  ALL_KEYS.filter((k) => !NOT_AN_ANSWER.has(k)).length;

/** True when nothing has been answered — the signal to open the wizard. */
export function isEmptyProfile(profile) {
  return answeredCount(profile) === 0;
}

/** The blocking questions still unanswered, as field objects, in asking order. */
export function missingBlocking(profile) {
  const p = profile || {};
  return ALL_FIELDS.filter((f) => f.need === BLOCKS && !filled(p[f.key]));
}

/** One line describing profile completeness, shared by settings and the popup. */
export function completenessLine(profile) {
  const answered = answeredCount(profile);
  if (!answered) {
    return { text: "Not filled in yet — auto-apply has nothing to work from.",
             tone: "warn" };
  }
  const missing = missingBlocking(profile);
  if (!missing.length) {
    return { text: `${answered} of ${ANSWERABLE_TOTAL} answered ✓ — nothing is ` +
                   `left that would stall an application.`, tone: "good" };
  }
  return {
    text: `${answered} of ${ANSWERABLE_TOTAL} answered · ${missing.length} ` +
          `question${missing.length === 1 ? "" : "s"} left that ` +
          `${missing.length === 1 ? "stalls" : "stall"} auto-apply`,
    tone: "warn",
  };
}

export { BLOCKS, NICE };
