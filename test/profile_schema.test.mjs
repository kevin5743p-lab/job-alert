// Unit test for the application-answers schema.
//
// Worth testing because three separate surfaces now ask this module the same
// question — "is this profile finished?" — and they used to answer it three
// different ways. The popup checked six hardcoded keys, settings checked six
// more, and the engine's submit gate blocked on nine questions neither list
// had ever heard of. The bug that mattered was not a wrong count: it was that
// `Object.keys(profile).length` counted cover_template, so a profile with zero
// real answers looked complete, and the questionnaire stopped opening itself.
//
// So the cases below are weighted toward the two failures with real cost:
// a profile that is empty being reported as filled in, and a question the
// submit gate blocks on going unlisted.
import {
  STEPS, ALL_KEYS, BLOCKING_KEYS, SENSITIVE_KEYS, ANSWERABLE_TOTAL,
  answeredCount, isEmptyProfile, missingBlocking, completenessLine, fieldFor,
} from "../extension/profile_schema.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? ""
    : `\n      expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
}

console.log("\nthe bug this module exists for — settings-only keys are not answers");
// cover_template was seeded on every save by the old questionnaire, which is
// exactly how the auto-open gate in popup.js and settings.js silently died.
check("cover_template alone is still an empty profile",
  isEmptyProfile({ cover_template: "modern" }), true);
check("consent tick alone is still an empty profile",
  isEmptyProfile({ eeo_autofill_consent: true }), true);
check("one real answer is not an empty profile",
  isEmptyProfile({ first_name: "Meet" }), false);
check("truly empty", isEmptyProfile({}), true);
check("null profile survives", isEmptyProfile(null), true);
check("cover_template does not inflate the count",
  answeredCount({ cover_template: "modern", first_name: "Meet" }), 1);

console.log("\nwhitespace is not an answer");
check("a space is empty", answeredCount({ first_name: "   " }), 0);
check("undefined is empty", answeredCount({ first_name: undefined }), 0);
check("an empty repeating group is empty", answeredCount({ work_history: [] }), 0);
check("a filled repeating group counts",
  answeredCount({ work_history: [{ employer: "Bosch" }] }), 1);

console.log("\nevery question the submit gate blocks on is asked somewhere");
// confidence.js COMMITMENT_RE is the list the engine refuses to proceed
// without. Each term here must have a field, or a run pauses on a question the
// user has no way to answer — which is the state the whole rebuild fixes.
const MUST_BE_ASKABLE = [
  "work_authorization", "requires_sponsorship", "notice_period",
  "salary_expectation", "willing_to_relocate", "willing_to_travel",
  "criminal_record", "eeo_gender", "eeo_race_ethnicity",
  "eeo_veteran_status", "eeo_disability_status",
];
for (const key of MUST_BE_ASKABLE) {
  check(`${key} has a field`, ALL_KEYS.includes(key), true);
  check(`${key} is marked as blocking`, BLOCKING_KEYS.includes(key), true);
}

console.log("\nkeys autofill.js can fill are all collectable");
// These two were matched by FIELD_SPECS from the beginning — patterns, an
// autocomplete mapping and a validator each — while no UI could set them, so
// resolveValue returned undefined and the box was left blank in silence.
// cover_templates.js builds the letterhead from them too.
check("address is asked", ALL_KEYS.includes("address"), true);
check("postal_code is asked", ALL_KEYS.includes("postal_code"), true);

console.log("\nsensitive answers are marked, and consent is not one of them");
for (const key of ["eeo_gender", "eeo_race_ethnicity", "eeo_veteran_status",
                   "eeo_disability_status", "date_of_birth", "de_anrede",
                   "references"]) {
  check(`${key} is sensitive`, SENSITIVE_KEYS.includes(key), true);
}
check("the consent tick itself is not sensitive data",
  SENSITIVE_KEYS.includes("eeo_autofill_consent"), false);

console.log("\nmissingBlocking reports in asking order, and only what is missing");
const half = {
  first_name: "Meet", last_name: "Dodiya", email: "a@b.c", phone: "+49 1",
  address: "Str. 1", postal_code: "80331", city: "Munich", country: "Germany",
};
const missing = missingBlocking(half).map((f) => f.key);
check("answered ones are absent", missing.includes("first_name"), false);
check("unanswered ones are present", missing.includes("willing_to_travel"), true);
check("order follows the flow",
  missing.indexOf("work_authorization") < missing.indexOf("willing_to_travel"), true);
check("nothing missing when all blocking keys are set",
  missingBlocking(Object.fromEntries(BLOCKING_KEYS.map((k) => [k, "x"]))).length, 0);

console.log("\ncompletenessLine — the one sentence three surfaces share");
check("empty profile warns", completenessLine({}).tone, "warn");
check("empty profile does not claim a count",
  /^Not filled in yet/.test(completenessLine({}).text), true);
check("partial profile warns", completenessLine(half).tone, "warn");
const done = Object.fromEntries(BLOCKING_KEYS.map((k) => [k, "x"]));
check("nothing blocking reads as good", completenessLine(done).tone, "good");

console.log("\nschema integrity");
check("no duplicate keys", ALL_KEYS.length, new Set(ALL_KEYS).size);
check("ANSWERABLE_TOTAL excludes the two settings keys",
  ANSWERABLE_TOTAL, ALL_KEYS.length - 2);
check("every step has a title", STEPS.every((s) => !!s.title), true);
check("every field has a label", STEPS.every((s) => s.fields.every((f) => !!f.label)), true);
// The rule that keeps this file honest: a question is only worth asking if
// something downstream reads the answer.
check("every field names its consumer",
  STEPS.every((s) => s.fields.every((f) => !!f.proof)), true);
check("every repeating group has columns",
  STEPS.every((s) => s.fields.every((f) =>
    f.control !== "repeating" || (f.columns || []).length > 0)), true);
check("every select offers options",
  STEPS.every((s) => s.fields.every((f) =>
    f.control !== "select" || (f.options || []).length > 0)), true);
check("fieldFor finds a real field", fieldFor("willing_to_travel")?.control, "select");
check("fieldFor refuses an unknown key", fieldFor("nope"), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
