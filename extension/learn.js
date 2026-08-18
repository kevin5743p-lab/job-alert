// learn.js — what the engine remembers between applications.
//
// THE GAP THIS FILLS
//
// `apply_runs.steps` records every action of every application, with the
// grounding it claimed. It is a good audit trail and it was never read back.
// So the eleventh application to a company's Workday tenant repeats the first
// one's mistakes exactly: it does not know the tenant wants an account, that
// the CV upload hides behind "Autofill with Resume", or that the German label
// "Kündigungsfrist" is the notice-period question.
//
// Two things are remembered, and they are different in kind:
//
//   a LESSON      a problem, and the fix that worked. Scoped, because
//                 "Workday hides the upload" is true of every Workday tenant
//                 while "this employer wants a photograph" is true of one.
//
//   a PLAYBOOK    what applying to one employer actually involves. Not a
//                 problem — just how it goes here. This is the "at BMW I need
//                 this, at Volkswagen I need that" half.
//
// THE PART THAT MAKES IT A LOOP
//
// Writing a fix down is not learning; anyone can keep a diary. The loop closes
// because every run records which remedies it was carrying (`applied_lessons`)
// and how far it got (`reached`), and the *next* run at the same problem
// compares the two. A remedy that stops moving runs further along is retired.
// Without that, a system accumulates confident advice and never finds out that
// half of it is wrong.
//
// WHAT IT COSTS
//
// Nothing on a clean submit: everything worth keeping from a successful
// application — the questions asked, the answers that went through, the
// documents wanted — is already in the step log in structured form, and is
// extracted deterministically. The model is only asked about a run that
// stopped, because "why did this stop and what would fix it" is the only
// question here that needs judgement.

import {
  recordLesson, settleLessons, activeLessons,
  getPlaybook, upsertPlaybook, saveApplyOutcome,
} from "./supabase.js";
import { normalizeCompany } from "./job_key.js";
import { helpForPause } from "./pause_help.js";
import { callClaude } from "./ai_client.js";

// ── the shape of a fix ──────────────────────────────────────────────────────
//
// A closed set, on purpose. A remedy of `{text: "be more careful"}` is a note:
// something to show the user and paste at a model, and nothing autofill or the
// submit gate can execute. Each kind below has a reader somewhere that acts on
// it, and a remedy of any other kind is dropped rather than stored.
export const REMEDY_KINDS = {
  // A form label means a saved answer. Read into the local field-map cache, so
  // the next form with this label fills for free and without a model call.
  profile_answer: ["label", "profile_key"],
  // A screening question and the answer that was actually sent. Read into the
  // prompt, and offered to the user for their saved custom answers.
  saved_answer: ["question", "answer"],
  // This employer/ATS demands an attachment. Read by the submit gate.
  document_required: ["doc_kind"],
  // How the flow behaves here. Read into the prompt — the one kind that is
  // legitimately prose, because navigation advice cannot be enumerated.
  flow_hint: ["text"],
  // Applying here needs an account first. Read before the run starts, so it
  // can be said upfront instead of discovered four minutes in.
  account_required: ["note"],
  // Something that made it worse. The negative case matters: without it the
  // memory only ever grows more things to try.
  avoid: ["text"],
};

/** A remedy is stored only if its shape is one a reader can act on. */
function validRemedy(r) {
  const fields = REMEDY_KINDS[r?.kind];
  if (!fields) return false;
  return fields.every((f) => typeof r[f] === "string" && r[f].trim());
}

// ── where a lesson applies ──────────────────────────────────────────────────

