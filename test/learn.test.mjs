// Unit test for the memory between applications.
//
// What's worth testing here is not that it stores things — it's the two places
// a learning loop goes wrong and keeps going wrong quietly:
//
//   1. scope leakage. A lesson filed under an empty key matches every other
//      empty-keyed lesson and is recalled for jobs it has nothing to do with.
//      That is how the field cache once filled Last Name with a country, and
//      the same shape of bug here would send BMW's answers to Volkswagen.
//
//   2. ungrounded lessons. A remedy citing a step that does not exist was not
//      read off the trail. Accept those and the memory fills up with confident
//      advice nobody can check — and, unlike a bad answer in a form, nothing
//      downstream ever catches it.
//
// The model pass is not exercised (it needs the proxy). Everything it produces
// goes through remedyFrom + validRemedy + placementFor, and those are pure.
import {
  atsOf, scopesFor, reachedFrom, promptBlockFor, problemKinds, REMEDY_KINDS,
} from "../extension/learn.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${want}, got ${got}`}`);
}

console.log("\nATS detection — an ats-scoped lesson helps every tenant on it");
check("Workday tenant", atsOf("https://bmw.wd3.myworkdayjobs.com/careers/job/123"), "workday");
check("Workday, other host", atsOf("vw.myworkdaysite.com"), "workday");
check("Greenhouse", atsOf("https://boards.greenhouse.io/acme/jobs/44"), "greenhouse");
check("SuccessFactors", atsOf("https://career5.successfactors.eu/career"), "successfactors");
check("an employer's own careers page is not an ATS", atsOf("https://careers.bmwgroup.com"), null);
check("empty input", atsOf(""), null);
check("undefined input", atsOf(undefined), null);

console.log("\nscoping — BMW's lessons must not reach Volkswagen");
{
  const s = scopesFor({ company: "BMW AG", ats: "workday",
                        domain: "bmw.wd3.myworkdayjobs.com" });
  check("narrowest scope is the company", s[0].scope, "company");
  // job_key.js normalisation is what makes "BMW AG" and "BMW Group" the same
  // employer. Without it the playbook written by a Greenhouse application is
  // invisible to a Workday one.
  check("company key is normalised", s[0].scope_key, "bmw");
  check("global is always last", s[s.length - 1].scope, "global");
  check("global has an empty key", s[s.length - 1].scope_key, "");
  check("four scopes when everything is known", s.length, 4);
}
{
  // The bug this guards: a company we could not name must produce NO
  // company-scoped entry, not a company-scoped entry keyed on "".
  const s = scopesFor({ company: "", ats: "workday", domain: "x.myworkdayjobs.com" });
  check("no company scope when the company is unknown",
    s.some((x) => x.scope === "company"), false);
  check("a legal-form-only name yields no company scope",
    scopesFor({ company: "GmbH" }).some((x) => x.scope === "company"), false);
}
{
  const s = scopesFor({});
  check("with nothing known, only global remains", s.length, 1);
  check("and it is global", s[0].scope, "global");
}

console.log("\nreached — the yardstick the confirmation loop measures against");
check("a submitted run is the top of the scale",
  reachedFrom([], "submitted"), 5);
check("nothing happened", reachedFrom([{ kind: "start" }], "failed"), 0);
check("page loaded", reachedFrom([{ kind: "page_ready", fields: 8 }], "failed"), 1);
check("an autofill that filled nothing is not progress",
  reachedFrom([{ kind: "page_ready" }, { kind: "autofill", filled: 0 }], "paused_needs_human"), 1);
check("an autofill that filled something is",
  reachedFrom([{ kind: "page_ready" }, { kind: "autofill", filled: 6 }], "paused_needs_human"), 2);
check("documents attached",
  reachedFrom([{ kind: "page_ready" }, { kind: "autofill", filled: 6 },
               { kind: "upload", doc: "cv" }], "paused_needs_human"), 3);
check("refused at the gate still beats pausing on page one",
  reachedFrom([{ kind: "page_ready" },
               { kind: "action", tool: "click", result: "submit blocked: consent" }],
              "paused_needs_human"), 4);
check("order doesn't matter — it's a high-water mark",
  reachedFrom([{ kind: "upload", doc: "cv" }, { kind: "page_ready" }], "failed"), 3);

