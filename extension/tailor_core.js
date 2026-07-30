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