// Keyed on the hostnames domain_health.js and resolve_ats.js already know. An
// ATS-scoped lesson is the highest-leverage kind there is: learn Workday's
// upload behaviour once at one employer and every Workday tenant benefits.
const ATS_HOSTS = [
  [/myworkdayjobs\.com|myworkdaysite\.com/, "workday"],
  [/greenhouse\.io/, "greenhouse"],
  [/lever\.co/, "lever"],
  [/ashbyhq\.com/, "ashby"],
  [/smartrecruiters\.com/, "smartrecruiters"],
  [/personio\.(de|com)/, "personio"],
  [/recruitee\.com/, "recruitee"],
  [/workable\.com/, "workable"],
  [/teamtailor\.com/, "teamtailor"],
  [/successfactors\.(eu|com)|sapsf\.(eu|com)/, "successfactors"],
  [/icims\.com/, "icims"],
  [/taleo\.net/, "taleo"],
  [/avature\.net/, "avature"],
  [/softgarden\.(de|io)/, "softgarden"],
  [/concludis\.de|dvinci\.de|rexx-systems\.com/, "german_smb"],
  [/linkedin\.com/, "linkedin"],
];

/** Which applicant-tracking system a host belongs to, or null. */
export function atsOf(urlOrDomain) {
  const s = String(urlOrDomain || "").toLowerCase();
  for (const [re, name] of ATS_HOSTS) if (re.test(s)) return name;
  return null;
}

/**
 * The scopes a job is in, narrowest first.
 *
 * Order is the precedence order: when a company-scoped lesson and an
 * ATS-scoped one describe the same problem, the company's wins, because it was
 * learned somewhere more specific than the general rule.
 */
export function scopesFor({ company, ats, domain } = {}) {
  const out = [];
  const companyKey = normalizeCompany(company);
  if (companyKey) out.push({ scope: "company", scope_key: companyKey });
  if (domain) out.push({ scope: "domain", scope_key: domain });
  if (ats) out.push({ scope: "ats", scope_key: ats });
  out.push({ scope: "global", scope_key: "" });
  return out;
}

// ── how far a run got ───────────────────────────────────────────────────────
//
// Derived from the step log rather than threaded through runApply as a
// variable, because every early return in that function would have to remember
// to set it and three of them already forgot to set `status`.
//
// Deliberately coarse. "Reached the submit gate and was refused" is a real
// improvement over "paused on page one", and a remedy that moves a run from 2
// to 4 has earned its place whether or not the application went out.
export const CHECKPOINTS =
  ["nothing", "page_ready", "form_filled", "docs_attached", "gate_reached", "submitted"];

export function reachedFrom(steps = [], status = "") {
  if (status === "submitted") return 5;
  let r = 0;
  for (const s of steps) {
    if (s.kind === "page_ready") r = Math.max(r, 1);
    if (s.kind === "autofill" && (s.filled || 0) > 0) r = Math.max(r, 2);
    if (s.kind === "upload") r = Math.max(r, 3);
    if (s.kind === "action" && /submit blocked|all checks passed|refused the submit/i
        .test(s.result || "")) r = Math.max(r, 4);
  }
  return r;
}

// ── recall: what we know before a run starts ────────────────────────────────

/** Lessons that have earned their place, best first. */
function rank(lessons) {
  const score = (l) =>
    (l.pinned ? 1000 : 0) +
    (l.times_worked * 3) - (l.times_failed * 2) +
    Math.min(l.times_seen, 5) +
    ({ company: 3, domain: 2, ats: 1, global: 0 }[l.scope] || 0);
  return [...lessons].sort((a, b) => score(b) - score(a));
}

// The prompt block is capped. Recall that grows without bound would eventually
// cost more per application than the application, and the tail of a ranked list
// is by construction the part that has proved least useful.
const MAX_LESSONS_IN_PROMPT = 12;
const MAX_QUESTIONS_IN_PROMPT = 10;

/**
 * Everything remembered about this job, ready to be used.
 *
 * Returns null-ish safely: a user with no history gets `{ lessons: [], ... }`
 * and an empty prompt block, and every caller treats that as "behave exactly as
 * before". Recall failing must never stop an application — this is an
 * improvement to a run, not a precondition for one.
 */