console.log("\nproblem kinds reuse the dashboard's classifier, not a second one");
check("a missing saved answer",
  problemKinds({ status: "paused_needs_human",
                 pauseReason: "legal/contractual question answered without a saved answer: Kündigungsfrist" })
    .includes("missing_profile"), true);
check("a consent box",
  problemKinds({ status: "paused_needs_human",
                 pauseReason: "consent required — you need to read and tick this yourself" })
    .includes("consent"), true);
check("our own crash is classified as ours",
  problemKinds({ status: "failed", error: "cdp: CSS is not defined" }).includes("fault"), true);
check("a clean submit has no problem at all",
  problemKinds({ status: "submitted" }).length, 0);
check("a stopped run with no reason is still classified",
  problemKinds({ status: "failed" }).length, 1);

console.log("\nthe remedy vocabulary is closed");
check("six kinds, each with a reader that acts on it",
  Object.keys(REMEDY_KINDS).length, 6);
for (const k of ["profile_answer", "saved_answer", "document_required",
                 "flow_hint", "account_required", "avoid"]) {
  check(`"${k}" is a known shape`, Array.isArray(REMEDY_KINDS[k]), true);
}

console.log("\nthe <learned> block");
{
  const empty = promptBlockFor({ company: "BMW", ats: "workday", playbook: null, lessons: [] });
  // A first application must cost exactly what it costs today. An empty block
  // that still emitted a wrapper would add tokens to every new employer for
  // the privilege of saying nothing.
  check("nothing known → no block at all", empty, "");
}
{
  const block = promptBlockFor({
    company: "BMW",
    ats: "workday",
    playbook: {
      runs: 4, submitted: 1, paused: 3,
      account_required: true,
      account_note: "their Workday tenant needs a login",
      required_documents: ["cv", "cover_letter", "photo"],
      known_questions: [
        { question: "Kündigungsfrist", answer: "3 Monate zum Quartalsende",
          profile_key: "notice_period", worked: true },
        { question: "A question that never went through", answer: "…", worked: false },
      ],
      flow_notes: [{ note: "the apply form is inside an iframe" }],
    },
    lessons: [
      { remedy: { kind: "flow_hint", text: "click 'Autofill with Resume' first" } },
      { remedy: { kind: "avoid", text: "do not use the LinkedIn Easy Apply route here" } },
      { remedy: { kind: "profile_answer", label: "Nachname", profile_key: "last_name" } },
    ],
  });

  check("says how many times we've been here", block.includes("4 time(s)"), true);
  check("names the account requirement", block.includes("needs a login"), true);
  check("lists the documents", block.includes("photo"), true);
  check("carries a question that worked", block.includes("Kündigungsfrist"), true);
  check("suppresses a question that didn't",
    block.includes("never went through"), false);
  check("carries flow notes", block.includes("inside an iframe"), true);
  check("carries flow hints from lessons", block.includes("Autofill with Resume"), true);
  // The negative case earns its place: without it the memory only ever grows
  // more things to try and never records what to stop doing.
  check("carries the negative case too", block.includes("Easy Apply route"), true);
  check("and labels it as such", block.includes("made things worse"), true);
  // The block is a hint about the FORM. The grounding contract is unchanged:
  // nothing in here is a source of facts about the applicant, and it has to
  // say so, because a list of previously-used answers is exactly the sort of
  // thing a model will otherwise treat as a profile.
  check("restates that values still need grounding",
    block.includes("come from the profile or the CV"), true);
  check("is wrapped in the tag the prompt expects",
    block.startsWith("<learned>") && block.endsWith("</learned>"), true);
  // profile_answer lessons feed the field cache and the rule pass, not the
  // prompt — putting them in both would pay tokens for something already free.
  check("label→key mappings are not spent on prompt tokens",
    block.includes("Nachname"), false);
}
{
  // A playbook with history but nothing learned yet still says something
  // useful: how many times, and how it went.
  const block = promptBlockFor({
    company: "Volkswagen", playbook: { runs: 1, submitted: 1 }, lessons: [],
  });
  check("a single successful run is still worth stating",
    block.includes("Volkswagen 1 time(s)"), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
