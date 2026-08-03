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

// LinkedIn, via the public guest endpoint the site itself uses to page search
// results — no login and no private API. Running it from the user's own browser
// and residential IP is the least bot-like way to read it, which is the whole
// reason this lives in the extension rather than on a server.
//
// Kept deliberately modest: a handful of queries per scan, spaced out, and no
// per-posting detail requests. The card gives title, company, location and date,
// which is enough to score; anything promising gets its full text read anyway
// when the user opens it and hits "Tailor this job".
const LINKEDIN_GUEST =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const LINKEDIN_MAX_QUERIES = 6;
const LINKEDIN_PAUSE_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The value can sit inside a nested <a>, so stopping at the first "<" finds only
// whitespace. Take a generous slice instead, drop complete tags, then cut at any
// half-tag the slice ran through — otherwise markup bleeds into the value
// ("BMW Group <div class="base-sea").
function cardField(card, cls) {
  const at = card.search(new RegExp(`class="[^"]*${cls}[^"]*"`));
  if (at === -1) return "";
  const after = card.slice(at);
  const start = after.indexOf(">");
  if (start === -1) return "";

  let text = after.slice(start + 1, start + 400).replace(/<[^>]*>/g, " ");
  text = text.split("<")[0];                       // trailing partial tag
  // Sibling elements are separated by a run of whitespace in the markup, so the
  // first chunk is this field's own text — without it the next element bleeds
  // in ("Munich, Bavaria, Germany   Be an early applicant").
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
  return (text.split(/\s{2,}|\n/)[0] || "").replace(/\s+/g, " ").trim();
}