export async function recallFor({ company, domain, url } = {}) {
  const ats = atsOf(url || domain);
  const companyKey = normalizeCompany(company);
  const scopes = scopesFor({ company, ats, domain });

  const [lessons, playbook] = await Promise.all([
    activeLessons(scopes).catch(() => []),
    companyKey ? getPlaybook(companyKey).catch(() => null) : null,
  ]);

  const ranked = rank(lessons);

  // Deduplicate by the problem, keeping the narrowest scope's answer. Two
  // lessons about the same field — one learned at this employer, one across
  // the whole ATS — must not both be quoted at the model as if they were
  // independent evidence.
  const seen = new Set();
  const chosen = [];
  for (const l of ranked) {
    const k = `${l.problem_kind}|${l.signature}`;
    if (seen.has(k)) continue;
    seen.add(k);
    chosen.push(l);
  }

  return {
    ats,
    companyKey,
    playbook,
    lessons: chosen,
    lessonIds: chosen.map((l) => l.id),
    requiredDocuments: documentsFrom(chosen, playbook),
    fieldHints: fieldHintsFrom(chosen),
    upfront: upfrontFrom(chosen, playbook),
    promptBlock: promptBlockFor({ company, ats, playbook, lessons: chosen }),
  };
}

/** Attachments this employer is known to want, for the submit gate. */
function documentsFrom(lessons, playbook) {
  const docs = new Set(playbook?.required_documents || []);
  for (const l of lessons) {
    if (l.remedy?.kind === "document_required") docs.add(l.remedy.doc_kind);
  }
  return [...docs];
}

/** label -> profile_key, for the free rule-based pass. */
function fieldHintsFrom(lessons) {
  const hints = {};
  for (const l of lessons) {
    if (l.remedy?.kind === "profile_answer") hints[l.remedy.label] = l.remedy.profile_key;
  }
  return hints;
}

/**
 * What the user should be told before the run starts, not after.
 *
 * An employer whose tenant needs an account is a four-minute run with a
 * foregone conclusion. Knowing it in advance turns that into a sentence.
 */
function upfrontFrom(lessons, playbook) {
  const notes = [];
  if (playbook?.account_required) {
    notes.push(playbook.account_note ||
      "this employer's system needs an account — the run will stop at the login");
  }
  for (const l of lessons) {
    if (l.remedy?.kind === "account_required") notes.push(l.remedy.note);
  }
  return [...new Set(notes)];
}

/**
 * The `<learned>` block.
 *
 * WHERE THIS GOES IN THE PROMPT MATTERS FINANCIALLY. It is appended *after*
 * the cache breakpoint that follows the CV, next to `<documents>`. The system
 * prompt, tools, profile and CV are byte-identical on every step of every job,
 * which is what turns a ~6K-token prefix into a ~600-token cache read. This
 * block is per-company by definition, so putting it inside the cached prefix
 * would invalidate that prefix on every application at every employer — paying
 * full price on all 25 steps to save a lookup. See buildSystem() in
 * apply_agent.js.
 */
