// apply_agent.js — the loop that actually applies for a job.
//
//   observe → decide → act → verify, until the form is submitted, the run
//   pauses for the user, or the budget runs out.
//
// DIVISION OF LABOUR — rules first, model second
//
// The model is the most expensive and least predictable component here, so it
// is used for the part that genuinely needs judgement and nothing else:
//
//   autofill.js (free)   every field that matches a saved profile answer
//   Groq (cheap)         mapping unfamiliar labels onto profile keys
//   Claude (here)        what to click next, and free text that has to be
//                        written from the CV
//
// On a Greenhouse form that means one model call and done. The cost only shows
// up on the flows that earn it — Workday's five pages of conditional questions.
//
// THE GROUNDING CONTRACT
//
// Every tool that produces a *value* requires the model to say where the value
// came from: a profile key, or a quote from the CV. confidence.js checks those
// claims against the actual CV before anything is submitted. The model cannot
// write an unsourced sentence into a form and have it reach an employer — if
// it cannot cite, the only legal move left is `pause`.

import { withDebugger, captureScreenshot } from "./cdp.js";
import { hold } from "./keepalive.js";
import { ensureDocuments } from "./docgen.js";
import { attachDocument, planUploads } from "./upload.js";
import { canSubmit, explain, isCommitmentQuestion } from "./confidence.js";
import { pauseHeadline, pauseLabel } from "./pause_help.js";
import {
  detectBlockSignal, recordBlock, recordSuccess, recordFailure,
} from "./domain_health.js";
import {
  updateApplyRun, appendApplyStep, uploadPauseScreenshot, tailoredForJob,
  getProfile, primaryDocuments,
} from "./supabase.js";
import { callClaude } from "./ai_client.js";

// Which model runs a step is now the proxy's decision, keyed on the task name
// sent with each call. Tier 0 is plain-DOM boards — Greenhouse, Lever, Ashby,
// Personio — where the form is one or two pages of ordinary inputs; tier 1 is
// Workday and friends, five pages of conditional questions and custom widgets.
// Splitting them lets the cheap model take the easy majority while the careful
// one keeps the flows that actually need it. Both are still gated by
// confidence.js, which is deterministic and model-independent: no model of
// either size can submit a form whose answers aren't grounded in the CV.
//
// To put everything back on one model, map both to "apply" here and drop
// apply_simple from the proxy's TASK_MODELS.
const taskFor = (tier) => (tier === 0 ? "apply_simple" : "apply");

const MAX_STEPS = 25;
const MAX_WALL_MS = 4 * 60 * 1000;
// How long the first page gets to actually render before we let the model look.
// Longer than the in-loop wait: a throttled background SPA hydrating from cold
// is the slow case, and it only happens once per run.
const FIRST_LOAD_MS = 30000;
// No fixed settle delay any more — waitForContent() polls for actual readiness
// instead. A constant was always going to be either too short for a throttled
// background SPA or wasted time on a plain form.

// ── tools ───────────────────────────────────────────────────────────────────
// `strict: true` so the API validates the shape for us. Every value-producing
// tool carries a mandatory sourcing field; that is the contract, expressed
// where the model cannot skip it rather than as a line in the prompt.

