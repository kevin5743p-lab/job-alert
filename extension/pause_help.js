// pause_help.js — turning "why it stopped" into "what you should do about it".
//
// A paused run already records a reason, and every one of those reasons is
// true. The trouble is that being true is not the same as being actionable:
//
//   "upload failed for u2 — cdp: CSS is not defined"
//
// tells the user nothing they can act on, and worse, it appears under a heading
// that says "Needs you" — so a fault of ours reads as a request for help the
// user cannot possibly answer. Meanwhile a reason that genuinely is theirs to
// settle (an unticked consent box, a saved answer they never filled in) looks
// exactly the same in the list.
//
// This module makes the distinction the interface owes the user:
//
//   what happened   the reason, kept verbatim — it is the audit trail
//   what to do      concrete steps, or an explicit "nothing, this one is ours"
//   what happens    whether pressing the button resumes it, or whether the
//   after           application is now theirs to finish in the open tab
//
// Classification is by pattern over the recorded reason rather than by a field
// on the run, so runs that paused before this existed are explained too, and
// nothing has to be migrated.
//
// The rule for adding a case: if a user reading it could not name the next
// action within a few seconds, the case is not finished.

/**
 * `resume` is the honest part, and the two values mean different things:
 *
 *   "retry"   the run can start again once the cause is dealt with, and the
 *             button does exactly that
 *   "manual"  the form is on screen and finishing it is the user's to do. The
 *             engine cannot take it from there — offering "Retry" as the
 *             primary action here would refill a form the user has already
 *             completed by hand
 */
// `group` exists so two patterns describing the *same* problem can't both take
// a slot. A broken CV upload matches the crash pattern and the upload pattern
// at once; without grouping, those two filled the list between them and the
// consent boxes named in the very same message were never shown.
const CASES = [
  // ── ours, not theirs ──────────────────────────────────────────────────────
  // Listed first: a technical failure often mentions a form control too, and
  // matching "required upload is empty" before "CSS is not defined" would file
  // our own crash under "something for you to tick".
  //
  // Specific before generic within the group — "your CV wouldn't attach" is
  // worth more to the user than "something threw".
  {
    kind: "upload_failed", group: "ours",
    test: /upload failed for|setFileInputFiles|no element for|debugger\.attach|datatransfer:|couldn't attach|cv upload/i,
    headline: "Your CV wouldn't attach to the form.",
    todo: [
      "Press Retry — the upload is tried a second way on a fresh run.",
      "If it fails again, open the tab and attach the CV yourself: it's in your packet, under Packet on this row.",
    ],
    resume: "retry",
  },
  {
    kind: "fault", group: "ours",
    test: /\b(is not defined|is not a function|cannot read (properties|property)|undefined is not|null is not|TypeError|SyntaxError|ReferenceError)\b/i,
    headline: "This one broke on our side — it isn't waiting on you.",
    todo: [
      "Press Retry. Most of these are a one-off and the second run goes through.",
      "If it stops here again, the cause is a bug rather than the form — the message above is what a report needs.",
    ],
    resume: "retry",
  },
  {
    kind: "site_blocked",
    test: /captcha|bot check|are you a (human|robot)|cloudflare|access denied|forbidden|rate ?limit|\b(401|403|429)\b/i,
    headline: "The site stopped the run, not the form.",
    todo: [
      "Open the tab and clear whatever it's showing — usually a bot check or a sign-in.",
      "Then press Retry. If the whole site is resting, use Resume now under Paused sites.",
    ],
    resume: "retry",
  },

  // ── genuinely theirs to decide ────────────────────────────────────────────
  {
    kind: "consent",
    test: /consent/i,
    headline: "There are consent boxes only you can tick.",
    todo: [
      "Open the tab and read what each box actually agrees to.",
      "Tick the ones you accept, then send the application yourself.",
    ],
    // Deliberately not "retry": these boxes are never ticked automatically, so
    // a fresh run would arrive at this same stop.
    resume: "manual",
  },
  {
    kind: "submit_off",
    test: /submit is switched off|submit disabled by policy|let me press submit/i,
    headline: "The form is filled and checked — it's only waiting to be sent.",
    todo: [
      "Open the tab, look it over, and press the form's own submit button.",
      "To have it sent for you next time: Settings → \"When a form is complete\" → let it submit when confident.",
    ],
    resume: "manual",
  },
  {
    kind: "sensitive",
    test: /sensitive value we won't fill|password|iban|social security|passport|id number/i,
    headline: "The form wants something we will not type for you.",
    todo: [
      "Open the tab and enter it yourself — passwords, ID and bank numbers are never filled by the engine.",
      "Then finish the application in the same tab.",
    ],
    resume: "manual",
  },

  // ── missing input we could have used ──────────────────────────────────────
  {
    kind: "missing_profile",
    test: /saved answer you don't have|without a saved answer|must come from the saved profile|doesn't match your saved/i,
    headline: "A question needs an answer you haven't saved yet.",
    todo: [
      "Open Settings → your application profile and fill in the answer named above.",
      "Then press Retry — the run picks the new answer up from the start.",
    ],
    resume: "retry",
  },
  {
    kind: "not_grounded",
    test: /not grounded|no cited source|evidence too vague/i,
    headline: "It wouldn't write an answer your CV doesn't support.",
    todo: [
      "Open the tab and answer that question in your own words, then send it yourself.",
      "If your CV does cover it, add the detail to your CV and re-tailor — the next run can then cite it.",
    ],
    resume: "manual",
  },
  {
    kind: "unsupported_site",
    test: /we don't apply through|apply directly/i,
    headline: "This posting only exists somewhere we don't apply through.",
    todo: [
      "Open it and apply by hand — your tailored CV and cover letter are already made, under Packet on this row.",
    ],
    resume: "manual",
  },
  {
    kind: "incomplete",
    test: /required field is empty|required question unanswered|required upload is empty|validation error|looks complete but was not submitted/i,
    headline: "The form still has something unanswered.",
    todo: [
      "Open the tab — what's missing is listed above, and it's on screen.",
      "Fill it in and send it yourself, or press Retry to have the run try the page again.",
    ],
    resume: "manual",
  },
];

