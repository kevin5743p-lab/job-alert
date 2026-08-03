// finder.js — find jobs from inside the browser.
//
// This is the "find" half of the system, ported so that installing the
// extension is all anyone needs: no repo to fork, no GitHub Actions, no
// terminal. It runs in the background worker, from the user's own machine and
// IP, using their own API key.
//
// Only public, no-auth endpoints are used — the same ATS feeds the Python
// fetchers poll. LinkedIn is deliberately absent: scraping it needs the user's
// logged-in session, and the in-page "Tailor this job" button already covers
// browsing LinkedIn by hand.

const UA_HEADERS = { Accept: "application/json, text/plain, */*" };
const FETCH_TIMEOUT = 20000;
// ATS boards keep postings up for weeks; older than this is a zombie listing.
const MAX_AGE_DAYS = 90;

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { headers: UA_HEADERS, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { headers: UA_HEADERS, signal: ctl.signal, redirect: "error" });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const stripHtml = (s) =>
  String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const fresh = (iso) => {
  if (!iso) return true;                       // no date given → don't discard
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 86400000 <= MAX_AGE_DAYS;
};

// ── Sources ────────────────────────────────────────────────────────────────
// Each returns the same job shape the rest of the pipeline expects.

async function fetchArbeitnow() {
  const data = await getJson("https://www.arbeitnow.com/api/job-board-api");
  const jobs = (data && data.data) || [];
  return jobs.map((j) => ({
    id: `arbeitnow_${j.slug}`,
    title: j.title || "",
    company: j.company_name || "",
    location: j.location || (j.remote ? "Remote" : ""),
    description: stripHtml(j.description).slice(0, 4000),
    url: j.url || "",
    published: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    source: "arbeitnow",
  }));
}

async function fetchGreenhouse(c) {
  const d = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.id)}/jobs?content=true`);
  return ((d && d.jobs) || []).filter((j) => fresh(j.updated_at)).map((j) => ({
    id: `gh_${c.id}_${j.id}`,
    title: j.title || "",
    company: c.name,
    location: (j.location && j.location.name) || "",
    description: stripHtml(j.content).slice(0, 4000),
    url: j.absolute_url || "",
    published: j.updated_at || null,
    source: `${c.name} (Direct)`,
  }));
}

async function fetchAshby(c) {
  const d = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.id)}`);
  return ((d && d.jobs) || [])
    .filter((j) => j.isListed !== false && fresh(j.publishedAt))
    .map((j) => ({
      id: `ashby_${c.id}_${j.id}`,
      title: j.title || "",
      company: c.name,
      location: j.location || "",
      description: (j.descriptionPlain || stripHtml(j.descriptionHtml)).slice(0, 4000),
      url: j.jobUrl || j.applyUrl || "",
      published: j.publishedAt || null,
      source: `${c.name} (Direct)`,
    }));
}

async function fetchLever(c) {
  const d = await getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(c.id)}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => ({
    id: `lever_${c.id}_${j.id}`,
    title: j.text || "",
    company: c.name,
    location: (j.categories && j.categories.location) || "",
    description: stripHtml(j.description).slice(0, 4000),
    url: j.hostedUrl || "",
    published: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    source: `${c.name} (Direct)`,
  })).filter((j) => fresh(j.published));
}

async function fetchRecruitee(c) {
  const d = await getJson(`https://${encodeURIComponent(c.id)}.recruitee.com/api/offers/`);
  return ((d && d.offers) || [])
    .filter((o) => !o.status || o.status === "published")
    .map((o) => ({
      id: `recruitee_${c.id}_${o.id}`,
      title: o.title || "",
      company: c.name,
      location: o.location || [o.city, o.country].filter(Boolean).join(", "),
      description: stripHtml(o.description).slice(0, 4000),
      url: o.careers_url || o.careers_apply_url || "",
      published: o.published_at || o.created_at || null,
      source: `${c.name} (Direct)`,
    })).filter((j) => fresh(j.published));
}

// Personio publishes XML. Parsed with regex rather than DOMParser because MV3
// service workers have no DOM — DOMParser simply doesn't exist there.
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function xmlTagAll(block, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = re.exec(block))) {
    out.push(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
  }
  return out;
}