const TOOLS = [
  {
    name: "click",
    description:
      "Click a button or link from the page's `buttons` list. Use this to move " +
      "through a multi-page form, open the apply form, or submit. Submitting is " +
      "independently checked before it happens, so click the submit button when " +
      "the form is genuinely complete rather than second-guessing it.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string", description: "id from the buttons list" },
        reason: { type: "string", description: "why this button, in a few words" },
      },
      required: ["element_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description:
      "Put a value into a text field. The value must come from the applicant's " +
      "saved profile — set `profile_key` to the key it came from. If no saved " +
      "answer covers this field, do not invent one: use `answer` when it is a " +
      "question the CV can answer, or `pause` when it is not.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        value: { type: "string" },
        profile_key: {
          type: "string",
          description: "the profile key this value came from, verbatim",
        },
      },
      required: ["element_id", "value", "profile_key"],
      additionalProperties: false,
    },
  },
  {
    name: "choose",
    description:
      "Select a dropdown option or radio choice. `grounding` must name the " +
      "profile key or CV fact behind the choice. For anything legal or " +
      "contractual — visa status, notice period, salary — the answer must come " +
      "from the saved profile; if it is not there, pause instead.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        option: { type: "string", description: "option text to select" },
        option_id: { type: "string", description: "radio option id, or empty" },
        grounding: { type: "string" },
      },
      required: ["element_id", "option", "option_id", "grounding"],
      additionalProperties: false,
    },
  },
  {
    name: "answer",
    description:
      "Write a free-text answer (motivation, 'why this role', a screening " +
      "question). `cv_evidence` must quote the part of the CV the answer rests " +
      "on; it is checked against the real CV before anything is submitted, and " +
      "an answer that does not check out will stop the run. Never write an " +
      "experience, tool, or figure the CV does not contain.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        text: { type: "string" },
        cv_evidence: {
          type: "string",
          description: "the passage of the CV this answer is drawn from",
        },
      },
      required: ["element_id", "text", "cv_evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "upload",
    description:
      "Attach a document to a file input. 'cv' and 'cover_letter' are written " +
      "for this posting; 'certificate', 'portfolio' and 'photo' come from the " +
      "user's own uploaded files and only exist if they added them. The exact " +
      "set available for this application is listed in <documents> — asking " +
      "for anything not on that list fails.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        // Every kind the system can attach, not every kind it has right now:
        // what is actually present varies per run and is stated in the system
        // prompt, where it can be accurate. A wrong guess here is answered with
        // a plain "there is no such document", which the model can act on —
        // whereas a schema that changed shape between runs could not be cached.
        doc_kind: { type: "string",
                    enum: ["cv", "cover_letter", "certificate", "portfolio", "photo"] },
      },
      required: ["element_id", "doc_kind"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description: "The application has been submitted, or the form is complete " +
                 "and only the pre-submit check remains.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["submitted", "ready_to_submit"] },
        note: { type: "string" },
      },
      required: ["outcome", "note"],
      additionalProperties: false,
    },
  },
  {
    name: "pause",
    description:
      "Hand this application back to the user. The right choice whenever you " +
      "would otherwise have to guess: an unanswerable screening question, a " +
      "consent box, a required account signup, a question about legal status " +
      "with no saved answer. Pausing is a normal outcome, not a failure — a " +
      "wrong answer sent under someone's name cannot be taken back.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        blocking_element_id: { type: "string" },
      },
      required: ["reason", "blocking_element_id"],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You are filling in a job application on behalf of the person whose profile and CV appear below. You act as them, so everything you enter must be true of them.

Rules, in order of precedence:

1. Never state anything that is not supported by the profile or the CV. Not a year of experience, not a tool, not a degree, not a salary. If a field wants a fact you do not have, pause.
2. Legal and contractual questions — visa or sponsorship, work authorisation, notice period, expected salary, relocation, criminal record, demographic questions — are answered ONLY from the saved profile. Never reason your way to one of these.
3. Never tick a consent, terms, privacy, or marketing checkbox. Those are the applicant's decision and pausing on them is correct behaviour.
4. Prefer pausing over guessing. A paused application costs the applicant one minute. A wrong one is sent under their name and cannot be recalled.
5. Fields already filled by the rule-based pass are done. Do not redo them.