const FALLBACK = {
  kind: "unknown",
  headline: "It stopped here and handed the application back to you.",
  todo: [
    "Open the tab to see where it got to — the page is left exactly as it was.",
    "Finish it yourself, or press Retry to run it again from the start.",
  ],
  resume: "manual",
};

const OURS = new Set(["fault", "upload_failed"]);

/**
 * Explain a pause.
 *
 * A run does not always stop for one reason, and the real message that prompted
 * this — a broken CV upload *and* two consent boxes, in the same pause — is
 * exactly the case a single-answer classifier gets wrong. Reporting only the
 * crash there would have told the user to press Retry and left them to discover
 * the consent boxes on the second stop.
 *
 * So every matching case is returned, in the order they are listed above.
 * Returns:
 *
 *   parts    one { kind, headline, todo, mine } per distinct cause
 *   mine     true only when *every* cause is ours — a run that also needs the
 *            user's signature still needs the user, whatever else broke
 *   resume   "retry" only when every cause clears on its own once dealt with.
 *            One manual cause makes the whole run manual, because a fresh run
 *            would arrive back at that same stop.
 */
export function helpForPause(reason) {
  const text = String(reason || "");
  const seen = new Set();
  // Two is the useful limit: a third line stops being read, and the reason
  // itself is displayed directly above this.
  const parts = CASES
    .filter((c) => c.test.test(text))
    .filter((c) => { const g = c.group || c.kind; return !seen.has(g) && seen.add(g); })
    .slice(0, 2);
  if (!parts.length) parts.push(FALLBACK);

  const mine = parts.every((p) => OURS.has(p.kind));
  const resume = parts.every((p) => p.resume === "retry") ? "retry" : "manual";
  // The one the user acts on: whatever they have to do themselves outranks
  // anything they only have to press a button about.
  const lead = parts.find((p) => !OURS.has(p.kind)) || parts[0];

  return {
    kind: lead.kind,
    headline: lead.headline,
    todo: lead.todo,
    parts: parts.map((p) => ({
      kind: p.kind, headline: p.headline, todo: p.todo, mine: OURS.has(p.kind),
    })),
    resume,
    cta: resume === "retry" ? "Retry" : "Open the tab",
    mine,
  };
}

/**
 * One line for a notification or a tooltip, where there is room for the action
 * and nothing else. The action, not the diagnosis — the diagnosis is already
 * in the reason next to it.
 */
export function pauseHeadline(reason) {
  const h = helpForPause(reason);
  return `${h.headline} ${h.todo[0]}`;
}

/** The status chip's label. A crash of ours should not claim to need the user. */
export function pauseLabel(reason) {
  return helpForPause(reason).mine ? "Our fault" : "Needs you";
}