export function promptBlockFor({ company, ats, playbook, lessons = [] }) {
  const lines = [];

  const label = company || "this employer";
  if (playbook?.runs) {
    const bits = [];
    if (playbook.submitted) bits.push(`${playbook.submitted} submitted`);
    if (playbook.paused) bits.push(`${playbook.paused} needed the applicant`);
    if (playbook.failed) bits.push(`${playbook.failed} failed`);
    lines.push(`You have applied to ${label} ${playbook.runs} time(s) before` +
               (bits.length ? `: ${bits.join(", ")}.` : "."));
  }

  const needs = [];
  if (playbook?.account_required) {
    needs.push(`An account on their system is required. ${playbook.account_note || ""}`.trim());
  }
  if (playbook?.required_documents?.length) {
    needs.push(`They want these attached: ${playbook.required_documents.join(", ")}.`);
  }
  if (needs.length) lines.push("", "What this employer needs:", ...needs.map((n) => `- ${n}`));

  const asked = (playbook?.known_questions || [])
    .filter((q) => q.worked !== false)
    .slice(0, MAX_QUESTIONS_IN_PROMPT);
  if (asked.length) {
    lines.push("", "Questions they have asked before, and the answer that went through:");
    for (const q of asked) {
      lines.push(`- "${q.question}" → ${q.profile_key ? `${q.profile_key}: ` : ""}"${q.answer}"`);
    }
    lines.push("Re-use these only where the question is genuinely the same one. " +
               "They are a record of what was sent, not a licence to answer a new question.");
  }

  const flow = (playbook?.flow_notes || []).map((n) => n.note).filter(Boolean);
  const hints = lessons.filter((l) => l.remedy?.kind === "flow_hint").map((l) => l.remedy.text);
  const all = [...new Set([...flow, ...hints])].slice(0, MAX_LESSONS_IN_PROMPT);
  if (all.length) lines.push("", "How the flow behaves here:", ...all.map((t) => `- ${t}`));

  const avoid = lessons.filter((l) => l.remedy?.kind === "avoid").map((l) => l.remedy.text);
  if (avoid.length) lines.push("", "Tried before and made things worse:", ...avoid.map((t) => `- ${t}`));

  if (!lines.length) return "";
  return `<learned>\n${lines.join("\n")}\n\n` +
         `This is what previous applications recorded. It is a strong hint about ` +
         `this employer's form, not a source of facts about the applicant — every ` +
         `value you enter still has to come from the profile or the CV.\n</learned>`;
}

// ── record: what a finished run teaches ─────────────────────────────────────

/**
 * Fold one finished run into the memory.
 *
 * Never throws. A learning pass that fails must not turn a submitted
 * application into a failed one, and must not stop the router draining the
 * queue — so every path here is caught and reported, and the caller ignores
 * the result.
 */
