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
import { canReach, hasAllSites, NEEDS_GRANT } from "./host_access.js";
import {
  detectBlockSignal, recordBlock, recordSuccess, recordFailure, domainOf,
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
    name: "type",
    description:
      "Type into a field one character at a time, as a person would. Use this " +
      "ONLY for widgets that filter as you type — tag inputs, autocompletes, " +
      "location and university pickers — where `fill` puts the text in but no " +
      "suggestions appear. Set `then_enter` to accept the first suggestion. " +
      "For an ordinary text box use `fill`; this is slower and unnecessary there.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        element_id: { type: "string" },
        text: { type: "string" },
        then_enter: {
          type: "boolean",
          description: "press Enter afterwards to accept the highlighted suggestion",
        },
        profile_key: {
          type: "string",
          description: "the profile key this value came from, verbatim",
        },
      },
      required: ["element_id", "text", "then_enter", "profile_key"],
      additionalProperties: false,
    },
  },
  {
    name: "choose",
    description:
      "Select a dropdown option or radio choice. Works for a real <select>, a " +
      "radio group, and custom dropdowns (`type: \"combobox\"` in the page " +
      "state) — for those it opens the menu, waits for the options and picks " +
      "one, so one call is the whole interaction. If the options list came " +
      "back empty, choose anyway: they usually only exist once it is open, and " +
      "a failed match replies with what was actually available. `grounding` " +
      "must name the profile key or CV fact behind the choice. For anything " +
      "legal or contractual — visa status, notice period, salary — the answer " +
      "must come from the saved profile; if it is not there, pause instead.",
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

/**
 * tabId -> frameId of the frame holding the application form.
 *
 * WHY THIS IS NOT ALWAYS 0
 *
 * Employers routinely embed the ATS in an iframe on their own careers page:
 * Greenhouse, SmartRecruiters, Personio and Workday all ship an embed, and on
 * those pages the top frame is marketing copy with no form in it whatsoever.
 *
 * `chrome.tabs.sendMessage(tabId, msg)` with no frame goes to EVERY frame that
 * is listening, and the promise settles on whichever replies first. So with the
 * engine in more than one frame, "what is on this page" was answered by an
 * essentially arbitrary frame — usually the top one, which is exactly the frame
 * without the form. The model then reasoned correctly over a page with no
 * application on it and gave up.
 *
 * chooseFormFrame() decides once per injection, and everything after that is
 * addressed to that frame explicitly.
 */
const formFrame = new Map();

async function engine(tabId, message) {
  const frameId = formFrame.get(tabId);
  return chrome.tabs.sendMessage(
    tabId, { target: "jca-engine", ...message },
    frameId != null ? { frameId } : undefined);
}

/** Forget a tab's chosen frame — it navigated, or the run is done with it. */
function forgetFrame(tabId) { formFrame.delete(tabId); }

// A frame id is only meaningful for the document that was loaded when we chose
// it. A navigation invalidates it, and a closed tab must not leave an entry
// behind for a future tab to inherit — the worker outlives many runs.
chrome.tabs.onRemoved.addListener((tabId) => forgetFrame(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") forgetFrame(tabId);
});

/**
 * Ask every frame how much of an application form it contains, and keep the
 * winner.
 *
 * Ties and near-ties go to the top frame: a single-frame page is the common
 * case, and preferring a child on a small margin would hand the run to a
 * cookie-consent iframe, which is full of buttons and genuinely visible.
 */
async function chooseFormFrame(tabId, frameIds) {
  const scored = [];
  for (const frameId of frameIds) {
    const r = await chrome.tabs.sendMessage(
      tabId, { target: "jca-engine", type: "FRAME_SCORE" }, { frameId }
    ).catch(() => null);
    if (r?.ok) scored.push({ frameId, ...r });
  }
  if (!scored.length) { formFrame.delete(tabId); return null; }

  const top = scored.find((s) => s.isTop) || scored[0];
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));

  // The margin is what stops a consent dialog or a chat widget stealing the
  // run: a real embedded application form scores far above them, so requiring
  // a clear win costs nothing and refuses the ambiguous cases.
  const winner = (best.frameId !== top.frameId && best.score > top.score * 2 && best.score >= 12)
    ? best : top;

  formFrame.set(tabId, winner.frameId);
  return winner;
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
    // PING goes to the chosen frame if there is one. If that frame has gone —
    // the embed re-mounted, the page navigated — this fails and we re-inject
    // and re-choose, which is the behaviour we want.
    const pong = await engine(tabId, { type: "PING" }).catch(() => null);
    if (pong?.ok) return true;

    // Only worth injecting once the tab has actually committed a document.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the tab was closed");

    if (tab.status === "complete" && !injected) {
      injected = true;
      forgetFrame(tabId);
      try {
        // allFrames, because the application is very often in an embed rather
        // than the page the user navigated to. Injecting only the top frame
        // meant the run drove a page that had no form in it.
        //
        // Frames we lack access to simply fail to inject; that is fine and
        // expected, so a partial result is a success as long as SOMETHING took.
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ENGINE_FILES,
        });

        const frameIds = (results || [])
          .filter((r) => !r.error)
          .map((r) => r.frameId)
          .filter((id) => id != null);

        if (frameIds.length) await chooseFormFrame(tabId, frameIds);
        continue;                       // re-PING immediately
      } catch (e) {
        // Injecting into all frames can fail wholesale on a page whose top
        // frame we may not touch. Before reporting that, find out whether the
        // real answer is simply that we were never granted the site.
        const reach = await canReach(tab.url);
        if (!tab.url || (!reach.ok && reach.reason === "not_granted")) {
          // Tagged, not just worded. runApply's catch branches on this flag and
          // ends the run as a pause with a `pause_reason`, which is what puts
          // the "Enable it now" button on the dashboard. Thrown as a plain
          // Error it was recorded as `error` on a `failed` run — a red row with
          // no button and nothing the user could do from where they were. That
          // is the exact failure being reported.
          //
          // Tagging here rather than guarding each call site covers all four:
          // the first load, the tab migration, the re-inject inside observe,
          // and the in-tab navigation.
          throw Object.assign(new Error(NEEDS_GRANT),
                              { needsGrant: true, host: hostOf(tab.url) });
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

/**
 * Block until a tab has actually committed the document we sent it to.
 *
 * `chrome.tabs.update` resolves when the navigation *starts*, not when it
 * lands. Until it lands the old document is still committed and its content
 * script still answers PING — so `ensureEngine` returned true against the page
 * we had just left, `waitForContent` read the stale DOM, and the model
 * cheerfully clicked the same Apply button until the step budget ran out. That
 * is the "it opens the site and nothing happens" symptom.
 *
 * Matching on host rather than the exact URL, because an ATS redirect chain
 * rewrites the path and query on the way in and demanding an exact match would
 * time out on every successful navigation.
 */
async function waitForNavigation(tabId, wantUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const want = hostOf(wantUrl);
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("the tab was closed");
    if (t.status === "complete" && (!want || hostOf(t.url) === want)) return t;
    await sleep(250);
  }
  // Out of time is not fatal on its own — the caller still has ensureEngine and
  // waitForContent behind this, and both have their own deadlines.
  return chrome.tabs.get(tabId).catch(() => null);
}

/**
 * Wait for a freshly opened tab to actually have a URL.
 *
 * `chrome.tabs` reports a brand-new tab with `url: ""` (or "about:blank") and
 * the real destination in `pendingUrl` until the navigation commits. Anything
 * that reads `tab.url` in that window sees nothing and, if it draws a
 * conclusion from that, draws the wrong one.
 */
async function waitForTabUrl(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await chrome.tabs.get(tabId).catch(() => null);
    if (!last) return null;                       // closed under us
    const url = last.url || "";
    if (url && url !== "about:blank") return last;
    await sleep(200);
  }
  return last;
}

