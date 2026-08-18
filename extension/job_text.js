// job_text.js — read a posting's own words out of a live page.
//
// The apply engine tailors a job that was never tailored by hand, and tailoring
// needs the posting's text. Nearly always the scan already stored it, in
// applications.description — that is free and is tried first. This is the
// fallback for everything else: a job added by hand, a scan that ran out of
// its description budget, a source that only ever gave a title.
//
// Without it, the model would be asked to write a CV against a job title. It
// would do it, and the result would be confident and useless — which is the
// worst failure this system can have, because nothing downstream can tell.
// Better to spend one page load.
//
// The reader runs *in the page*, so it must be self-contained: it is serialised
// by chrome.scripting.executeScript and cannot see anything in this module. It
// is deliberately the same heuristic as content.js's readDescription — gather
// every plausible container, keep the longest text — because that one has
// survived contact with three dozen job boards.

/** How long the page gets to load and hydrate before we give up on it. */
const LOAD_TIMEOUT_MS = 30000;
/** Below this, whatever we scraped is a nav bar, not a job description. */
const MIN_USEFUL = 200;
/** The tailoring prompt is budgeted; the scan stores the same ceiling. */
const MAX_CHARS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs in the page. Returns { text, title } for one frame.
 *
 * Kept as one function with no helpers and no outer references, because that
 * is the only shape executeScript can serialise.
 */
function scrapePosting() {
  const selectors = [
    // The named containers, most specific first. Same list content.js carries,
    // plus the generic ones every ATS seems to converge on.
    "#job-details",
    "[class*='jobs-description']",
    "[class*='jobs-box__html-content']",
    ".show-more-less-html__markup",
    "[data-automation-id='jobPostingDescription']",
    "[data-automation-id='job-posting-details']",
    "#jobDescriptionText",
    "[class*='jobsearch-JobComponent-description']",
    "[class*='JobPostDescription']",
    "[class*='ashby-job-posting']",
    "[id*='jobDescription']",
    "[class*='jobDescription']",
    "[class*='job-description']",
    "[class*='description__text']",
    "[itemprop='description']",
    "[class*='job-sections']",
    ".job__description",
    ".posting-page",
    "article",
  ].join(", ");

  let best = "";
  document.querySelectorAll(selectors).forEach((el) => {
    const t = (el.innerText || el.textContent || "").trim();
    if (t.length > best.length) best = t;
  });

  // Last resort: the main column. Noisier — it can carry "similar jobs" and a
  // cookie banner — but a description with noise around it still tailors
  // correctly, and nothing at all does not.
  //
  // 200 rather than MIN_USEFUL: this function is serialised and run in the
  // page, so it cannot see a constant declared up there. Keep the two in step.
  if (best.length < 200) {
    const main = document.querySelector("main") || document.body;
    const mainText = ((main && main.innerText) || "").trim();
    if (mainText.length > best.length) best = mainText;
  }

  const h1 = document.querySelector("h1");
  return {
    text: best,
    title: ((h1 && h1.innerText) || document.title || "").trim(),
  };
}

/** Wait until the tab has finished loading, or the deadline passes. */
async function waitForLoad(tabId, deadline) {
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the tab was closed");
    if (tab.status === "complete") return;
    if (Date.now() > deadline) return;      // scrape what there is anyway
    await sleep(500);
  }
}

/**
 * Open a posting in a background tab, read its text, close the tab.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{description: string, title: string}|null>} null when the
 *   page could not be read at all — the caller decides whether that is fatal.
 */
export async function readPostingText(url, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  if (!url) return null;
  const deadline = Date.now() + timeoutMs;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForLoad(tabId, deadline);

    // Two passes, because "complete" is when the HTML finished, not when a
    // single-page board finished rendering into it. The first read usually
    // works; the retry is for LinkedIn and Workday, which paint the description
    // after load.
    let best = { description: "", title: "" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(1500);

      // allFrames, because employers embed the board (Greenhouse, Personio,
      // SmartRecruiters all ship an embed) and on those pages the top frame is
      // marketing copy. Frames we can't touch simply fail; a partial result is
      // fine as long as one frame answered.
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: scrapePosting,
      }).catch(() => []);

      for (const r of results || []) {
        const text = (r?.result?.text || "").trim();
        if (text.length > best.description.length) {
          best = { description: text, title: r.result.title || best.title };
        }
      }
      if (best.description.length >= MIN_USEFUL) break;
      if (Date.now() > deadline) break;
    }

    if (!best.description) return null;
    return { description: best.description.slice(0, MAX_CHARS), title: best.title };
  } catch (e) {
    console.warn("Couldn't read the posting text:", e);
    return null;
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  }
}
