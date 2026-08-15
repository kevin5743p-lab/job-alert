// Unit test for the cross-site job key.
//
// Worth testing because the two ways this can be wrong have very different
// costs. A MISS (two spellings of one job producing different keys) costs a few
// cents to re-tailor. A COLLISION (two different jobs producing one key) sends
// a CV written for another role to a real employer, under the user's name, and
// cannot be recalled. So the collision cases below matter more than the match
// cases, and the normaliser is deliberately tuned to fail toward misses.
import { jobKey, normalizeTitle, normalizeCompany }
  from "../extension/job_key.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n      expected ${want}, got ${got}`}`);
}

const same = (name, a, b) => {
  const ka = jobKey(a), kb = jobKey(b);
  check(name, ka !== null && ka === kb, true);
};
const differ = (name, a, b) => {
  const ka = jobKey(a), kb = jobKey(b);
  check(name, ka !== kb || ka === null, true);
};

console.log("\nthe case this exists for — aggregator vs employer board");
same("LinkedIn gender marker vs Greenhouse without",
  { company: "Bosch", title: "Werkstudent Data Science (m/w/d)" },
  { company: "Bosch", title: "Werkstudent Data Science" });

same("legal form differs between sites",
  { company: "Robert Bosch GmbH", title: "Data Engineer" },
  { company: "Robert Bosch", title: "Data Engineer" });

same("Group suffix on the aggregator only",
  { company: "BMW Group", title: "Software Engineer" },
  { company: "BMW", title: "Software Engineer" });

same("requisition id appended by the ATS",
  { company: "SAP", title: "Cloud Developer (JR0091234)" },
  { company: "SAP", title: "Cloud Developer" });

same("case and spacing noise",
  { company: "  siemens   AG ", title: "DATA  ENGINEER" },
  { company: "Siemens", title: "Data Engineer" });

same("umlaut folded",
  { company: "Müller", title: "Fertigungsplaner" },
  { company: "Muller", title: "Fertigungsplaner" });

same("gender marker variants",
  { company: "Zalando", title: "Analyst (w/m/d)" },
  { company: "Zalando", title: "Analyst (all genders)" });

console.log("\ncollisions — these must stay distinct");
differ("seniority is part of the role",
  { company: "Bosch", title: "Data Engineer" },
  { company: "Bosch", title: "Senior Data Engineer" });

differ("different companies, same title",
  { company: "Bosch", title: "Data Engineer" },
  { company: "Siemens", title: "Data Engineer" });

differ("intern is not the same as full-time",
  { company: "SAP", title: "Praktikum Data Science" },
  { company: "SAP", title: "Data Scientist" });

differ("'Group' inside a title is not a company suffix",
  { company: "Allianz", title: "Group Reporting Specialist" },
  { company: "Allianz", title: "Reporting Specialist" });

console.log("\nrefuses to key what it can't key safely");
check("no company", jobKey({ title: "Data Engineer" }), null);
check("no title", jobKey({ company: "Bosch" }), null);
check("empty object", jobKey({}), null);
check("title too short to be distinctive", jobKey({ company: "Bosch", title: "QA" }), null);
check("company that is only a legal form",
  jobKey({ company: "GmbH", title: "Data Engineer" }), null);

console.log("\nnormalisers");
check("repeated suffix stripping", normalizeCompany("Müller GmbH & Co. KG"), "muller");
check("title keeps its words", normalizeTitle("Senior Data Engineer (m/w/d)"),
  "senior data engineer");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