export async function recordRun({
  run, status, steps = [], answers = {}, pauseReason = "", error = "",
  recall = null, startedAt = 0, docsAttached = [],
}) {
  try {
    const ats = recall?.ats ?? atsOf(run.job_url);
    const companyKey = recall?.companyKey ?? normalizeCompany(run.job_company);
    const reached = reachedFrom(steps, status);
    const kinds = problemKinds({ status, pauseReason, error });

    // ── the confirmation loop ────────────────────────────────────────────────
    // Settle the remedies this run was carrying BEFORE writing new ones, so a
    // lesson cannot be credited for a run it was itself written from.
    //
    // "Worked" is not "the application went out" — most applications legitimately
    // pause. It is "this run got further than the one that taught us", which is
    // the only claim the evidence actually supports.
    if (recall?.lessonIds?.length) {
      const previous = recall.playbook?.last_reached ?? 0;
      // `reached > 0` is not redundant with `reached > previous`. On a first
      // application to an employer there is no playbook and no high-water mark,
      // so a run that died before the page even loaded would clear the bar and
      // credit every ATS-scoped and global lesson it happened to be carrying —
      // a memory congratulating itself for a run that did nothing.
      const worked = status === "submitted" || (reached > 0 && reached > previous);
      await settleLessons(recall.lessonIds, worked).catch(() => {});
    }

    // ── deterministic extraction ─────────────────────────────────────────────
    // Everything derivable without judgement. This runs on every outcome
    // including a clean submit, and on a clean submit it is the whole pass.
    const facts = extract({ steps, answers, docsAttached, reached });

    // ── the model pass ───────────────────────────────────────────────────────
    // Only for a run that stopped. A submitted application has nothing left to
    // diagnose, and paying for a diagnosis of it on every success is how a
    // feature like this quietly becomes the most expensive part of the system.
    let inferred = { lessons: [], flow_notes: [], account_required: null };
    if (status !== "submitted" && (pauseReason || error)) {
      inferred = await distil({
        run, status, steps, pauseReason, error, kinds, facts,
        playbook: recall?.playbook, ats,
      }).catch((e) => {
        console.warn("learn: distil failed", e);
        return { lessons: [], flow_notes: [], account_required: null };
      });
    }

    // ── write ────────────────────────────────────────────────────────────────
    const written = [];
    for (const l of [...facts.lessons, ...inferred.lessons]) {
      if (!validRemedy(l.remedy)) continue;
      const target = placementFor(l, { companyKey, ats, domain: run.domain });
      if (!target) continue;
      const id = await recordLesson({
        ...target,
        problem_kind: l.problem_kind,
        signature: l.signature.slice(0, 200),
        remedy: l.remedy,
        remedy_note: (l.remedy_note || "").slice(0, 400),
        evidence: { run_id: run.id, step: l.from_step ?? null, quote: l.quote || null },
      }).catch(() => null);
      if (id) written.push(id);
    }

    if (companyKey) {
      await upsertPlaybook(companyKey, {
        company_name: run.job_company || null,
        ats,
        domain: run.domain,
        status,
        reached,
        steps_used: facts.stepsUsed,
        questions: facts.questions,
        documents: facts.documentsWanted,
        flow_notes: inferred.flow_notes,
        account_required: inferred.account_required,
      }).catch((e) => console.warn("learn: playbook write failed", e));
    }

    await saveApplyOutcome({
      run_id: run.id,
      company_key: companyKey || null,
      ats, domain: run.domain, status,
      problem_kind: kinds[0] || null,
      problem_signature: facts.signature || null,
      applied_lessons: recall?.lessonIds || [],
      reached,
      steps_used: facts.stepsUsed,
      duration_ms: startedAt ? Date.now() - startedAt : null,
      learned: { facts, inferred: inferred.lessons, wrote: written.length },
    }).catch((e) => console.warn("learn: outcome write failed", e));

    // The local field-map cache is a projection of this memory, not a rival
    // store. Feeding learned mappings into it is what makes them free: the
    // Groq mapping pass consults it before asking, so a label learned here
    // never costs a call again — on this machine or, once synced, any other.
    await warmFieldCache([...facts.lessons, ...inferred.lessons]).catch(() => {});

    return { wrote: written.length, reached, kinds };
  } catch (e) {
    console.warn("learn: recordRun failed", e);
    return { wrote: 0, error: String(e?.message || e) };
  }
}

/**
 * The problem's vocabulary, reusing the classifier the dashboard already uses.
 *
 * Deliberately not a second taxonomy. pause_help.js decides what a pause reason
 * means for the user; if learning invented its own kinds they would drift, and
 * the dashboard would end up explaining a lesson in different words from the
 * pause that produced it.
 */
export function problemKinds({ status, pauseReason, error }) {
  const text = pauseReason || error || "";
  if (!text) return status === "submitted" ? [] : [status];
  const help = helpForPause(text);
  const kinds = (help.parts || []).map((p) => p.kind).filter(Boolean);
  return kinds.length ? kinds : ["unknown"];
}

/**
 * Which scope a lesson belongs in.
 *
 * The model proposes a scope and it is checked, not trusted: a lesson claiming
 * `ats` scope when we do not know the ATS, or `company` when the company name
 * was never resolved, would be stored under an empty key — where it would match
 * every other empty-keyed lesson and be recalled for jobs it has nothing to do
 * with. That is the same failure the blank-label bug caused in the field cache,
 * and it is worth refusing here for the same reason.
 */
function placementFor(lesson, { companyKey, ats, domain }) {
  const want = lesson.scope || "company";
  if (want === "global") return { scope: "global", scope_key: "" };
  if (want === "ats" && ats) return { scope: "ats", scope_key: ats };
  if (want === "company" && companyKey) return { scope: "company", scope_key: companyKey };
  if (want === "domain" && domain) return { scope: "domain", scope_key: domain };
  // Fall back to the narrowest scope we can actually name, rather than
  // discarding a true observation over a scope we could not honour.
  if (companyKey) return { scope: "company", scope_key: companyKey };
  if (domain) return { scope: "domain", scope_key: domain };
  return null;
}