async function fetchPersonio(c) {
  // Unknown tenants 307 to personio.com; redirect:"error" in getText turns that
  // into a clean miss rather than a page of marketing HTML to mis-parse.
  const xml = await getText(`https://${encodeURIComponent(c.id)}.jobs.personio.de/xml`);
  if (!xml || xml.indexOf("<position>") === -1) return [];

  return xmlTagAll(xml, "position").map((p) => {
    const id = xmlTag(p, "id");
    const created = xmlTag(p, "createdAt");
    if (!id || !fresh(created)) return null;
    const desc = xmlTagAll(p, "value").map(stripHtml).join(" ");
    return {
      id: `personio_${c.id}_${id}`,
      title: xmlTag(p, "name"),
      company: c.name,
      location: xmlTagAll(p, "office").join(", "),
      description: desc.slice(0, 4000),
      url: `https://${c.id}.jobs.personio.de/job/${id}`,
      published: created || null,
      source: `${c.name} (Direct)`,
    };
  }).filter(Boolean);
}

async function fetchSmartRecruiters(c, queries) {
  const jobs = [];
  const seen = new Set();
  // The list endpoint has no descriptions; titles are enough for the prefilter,
  // and the AI pass gets the posting URL for anything promising.
  for (const q of queries.slice(0, 6)) {
    const d = await getJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.id)}/postings` +
      `?q=${encodeURIComponent(q)}&limit=50`);
    for (const it of (d && d.content) || []) {
      if (!it.id || seen.has(it.id)) continue;
      seen.add(it.id);
      if (!fresh(it.releasedDate)) continue;
      const loc = it.location || {};
      jobs.push({
        id: `smartr_${c.id}_${it.id}`,
        title: it.name || "",
        company: c.name,
        location: [loc.city, loc.region, loc.country].filter(Boolean).join(", "),
        description: "",
        url: `https://jobs.smartrecruiters.com/${c.id}/${it.id}`,
        published: it.releasedDate || null,
        source: `${c.name} (Direct)`,
      });
    }
  }
  return jobs;
}

const ATS = {
  greenhouse: fetchGreenhouse,
  ashby: fetchAshby,
  lever: fetchLever,
  recruitee: fetchRecruitee,
  personio: fetchPersonio,
  smartrecruiters: fetchSmartRecruiters,
};

// ── Known-good boards ──────────────────────────────────────────────────────
// Asking the model to name employers works; asking it to guess their ATS slug
// does not — in practice roughly one suggestion in twenty resolves, and a scan
// with no live boards finds nothing at all. So the search starts from a
// hand-verified registry (every entry probed and returning open roles at the
// time of writing) and the model's suggestions are added on top once validated.
//
// `tags` decide which boards are worth polling for a given candidate; they are
// matched against their field and keywords.
const KNOWN_BOARDS = [
  // automotive / autonomous driving / mobility
  { name: "Wayve", ats: "greenhouse", id: "wayve", tags: "automotive autonomous av perception ml" },
  { name: "Waymo", ats: "greenhouse", id: "waymo", tags: "automotive autonomous av perception ml" },
  { name: "Nuro", ats: "greenhouse", id: "nuro", tags: "automotive autonomous av robotics" },
  { name: "Motional", ats: "greenhouse", id: "motional", tags: "automotive autonomous av" },
  { name: "Torc Robotics", ats: "greenhouse", id: "torcrobotics", tags: "automotive autonomous av trucking" },
  { name: "May Mobility", ats: "greenhouse", id: "maymobility", tags: "automotive autonomous av" },
  { name: "Helm.ai", ats: "ashby", id: "helm-ai", tags: "automotive autonomous av ml perception" },
  { name: "Lucid Motors", ats: "greenhouse", id: "lucidmotors", tags: "automotive ev vehicle" },
  { name: "Scout Motors", ats: "greenhouse", id: "scoutmotors", tags: "automotive ev vehicle" },
  { name: "Verkor", ats: "lever", id: "verkor", tags: "automotive battery energy manufacturing" },
  { name: "Blickfeld", ats: "personio", id: "blickfeld", tags: "automotive lidar sensors hardware" },
  { name: "Bosch", ats: "smartrecruiters", id: "BoschGroup", tags: "automotive engineering embedded industrial" },
  // energy / industrial / deep tech
  { name: "1KOMMA5°", ats: "personio", id: "1komma5grad", tags: "energy solar engineering" },
  // software / data / ml
  { name: "Databricks", ats: "greenhouse", id: "databricks", tags: "software data ml engineering" },
  { name: "Datadog", ats: "greenhouse", id: "datadog", tags: "software data engineering" },
  { name: "Cloudflare", ats: "greenhouse", id: "cloudflare", tags: "software engineering infrastructure" },
  { name: "Celonis", ats: "greenhouse", id: "celonis", tags: "software data process mining" },
  { name: "Ashby", ats: "ashby", id: "ashby", tags: "software engineering" },
  // fintech
  { name: "Stripe", ats: "greenhouse", id: "stripe", tags: "fintech software finance payments" },
  { name: "Ramp", ats: "ashby", id: "Ramp", tags: "fintech software finance" },
  { name: "N26", ats: "greenhouse", id: "n26", tags: "fintech finance banking" },
  { name: "SumUp", ats: "greenhouse", id: "sumup", tags: "fintech finance payments" },
  { name: "Trade Republic", ats: "greenhouse", id: "traderepublic", tags: "fintech finance trading" },
  // health
  { name: "Doctolib", ats: "greenhouse", id: "doctolib", tags: "health healthcare software" },
];