/** All tab ids right now — the "before" half of new-tab detection. */
async function tabIdsNow() {
  const all = await chrome.tabs.query({}).catch(() => []);
  return new Set(all.map((t) => t.id));
}

/**
 * What a page says once an application has actually landed.
 *
 * Deliberately generous, and deliberately only ever used as *positive*
 * evidence: a page that says none of this may still have submitted, so a miss
 * pauses for the user rather than recording a failure.
 */
const CONFIRMATION_RE = new RegExp([
  "thank you", "thanks for applying", "application (received|submitted|complete)",
  "we('| ha)ve received", "successfully (applied|submitted)",
  "vielen dank", "danke für", "bewerbung .*(eingegangen|erhalten|übermittelt)",
  "erfolgreich (übermittelt|gesendet|versendet)",
].join("|"), "i");

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
/** A page's identity for "has this actually changed?" purposes. */
const pageSigOf = (s) =>
  `${s?.url || ""}|${s?.step || ""}|${(s?.fields || []).map((f) => f.id).join(",")}`;

async function waitForContent(tabId, timeoutMs = 25000,
                              { requireSignal = false, changedFrom = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  // `changedFrom` says "don't accept the page we just acted on". A grace window
  // keeps that from costing anything when the click legitimately changed
  // nothing — after it, the old page is accepted rather than waiting out the
  // whole timeout.
  const grace = Date.now() + 2000;
  const was = changedFrom ? pageSigOf(changedFrom) : null;
  let lastSize = -1, stableFor = 0, latest = null;

  while (Date.now() < deadline) {
    latest = await observe(tabId).catch(() => null);

    if (latest) {
      // "Ready" must mean "ready and different". Clicking Next on page 2 of a
      // Workday wizard leaves a page that is still a form, so the first poll
      // returned instantly with the page we had just left — and the model was
      // shown stale fields and clicked Next again.
      const fresh = !was || Date.now() > grace || pageSigOf(latest) !== was;

      // Unambiguously ready: a real form, or a control that starts one.
      if (fresh && latest.isForm) return latest;
      if (fresh && (latest.buttons || []).some((b) => APPLY_CONTROL_RE.test(b.text))) return latest;

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
  // A bare `observe()` here could throw straight out of waitForContent and into
  // the run's catch, turning "the page was slow" into a failed application.
  return latest || await observe(tabId).catch(() => null);
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

  // Which domain a failure actually belongs to. A run migrates: it starts on
  // the board and can end on the employer's own site, and the circuit breaker
  // is only meaningful if the strike lands where the trouble was.
  // `contactedDomain` stays false until a tab is open, so everything that can
  // go wrong before then — document rendering, storage, the tailored packet —
  // cannot get a site quarantined.
  let activeDomain = run.domain;
  let contactedDomain = false;
  // The `finally` below reads this to decide whether to keep the tab. A `return`
  // can't be seen from there, so every exit has to record itself here first —
  // three of them didn't, and a run that paused on a timeout or on running out
  // of steps had its tab closed as if it had failed. That is the tab the user is
  // being asked to finish the application in. `handOver()` exists so a pause and
  // the record of it can't drift apart again.
  let status = "failed";

  /**
   * Refuse to hand back a request the user has already satisfied.
   *
   * Asking for the all-sites permission when it is already held is not a
   * recoverable state from the user's side: they press the button, the run
   * restarts, and it stops in the same place with the same message. There is
   * nothing they can do to break out of it, so the loop must be made
   * impossible here rather than explained better in the UI.
   *
   * If we get here holding the grant, the pause is a bug in our reachability
   * check and the honest thing is to say so and let the run be retried.
   */
  const grantPause = async (reason) => {
    if (await hasAllSites()) {
      return await handOver(
        "The run stopped saying it needed site permission, but that permission " +
        "is already granted — so this is a fault on our side, not something " +
        "for you to fix. Press Retry; if it happens again it needs reporting.");
    }
    return await handOver(reason);
  };

  const handOver = async (reason, blocking) => {
    // Assigned BEFORE the first await, and that ordering is the whole point.
    //
    // Callers write `return handOver(...)`. In an async function that evaluates
    // the call, runs it only as far as its first await, and then runs the
    // `finally` below — all before the returned promise settles. With the
    // assignment after the await, `finally` still saw "failed", computed
    // `keep = null`, and called chrome.tabs.remove() on the tab *while*
    // pauseRun was still screenshotting it. Every "took too long" and "gave up
    // after 25 steps" hand-off destroyed the half-filled application it had
    // just asked the user to go and finish.
    //
    // Setting it first makes that unreachable even if a future caller forgets
    // the await — which is why it is done this way round rather than by
    // auditing the call sites.
    status = "paused_needs_human";
    await pauseRun(run, tabId, reason, blocking);
    return status;
  };

  try {
    // ── can we even touch this site? ────────────────────────────────────────
    //
    // Asked first, before a single PDF is rendered or a tab is opened. This
    // used to be discovered at the far end of the run — after the documents
    // were made, the posting was opened, and the Apply button had been clicked
    // through to the employer's own domain — and the answer was always going to
    // be the same one `permissions.contains` gives instantly. The user got a
    // dead run and a instruction to go and find a setting.
    //
    // Note this is the *posting's* origin. The employer's site is a different
    // origin we cannot know yet; that one is checked at the moment we follow a
    // link to it, in followNewTab's caller.
    const reach = await canReach(run.job_url);
    if (!reach.ok && reach.reason === "not_granted") {
      return await grantPause(NEEDS_GRANT);
    }
    if (!reach.ok && reach.reason === "unsupported_scheme") {
      return await handOver(
        `This posting's address isn't a web page we can drive (${run.job_url}). ` +
        `Open it yourself — your tailored CV and cover letter are ready.`);
    }

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
    contactedDomain = true;              // from here on, failures are the site's
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
    // A Map keyed on jcaId, not a list. As a list nothing ever removed an
    // entry, so a first attempt that failed because a React uploader had not
    // yet mounted its change handler left a permanent record — and a later,
    // successful attach of the very same input still blocked the submit with
    // "required upload is empty".
    const unmetUploads = new Map();

    /**
     * Attach whatever this page still wants, and keep the unmet set honest.
     *
     * Called both after a rule-based fill and on any later observation that
     * shows an empty upload, because on a same-URL multi-page flow the CV slot
     * frequently is not on the page we first filled.
     */
    const attachPending = async (fileInputs) => {
      const { plan, unmet } = planUploads(fileInputs, docs);
      for (const u of unmet) unmetUploads.set(u.jcaId, u);

      for (const p of plan) {
        try {
          const res = await attachDocument(tabId, {
            jcaId: p.jcaId, doc: p.doc, tier: run.tier, frameId: formFrame.get(tabId),
          });
          unmetUploads.delete(p.jcaId);
          say(`Attached ${p.kind} (${res.path}${res.unverified ? ", taken by the page" : ""})`);
          await appendApplyStep(run.id, {
            kind: "upload", doc: p.kind, via: res.path, unverified: !!res.unverified,
          });
        } catch (e) {
          unmetUploads.set(p.jcaId, { jcaId: p.jcaId, label: p.label, reason: e.message });
          await appendApplyStep(run.id, { kind: "upload_failed", doc: p.kind, error: e.message });
        }
      }
    };

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (Date.now() - started > MAX_WALL_MS) {
        return await handOver("took too long — handing this one back to you");
      }

      const state = await observe(tabId);

      // ── are we still welcome? ─────────────────────────────────────────────
      const signal = detectBlockSignal(state);
      if (signal) {
        // Leave. No retry, no reload, and nothing goes near the challenge.
        //
        // Quarantine the site that put the challenge up, which after a follow
        // is the employer's, not the board we came in through. Resting
        // linkedin.com because a company's own careers page showed a captcha
        // stops every other LinkedIn application for a day, for nothing.
        const blocker = domainOf(state.url) || activeDomain;
        await recordBlock(blocker, signal);
        await appendApplyStep(run.id, { kind: "blocked", signal, url: state.url });
        await updateApplyRun(run.id, {
          status: "blocked", error: `site returned a block signal (${signal})`,
          finished_at: new Date().toISOString(),
        });
        say(`${blocker} asked us to stop (${signal}). Quarantined for 24h; other sites keep running.`);
        return "blocked";
      }

      // ── free pass: rules, then uploads ────────────────────────────────────
      //
      // Keyed on what the page IS, not on its address. Every multi-page flow
      // that matters — LinkedIn Easy Apply's modal, Workday's wizard, iCIMS,
      // SmartRecruiters, Ashby — advances through four or five pages of
      // questions without the URL ever changing. Keyed on `state.url`, the free
      // rule-based pass ran on page one and never again, so pages two onward
      // were filled one field per model round-trip against a 25-step budget and
      // simply ran out. This is the single change that makes those flows
      // finishable.
      //
      // Re-running is safe: autofill never overwrites a field that already has
      // a value, so a page it has seen costs one message and fills nothing.
      const pageSig = `${state.url}|${state.step || ""}|` +
                      (state.fields || []).map((f) => f.id).join(",");

      if ((state.isFillable ?? state.isForm) && !autofilled.has(pageSig)) {
        autofilled.add(pageSig);
        const { report } = await engine(tabId, { type: "AUTOFILL", profile, packet });
        say(`Filled ${report?.filled?.length || 0} fields from your saved answers`);
        await appendApplyStep(run.id, {
          kind: "autofill", url: state.url,
          filled: report?.filled?.length || 0, skipped: report?.skipped || [],
        });
        await attachPending(report?.files || []);
        continue;                    // re-observe with the form now populated
      }

      // Uploads are planned on every observation, not only on a page we have
      // just autofilled. A CV slot that appears on step three of a same-URL
      // flow was otherwise never attached, and the gate then refused to submit
      // an otherwise finished application because "required upload is empty".
      if ((state.files || []).some((f) => !f.attached)) {
        await attachPending(state.files);
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
      if (!call) return await handOver("the model stopped without choosing an action");

      const outcome = await execute({
        call, state, tabId, run, docs, answers, profile, cvText,
        unmetUploads, submitPolicy, say, openTabs, frameId: formFrame.get(tabId),
      });

      // The click opened the application elsewhere — that tab is the run now.
      // The autofill pass is keyed by page signature, so the new page gets its
      // own free rule-based pass rather than being treated as already handled.
      if (outcome.tabId && outcome.tabId !== tabId) {
        tabId = outcome.tabId;
        activeDomain = domainOf(outcome.url) || activeDomain;
        await ensureEngine(tabId);
        await waitForContent(tabId, FIRST_LOAD_MS, { requireSignal: true });
      } else if (outcome.url) {
        // Same tab, new site — a plain <a href> Apply link, or a redirect chain
        // from the board to the ATS. The breaker must follow the run.
        activeDomain = domainOf(outcome.url) || activeDomain;
      }

      await appendApplyStep(run.id, {
        kind: "action", tool: call.name, input: redact(call.input),
        result: outcome.summary,
      });

      if (outcome.terminal) {
        // A terminal step may have paused on a DIFFERENT tab from the one the
        // loop is holding — the employer's page we had just followed to. The
        // `finally` keeps exactly one tab, and without this it kept the stale
        // posting and closed the page the user was being sent to.
        if (outcome.pausedTabId != null) tabId = outcome.pausedTabId;
        status = outcome.status;
        if (status === "submitted") await recordSuccess(activeDomain);
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
      //
      // `changedFrom` is the page we just acted on. Without it the first poll
      // matched immediately — the page after a "Next" click is still a form —
      // and the model was handed the previous step's fields to act on again.
      await waitForContent(tabId, 12000, { changedFrom: state });
    }

    return await handOver(`gave up after ${MAX_STEPS} steps`);

  } catch (e) {
    // A missing grant is not a failure, it is a question. Ending it as a pause
    // is what gives the row a `pause_reason`, and therefore the one-click
    // "Enable it now" button — instead of a red "Failed" carrying an
    // instruction to go and find a setting.
    if (e?.needsGrant) {
      return await grantPause(e.host ? `${NEEDS_GRANT} (This one is on ${e.host}.)` : NEEDS_GRANT);
    }

    // Strike the domain we were actually on, and only if we ever got there.
    //
    // ensureDocuments() runs before the tab is opened, so a read-only Downloads
    // folder or a Storage 403 used to put three strikes on greenhouse.io and
    // quarantine it for a day over a fault on this machine that the site had no
    // part in. And once a run follows a posting to the employer's site, later
    // failures belong to that domain, not to the board we came from.
    if (contactedDomain) await recordFailure(activeDomain, e.message).catch(() => {});

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
      // Record what the field ACTUALLY holds, not what we asked for. A date or
      // masked input that discarded the value would otherwise be remembered as
      // filled, pass through the run untouched, and fail the gate at the very
      // end with nothing pointing at the cause.
      const landed = r?.value ?? "";
      answers[a.element_id] = { label, text: landed || a.value,
                                profileKey: a.profile_key, via: "fill" };
      if (!r?.ok) {
        return { summary: `could not fill "${label}": ${r?.error}`, isError: true };
      }
      return {
        summary: landed === a.value
          ? `filled "${label}"`
          : `filled "${label}" — it now reads "${landed}" ` +
            `(the field reformatted or trimmed what was typed)`,
      };
    }

    case "type": {
      const r = await engine(tabId, {
        type: "ACT",
        action: { type: "TYPE", jcaId: a.element_id, text: a.text,
                  thenEnter: !!a.then_enter },
      });
      const label = labelOf(state, a.element_id);
      answers[a.element_id] = { label, text: a.text, profileKey: a.profile_key, via: "type" };
      return {
        summary: r?.ok
          ? `typed "${a.text}" into "${label}"${a.then_enter ? " and pressed Enter" : ""}` +
            ` (it now reads "${r.value ?? ""}")`
          : `could not type: ${r?.error}`,
        isError: !r?.ok,
      };
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
          jcaId: a.element_id, doc, tier: run.tier, frameId: ctx.frameId,
        });
        unmetUploads.delete(a.element_id);
        return { summary: `attached ${a.doc_kind} (${res.path})` };
      } catch (e) {
        unmetUploads.set(a.element_id,
          { jcaId: a.element_id, label: a.doc_kind, reason: e.message });
        return { summary: `upload failed: ${e.message}`, isError: true };
      }
    }

    case "click": {
      const btn = (state.buttons || []).find((b) => b.id === a.element_id);

      // ── THE GATE ──────────────────────────────────────────────────────────
      if (btn?.kind === "submit") {
        const gate = canSubmit(state, {
          answers, profile, cvText, unmetUploads: [...unmetUploads.values()],
        });

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
        // ── did it actually go? ──────────────────────────────────────────────
        //
        // This used to sleep 2.5s and write "submitted". Every client-side
        // rejection — a required field the gate could not see, a server-side
        // validation error, a session that expired — was therefore recorded as
        // a sent application. That is the worst error this system can make:
        // the user believes they have applied and never does.
        //
        // So: look at the page afterwards and require evidence.
        await sleep(2500);
        const after = await observe(tabId).catch(() => null);

        const errors = after?.errors || [];
        // A page we can no longer read is NOT evidence of success. It usually
        // means the submit navigated somewhere — but it also covers a closed
        // tab and an origin we have no access to, and of the two possible
        // mistakes only one is recoverable: a run wrongly marked "unconfirmed"
        // costs the user a look, while a run wrongly marked "Applied ✓" means
        // they never apply and never find out.
        const movedOn = !!after && after.url !== state.url;
        const thanked = CONFIRMATION_RE.test(after?.text || "");

        if (errors.length) {
          // Recoverable, and the model gets to fix it: this is a form that is
          // still on screen telling us what is wrong with it.
          return { summary: `the form refused the submit: ${errors.join("; ")}`,
                   isError: true };
        }
        if (movedOn || thanked) {
          await updateApplyRun(run.id, {
            status: "submitted", finished_at: new Date().toISOString(),
          });
          return { terminal: true, status: "submitted", summary: "submitted" };
        }
        // No navigation, no confirmation, no error. We genuinely do not know,
        // and guessing either way is worse than saying so.
        await pauseRun(run, tabId,
          "Submit was clicked, but the page showed no confirmation and no error — " +
          "please check whether the application actually went through.");
        return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
                 summary: "submitted but unconfirmed" };
      }

      // The application may have opened somewhere else entirely.
      const opened = await followNewTab(tabId, tabsBefore, ctx.openTabs);
      if (opened) {
        // The moment we learn the employer's real domain is the moment to find
        // out whether we may touch it — not four steps later, when injection
        // fails with a message naming no host at all.
        //
        // A tab is caught within a few hundred milliseconds of the click, and
        // at that point it usually has NO url yet — the destination is in
        // `pendingUrl` until the navigation commits.
        //
        // Reading that empty url as "we lack permission for this origin" is
        // what produced an unbreakable loop: every run paused asking for a
        // permission the user had already granted, and granting it again
        // restarted a run that paused in the same place. Since the manifest
        // now takes "tabs", `url` is readable for every origin, so a blank one
        // means "not navigated yet" and nothing else — wait for it.
        const settled = await waitForTabUrl(opened.id);
        const openedUrl = settled?.url || opened.pendingUrl || opened.url || "";
        opened.url = openedUrl;

        const reach = await canReach(openedUrl);
        if (openedUrl && !reach.ok && reach.reason === "not_granted") {
          const site = hostOf(openedUrl);
          await pauseRun(run, opened.id,
            site ? `${NEEDS_GRANT} (This one is on ${site}.)` : NEEDS_GRANT);
          // `pausedTabId` is the employer's tab, not the posting we came from.
          // That is the page with the application on it, and it is the one the
          // cleanup must keep open.
          return { terminal: true, status: "paused_needs_human", pausedTabId: opened.id,
                   summary: `followed to ${site || "the employer's site"}; no access to that origin` };
        }
        // Only judge a scheme we can actually see. A tab that still has no url
        // after the wait is followed anyway — ensureEngine gives a truthful
        // error about the page it finds, which beats guessing here.
        if (openedUrl && !reach.ok) {
          await pauseRun(run, opened.id,
            `The application moved to ${openedUrl}, which isn't a page we can drive. ` +
            `Open it and finish there — your documents are ready.`);
          return { terminal: true, status: "paused_needs_human", pausedTabId: opened.id,
                   summary: `followed to an unsupported address` };
        }

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
          url: opened.url,
          summary: `clicked "${btn?.text || a.element_id}" — it opened the application ` +
                   `on ${where}, which is where we are now. The previous page is ` +
                   `irrelevant; work from the new page state.`,
        };
      }

      // No new tab, but the control was a link out of here. A blocked popup or
      // a swallowed click shouldn't cost the application when we know exactly
      // where the button pointed — go there in the tab we already have.
      //
      // This is the commonest shape of all on LinkedIn: "Apply on company
      // website" is a target=_blank link, and Chrome suppresses the popup in a
      // background tab — which is exactly how a queued run opens the posting.
      if (btn?.opensNewTab && btn.href && hostOf(btn.href) !== hostOf(state.url)) {
        // The sibling path above gates on reach; this one did not, so the very
        // most likely route to an employer's own site went straight into
        // ensureEngine and died as a bare "failed".
        const reach = await canReach(btn.href);
        if (!reach.ok && reach.reason === "not_granted") {
          await pauseRun(run, tabId,
            `${NEEDS_GRANT} (This one is on ${hostOf(btn.href)}.)`);
          return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
                   summary: `would have followed to ${hostOf(btn.href)}; no access there` };
        }

        await chrome.tabs.update(tabId, { url: btn.href });
        // The pinned frame belonged to the document we are leaving.
        forgetFrame(tabId);
        // chrome.tabs.update resolves when the navigation STARTS. The old
        // document is still committed and its engine still answers PING, so
        // without this ensureEngine succeeded against the page we had just left,
        // waitForContent read the old DOM, and the model clicked the same Apply
        // button over and over until the step budget ran out.
        await waitForNavigation(tabId, btn.href);
        await ensureEngine(tabId);
        say(`Following "${btn.text}" to ${hostOf(btn.href)}.`);
        await appendApplyStep(run.id, {
          kind: "followed_link", from: state.url, to: btn.href,
        });
        return { url: btn.href,
                 summary: `clicked "${btn.text}"; it opened nothing, so this tab was ` +
                          `navigated to ${hostOf(btn.href)} instead. Work from the new page.` };
      }

      // Nothing opened and nothing was declared — but the click may still have
      // navigated us. A plain <a href> Apply link with no target, or a board
      // that 302s through to the employer's ATS, both land here, and both leave
      // the run on a completely different site than the one it checked access
      // for at the start.
      const landed = await chrome.tabs.get(tabId).catch(() => null);
      if (landed?.url && hostOf(landed.url) !== hostOf(state.url)) {
        const reach = await canReach(landed.url);
        if (!reach.ok && reach.reason === "not_granted") {
          await pauseRun(run, tabId, `${NEEDS_GRANT} (This one is on ${hostOf(landed.url)}.)`);
          return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
                   summary: `the click landed on ${hostOf(landed.url)}; no access there` };
        }
        forgetFrame(tabId);
        await waitForNavigation(tabId, landed.url, 15000);
        await ensureEngine(tabId).catch(() => {});
        return { url: landed.url,
                 summary: `clicked "${btn?.text || a.element_id}" and it moved to ` +
                          `${hostOf(landed.url)}. Work from the new page state.` };
      }

      return { summary: `clicked "${btn?.text || a.element_id}" (${a.reason})` };
    }

    case "done": {
      if (a.outcome === "submitted") {
        // The model saying it submitted is a claim, not evidence — and it is
        // the least impartial witness available, having just spent eight steps
        // trying to. Held to the same standard as the submit click itself: the
        // page must have moved on or said thank you.
        const after = await observe(tabId).catch(() => null);
        const confirmed = !!after &&
          (after.url !== state.url || CONFIRMATION_RE.test(after.text || ""));

        if (confirmed) {
          await updateApplyRun(run.id, {
            status: "submitted", finished_at: new Date().toISOString(),
          });
          return { terminal: true, status: "submitted", summary: a.note };
        }
        await pauseRun(run, tabId,
          "The run believes it submitted, but the page showed no confirmation — " +
          "please check whether the application actually went through.");
        return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
                 summary: `claimed submitted, unconfirmed: ${a.note}` };
      }
      // "ready_to_submit" without having clicked anything means the model
      // believes it is finished but did not press the button. Treat that as a
      // hand-off rather than assuming success.
      await pauseRun(run, tabId, `Form looks complete but was not submitted: ${a.note}`);
      return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
               summary: a.note };
    }

    case "pause":
      await pauseRun(run, tabId, a.reason, a.blocking_element_id
        ? [{ reason: a.reason, jcaId: a.blocking_element_id }] : []);
      return { terminal: true, status: "paused_needs_human", pausedTabId: tabId,
               summary: a.reason };

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