// ── deterministic extraction ────────────────────────────────────────────────

/**
 * What the step log says outright.
 *
 * No model involved and no judgement applied: every fact here is something the
 * run already recorded in structured form. This is why a successful application
 * costs nothing to learn from.
 */
function extract({ steps, answers, docsAttached, reached }) {
  const lessons = [];
  const questions = [];
  const documentsWanted = new Set(docsAttached);

  for (const [, a] of Object.entries(answers)) {
    if (!a?.label || !a?.text) continue;

    // A field the model had to map to a saved answer is a field the free
    // rule-based pass could have filled if it had known the label. That is the
    // single cheapest thing in this file: one lesson turns a model round-trip
    // into a local cache hit, permanently.
    if (a.profileKey && a.via !== "answer") {
      lessons.push({
        scope: "ats",
        problem_kind: "field_unmapped",
        signature: normLabel(a.label),
        remedy: { kind: "profile_answer", label: a.label, profile_key: a.profileKey },
        remedy_note: `The field "${a.label}" is your saved "${a.profileKey}".`,
        quote: a.label,
      });
    }

    // A free-text answer that went through is worth keeping verbatim against
    // the employer — the second application should not re-derive it.
    if (a.via === "answer" && a.text.length > 20) {
      questions.push({
        question: a.label,
        answer: a.text.slice(0, 1200),
        profile_key: a.profileKey || null,
        // Only claimed to have worked once the run actually submitted; a
        // paused run's answers are drafts, not precedents.
        worked: reached >= 5,
      });
    }
  }

  for (const s of steps) {
    if (s.kind === "upload" && s.doc) documentsWanted.add(s.doc);
    // An upload the site refused is a document it wanted and did not get. Worth
    // recording as required even though the attempt failed — arguably
    // especially then, since the gate should block on it next time.
    if (s.kind === "upload_failed" && s.doc) documentsWanted.add(s.doc);
  }

  const actions = steps.filter((s) => s.kind === "action");
  const lastError = [...actions].reverse().find((s) => /could not|failed|refused/i.test(s.result || ""));

  return {
    lessons,
    questions,
    documentsWanted: [...documentsWanted],
    stepsUsed: actions.length,
    signature: lastError ? normLabel(lastError.result).slice(0, 120) : "",
  };
}

const normLabel = (s) =>
  String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

// ── the model pass ──────────────────────────────────────────────────────────

const LEARN_TOOL = {
  name: "record_lessons",
  description: "Record what this application taught, so the next one goes better.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      lessons: {
        type: "array",
        description: "Fixes worth remembering. Empty is a valid answer — most " +
                     "runs teach nothing new, and inventing a lesson to fill " +
                     "this in makes future applications worse, not better.",
        items: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["global", "ats", "company", "domain"] },
            problem_kind: { type: "string" },
            signature: { type: "string",
                         description: "short stable fingerprint of this exact problem" },
            remedy_kind: { type: "string",
                           enum: ["profile_answer", "saved_answer", "document_required",
                                  "flow_hint", "account_required", "avoid"] },
            remedy_text: { type: "string",
                           description: "the fix. For profile_answer use " +
                                        "'label => profile_key'; for document_required " +
                                        "the document kind alone; otherwise a sentence " +
                                        "the next run can act on." },
            remedy_note: { type: "string", description: "one sentence for the user" },
            from_step: { type: "integer",
                         description: "index in the numbered trail this is drawn from" },
          },
          required: ["scope", "problem_kind", "signature", "remedy_kind",
                     "remedy_text", "remedy_note", "from_step"],
          additionalProperties: false,
        },
      },
      flow_notes: {
        type: "array",
        description: "How this employer's form behaves. Facts about the flow, not fixes.",
        items: { type: "string" },
      },
      account_required: {
        type: "boolean",
        description: "true only if the run stopped at a login or signup wall",
      },
    },
    required: ["lessons", "flow_notes", "account_required"],
    additionalProperties: false,
  },
};

