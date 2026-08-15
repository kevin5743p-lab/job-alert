// Unit test for the "was this our fault or the site's?" classifier.
//
// This decides whether a failed run counts toward the circuit breaker, and the
// two mistakes are not symmetrical:
//
//   calling OUR fault THEIRS  → a working site is rested for 24 hours over a
//                               bug on our side. This actually happened:
//                               a missing host permission quarantined LinkedIn.
//   calling THEIR fault OURS  → we keep hammering a site that is blocking us,
//                               which is what gets an account restricted.
//
// So the list is explicit and closed: anything not recognised as ours counts
// as the site pushing back. The second block below is the one that matters —
// it pins the default open, so a new error string never silently stops
// tripping the breaker.
import { isOurFault } from "../extension/domain_health.js";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${want}, got ${got}`}`);
};

console.log("\nours — must NOT count toward quarantine");
for (const msg of [
  "couldn't inject into this page: Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
  "This employer hosts its application on its own site, which needs one extra permission.",
  "the tab was closed",
  "this job hasn't been tailored yet — tailor it first",
  "You've used this month's AI allowance ($3.00).",
  "quota_exceeded",
  "NOT_SIGNED_IN",
  "Claude call failed: HTTP 500",
  "upstream_unreachable",
  "took too long — handing this one back to you",
  "gave up after 25 steps",
  "the model stopped without choosing an action",
  "The tailored packet was cut short at 2200 tokens.",
]) check(msg.slice(0, 58), isOurFault(msg), true);

console.log("\ntheirs — MUST count toward quarantine");
for (const msg of [
  "the page never became ready — it may be showing a login wall",
  "cloudflare_challenge",
  "unusual activity detected",
  "HTTP 403 Forbidden",
  "rate limited",
  "Access denied",
  "captcha",
  // The important one: an error nobody has seen before must count. If a new
  // failure string quietly fell through to "ours", the breaker would stop
  // protecting the user from the sites that actually block them.
  "some entirely new failure we have never seen",
  "",
  null,
]) check(JSON.stringify(msg)?.slice(0, 58) ?? "null", isOurFault(msg), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
