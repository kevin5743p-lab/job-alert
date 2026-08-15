// Static check: does every named/namespace import resolve to a real export?
// The extension has no build step and no test runner, so this is the cheapest
// way to catch a typo'd import before loading it in Chrome.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));

const exported = {};
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  const set = new Set();
  for (const m of s.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)) set.add(m[1]);
  for (const m of s.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/gm)) set.add(m[1]);
  for (const m of s.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    m[1].split(",").forEach((x) => { const n = x.trim().split(/\s+as\s+/).pop(); if (n) set.add(n); });
  }
  exported[f] = set;
}

let bad = 0;
const fail = (msg) => { console.log(`  MISSING  ${msg}`); bad++; };

for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  // Strip comments and import statements before scanning member access. Both
  // routinely contain a module path like "./router.js", which would otherwise
  // read as `router` dot `js` — a member that obviously doesn't exist.
  const body = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from\s*"[^"]+";?\s*$/gm, "");

  for (const m of raw.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\/([^"]+)"/g)) {
    const target = m[2];
    if (!exported[target]) { fail(`file  ${f} -> ${target}`); continue; }
    for (const n of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!exported[target].has(n)) fail(`export ${f}: "${n}" not in ${target}`);
    }
  }

  for (const m of raw.matchAll(/import \* as ([A-Za-z0-9_]+) from "\.\/([^"]+)"/g)) {
    const [, ns, target] = m;
    if (!exported[target]) { fail(`file  ${f} -> ${target}`); continue; }
    const seen = new Set();
    for (const u of body.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z0-9_]+)`, "g"))) {
      if (seen.has(u[1])) continue;
      seen.add(u[1]);
      if (!exported[target].has(u[1])) fail(`export ${f}: "${ns}.${u[1]}" not in ${target}`);
    }
  }
}

console.log(bad ? `\n  ${bad} problem(s)` : "\n  all imports resolve");
process.exit(bad ? 1 : 0);
