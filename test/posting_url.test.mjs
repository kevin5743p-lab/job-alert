// Unit test for the "is this a posting or a careers portal?" guard.
//
// The cost of the two failure directions is lopsided, so the test is weighted
// that way too. A false REJECT costs the user one manual application. A false
// ACCEPT sends the apply engine to a search page, where it renders documents,
// spends an Anthropic call and a browser tab, and reports that the website was
// wrong — which is exactly the bug this was written for.
import { looksLikeAPosting, canonicalPostingUrl } from "../extension/posting_url.js";

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

// ── canonicalPostingUrl ─────────────────────────────────────────────────────
//
// This computes the key that every posting is stored and looked up under, so it
// has two jobs and the second is easy to overlook:
//
//   1. Keep the part of the query that NAMES the posting. SuccessFactors — VW,
//      BMW, Schaeffler, most of German industry — serves every job on one host
//      from one `/career` path and identifies it entirely in the query. The old
//      rule dropped the query as tracking noise, so all of them collapsed onto
//      a single URL: each tailoring overwrote the last, and none matched the
//      application row the scanner had saved. The dashboard showed a job it had
//      just tailored with a permanently greyed-out Apply button.
//
//   2. Leave everything ELSE exactly as it was. Rows already exist under these
//      keys. Sorting the query or trimming a trailing slash would be tidier and
//      would orphan every row already stored — so a URL carrying no tracking
//      parameters must come back byte-identical.
console.log("\ncanonicalPostingUrl — identity is preserved");

// Every URL shape actually present in a real installation. All must be no-ops.
for (const url of [
  "https://career5.successfactors.eu/career?company=VWAGLPPROD10&career_job_req_id=28826&career_ns=job_listing",
  "https://career5.successfactors.eu/career?company=bmwag&career_job_req_id=191116&career_ns=job_listing",
  "https://career5.successfactors.eu/career?company=schaeffler&career_job_req_id=37173&career_ns=job_listing",
  "https://www.linkedin.com/jobs/view/4444375446/",          // trailing slash kept
  "https://job-boards.eu.greenhouse.io/isaraerospace/jobs/4697662101",
  "https://jobs.smartrecruiters.com/BoschGroup/744000142366139",
  "https://careers.hellofresh.com/global/en/job/8081189?gh_jid=8081189",  // gh_jid NAMES it
  "https://www.tesla.com/careers/search/job/apply/279570",
  "https://hmetc.softgarden.io/applySuccess",
]) check(`unchanged: ${url.slice(0, 52)}`, canonicalPostingUrl(url), url);

console.log("\ncanonicalPostingUrl — different jobs stay different");
{
  const vw = "https://career5.successfactors.eu/career?company=VWAGLPPROD10&career_job_req_id=28826&career_ns=job_listing";
  const bmw = "https://career5.successfactors.eu/career?company=bmwag&career_job_req_id=191116&career_ns=job_listing";
  const vw2 = "https://career5.successfactors.eu/career?company=VWAGLPPROD10&career_job_req_id=22904&career_ns=job_listing";
  check("VW ≠ BMW", canonicalPostingUrl(vw) === canonicalPostingUrl(bmw), false);
  check("two VW postings differ", canonicalPostingUrl(vw) === canonicalPostingUrl(vw2), false);
}

console.log("\ncanonicalPostingUrl — referral noise is dropped");
check("utm_* removed",
  canonicalPostingUrl("https://jobs.acme.com/apply?utm_source=x&utm_campaign=y"),
  "https://jobs.acme.com/apply");
check("identity survives alongside tracking",
  canonicalPostingUrl("https://career5.successfactors.eu/career?company=bmwag&utm_source=li&career_job_req_id=1"),
  "https://career5.successfactors.eu/career?company=bmwag&career_job_req_id=1");
check("a link with only tracking loses its query",
  canonicalPostingUrl("https://www.linkedin.com/jobs/view/44/?trk=x&refId=y&position=3"),
  "https://www.linkedin.com/jobs/view/44/");
check("fragment dropped",
  canonicalPostingUrl("https://jobs.acme.com/apply#section"),
  "https://jobs.acme.com/apply");
for (const junk of ["", "not a url", null, undefined]) {
  check(`survives ${JSON.stringify(junk)}`,
    typeof canonicalPostingUrl(junk), "string");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
