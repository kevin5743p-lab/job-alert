// Unit test for the "is this a posting or a careers portal?" guard.
//
// The cost of the two failure directions is lopsided, so the test is weighted
// that way too. A false REJECT costs the user one manual application. A false
// ACCEPT sends the apply engine to a search page, where it renders documents,
// spends an Anthropic call and a browser tab, and reports that the website was
// wrong — which is exactly the bug this was written for.
import { looksLikeAPosting } from "../extension/posting_url.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${want}, got ${got}`}`);
};

console.log("\nreal postings — must all pass");
for (const url of [
  // The one that started this: query string names the requisition.
  "https://career5.successfactors.eu/career?company=bmwag&career_job_req_id=170553&career_ns=job_listing",
  "https://www.linkedin.com/jobs/view/4452401790/",
  "https://jobs.smartrecruiters.com/BoschGroup/744000143501419",
  "https://www.tesla.com/careers/search/job/apply/279570",
  "https://boards.greenhouse.io/acme/jobs/4012345",
  "https://jobs.lever.co/company/8f2a-1234",
  "https://acme.jobs.personio.de/job/1234567",
  // Short path, but a query string identifies the job.
  "https://example.com/careers?jobId=123",
]) check(url.slice(0, 62), looksLikeAPosting(url), true);

console.log("\nportal roots and junk — must all be rejected");
for (const url of [
  "https://career5.successfactors.eu/career",   // the actual bad row
  "https://career5.successfactors.eu/",
  "https://career5.successfactors.eu",
  "https://www.tesla.com/careers",
  "https://boards.greenhouse.io/acme",
  "",
  "not a url",
  null,
  undefined,
]) check(JSON.stringify(url), looksLikeAPosting(url), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