// Boards whose tags overlap what this candidate is looking for. Falls back to
// the whole registry when nothing matches, since polling a few extra boards is
// cheap and finding nothing is not.
export function pickKnownBoards(sp) {
  // Parenthesised deliberately: without it the trailing .toLowerCase().match()
  // binds to the last template literal only, the concatenation yields a string,
  // and new Set(string) becomes a set of single characters that matches nothing.
  const haystack = [
    sp.field || "",
    (sp.must_have_keywords || []).join(" "),
    (sp.search_queries || []).join(" "),
    (sp.target_titles || []).join(" "),
  ].join(" ").toLowerCase();
  const words = new Set(haystack.match(/[a-zäöüß]+/g) || []);

  const hits = KNOWN_BOARDS.filter((b) =>
    b.tags.split(" ").some((t) => words.has(t)));
  return hits.length ? hits : KNOWN_BOARDS;
}

// ── Board validation ───────────────────────────────────────────────────────
// The model reliably names real employers but frequently guesses the wrong ATS
// for them — large corporates in particular are usually on Workday or
// SuccessFactors, not on the public boards we can read. An unvalidated list
// therefore yields nothing at all, silently. So every candidate is probed once
// and only the boards that actually answer are kept.
const PROBE = {
  greenhouse: (id) => `https://boards-api.greenhouse.io/v1/boards/${id}/jobs?content=false`,
  ashby: (id) => `https://api.ashbyhq.com/posting-api/job-board/${id}`,
  lever: (id) => `https://api.lever.co/v0/postings/${id}?mode=json`,
  recruitee: (id) => `https://${id}.recruitee.com/api/offers/`,
  smartrecruiters: (id) => `https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=1`,
  personio: (id) => `https://${id}.jobs.personio.de/xml`,
};

async function probe(c) {
  const ats = String(c.ats || "").toLowerCase();
  const build = PROBE[ats];
  if (!build || !c.id) return false;
  const url = build(encodeURIComponent(c.id));
  try {
    // No redirect following: Personio bounces unknown tenants to its marketing
    // page, which would otherwise answer 200 and look alive.
    const r = await fetch(url, { headers: UA_HEADERS, redirect: "error" });
    if (!r.ok) return false;
    if (ats === "personio") {
      const t = await r.text();
      return t.indexOf("<position>") !== -1;
    }
    const d = await r.json();
    if (ats === "smartrecruiters") return Number(d.totalFound || 0) > 0;
    if (ats === "greenhouse") return Array.isArray(d.jobs);
    if (ats === "ashby") return Array.isArray(d.jobs);
    if (ats === "lever") return Array.isArray(d);
    if (ats === "recruitee") return Array.isArray(d.offers);
    return true;
  } catch {
    return false;
  }
}

export async function validateTargets(candidates, onProgress = () => {}) {
  const live = [];
  const list = candidates || [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    onProgress(`Checking employer boards… (${i + 1}/${list.length})`);
    if (await probe(c)) live.push({ name: c.name, ats: c.ats, id: c.id });
  }
  return live;
}

/**
 * Fetch from every configured source. Each is isolated so one broken board
 * can't sink the scan. `onProgress(text)` drives the UI.
 */
export async function fetchAll(searchProfile, onProgress = () => {}) {
  const queries = searchProfile.search_queries || [];
  const targets = searchProfile.company_targets || [];
  const all = [];
  const stats = [];

  onProgress("Searching job boards…");
  try {
    const jobs = await fetchArbeitnow();
    all.push(...jobs);
    stats.push(`arbeitnow ${jobs.length}`);
  } catch { stats.push("arbeitnow ⚠"); }

  let done = 0;
  for (const c of targets) {
    const fn = ATS[String(c.ats || "").toLowerCase()];
    done++;
    if (!fn || !c.id) continue;
    onProgress(`Checking ${c.name} (${done}/${targets.length})…`);
    try {
      const jobs = await fetchSmartOrPlain(fn, c, queries);
      all.push(...jobs);
      if (jobs.length) stats.push(`${c.name} ${jobs.length}`);
    } catch { /* a dead board is normal; skip it */ }
  }

  // Dedup on id and on title+company (boards repost the same role).
  const byId = new Set(), byTitle = new Set(), unique = [];
  for (const j of all) {
    const tk = `${(j.title || "").toLowerCase()}|${(j.company || "").toLowerCase()}`;
    if (!j.id || byId.has(j.id) || byTitle.has(tk)) continue;
    byId.add(j.id); byTitle.add(tk);
    unique.push(j);
  }
  return { jobs: unique, stats };
}