async function fetchLinkedIn(queries, location) {
  const out = [];
  const seen = new Set();

  for (const q of (queries || []).slice(0, LINKEDIN_MAX_QUERIES)) {
    const url = `${LINKEDIN_GUEST}?keywords=${encodeURIComponent(q)}` +
      `&location=${encodeURIComponent(location || "Germany")}` +
      `&f_TPR=r604800&start=0`;                       // posted in the last week
    const html = await getText(url);
    if (!html) { await sleep(LINKEDIN_PAUSE_MS); continue; }

    for (const m of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
      const card = m[1];
      const href = (card.match(
        /href="(https:\/\/[a-z]{2,3}\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
      if (!href) continue;

      // Canonicalise to the same shape content.js produces on a job page, so a
      // posting found here and one tailored by hand are the same tracker row
      // rather than two.
      const id = (href.match(/-(\d{6,})$/) || href.match(/\/(\d{6,})(?:\/|$)/) || [])[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const title = cardField(card, "base-search-card__title");
      if (!title) continue;
      const posted = (card.match(/datetime="([^"]+)"/) || [])[1] || null;

      out.push({
        id: `li_${id}`,
        title,
        company: cardField(card, "base-search-card__subtitle"),
        location: cardField(card, "job-search-card__location"),
        description: "",
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        published: posted,
        source: "LinkedIn",
      });
    }
    await sleep(LINKEDIN_PAUSE_MS);
  }
  return out;
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

// SuccessFactors — how the big German OEMs publish. There is no clean API, but
// SAP exposes a documented XML summary feed (KBA 2428902) that lists every open
// posting. This is the only way to reach BMW, Volkswagen and Schaeffler from the
// browser; without it the extension misses exactly the employers a German
// automotive candidate most wants.
//
// The feed is large (1-3 MB) and carries no location or date per posting, only
// JobTitle, Job-Description and ReqId — so descriptions are truncated hard and
// location is left for the scorer to infer from the text.
async function fetchSuccessFactors(c) {
  const host = c.host || "career5.successfactors.eu";
  const xml = await getText(
    `https://${host}/career?company=${encodeURIComponent(c.id)}` +
    `&career_ns=job_listing_summary&resultType=XML`);
  if (!xml || xml.indexOf("<Job>") === -1) return [];

  return xmlTagAll(xml, "Job").map((block) => {
    const reqId = xmlTag(block, "ReqId");
    const title = stripHtml(xmlTag(block, "JobTitle"));
    if (!reqId || !title) return null;
    return {
      id: `sf_${c.id}_${reqId}`,
      title,
      company: c.name,
      location: "",                    // not in the feed; the scorer reads the text
      description: stripHtml(xmlTag(block, "Job-Description")).slice(0, 2500),
      url: `https://${host}/career?company=${encodeURIComponent(c.id)}` +
           `&career_job_req_id=${reqId}&career_ns=job_listing`,
      published: null,
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
  successfactors: fetchSuccessFactors,
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
// Germany only. Boards headquartered elsewhere were dropped even where they
// post the odd German role: they made scans slow (a single US board can return
// 800 postings) and crowded the scoring budget with jobs nobody here can take.
const KNOWN_BOARDS = [
  // automotive / autonomous driving / mobility
  { name: "Blickfeld", ats: "personio", id: "blickfeld", tags: "automotive lidar sensors hardware" },
  { name: "Bosch", ats: "smartrecruiters", id: "BoschGroup", tags: "automotive engineering embedded industrial" },
  { name: "Continental", ats: "smartrecruiters", id: "ContinentalAG", tags: "automotive engineering" },
  // The German OEMs. Verified live: BMW ~257 postings, Schaeffler ~429,
  // Volkswagen ~170. These are the employers a German automotive candidate
  // actually wants, and nothing else on this list reaches them.
  { name: "BMW Group", ats: "successfactors", id: "bmwag",
    host: "career5.successfactors.eu", tags: "automotive engineering vehicle fahrzeug" },
  { name: "Schaeffler", ats: "successfactors", id: "schaeffler",
    host: "career5.successfactors.eu", tags: "automotive engineering industrial mechanical" },
  { name: "Volkswagen", ats: "successfactors", id: "VWAGLPPROD10",
    host: "career5.successfactors.eu", tags: "automotive engineering vehicle fahrzeug" },
  // German engineering, robotics and hardware — where a Germany-based engineer
  // is most likely to find something they can actually take.
  { name: "NavVis", ats: "greenhouse", id: "navvis", tags: "engineering sensors lidar mapping software automotive" },
  { name: "Helsing", ats: "greenhouse", id: "helsing", tags: "engineering ml software defence" },
  { name: "Isar Aerospace", ats: "greenhouse", id: "isaraerospace", tags: "aerospace engineering manufacturing simulation" },
  { name: "ProGlove", ats: "personio", id: "proglove", tags: "hardware engineering industrial iot embedded" },
  { name: "Magazino", ats: "personio", id: "magazino", tags: "robotics engineering automation logistics" },
  { name: "Wandelbots", ats: "personio", id: "wandelbots", tags: "robotics engineering automation software" },
  { name: "CELUS", ats: "personio", id: "celus", tags: "electronics hardware engineering embedded" },
  { name: "Semron", ats: "personio", id: "semron", tags: "semiconductor hardware engineering ml" },
  // energy / industrial / deep tech
  { name: "1KOMMA5°", ats: "personio", id: "1komma5grad", tags: "energy solar engineering" },
  // software / data / ml
  { name: "Celonis", ats: "greenhouse", id: "celonis", tags: "software data process mining" },
  { name: "Contentful", ats: "greenhouse", id: "contentful", tags: "software engineering" },
  { name: "Staffbase", ats: "greenhouse", id: "staffbase", tags: "software engineering" },
  { name: "GetYourGuide", ats: "greenhouse", id: "getyourguide", tags: "software data engineering" },
  { name: "HelloFresh", ats: "greenhouse", id: "hellofresh", tags: "software data operations supply" },
  { name: "Alasco", ats: "personio", id: "alasco", tags: "software construction finance" },
  { name: "Everphone", ats: "personio", id: "everphone", tags: "software operations" },
  { name: "Grover", ats: "greenhouse", id: "grover", tags: "software operations" },
  // fintech
  { name: "N26", ats: "greenhouse", id: "n26", tags: "fintech finance banking" },
  { name: "SumUp", ats: "greenhouse", id: "sumup", tags: "fintech finance payments" },
  { name: "Trade Republic", ats: "greenhouse", id: "traderepublic", tags: "fintech finance trading" },
  { name: "Solaris", ats: "greenhouse", id: "solarisbank", tags: "fintech finance banking" },
  { name: "Raisin", ats: "greenhouse", id: "raisin", tags: "fintech finance banking savings" },
  // health
  { name: "Doctorly", ats: "personio", id: "doctorly", tags: "health healthcare software" },
  { name: "Climedo", ats: "personio", id: "climedo", tags: "health healthcare clinical data" },
  { name: "Temedica", ats: "personio", id: "temedica", tags: "health healthcare data" },
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
  successfactors: (id, host) =>
    `https://${host || "career5.successfactors.eu"}/career?company=${id}` +
    `&career_ns=job_listing_summary&resultType=XML`,
};

async function probe(c) {
  const ats = String(c.ats || "").toLowerCase();
  const build = PROBE[ats];
  if (!build || !c.id) return false;
  const url = build(encodeURIComponent(c.id), c.host);
  try {
    // No redirect following: Personio bounces unknown tenants to its marketing
    // page, which would otherwise answer 200 and look alive.
    const r = await fetch(url, { headers: UA_HEADERS, redirect: "error" });
    if (!r.ok) return false;
    if (ats === "personio") {
      const t = await r.text();
      return t.indexOf("<position>") !== -1;
    }
    if (ats === "successfactors") {
      // A wrong company id still answers 200, with a short error page rather
      // than the feed — so check for actual postings.
      const t = await r.text();
      return t.indexOf("<Job>") !== -1;
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

  onProgress("Searching LinkedIn…");
  try {
    const jobs = await fetchLinkedIn(queries, searchProfile.location);
    all.push(...jobs);
    stats.push(`LinkedIn ${jobs.length}`);
  } catch { stats.push("LinkedIn ⚠"); }

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
  const exclude = (sp.exclude_keywords || []).map((k) => k.toLowerCase());

  // Target titles are phrases ("Werkstudent Automotive"), but real postings are
  // titled "Werkstudent Softwareentwicklung (m/w/d)" — testing for the whole
  // phrase almost never matches. Compare on the individual words instead, minus
  // the ones too generic to mean anything on their own.
  const STOP = new Set(["and", "der", "die", "das", "und", "für", "mit", "the",
                        "job", "jobs", "role", "position", "stelle"]);
  const titleWords = new Set();
  for (const t of sp.target_titles || []) {
    for (const w of (t.toLowerCase().match(/[a-zäöüß]{4,}/g) || [])) {
      if (!STOP.has(w)) titleWords.add(w);
    }
  }

  return jobs.filter((j) => {
    const title = (j.title || "").toLowerCase();
    const text = `${title} ${(j.description || "").toLowerCase()}`;
    // Seniority and experience mismatches are worth rejecting on the title
    // alone; in the body those words often appear in boilerplate.
    if (exclude.some((k) => title.includes(k))) return false;
    if (!must.length && !titleWords.size) return true;
    if (must.some((k) => text.includes(k))) return true;
    for (const w of titleWords) if (title.includes(w)) return true;
    return false;
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
// This is a German job search, so anything abroad is dropped outright rather
// than ranked — a role in California is not a worse match, it is not a match.
// Some feeds (SuccessFactors especially) carry no location field at all, so
// those fall back to reading the posting text before being discarded.
const GERMAN_HINTS = new RegExp([
  "germany", "deutschland", "\\bde\\b",
  // the larger cities, which is how most postings actually name the place
  "berlin", "münchen", "munich", "hamburg", "köln", "cologne", "frankfurt",
  "stuttgart", "düsseldorf", "dortmund", "essen", "leipzig", "bremen",
  "dresden", "hannover", "nürnberg", "nuremberg", "duisburg", "bochum",
  "wuppertal", "bielefeld", "bonn", "münster", "karlsruhe", "mannheim",
  "augsburg", "wiesbaden", "braunschweig", "kiel", "chemnitz", "aachen",
  "magdeburg", "freiburg", "krefeld", "mainz", "lübeck", "erfurt", "rostock",
  "kassel", "potsdam", "saarbrücken", "ingolstadt", "regensburg", "würzburg",
  "heidelberg", "\\bulm\\b", "wolfsburg", "erlangen", "reutlingen",
  "friedrichshafen", "sindelfingen", "böblingen", "schweinfurt", "herzogenaurach",
].join("|"), "i");

// Signals used when a feed gives no location at all — SuccessFactors carries
// none, and BMW's single feed mixes German, US, French and Korean postings.
//
// The reliable tell is the German gender marker, "(m/w/d)" / "(f/m/x)", which
// German-market postings carry and others do not. Foreign markers rule a
// posting out first: France uses "(F/H)", US listings say "Co-Op" or
// "Spring 2027". Requiring a positive German signal rather than merely the
// absence of a foreign one is deliberate — filling the tracker with jobs in
// South Carolina is worse than missing a few German ones.
const DE_GENDER_RE = /\((?:[mwfdx]\s*\/\s*){1,2}[mwfdx]\)/i;
const DE_LANG_RE =
  /\b(und|für|mit|Ihre|Aufgaben|Qualifikationen|Kenntnisse|Berufserfahrung|Studium|Werkstudent|Praktikum|Abschlussarbeit)\b/;
const FOREIGN_RE =
  /\(F\/H\)|alternant|korea|\bUSA\b|United States|Spartanburg|Woodcliff|Co-?Op\b|Spring 20\d\d|south africa|thailand|mexico|brazil|\bchina\b|\bjapan\b|\bindia\b/i;

export function isReachable(job) {
  const loc = job.location || "";
  if (loc) {
    if (REMOTE_RE.test(loc)) return true;
    if (FAR_RE.test(loc)) return false;
    return GERMAN_HINTS.test(loc);
  }

  const title = job.title || "";
  const text = `${title} ${(job.description || "").slice(0, 1500)}`;
  if (FOREIGN_RE.test(title)) return false;
  return DE_GENDER_RE.test(title) || GERMAN_HINTS.test(text) || DE_LANG_RE.test(text);
}

/**
 * Keep only postings someone in Germany could actually take, then put the
 * clearly-local ones first so they get the scoring budget.
 */
export function prioritise(jobs, baseLocation) {
  return jobs
    .filter(isReachable)
    .map((j) => ({ j, rank: locationRank(j, baseLocation) }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.j);
}
