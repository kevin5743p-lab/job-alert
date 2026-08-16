// Unit test for "may we touch this page?", and for the loop it once created.
//
// THE BUG THIS PINS DOWN
//
// A user granted auto-apply on all sites, and every run still stopped asking
// them to grant it. Pressing the button restarted the run, which stopped in the
// same place with the same message. There was no way out from their side —
// they had already done the only thing being asked of them.
//
// Two independent causes, both represented below:
//
//   1. `hasAllSites()` asked whether https AND http were both granted. Chrome
//      commonly records only the https half, so the answer was false for
//      someone who had granted everything the UI ever offered them.
//   2. `canReach()` could report not_granted for an https origin while the
//      run-anywhere grant was held — a state that is by definition a bug on our
//      side, and one the user cannot possibly resolve.
//
// The invariant: HOLDING THE GRANT MUST NEVER PRODUCE A REQUEST FOR THE GRANT.

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

// Chrome's real semantics: a broad granted pattern covers a narrow query.
const granted = new Set();
globalThis.chrome = {
  permissions: {
    contains: async ({ origins }) => origins.every((o) =>
      granted.has(o) ||
      (granted.has("https://*/*") && o.startsWith("https://")) ||
      (granted.has("http://*/*") && o.startsWith("http://"))),
  },
};

const { canReach, hasAllSites, originPatternFor } =
  await import("../extension/host_access.js");

const SITES = [
  "https://careers.bosch.com/job/1",
  "https://jobs.acme.io/apply?x=1",
  "https://boards.greenhouse.io/acme/jobs/123",
];

console.log("\nnothing granted — it must ask");
granted.clear();
check("hasAllSites", await hasAllSites(), false);
for (const u of SITES) check(`canReach ${new URL(u).hostname}`, (await canReach(u)).ok, false);
check("reason is actionable", (await canReach(SITES[0])).reason, "not_granted");

console.log("\nhttps-only grant — the shape Chrome actually records");
granted.clear(); granted.add("https://*/*");
// Before the fix this was false, because the check demanded http as well — so
// the banner never cleared and every run asked again.
check("hasAllSites", await hasAllSites(), true);
for (const u of SITES) check(`canReach ${new URL(u).hostname}`, (await canReach(u)).ok, true);

console.log("\nboth granted");
granted.clear(); granted.add("https://*/*"); granted.add("http://*/*");
check("hasAllSites", await hasAllSites(), true);
check("http site reachable", (await canReach("http://alte-firma.de/jobs")).ok, true);

console.log("\nTHE INVARIANT: holding the grant may never ask for the grant");
granted.clear(); granted.add("https://*/*");
for (const u of [
  "https://a.example",                       // never seen before
  "https://sub.deep.example.co.uk/apply",
  "https://xn--bcher-kva.example/stelle",    // punycode
  "https://careers.acme.com:8443/apply",     // non-standard port
]) {
  const r = await canReach(u);
  check(`no re-ask for ${u.slice(0, 40)}`, r.reason === "not_granted", false);
}

console.log("\nschemes we could never drive are refused, not turned into a prompt");
for (const bad of ["chrome://extensions", "file:///tmp/a.html", "about:blank", "", null]) {
  const r = await canReach(bad);
  check(`${JSON.stringify(bad)} → not a grant request`, r.reason, "unsupported_scheme");
  check(`${JSON.stringify(bad)} → pattern refused`, originPatternFor(bad), null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