const LEARN_SYSTEM =
`You are reviewing one job application that did not complete, to work out what would make the next one at this employer go better.

You are writing to a system, not to a person. Everything you record is fed back into the next application at this company, so a wrong lesson is worse than no lesson: it will be followed.

Rules:
1. Every lesson must be drawn from a specific numbered step in the trail. Set from_step to it. If you cannot point at a step, do not record the lesson.
2. Record the CAUSE, not the symptom. "Required upload was empty" is the symptom; "this employer's form only reveals the CV upload after clicking Continue on page 1" is the cause and is worth keeping.
3. Scope as widely as the evidence honestly supports and no wider. Behaviour of the applicant-tracking system itself is "ats" and helps every employer using it. Something about this employer specifically is "company". Do not mark something "global" unless it would be true of any form anywhere.
4. Never record anything about the applicant themselves — their answers, their details, their suitability. This memory is about how forms behave. Their profile is edited by them, not inferred by you.
5. Returning an empty list is the correct answer for a run that stopped for a reason nothing could have prevented — a captcha, a site outage, a consent box that is the applicant's to tick. Do not manufacture a lesson from one of those.`;

/**
 * Ask what this run teaches. One call, cheap model, strict output.
 *
 * The trail is numbered and truncated: numbering is what makes the grounding
 * requirement checkable, and truncation is what keeps a 25-step run with long
 * page states from costing more to learn from than it cost to attempt.
 */
async function distil({ run, status, steps, pauseReason, error, kinds, facts, playbook, ats }) {
  const trail = steps
    .filter((s) => s.kind !== "documents")
    .slice(-40)
    .map((s, i) => `${i}. ${describeStep(s)}`)
    .join("\n");

  const known = playbook
    ? `\nAlready known about this employer:\n` +
      `${playbook.required_documents?.length ? `- wants: ${playbook.required_documents.join(", ")}\n` : ""}` +
      `${playbook.account_required ? `- needs an account\n` : ""}` +
      `${(playbook.flow_notes || []).map((n) => `- ${n.note}`).join("\n")}\n` +
      `Do not record any of these again.\n`
    : "";

  const reply = await callClaude({
    task: "learn",
    system: LEARN_SYSTEM,
    messages: [{
      role: "user",
      content:
        `Employer: ${run.job_company || "unknown"}\n` +
        `Role: ${run.job_title || "unknown"}\n` +
        `System: ${ats || "unknown"} (${run.domain})\n` +
        `Outcome: ${status}\n` +
        `Classified as: ${kinds.join(", ") || "unclassified"}\n` +
        `Stopped because: ${pauseReason || error || "unknown"}\n` +
        `Documents it wanted: ${facts.documentsWanted.join(", ") || "none recorded"}\n` +
        known +
        `\nNumbered trail:\n${trail}\n\n` +
        `What should the next application to this employer do differently?`,
    }],
    tools: [LEARN_TOOL],
    tool_choice: { type: "tool", name: "record_lessons", disable_parallel_tool_use: true },
    max_tokens: 1500,
    jobUrl: run.job_url,
  });

  const call = (reply.content || []).find((b) => b.type === "tool_use");
  if (!call) return { lessons: [], flow_notes: [], account_required: null };

  const maxStep = Math.max(0, Math.min(steps.length, 40) - 1);
  const lessons = [];
  for (const l of call.input.lessons || []) {
    // The grounding contract, enforced rather than requested. A lesson citing a
    // step that does not exist was not read off the trail, and a memory that
    // accepts those fills up with plausible advice nobody can check.
    if (!Number.isInteger(l.from_step) || l.from_step < 0 || l.from_step > maxStep) continue;
    const remedy = remedyFrom(l);
    if (!remedy) continue;
    lessons.push({
      scope: l.scope,
      problem_kind: l.problem_kind,
      signature: normLabel(l.signature),
      remedy,
      remedy_note: l.remedy_note,
      from_step: l.from_step,
      quote: describeStep(steps[l.from_step]).slice(0, 200),
    });
  }

  return {
    lessons,
    flow_notes: (call.input.flow_notes || []).filter((s) => s && s.length > 8).slice(0, 6),
    account_required: call.input.account_required === true ? true : null,
  };
}

