// Unit test for "a stopped run must say what to do about it".
//
// A pause reason is a record of what happened. On its own that left users
// reading "upload failed for u2 — cdp: CSS is not defined" under a heading
// saying "Needs you", with nothing they could act on. This module turns the
// reason into an action, and three properties of it actually matter:
//
//   1. WHOSE FAULT. A crash of ours must not claim to need the user. Getting
//      this backwards sends someone hunting through a form for a problem that
//      was never on their side.
//   2. WHICH BUTTON. "retry" is right when the obstacle is upstream of the form
//      and wrong when the form is filled in and waiting on a signature — a
//      fresh run would refill a form the user has already completed by hand.
//      "grant" outranks both: until the permission is given nothing else about
//      the run can be attempted.
//   3. COMPOUND REASONS. A run can stop for two reasons at once, and the real
//      message that prompted all of this was exactly that — a broken upload AND
//      two consent boxes. Reporting only the first tells the user to press
//      Retry and lets them discover the consent boxes on the second stop.
import { helpForPause, pauseLabel, pauseHeadline } from "../extension/pause_help.js";
import { NEEDS_GRANT, originPatternFor } from "../extension/host_access.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

// ── the real messages ───────────────────────────────────────────────────────
// Verbatim from a user's dashboard. If these ever stop classifying, the feature
// is broken for the case it was built for.

const PROGNUM =
  "The CV upload consistently fails due to a technical error (upload failed for " +
  "u2 — cdp: CSS is not defined). Unable to attach the CV file, which is needed " +
  "for a complete application. Also, two consent checkboxes (privacy policy " +
  "acceptance and application data consent) require the applicant's own decision.";

const AVL =
  "Form is complete and checks out — submit is switched off, so it's yours to send.";

// The wording ensureEngine used before host_access.js existed. Runs paused
// under it are still in the table, so it has to keep classifying.
const LEGACY_GRANT =
  "This employer hosts its application on its own site, which needs one extra " +
  "permission. Open Settings → Applying and click \"Enable auto-apply on all " +
  "sites\", then retry this job.";

console.log("\ncompound reasons — both causes must survive");
{
  const h = helpForPause(PROGNUM);
  check("two distinct causes reported", h.parts.length, 2);
  check("the upload failure is one of them",
    h.parts.some((p) => p.kind === "upload_failed"), true);
  check("the consent boxes are the other",
    h.parts.some((p) => p.kind === "consent"), true);
  // A consent box is the user's to tick however the upload went, so this is
  // theirs — and Retry alone would not get past it.
  check("not billed as our fault", h.mine, false);
  check("chip says Needs you", pauseLabel(PROGNUM), "Needs you");
  check("primary action is the tab, not Retry", h.resume, "manual");
}

console.log("\nwhose fault it is");
check("a bare crash is ours", pauseLabel("step 4: Cannot read properties of undefined"), "Our fault");
check("a bare crash offers Retry", helpForPause("TypeError: x is not a function").resume, "retry");
check("consent is not ours", pauseLabel("consent required — you must tick this yourself"), "Needs you");
check("submit-disabled is not ours", pauseLabel(AVL), "Needs you");

console.log("\nwhich button");
check("submit switched off → open the tab", helpForPause(AVL).resume, "manual");
check("missing profile answer → retry after fixing",
  helpForPause('cited a saved answer you don\'t have ("notice_period"): Kündigungsfrist').resume, "retry");
check("ungrounded answer is the user's to write",
  helpForPause("only 20% of the cited evidence appears in the CV — the answer is not grounded").resume,
  "manual");
check("an unrecognised reason still hands over safely",
  helpForPause("something nobody has written a case for yet").resume, "manual");

console.log("\nthe permission grant outranks everything");
for (const [name, reason] of [
  ["current wording", NEEDS_GRANT],
  ["with the host named", `${NEEDS_GRANT} (This one is on careers.bosch.com.)`],
  ["the legacy Settings wording", LEGACY_GRANT],
  ["Chrome's own injection error", "couldn't inject into https://careers.acme.com: Cannot access contents of the page."],
]) {
  check(`${name} → grant`, helpForPause(reason).resume, "grant");
  check(`${name} → one-click CTA`, helpForPause(reason).cta, "Enable it now");
}
// A run blocked on BOTH the grant and something else must still lead with the
// grant: nothing else can even be attempted until it is given.
check("grant wins over a co-occurring consent stop",
  helpForPause(`${NEEDS_GRANT} Also, consent required — you need to tick this yourself.`).resume,
  "grant");

console.log("\nevery reason produces a usable one-liner");
for (const r of [PROGNUM, AVL, NEEDS_GRANT, "", null, "unrecognised"]) {
  const line = pauseHeadline(r);
  check(`non-empty for ${JSON.stringify(String(r).slice(0, 24))}`,
    typeof line === "string" && line.length > 20, true);
}

// ── host_access ─────────────────────────────────────────────────────────────
// The pattern has to be exactly what chrome.permissions wants, and schemes we
// could never inject into must be refused rather than turned into a grant
// prompt the user cannot satisfy.
console.log("\norigin patterns");
check("https", originPatternFor("https://careers.bosch.com/job/1?x=2"), "https://careers.bosch.com/*");
check("http is supported too", originPatternFor("http://alte-firma.de/jobs"), "http://alte-firma.de/*");
check("port is not part of the pattern", originPatternFor("https://x.de:8443/a"), "https://x.de/*");
for (const bad of ["chrome://extensions", "file:///tmp/x.html", "about:blank", "not a url", "", null, undefined]) {
  check(`refused: ${JSON.stringify(bad)}`, originPatternFor(bad), null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
