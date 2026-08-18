// confidence.js — the gate that stands between a filled form and a sent one.
//
// A submitted application cannot be recalled. Everything else in this system is
// recoverable: a bad fill can be corrected, a stalled run can be retried, a
// quarantined domain comes back tomorrow. Pressing submit is the one action
// that is final, so the decision to press it is made here, by deterministic
// checks over the observed page — not by asking the model whether it feels
// confident. A model that has just spent eight steps filling a form is the
// least impartial judge available of whether it filled it correctly.
//
// The gate only ever blocks. It cannot cause a submit; it can only refuse one.

/** Words that are structure rather than content, ignored when matching. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at",
  "by", "from", "as", "is", "are", "was", "were", "be", "been", "i", "my",
  "me", "we", "our", "it", "its", "that", "this", "have", "has", "had",
]);

const tokens = (s) => String(s || "").toLowerCase()
  .replace(/[^a-z0-9äöüß\s+#.-]/g, " ")
  .split(/\s+/).filter((t) => t && t.length > 1 && !STOP.has(t));

/**
 * Does this claimed evidence actually appear in the CV?
 *
 * The model is required to quote its source for anything it writes into a
 * free-text box. That requirement is worth nothing unless it is checked — an
 * unchecked citation field just teaches the model that citing is a formality.
 *
 * Token overlap rather than exact substring: a genuine citation gets
 * paraphrased in the quoting ("led a team of 4" vs "leading a 4-person team"),
 * and demanding character-exact quotes would reject honest evidence and push
 * the model toward copying irrelevant text that happens to match.
 */
export function evidenceIsGrounded(evidence, cvText, { threshold = 0.6 } = {}) {
  const claim = tokens(evidence);
  if (claim.length < 3) return { ok: false, reason: "evidence too vague to check" };

  const haystack = new Set(tokens(cvText));
  const hits = claim.filter((t) => haystack.has(t)).length;
  const ratio = hits / claim.length;

  return ratio >= threshold
    ? { ok: true, ratio }
    : { ok: false, ratio,
        reason: `only ${Math.round(ratio * 100)}% of the cited evidence appears ` +
                `in the CV — the answer is not grounded` };
}

/**
 * Questions whose answer is a legal or contractual commitment.
 *
 * These get a stricter rule than the rest of the form: the value must come from
 * the saved profile verbatim. The model may not reason its way to "probably
 * no" on a sponsorship question — being wrong here misrepresents the applicant
 * to an employer, and it is the kind of wrong that surfaces at an offer stage.
 */
const COMMITMENT_RE = new RegExp([
  "sponsor", "visa", "work permit", "arbeitserlaubnis", "aufenthalt",
  "right to work", "work authori", "legally (able|entitled|authorized)",
  "notice period", "kündigungsfrist", "verfügbar", "availability", "start date",
  "salary", "gehalt", "compensation", "expected pay", "desired pay",
  "relocat", "umzug", "willing to travel",
  "criminal", "conviction", "vorstraf",
  "disability", "veteran", "ethnicity", "gender", "race",
].join("|"), "i");

export function isCommitmentQuestion(label) {
  return COMMITMENT_RE.test(String(label || ""));
}

/**
 * Is the value we typed the saved answer, allowing for formatting?
 *
 * Forms reformat as you type — a phone number gains spaces, a salary gains a
 * currency symbol or a thousands separator, a date changes order. Comparing
 * raw strings would flag all of those as mismatches, so this compares what is
 * left after the formatting.
 */