/**
 * The flat `remedy_kind` + `remedy_text` pair back into a typed remedy.
 *
 * The tool schema is flat because a discriminated union across six shapes is
 * more than a small model reliably fills in, and a malformed union arrives as
 * a validation retry rather than an answer. Parsing two strings here is the
 * cheaper half of that trade — and anything that does not parse is dropped by
 * validRemedy() rather than stored half-formed.
 */
function remedyFrom(l) {
  const text = String(l.remedy_text || "").trim();
  if (!text) return null;

  switch (l.remedy_kind) {
    case "profile_answer": {
      const [label, key] = text.split(/\s*=>\s*|\s*->\s*/);
      if (!label || !key) return null;
      return { kind: "profile_answer", label: label.trim(), profile_key: key.trim() };
    }
    case "saved_answer": {
      const [q, a] = text.split(/\s*=>\s*|\s*->\s*/);
      if (!q || !a) return null;
      return { kind: "saved_answer", question: q.trim(), answer: a.trim() };
    }
    case "document_required":
      return { kind: "document_required", doc_kind: text.toLowerCase().replace(/\s+/g, "_") };
    case "account_required":
      return { kind: "account_required", note: text };
    case "flow_hint":
      return { kind: "flow_hint", text };
    case "avoid":
      return { kind: "avoid", text };
    default:
      return null;
  }
}

/** One step as a line the model can read, with values kept out of it. */
function describeStep(s) {
  if (!s) return "(no step)";
  switch (s.kind) {
    case "action":
      return `${s.tool} on "${s.input?.element_id || "?"}" — ${s.result || ""}`;
    case "autofill":
      return `rule pass filled ${s.filled} fields` +
             (s.skipped?.length ? `, skipped ${s.skipped.length}` : "");
    case "upload":        return `attached ${s.doc} via ${s.via}`;
    case "upload_failed": return `FAILED to attach ${s.doc}: ${s.error}`;
    case "pause":         return `PAUSED: ${s.reason}`;
    case "blocked":       return `BLOCKED by the site: ${s.signal}`;
    case "page_ready":    return `page ready — ${s.fields} fields, ${s.buttons} buttons` +
                                 (s.sawControls?.length ? `, saw: ${s.sawControls.join(" / ")}` : "");
    case "followed_tab":
    case "followed_link": return `followed to ${s.to}`;
    default:              return s.kind;
  }
}

// ── feeding the local field cache ───────────────────────────────────────────

const LEARNED_KEY = "learnedFieldMap";
const MIN_LABEL_LEN = 3;

/**
 * Push learned label→key mappings into the cache the Groq mapping pass reads.
 *
 * Same key and same normalisation as background.js, deliberately: this is the
 * existing cache being warmed from durable memory, not a second one competing
 * with it. The blank-label guard is repeated here rather than assumed, because
 * an empty key in that map is what once filled Last Name with a country.
 */
async function warmFieldCache(lessons) {
  const add = {};
  for (const l of lessons) {
    if (l.remedy?.kind !== "profile_answer") continue;
    const k = normLabel(l.remedy.label).slice(0, 90);
    if (k.length < MIN_LABEL_LEN) continue;
    add[k] = l.remedy.profile_key;
  }
  if (!Object.keys(add).length) return;
  const store = await chrome.storage.local.get(LEARNED_KEY);
  await chrome.storage.local.set({ [LEARNED_KEY]: { ...(store[LEARNED_KEY] || {}), ...add } });
}