function fetchSmartOrPlain(fn, c, queries) {
  return fn === fetchSmartRecruiters ? fn(c, queries) : fn(c);
}

// ── Cheap keyword pre-filter ───────────────────────────────────────────────
// Scoring every posting with the model would burn the free tier in one scan,
// so a free pass discards the obvious misses first — the same two-stage design
// the Python pipeline uses.
export function prefilter(jobs, sp) {
  const must = (sp.must_have_keywords || []).map((k) => k.toLowerCase());
  const titles = (sp.target_titles || []).map((k) => k.toLowerCase());
  const exclude = (sp.exclude_keywords || []).map((k) => k.toLowerCase());

  return jobs.filter((j) => {
    const title = (j.title || "").toLowerCase();
    const text = `${title} ${(j.description || "").toLowerCase()}`;
    // Seniority and experience mismatches are worth rejecting on the title
    // alone; in the body those words often appear in boilerplate.
    if (exclude.some((k) => title.includes(k))) return false;
    if (!must.length && !titles.length) return true;
    return must.some((k) => text.includes(k)) || titles.some((k) => title.includes(k));
  });
}

// Roughly, is this posting somewhere the candidate could actually work?
// Several boards in the registry are US-based, so without this the scoring
// budget is spent entirely on roles that will be capped for distance anyway,
// and the local ones are never even looked at.
const REMOTE_RE = /\bremote\b|\bhybrid\b|home ?office|anywhere|work from home/i;
const FAR_RE = /\b(united states|usa|u\.s\.|canada|india|singapore|australia|japan|china|brazil|mexico|israel)\b|,\s*(ca|ny|tx|wa|ma|il|ga|co|az|nc|va|or|pa|fl|mi|oh|nj|md|mn|ut|tn)\b/i;

// Boards label the same country differently — SmartRecruiters returns "de"
// where Greenhouse writes "Germany" and Personio "Deutschland". Without these
// the most relevant local jobs (Bosch's German postings, for instance) are
// treated as unknown and lose their place in the scoring queue.
const COUNTRY_ALIASES = [
  ["germany", "deutschland", "de", "ger", "deu"],
  ["austria", "österreich", "oesterreich", "at", "aut"],
  ["switzerland", "schweiz", "suisse", "ch", "che"],
  ["netherlands", "nederland", "holland", "nl", "nld"],
  ["france", "frankreich", "fr", "fra"],
  ["spain", "españa", "espana", "es", "esp"],
  ["italy", "italia", "it", "ita"],
  ["poland", "polska", "pl", "pol"],
  ["united kingdom", "uk", "england", "gb", "gbr", "britain"],
  ["ireland", "ie", "irl"],
  ["belgium", "belgië", "belgique", "be", "bel"],
  ["sweden", "sverige", "se", "swe"],
  ["denmark", "danmark", "dk", "dnk"],
];

function expandLocationTerms(text) {
  const tokens = (text.toLowerCase().match(/[a-zäöüß]{2,}/g) || []);
  const out = new Set(tokens);
  for (const group of COUNTRY_ALIASES) {
    if (group.some((alias) => tokens.includes(alias))) {
      group.forEach((alias) => out.add(alias));
    }
  }
  return out;
}

export function locationRank(job, baseLocation) {
  const loc = `${job.location || ""}`;
  if (!loc) return 1;                                   // unknown — worth a look
  if (REMOTE_RE.test(loc)) return 0;                    // remote suits anyone
  if (!baseLocation) return 1;

  const mine = expandLocationTerms(baseLocation);
  const here = expandLocationTerms(loc);
  // Two-letter country codes are only trusted as whole tokens: "de" appears
  // inside plenty of place names ("Île-de-France") but rarely stands alone
  // except as a country.
  for (const term of mine) {
    if (term.length <= 2) { if (here.has(term)) return 0; }
    else if (loc.toLowerCase().includes(term)) return 0;
  }

  return FAR_RE.test(loc) ? 3 : 2;                      // clearly far vs. unclear
}

/**
 * Order postings so the scoring budget goes to the ones that could actually
 * work out: local and remote first, unclear next, other continents last.
 */
export function prioritise(jobs, baseLocation) {
  return jobs
    .map((j) => ({ j, rank: locationRank(j, baseLocation) }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.j);
}