function valuesAgree(entered, saved) {
  const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
  const a = flat(entered), b = flat(saved);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Decide whether this page may be submitted.
 *
 *   state    the latest observation from apply_engine.js
 *   ctx      { answers, profile, cvText, uploadPlan }
 *
 * Returns { ok: true } or { ok: false, reason, blocking }.
 */
export function canSubmit(state, ctx = {}) {
  const { answers = {}, profile = {}, cvText = "", unmetUploads = [],
          requiredDocuments = [], attachedDocuments = [] } = ctx;
  const blocking = [];
  const say = (reason, id) => blocking.push({ reason, jcaId: id || null });

  // 1. Validation errors the site is already showing. Submitting into a form
  //    that is complaining is guaranteed to fail, and often silently resets it.
  for (const err of state.errors || []) say(`unresolved validation error: ${err}`);

  // 2. Required fields still empty.
  for (const f of state.fields || []) {
    if (f.blocked) {
      // A sensitive field we refuse to fill (password, ID number, IBAN). If the
      // form requires it, this application is the user's to finish.
      if (f.required) say(`requires a sensitive value we won't fill: ${f.label}`, f.id);
      continue;
    }
    if (f.required && !String(f.value || "").trim()) {
      say(`required field is empty: ${f.label}`, f.id);
    }
  }

  // 3. Required choices with nothing selected.
  for (const c of state.choices || []) {
    if (c.required && !c.selected) say(`required question unanswered: ${c.question}`, c.id);
  }

  // 4. Required uploads that never got a file.
  for (const f of state.files || []) {
    if (f.required && !f.attached) say(`required upload is empty: ${f.label}`, f.id);
  }
  for (const u of unmetUploads) say(`${u.reason}: ${u.label}`, u.jcaId);

  // 4b. Documents this employer has wanted before, that nothing attached this
  //     time. The form itself is not always the authority on this: plenty of
  //     ATS forms accept a submission with an optional-looking upload empty and
  //     the employer discards the application later for the missing transcript.
  //
  //     Only what a previous application here actually attached counts as
  //     known-required, so this can never fire on a first application — it is
  //     learned evidence, not a guess about what employers generally want.
  for (const kind of requiredDocuments) {
    if (!attachedDocuments.includes(kind)) {
      say(`this employer wanted a ${kind.replace(/_/g, " ")} last time and nothing ` +
          `attached one — check the form before it goes`);
    }
  }

  // 5. Consent. Never ticked automatically, so an unticked required box always
  //    stops here. This is a decision about what the user agrees to, and it is
  //    not ours to make on their behalf however obvious it looks.
  for (const k of state.consent || []) {
    if (!k.checked) {
      say(k.required
        ? `consent required — you need to read and tick this yourself: ${k.text}`
        : `optional consent left for you to decide: ${k.text}`, k.id);
    }
  }

  // 6. Every value we entered must trace back to something real.
  //
  // Two legitimate sources, and an answer needs exactly one of them:
  //
  //   profileKey   the user typed this answer themselves during onboarding
  //   evidence     a passage of the CV, which is checked against the real CV
  //
  // Requiring a CV quote for everything would be wrong — an email address is
  // not in the CV and does not need to be. Requiring neither would make the
  // whole grounding contract decorative.
  for (const [jcaId, a] of Object.entries(answers)) {
    if (!a?.text) continue;

    if (a.profileKey && profile[a.profileKey] != null && profile[a.profileKey] !== "") {
      // A `fill` claims to have copied a saved answer across verbatim, so it is
      // worth confirming it actually did. `choose` is exempt: mapping a saved
      // "EU Blue Card" onto the option "No" for a sponsorship question is a
      // correct translation, not a mismatch.
      if (a.via === "fill" && !valuesAgree(a.text, profile[a.profileKey])) {
        say(`entered a value that doesn't match your saved "${a.profileKey}": ${a.label}`, jcaId);
      }
      continue;
    }
    if (a.profileKey) {
      say(`cited a saved answer you don't have ("${a.profileKey}"): ${a.label}`, jcaId);
      continue;
    }
    if (!a.evidence) { say(`answer written with no cited source: ${a.label}`, jcaId); continue; }

    const g = evidenceIsGrounded(a.evidence, cvText);
    if (!g.ok) say(`${g.reason} (${a.label})`, jcaId);
  }

  // 7. Commitment questions must trace back to the saved profile, not to
  //    reasoning. `profileKey` is set only when the value came from there.
  for (const [jcaId, a] of Object.entries(answers)) {
    if (!a?.label || !isCommitmentQuestion(a.label)) continue;
    if (!a.profileKey || profile[a.profileKey] == null) {
      say(`legal/contractual question answered without a saved answer: ${a.label}`, jcaId);
    }
  }

  return blocking.length
    ? { ok: false, blocking, reason: blocking[0].reason }
    : { ok: true };
}

/**
 * A short, plain summary for the dashboard and the notification.
 *
 * The user is going to read this while deciding whether to finish the
 * application by hand, so it says what is in the way, not how many rules fired.
 */
export function explain(gate) {
  if (gate.ok) return "Ready to submit.";
  const n = gate.blocking.length;
  const first = gate.blocking.slice(0, 3).map((b) => `• ${b.reason}`).join("\n");
  return n <= 3 ? first : `${first}\n• …and ${n - 3} more`;
}
