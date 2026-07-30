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