Working method: one action per turn, then look at the new page state. Multi-page forms show a step indicator — use it to confirm a Next click actually advanced rather than bouncing back with errors. If validation errors appear, fix the field they name before moving on. When every required field, upload, and question on the final page is complete, click the submit button; a separate deterministic check runs before the click actually goes through, so you do not need to re-verify the form yourself.`;

// ── the model call ──────────────────────────────────────────────────────────
//
// Goes through ai-proxy, which holds the shared Anthropic key, picks the model
// from the task name, and bills the call against this user's monthly allowance.
// Nothing here knows the key, and `task` — not this file — is what decides how
// much a step costs.

function askClaude({ task, system, messages }) {
  return callClaude({
    task,
    system,
    messages,
    tools: TOOLS,
    // Every turn must be an action, and exactly one: each tool changes the page,
    // so a second call decided against the same observation would be acting on a
    // page that no longer exists. Without the flag the model is free to emit
    // several tool_use blocks at once, and every one of them needs a matching
    // tool_result or the *next* request is rejected outright.
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    output_config: { effort: "medium" },
    max_tokens: 4096,
  });
}

/**
 * The system block, split so the stable part can be cached.
 *
 * Instructions, profile, and CV are byte-identical on every step of every job.
 * With a cache breakpoint after the CV, a ~6K-token prefix bills as a ~600
 * token read from the second call onward — and the tools render before the
 * system block, so they land inside the same cached prefix for free.
 */
function buildSystem(profile, cvText, docKinds = []) {
  return [
    { type: "text", text: SYSTEM },
    { type: "text", text: `<saved_profile>\n${JSON.stringify(profile, null, 1)}\n</saved_profile>` },
    {
      type: "text",
      text: `<cv>\n${cvText}\n</cv>`,
      cache_control: { type: "ephemeral" },
    },
    // Deliberately after the cache breakpoint: this is the one part of the
    // system prompt that differs run to run, and it is two lines long. Putting
    // it before the CV would invalidate the cached prefix on every application
    // for the sake of a sentence.
    {
      type: "text",
      text: `<documents>\nAttachable right now: ${docKinds.join(", ") || "none"}.\n` +
            `Anything not listed does not exist — pause and ask rather than ` +
            `substituting a different document.\n</documents>`,
    },
  ];
}

// ── tab plumbing ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function engine(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: "jca-engine", ...message });
}

/** The content scripts, in load order — same list as the manifest. */
const ENGINE_FILES = [
  "print_doc.js", "cover_templates.js", "autofill.js", "apply_engine.js",
];

/**
 * Make sure the tab has a live engine, injecting one if it doesn't.
 *
 * Relying on the manifest's `content_scripts` alone is not enough. It only
 * fires on a real navigation, so the script is missing whenever the page was
 * already open before the extension loaded, and it is *lost* when a single-page
 * app like LinkedIn performs a hard redirect part-way through a flow. Both show
 * up as the same unhelpful "Receiving end does not exist".
 *
 * chrome.scripting.executeScript is idempotent enough for this: re-injecting
 * re-runs the IIFEs, which just re-registers the listeners.
 */
async function ensureEngine(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;

  while (Date.now() < deadline) {
    const pong = await engine(tabId, { type: "PING" }).catch(() => null);
    if (pong?.ok) return true;

    // Only worth injecting once the tab has actually committed a document.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the tab was closed");

    if (tab.status === "complete" && !injected) {
      injected = true;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          files: ENGINE_FILES,
        });
        continue;                       // re-PING immediately
      } catch (e) {
        // The common cause is not a broken page but a missing host permission:
        // the manifest covers the job boards, and an employer's own careers
        // site can be any domain at all. Chrome will not even reveal tab.url
        // without permission, so the raw error names no host and reads like a
        // mystery — ask Chrome directly instead of guessing.
        const granted = await chrome.permissions
          .contains({ origins: ["https://*/*"] }).catch(() => false);
        if (!granted) {
          throw new Error(
            "This employer hosts its application on its own site, which needs " +
            "one extra permission. Open Settings → Applying and click " +
            "\"Enable auto-apply on all sites\", then retry this job.");
        }
        throw new Error(
          `couldn't inject into ${tab.url?.split("?")[0] || "this page"}: ${e.message}`);
      }
    }
    if (tab.status === "complete" && injected) injected = false;   // allow a retry after a navigation
    await sleep(400);
  }
  throw new Error("the page never became ready — it may be showing a login wall");
}

/**
 * Read the page, re-establishing the engine if the connection was lost.
 *
 * A navigation between two steps tears down the content script, and the next
 * message fails with "Receiving end does not exist". That is recoverable — the
 * page is fine, we just need to inject again — so it should not end the run.
 */
async function observe(tabId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await engine(tabId, { type: "OBSERVE" });
      if (!resp?.ok) throw new Error(resp?.error || "observe failed");
      return resp.state;
    } catch (e) {
      if (attempt === 1 || !/Receiving end|Could not establish/i.test(e.message)) throw e;
      await ensureEngine(tabId, 20000);     // navigated mid-flow; re-inject
    }
  }
}

/**
 * Did that click open the application in a different tab?
 *
 * This is how most "Apply on the company site" postings work, and it is the
 * whole of LinkedIn's off-site apply: the button is a `window.open`, the
 * employer's real form opens in a new tab, and the page we were watching stays
 * put and switches to "Did you finish applying? Yes / No". Watching only the
 * tab we opened, the run sees an Apply button that "does nothing", concludes
 * there is no reachable form, and hands back a job whose form was open the
 * whole time one tab over.
 *
 * Chrome sets `openerTabId` on a tab opened by a page, so the new tab
 * identifies itself; `known` carries the ids we've already adopted so a second
 * click can't re-follow the same one. Polled, because the tab appears a beat
 * after the click returns.
 */
async function followNewTab(tabId, before, known, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = await chrome.tabs.query({}).catch(() => []);
    const fresh = all.filter((t) => !before.has(t.id) && !known.has(t.id));

    // `openerTabId` is the reliable signal, but it is not always there:
    // LinkedIn marks its external links rel="noopener", and that can sever the
    // relationship the tabs API reports. So fall back to "exactly one tab
    // appeared while we were clicking" — exactly one, because if the user
    // opened something of their own in the same few seconds we would rather
    // carry on where we are than start driving their tab.
    const hit = fresh.find((t) => t.openerTabId === tabId) ||
                (fresh.length === 1 ? fresh[0] : null);
    if (hit) { known.add(hit.id); return hit; }
    await sleep(300);
  }
  return null;
}

/** All tab ids right now — the "before" half of new-tab detection. */
async function tabIdsNow() {
  const all = await chrome.tabs.query({}).catch(() => []);
  return new Set(all.map((t) => t.id));
}

/** A control that would open or advance an application. */
const APPLY_CONTROL_RE =
  /\b(easy apply|apply|bewerben|jetzt bewerben|bewerbung|submit|weiter|continue|next)\b/i;

