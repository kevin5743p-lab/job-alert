// Unit test for the confidence gate — the thing standing between a filled form
// and a sent one. Everything else in the system is recoverable; this isn't, so
// it's the part worth testing before any of it touches a real posting.
import { canSubmit, evidenceIsGrounded, isCommitmentQuestion }
  from "../extension/confidence.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${want}, got ${got}`}`);
}

const CV = `Meet Patel. Data Engineer.
Built ETL pipelines in Python and Apache Airflow at Acme GmbH, processing 4TB daily.
Led a team of 4 engineers migrating a legacy Oracle warehouse to Snowflake.
MSc Computer Science, TU Munich. German B2, English fluent.`;

const PROFILE = {
  first_name: "Meet", last_name: "Patel", email: "m@example.com",
  work_authorization: "EU Blue Card", notice_period: "3 months",
  salary_expectation: "75000",
};

const blank = { fields: [], choices: [], files: [], consent: [], errors: [] };

console.log("\nevidence grounding");
check("real CV quote is accepted",
  evidenceIsGrounded("built ETL pipelines in Python and Airflow", CV).ok, true);
check("paraphrase of a real CV fact is accepted",
  evidenceIsGrounded("led a team of 4 engineers on a Snowflake migration", CV).ok, true);
check("fabricated experience is rejected",
  evidenceIsGrounded("five years managing Kubernetes clusters at Google", CV).ok, false);
check("vague evidence is rejected",
  evidenceIsGrounded("yes", CV).ok, false);

console.log("\ncommitment questions are recognised");
for (const q of ["Do you require visa sponsorship?", "What is your notice period?",
                 "Expected salary", "Kündigungsfrist", "Work authorization status",
                 "Are you willing to relocate?"]) {
  check(`"${q}"`, isCommitmentQuestion(q), true);
}
check(`"Why do you want this role?" is NOT a commitment question`,
  isCommitmentQuestion("Why do you want this role?"), false);

console.log("\ngate: blocks");
check("empty required field blocks",
  canSubmit({ ...blank, fields: [{ id: "f1", label: "Phone", required: true, value: "" }] }).ok,
  false);
check("visible validation error blocks",
  canSubmit({ ...blank, errors: ["Phone number is required"] }).ok, false);
check("missing required upload blocks",
  canSubmit({ ...blank, files: [{ id: "u1", label: "Resume", required: true, attached: false }] }).ok,
  false);
check("unanswered required radio blocks",
  canSubmit({ ...blank, choices: [{ id: "c1", question: "Start date?", required: true, selected: null }] }).ok,
  false);
check("UNTICKED CONSENT BLOCKS — even when not required",
  canSubmit({ ...blank, consent: [{ id: "k1", text: "I agree to the terms", checked: false, required: false }] }).ok,
  false);
check("required sensitive field blocks (we never fill those)",
  canSubmit({ ...blank, fields: [{ id: "f9", label: "Passport number", required: true, blocked: true }] }).ok,
  false);

// A sign-in the browser's own password manager has already filled.
//
// The rule is not "passwords are allowed now" — it is that a box with
// something already in it has nothing left for us to write, and stopping there
// stopped runs over work that was already done. `blocked` still means we never
// type into it and never see what it holds; `prefilled` only says it is not
// empty. Both directions are pinned here because getting the second one wrong
// would send an application with an empty credential field.
check("a PREFILLED sensitive field does not block — nothing left for us to enter",
  canSubmit({ ...blank, fields: [
    { id: "f9", label: "Password", required: true, blocked: true, prefilled: true }] }).ok,
  true);
check("an EMPTY sensitive field still blocks",
  canSubmit({ ...blank, fields: [
    { id: "f9", label: "Password", required: true, blocked: true, prefilled: false }] }).ok,
  false);
check("a sensitive field with no prefilled flag at all still blocks",
  canSubmit({ ...blank, fields: [
    { id: "f9", label: "Password", required: true, blocked: true }] }).ok,
  false);
check("a prefilled sensitive field raises nothing at all, not even a soft note",
  (canSubmit({ ...blank, fields: [
    { id: "f9", label: "Password", required: true, blocked: true, prefilled: true, value: "" }] })
    .blocking || []).length,
  0);

console.log("\ngate: grounding");
check("answer with a fabricated citation blocks",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    f2: { label: "Why you?", text: "I ran GCP at scale.",
          evidence: "five years managing Kubernetes clusters at Google" } } }).ok,
  false);
check("answer with no citation at all blocks",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    f2: { label: "Why you?", text: "I'd be great." } } }).ok,
  false);
check("answer citing the real CV passes",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    f2: { label: "Why you?", text: "I've built Airflow pipelines in Python.",
          evidence: "Built ETL pipelines in Python and Apache Airflow" } } }).ok,
  true);

console.log("\ngate: commitment questions must come from the profile");
check("visa question answered from reasoning blocks",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    c1: { label: "Do you require visa sponsorship?", text: "No",
          evidence: "MSc Computer Science, TU Munich" } } }).ok,
  false);
check("visa question answered from the saved profile passes",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    c1: { label: "Do you require visa sponsorship?", text: "No",
          via: "choose", profileKey: "work_authorization" } } }).ok,
  true);
check("salary answered from a profile key that isn't set blocks",
  canSubmit(blank, { cvText: CV, profile: { first_name: "Meet" }, answers: {
    c2: { label: "Expected salary", text: "90000", via: "fill", profileKey: "salary_expectation" } } }).ok,
  false);

check("fill claiming a profile key but typing something else blocks",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    c3: { label: "Notice period", text: "immediately", via: "fill",
          profileKey: "notice_period" } } }).ok,
  false);
check("fill with the saved value, reformatted, passes",
  canSubmit(blank, { cvText: CV, profile: PROFILE, answers: {
    c4: { label: "Expected salary", text: "75.000 EUR", via: "fill",
          profileKey: "salary_expectation" } } }).ok,
  true);

console.log("\ngate: the happy path");
check("fully complete, grounded, consent ticked → SUBMIT",
  canSubmit({
    fields: [{ id: "f1", label: "Email", required: true, value: "m@example.com" }],
    choices: [{ id: "c1", question: "Remote?", required: true, selected: true }],
    files: [{ id: "u1", label: "Resume", required: true, attached: true }],
    consent: [{ id: "k1", text: "I agree", checked: true, required: true }],
    errors: [],
  }, { cvText: CV, profile: PROFILE, answers: {
    f1: { label: "Email", text: "m@example.com", via: "fill", profileKey: "email" } } }).ok,
  true);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