/**
 * Wait until the page has actually rendered before letting the model look.
 *
 * The content script being alive says nothing about the page being finished.
 * A single-page app in a background tab — which Chrome throttles — can take
 * many seconds past document_idle to render its main action. Showing the model
 * a half-built page is worse than showing it nothing: it reasons correctly over
 * what it can see, concludes there is no application here, and pauses. That is
 * the model behaving properly on input we got wrong.
 *
 * So: poll until there is something to act on, or until the DOM stops changing.
 */
async function waitForContent(tabId, timeoutMs = 25000, { requireSignal = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1, stableFor = 0, latest = null;

  while (Date.now() < deadline) {
    latest = await observe(tabId).catch(() => null);

    if (latest) {
      // Unambiguously ready: a real form, or a control that starts one.
      if (latest.isForm) return latest;
      if ((latest.buttons || []).some((b) => APPLY_CONTROL_RE.test(b.text))) return latest;

      // Otherwise settle for the DOM having stopped growing. Two consecutive
      // identical readings on a non-empty page is enough — anything more and
      // pages that poll in the background never look settled at all.
      //
      // `requireSignal` switches that off, and it exists because "stopped
      // growing" is not the same as "finished". The apply tab is opened
      // inactive, and Chrome throttles a hidden tab's timers hard: LinkedIn
      // serves its nav chrome from the shell and hydrates the job card after,
      // so for several seconds the page is genuinely stable — as a header with
      // nothing under it. Handing that to the model got exactly the answer it
      // deserved: "no apply button, only navigation links", and a pause on a
      // posting whose Apply button was seconds from rendering. On the first
      // load we now wait for the real thing or run out the clock; a page that
      // truly has no application on it costs one slow run, which is a much
      // better trade than a false hand-off.
      const size = (latest.buttons?.length || 0) + (latest.fields?.length || 0);
      if (!requireSignal && size > 0 && size === lastSize) {
        if (++stableFor >= 2) return latest;
      } else if (size !== lastSize) {
        stableFor = 0;
        lastSize = size;
      }
    }
    await sleep(900);
  }
  return latest || observe(tabId);
}

// ── the loop ────────────────────────────────────────────────────────────────

/**
 * Apply for one job.
 *
 * `run` is a row from apply_runs. Returns the terminal status.
 * Never throws for ordinary failure — a failed run is recorded, not raised,
 * because the router must keep draining the rest of the queue either way.
 */
export async function runApply(run, { submitPolicy = "confident", onProgress } = {}) {
  const started = Date.now();
  const say = (text, extra) => onProgress?.({ runId: run.id, text, ...extra });

  // Refcounted, so this is harmless when the pump already holds it — and it
  // means a run is protected even if something calls runApply directly.
  const release = hold();

  let tabId = null;
  // Every tab this run is responsible for, including ones an Apply button
  // opened. The run can migrate between them, so cleanup can't just close
  // "the" tab — it has to close all of them but the one being handed over.
  const openTabs = new Set();
  // The `finally` below reads this to decide whether to keep the tab. A `return`
  // can't be seen from there, so every exit has to record itself here first —
  // three of them didn't, and a run that paused on a timeout or on running out
  // of steps had its tab closed as if it had failed. That is the tab the user is
  // being asked to finish the application in. `handOver()` exists so a pause and
  // the record of it can't drift apart again.
  let status = "failed";
  const handOver = async (reason, blocking) => {
    await pauseRun(run, tabId, reason, blocking);
    status = "paused_needs_human";
    return status;
  };

  try {
    // ── context ─────────────────────────────────────────────────────────────
    // The whole tailored row, not just its packet: the id identifies which
    // tailoring this application is being made from, and docgen needs that to
    // tell a current PDF from one rendered before the job was re-tailored.
    //
    // Looked up by job identity, not by run.job_url alone. resolve_ats.js
    // reroutes an aggregator posting to the employer's own ATS and queues the
    // run under that new URL, keeping the original in original_job_url — but
    // the user tailored against the original. A URL-only lookup missed, and the
    // run died claiming the job had never been tailored.
    const [profileRow, tailored] = await Promise.all([
      getProfile(),
      tailoredForJob({
        url: run.job_url,
        originalUrl: run.original_job_url,
        company: run.job_company,
        title: run.job_title,
      }),
    ]);
    if (!tailored?.packet) {
      throw new Error("this job hasn't been tailored yet — tailor it first");
    }
    const packet = tailored.packet;

    const profile = profileRow?.application_profile || {};
    const cvText = profileRow?.cv_text || "";
    const applicantName = profile.full_name ||
      [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "Applicant";

    const job = { url: run.job_url, title: run.job_title, company: run.job_company };

    // Log each stage as it completes, not just once the loop is under way.
    // When this run died silently the step log was empty, which said nothing
    // about how far it had got — a breadcrumb per stage is the difference
    // between "somewhere in the first half" and knowing exactly where.
    await appendApplyStep(run.id, { kind: "start", url: run.job_url, tier: run.tier });

    say("Rendering CV and cover letter…");
    const docs = await ensureDocuments({
      job, packet, applicantName, tailoredId: tailored.id,
    });

    // Then whatever the user has in their library, for the slots the renderer
    // can't fill. A form asking for an Arbeitszeugnis, a transcript or a photo
    // used to be the end of the run — there was no such file anywhere in the
    // system, so the only honest move was to hand the job back.
    //
    // Generated documents win where both exist: a CV written for *this* posting
    // is strictly better than the general one on file, and silently sending the
    // general one would undo the entire point of tailoring.
    const library = await primaryDocuments().catch(() => ({}));
    const fromLibrary = [];
    for (const [kind, doc] of Object.entries(library)) {
      if (kind === "other" || docs[kind]) continue;
      docs[kind] = doc;
      fromLibrary.push(kind);
    }

    // Which tailoring the attachments came from, in the audit trail — the point
    // of the trail is that a sent application can be reconstructed, and "which
    // CV went out" is the first thing you'd want to know.
    await appendApplyStep(run.id, {
      kind: "documents", kinds: Object.keys(docs), fromLibrary,
      tailoredId: tailored.id,
      // Which identity rule found this packet. A reuse that turns out to be
      // wrong is otherwise very hard to explain after the fact — "url" is
      // exact, "job_key" was a company+title judgement call.
      matchedBy: tailored.matched_by || "url",
    });

    // ── open the posting ────────────────────────────────────────────────────
    say("Opening the job…");
    const tab = await chrome.tabs.create({ url: run.job_url, active: false });
    tabId = tab.id;
    openTabs.add(tabId);
    await appendApplyStep(run.id, { kind: "tab_opened", tabId });

    await ensureEngine(tabId);
    await appendApplyStep(run.id, { kind: "engine_ready" });

    say("Waiting for the page to finish loading…");
    // Strict on the first load: a wrong answer here doesn't cost a retry, it
    // ends the run with a hand-off the user then has to redo by hand.
    const firstView = await waitForContent(tabId, FIRST_LOAD_MS, { requireSignal: true });
    await appendApplyStep(run.id, {
      kind: "page_ready",
      buttons: (firstView?.buttons || []).length,
      fields: (firstView?.fields || []).length,
      isForm: !!firstView?.isForm,
      // Recorded so a future "there was no Apply button" pause can be checked
      // against what was actually on the page at the time.
      sawControls: (firstView?.buttons || [])
        .filter((b) => APPLY_CONTROL_RE.test(b.text)).map((b) => b.text).slice(0, 6),
    });

    // ── conversation state ──────────────────────────────────────────────────
    //
    // A job that has already failed twice used to escalate to the most
    // expensive model here. That is exactly backwards on a shared budget: the
    // jobs that burned two full runs are the ones least likely to be rescued by
    // a bigger model, and they would spend several users' allowance trying. A
    // third failure now pauses for the human instead — see the attempts check
    // in the pause path.
    const task = taskFor(run.tier);
    const system = buildSystem(profile, cvText, Object.keys(docs));
    const messages = [];
    const answers = {};              // jcaId -> {label, text, evidence, profileKey}
    const autofilled = new Set();    // urls the rule pass has already run on
    let unmetUploads = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (Date.now() - started > MAX_WALL_MS) {
        return handOver("took too long — handing this one back to you");
      }

      const state = await observe(tabId);

      // ── are we still welcome? ─────────────────────────────────────────────
      const signal = detectBlockSignal(state);
      if (signal) {
        // Leave. No retry, no reload, and nothing goes near the challenge.
        await recordBlock(run.domain, signal);
        await appendApplyStep(run.id, { kind: "blocked", signal, url: state.url });
        await updateApplyRun(run.id, {
          status: "blocked", error: `site returned a block signal (${signal})`,
          finished_at: new Date().toISOString(),
        });
        say(`${run.domain} asked us to stop (${signal}). Quarantined for 24h; other sites keep running.`);
        return "blocked";
      }

      // ── free pass: rules, then uploads ────────────────────────────────────
      if (state.isForm && !autofilled.has(state.url)) {
        autofilled.add(state.url);
        const { report } = await engine(tabId, { type: "AUTOFILL", profile, packet });
        say(`Filled ${report?.filled?.length || 0} fields from your saved answers`);
        await appendApplyStep(run.id, {
          kind: "autofill", url: state.url,
          filled: report?.filled?.length || 0, skipped: report?.skipped || [],
        });

        const { plan, unmet } = planUploads(report?.files || [], docs);
        unmetUploads = unmet;
        for (const p of plan) {
          try {
            const res = await attachDocument(tabId, {
              jcaId: p.jcaId, doc: p.doc, tier: run.tier,
            });
            say(`Attached ${p.kind} (${res.path})`);
            await appendApplyStep(run.id, { kind: "upload", doc: p.kind, via: res.path });
          } catch (e) {
            unmetUploads.push({ jcaId: p.jcaId, label: p.label, reason: e.message });
            await appendApplyStep(run.id, { kind: "upload_failed", doc: p.kind, error: e.message });
          }
        }
        continue;                    // re-observe with the form now populated
      }

      // ── ask the model ─────────────────────────────────────────────────────
      messages.push({ role: "user", content: JSON.stringify(observationFor(state), null, 1) });
      const reply = await askClaude({ task, system, messages });
      messages.push({ role: "assistant", content: reply.content });

      // Only the first call is executed — see disable_parallel_tool_use above —
      // but the belt-and-braces part is that every id still gets answered below.
      // An unanswered tool_use is not a degraded turn, it is a hard 400 on the
      // next request that kills the run and quarantines the site.
      const calls = reply.content.filter((b) => b.type === "tool_use");
      const call = calls[0];
      if (!call) return handOver("the model stopped without choosing an action");

      const outcome = await execute({
        call, state, tabId, run, docs, answers, profile, cvText,
        unmetUploads, submitPolicy, say, openTabs,
      });

      // The click opened the application elsewhere — that tab is the run now.
      // The autofill pass is keyed by URL, so the new page gets its own free
      // rule-based pass rather than being treated as already handled.
      if (outcome.tabId && outcome.tabId !== tabId) {
        tabId = outcome.tabId;
        await ensureEngine(tabId);
        await waitForContent(tabId, FIRST_LOAD_MS, { requireSignal: true });
      }

      await appendApplyStep(run.id, {
        kind: "action", tool: call.name, input: redact(call.input),
        result: outcome.summary,
      });

      if (outcome.terminal) {
        status = outcome.status;
        if (status === "submitted") await recordSuccess(run.domain);
        return status;
      }

      // Tell the model what happened, then loop.
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: call.id,
            content: outcome.summary, is_error: !!outcome.isError },
          // Anything the model asked for alongside the executed call is answered
          // rather than dropped: the page has moved on, so the honest reply is
          // "not run", and it re-decides from the observation that follows.
          ...calls.slice(1).map((extra) => ({
            type: "tool_result", tool_use_id: extra.id, is_error: true,
            content: "Not run — one action per turn. Decide again from the page state below.",
          })),
        ],
      });
      // Keep the window bounded: the page state is re-sent every turn anyway,
      // so old observations are dead weight that only inflate the bill.
      trim(messages);
      // Same reasoning as the first load: clicking "Easy Apply" opens a modal
      // that renders asynchronously, and a Next click re-renders the whole
      // step. Returns as soon as there's something actionable, so the common
      // case costs one poll rather than a fixed delay.
      await waitForContent(tabId, 12000);
    }

    return handOver(`gave up after ${MAX_STEPS} steps`);

  } catch (e) {
    await recordFailure(run.domain, e.message).catch(() => {});
    await updateApplyRun(run.id, {
      status: "failed", error: String(e?.message || e).slice(0, 500),
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    say(`Failed: ${e.message}`);
    return status;
  } finally {
    // A paused run is one the user has to finish, so its tab stays open and is
    // brought to the front — closing it and asking them to find the posting
    // again would defeat the point of pausing. Everything else cleans up.
    //
    // "Its tab" is whichever one the run ended on: following an Apply button to
    // the employer's site means the tab worth keeping is the one with the form,
    // not the job posting we started from.
    const keep = status === "paused_needs_human" ? tabId : null;
    for (const id of openTabs) {
      if (id === keep) continue;
      await chrome.tabs.remove(id).catch(() => {});
    }
    if (keep != null) await chrome.tabs.update(keep, { active: true }).catch(() => {});
    release();
  }
}

// ── executing one decision ──────────────────────────────────────────────────

async function execute(ctx) {
  const { call, state, tabId, run, docs, answers, profile, cvText,
          unmetUploads, submitPolicy, say } = ctx;
  const a = call.input;

  switch (call.name) {
    case "fill": {
      const r = await engine(tabId, {
        type: "ACT", action: { type: "FILL", jcaId: a.element_id, value: a.value },
      });
      const label = labelOf(state, a.element_id);
      answers[a.element_id] = { label, text: a.value, profileKey: a.profile_key, via: "fill" };
      return { summary: r?.ok ? `filled "${label}"` : `could not fill: ${r?.error}`,
               isError: !r?.ok };
    }

    case "choose": {
      const r = await engine(tabId, {
        type: "ACT",
        action: { type: "CHOOSE", jcaId: a.element_id, option: a.option,
                  optionId: a.option_id || null },
      });
      const label = labelOf(state, a.element_id);
      answers[a.element_id] = { label, text: a.option, via: "choose",
                                profileKey: keyFromGrounding(a.grounding, profile) };
      return { summary: r?.ok ? `chose "${a.option}" for "${label}"` : `could not choose: ${r?.error}`,
               isError: !r?.ok };
    }

    case "answer": {
      const r = await engine(tabId, {
        type: "ACT", action: { type: "FILL", jcaId: a.element_id, value: a.text },
      });
      const label = labelOf(state, a.element_id);
      answers[a.element_id] = { label, text: a.text, evidence: a.cv_evidence, via: "answer" };
      // Commitment questions can't be answered from the CV at all, however
      // good the citation is. Say so now rather than letting the gate reject it
      // at the very end, so the model can pause on the spot.
      if (isCommitmentQuestion(label)) {
        return { summary:
          `wrote an answer, but "${label}" is a legal/contractual question — it ` +
          `must come from the saved profile, not the CV. If there is no saved ` +
          `answer for it, pause.`, isError: true };
      }
      return { summary: r?.ok ? `answered "${label}"` : `could not answer: ${r?.error}`,
               isError: !r?.ok };
    }

    case "upload": {
      const doc = docs[a.doc_kind];
      if (!doc) {
        return {
          summary: `there is no ${a.doc_kind} for this application — ` +
                   `available: ${Object.keys(docs).join(", ") || "none"}`,
          isError: true,
        };
      }
      try {
        const res = await attachDocument(tabId, {
          jcaId: a.element_id, doc, tier: run.tier,
        });
        return { summary: `attached ${a.doc_kind} (${res.path})` };
      } catch (e) {
        unmetUploads.push({ jcaId: a.element_id, label: a.doc_kind, reason: e.message });
        return { summary: `upload failed: ${e.message}`, isError: true };
      }
    }

    case "click": {
      const btn = (state.buttons || []).find((b) => b.id === a.element_id);

      // ── THE GATE ──────────────────────────────────────────────────────────
      if (btn?.kind === "submit") {
        const gate = canSubmit(state, { answers, profile, cvText, unmetUploads });

        if (!gate.ok) {
          await pauseRun(run, tabId, explain(gate), gate.blocking);
          return { terminal: true, status: "paused_needs_human",
                   summary: `submit blocked: ${gate.reason}` };
        }
        if (submitPolicy === "never") {
          await pauseRun(run, tabId,
            "Form is complete and checks out — submit is switched off, so it's yours to send.");
          return { terminal: true, status: "paused_needs_human",
                   summary: "complete; submit disabled by policy" };
        }
        say("All checks passed — submitting.");
      }

      // Snapshot before the click, so a tab it opens can be told from one that
      // was already there.
      const tabsBefore = await tabIdsNow();
      const r = await engine(tabId, { type: "ACT", action: { type: "CLICK", jcaId: a.element_id } });
      if (!r?.ok) return { summary: `could not click: ${r?.error}`, isError: true };

      if (btn?.kind === "submit") {
        await sleep(2500);                            // let the submit land
        await updateApplyRun(run.id, {
          status: "submitted", finished_at: new Date().toISOString(),
        });
        return { terminal: true, status: "submitted", summary: "submitted" };
      }

      // The application may have opened somewhere else entirely.
      const opened = await followNewTab(tabId, tabsBefore, ctx.openTabs);
      if (opened) {
        // Keep the run in the background, the way it started. window.open and
        // target=_blank both foreground the new tab, and yanking the user's
        // focus away every time an Apply button is pressed is not what a queue
        // draining quietly behind them should do.
        await chrome.tabs.update(opened.id, { active: false }).catch(() => {});
        const where = hostOf(opened.url) || "a new tab";
        say(`That opened the employer's own page (${where}) — following it there.`);
        await appendApplyStep(run.id, {
          kind: "followed_tab", from: state.url, to: opened.url || null, tabId: opened.id,
        });
        return {
          tabId: opened.id,
          summary: `clicked "${btn?.text || a.element_id}" — it opened the application ` +
                   `on ${where}, which is where we are now. The previous page is ` +
                   `irrelevant; work from the new page state.`,
        };
      }

      // No new tab, but the control was a link out of here. A blocked popup or
      // a swallowed click shouldn't cost the application when we know exactly
      // where the button pointed — go there in the tab we already have.
      if (btn?.opensNewTab && btn.href && hostOf(btn.href) !== hostOf(state.url)) {
        await chrome.tabs.update(tabId, { url: btn.href });
        await ensureEngine(tabId);
        say(`Following "${btn.text}" to ${hostOf(btn.href)}.`);
        await appendApplyStep(run.id, {
          kind: "followed_link", from: state.url, to: btn.href,
        });
        return { summary: `clicked "${btn.text}"; it opened nothing, so this tab was ` +
                          `navigated to ${hostOf(btn.href)} instead. Work from the new page.` };
      }
      return { summary: `clicked "${btn?.text || a.element_id}" (${a.reason})` };
    }

    case "done": {
      if (a.outcome === "submitted") {
        await updateApplyRun(run.id, {
          status: "submitted", finished_at: new Date().toISOString(),
        });
        return { terminal: true, status: "submitted", summary: a.note };
      }
      // "ready_to_submit" without having clicked anything means the model
      // believes it is finished but did not press the button. Treat that as a
      // hand-off rather than assuming success.
      await pauseRun(run, tabId, `Form looks complete but was not submitted: ${a.note}`);
      return { terminal: true, status: "paused_needs_human", summary: a.note };
    }

    case "pause":
      await pauseRun(run, tabId, a.reason, a.blocking_element_id
        ? [{ reason: a.reason, jcaId: a.blocking_element_id }] : []);
      return { terminal: true, status: "paused_needs_human", summary: a.reason };

    default:
      return { summary: `unknown tool ${call.name}`, isError: true };
  }
}

// ── pausing ─────────────────────────────────────────────────────────────────

/**
 * Stop and hand the application back, with a screenshot of exactly where.
 *
 * The tab is left open when it is the one the user needs to finish in — closing
 * it and asking them to find the posting again would defeat the point.
 */
async function pauseRun(run, tabId, reason, blocking = []) {
  let screenshotPath = null;
  try {
    const shot = await withDebugger(tabId, (cdp) => captureScreenshot(cdp));
    screenshotPath = await uploadPauseScreenshot(run.id, shot);
  } catch { /* a missing screenshot must not turn a pause into a failure */ }

  await updateApplyRun(run.id, {
    status: "paused_needs_human",
    pause_reason: String(reason).slice(0, 1000),
    screenshot_path: screenshotPath,
    finished_at: new Date().toISOString(),
  });
  // `tabId` is recorded because the tab is deliberately left open — it holds
  // the half-filled form the user is being asked to finish. Without it the
  // dashboard can only offer the job's URL, which opens a second, blank copy
  // of the form and throws away everything this run typed.
  await appendApplyStep(run.id, { kind: "pause", reason, blocking, tabId });

  // The notification is read on a phone or out of the corner of an eye, so it
  // carries the action rather than the diagnosis — and it says whose problem
  // this is. A crash of ours announcing itself as "Needs you" sends the user
  // looking for something to fix that was never on their side.
  chrome.notifications?.create(`jca-${run.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: `${pauseLabel(reason)} — ${run.job_company || "application"}`,
    message: pauseHeadline(reason).slice(0, 240),
  }, () => void chrome.runtime.lastError);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The slice of page state the model sees. Drops the block-detection fields. */
function observationFor(state) {
  const { text, html, ...rest } = state;
  return rest;
}

/** Host of a URL, for saying where we ended up. Never throws on a blank tab. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function labelOf(state, jcaId) {
  const hit = [...(state.fields || []), ...(state.choices || [])]
    .find((f) => f.id === jcaId);
  return hit?.label || hit?.question || jcaId;
}

/** Map a free-text grounding claim back to a profile key, when it names one. */
function keyFromGrounding(grounding, profile) {
  const g = String(grounding || "").toLowerCase();
  return Object.keys(profile).find((k) => g.includes(k.replace(/_/g, " ")) || g.includes(k)) || null;
}

/** Values are the applicant's own details — never log them verbatim. */
function redact(input) {
  const out = { ...input };
  for (const k of ["value", "text"]) {
    if (out[k]) out[k] = `${String(out[k]).slice(0, 40)}${out[k].length > 40 ? "…" : ""}`;
  }
  return out;
}

const KEEP_TURNS = 8;

/** An observation is the only message that is safe to start a window on. */
function isObservation(m) {
  return m?.role === "user" && typeof m.content === "string";
}

function trim(messages) {
  // A turn is normally (observation, assistant, tool_result), so three per turn
  // is the right size — but it is not a rhythm to cut on blindly. The rule-based
  // autofill pass answers a page without asking the model at all, so a turn can
  // be one message long, and cutting at a fixed offset can leave the window
  // opening on a tool_result whose tool_use has just been dropped. That is
  // rejected exactly as harshly as the unanswered tool_use it mirrors.
  //
  // So: cut no earlier than the budget, then walk forward to the next plain
  // observation. If there is none, keep the window whole — an oversized request
  // costs money, a malformed one ends the run.
  let cut = messages.length - KEEP_TURNS * 3;
  if (cut <= 0) return;
  while (cut < messages.length && !isObservation(messages[cut])) cut++;
  if (cut < messages.length) messages.splice(0, cut);
}
