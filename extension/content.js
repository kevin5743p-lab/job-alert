// content.js — runs on LinkedIn job pages.
//
// Three jobs: (1) inject a floating "Tailor this job" button, (2) read the job
// off the page when clicked, (3) show the tailored result in a slide-in panel.
// The actual Groq call happens in the background worker (see background.js).
//
// Reading the job from LinkedIn's DOM is the fragile, per-site part: LinkedIn
// ships obfuscated, versioned class names and two layouts (the /jobs/view/ page
// and the search split-view). We try several selectors and degrade gracefully.
// Expect to revisit these selectors when LinkedIn reshuffles its markup.

(function () {
  if (window.__jobCopilotLoaded) return;
  window.__jobCopilotLoaded = true;

  const $ = (sel, root = document) => root.querySelector(sel);

  // Return the trimmed text of the first selector that matches and has text.
  function pickText(selectors) {
    for (const sel of selectors) {
      const el = $(sel);
      const txt = el && (el.innerText || el.textContent || "").trim();
      if (txt) return txt;
    }
    return "";
  }

  // ── Per-site readers ──────────────────────────────────────────────────────
  // Each entry only needs to say where the metadata lives; the description
  // falls back to the generic longest-block heuristic, and missing title/company
  // fall back to parsing document.title. Selectors use partial class matching
  // ([class*=...]) because these sites hash or version their class names.
  const SITES = {
    linkedin: {
      match: (h) => h.endsWith("linkedin.com"),
      title: ["[class*='job-details-jobs-unified-top-card__job-title']",
              "[class*='jobs-unified-top-card__job-title']",
              ".jobs-search__job-details h1", "h1.t-24", ".topcard__title"],
      company: ["[class*='job-details-jobs-unified-top-card__company-name'] a",
                "[class*='job-details-jobs-unified-top-card__company-name']",
                "[class*='jobs-unified-top-card__company-name']",
                ".topcard__org-name-link"],
      location: ["[class*='job-details-jobs-unified-top-card__primary-description']",
                 "[class*='jobs-unified-top-card__primary-description']",
                 ".topcard__flavor--bullet"],
      description: ["#job-details", "[class*='jobs-description']",
                    "[class*='jobs-box__html-content']", ".show-more-less-html__markup"],
      canonicalUrl: () => {
        const m = window.location.pathname.match(/\/jobs\/view\/(\d+)/);
        if (m) return `https://www.linkedin.com/jobs/view/${m[1]}/`;
        const id = new URLSearchParams(window.location.search).get("currentJobId");
        return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
      },
    },
    workday: {
      // Workday renders the posting inside a data-automation-id scaffold, which
      // is far more stable than its generated class names.
      match: (h) => h.includes("myworkdayjobs.com") || h.includes("myworkdaysite.com"),
      title: ["[data-automation-id='jobPostingHeader']", "h1", "h2"],
      company: [],   // not in the DOM — comes from document.title / the tenant
      location: ["[data-automation-id='locations']",
                 "[data-automation-id='jobPostingLocation']"],
      description: ["[data-automation-id='jobPostingDescription']",
                    "[data-automation-id='job-posting-details']"],
    },
    indeed: {
      match: (h) => h.includes("indeed."),
      title: ["[data-testid='jobsearch-JobInfoHeader-title']",
              ".jobsearch-JobInfoHeader-title", "h1"],
      company: ["[data-testid='inlineHeader-companyName']",
                "[data-company-name='true']", "[class*='JobInfoHeader-companyName']"],
      location: ["[data-testid='inlineHeader-companyLocation']",
                 "[data-testid='job-location']"],
      description: ["#jobDescriptionText", "[class*='jobsearch-JobComponent-description']"],
      canonicalUrl: () => {
        const jk = new URLSearchParams(window.location.search).get("jk");
        return jk ? `${window.location.origin}/viewjob?jk=${jk}` : null;
      },
    },
    greenhouse: {
      match: (h) => h.includes("greenhouse.io"),
      title: [".app-title", "h1.section-header", "h1"],
      company: [".company-name", "[class*='company-name']"],
      location: [".location", "[class*='location']"],
      description: ["#content", ".job__description", "[class*='job-post']"],
    },
    ashby: {
      match: (h) => h.includes("ashbyhq.com"),
      title: ["h1", "[class*='JobPostHeader'] h1"],
      company: ["[class*='CompanyName']", "header a"],
      location: ["[class*='JobPostHeader'] [class*='location']"],
      description: ["[class*='JobPostDescription']", "[class*='ashby-job-posting']", "main"],
    },
    lever: {
      match: (h) => h.includes("lever.co"),
      title: [".posting-headline h2", "h2"],
      company: [".main-header-logo img", "[class*='company']"],
      location: [".posting-categories .location", ".location"],
      description: [".section-wrapper.page-full-width", "[class*='section-wrapper']"],
    },
    personio: {
      match: (h) => h.includes("jobs.personio.de"),
      title: ["h1", "[class*='job-title']"],
      company: ["[class*='company']"],
      location: ["[class*='office']", "[class*='location']"],
      description: ["[class*='job-description']", "main", "article"],
    },
    recruitee: {
      match: (h) => h.includes("recruitee.com"),
      title: ["h1", "[class*='job-title']"],
      company: ["[class*='company-name']"],
      location: ["[class*='job-location']", "[class*='location']"],
      description: ["[class*='job-description']", "main", "article"],
    },
    smartrecruiters: {
      match: (h) => h.includes("smartrecruiters.com"),
      title: ["h1", "[class*='job-title']"],
      company: ["[class*='company-name']", "[itemprop='hiringOrganization']"],
      location: ["[class*='job-location']", "[itemprop='jobLocation']"],
      description: ["[itemprop='description']", "[class*='job-sections']", "main"],
    },
  };

  function currentSite() {
    const host = window.location.hostname;
    for (const [name, cfg] of Object.entries(SITES)) {
      if (cfg.match(host)) return [name, cfg];
    }
    return ["generic", {}];
  }

  function readJob() {
    const [name, cfg] = currentSite();
    // document.title is "<job> | <company> | <site>" on nearly every job board,
    // so it's a layout-independent backstop when selectors miss.
    const fromTitleTag = parseDocumentTitle();

    const title = pickText(cfg.title || []) || fromTitleTag.title;
    const company = pickText(cfg.company || []) || fromTitleTag.company;
    const location = pickText(cfg.location || []);
    const description = readDescription(cfg.description || []);
    // Canonical URL is the dedup key for the applications table: the same
    // posting must always produce the same URL. Sites without a rule fall back
    // to the path (query strings are usually tracking noise).
    const url = (cfg.canonicalUrl && cfg.canonicalUrl()) ||
                (window.location.origin + window.location.pathname);
    return { title, company, location, description, url, source: name };
  }

  // Job boards title their tabs "<job> | <company> | <site>", so this is a
  // reliable last resort when the DOM classes have moved. The site name is
  // dropped so it can't be mistaken for the employer.
  const SITE_WORDS = /^(linkedin|indeed|greenhouse|ashby|lever|personio|recruitee|smartrecruiters|workday|jobs?|careers?)$/i;

  function parseDocumentTitle() {
    const parts = (document.title || "")
      .split(/[|–—]|\sat\s/).map((p) => p.trim())
      .filter((p) => p && !SITE_WORDS.test(p));
    if (parts.length >= 2) return { title: parts[0], company: parts[1] };
    if (parts.length === 1) return { title: parts[0], company: "" };
    return { title: "", company: "" };
  }

  // Job boards hash and reshuffle their class names, so rather than trusting one
  // exact selector we gather every plausible container — the site's own hints
  // plus generic ones — and keep the LONGEST text block. As long as ONE of them
  // still wraps the description, we find it.
  function readDescription(siteSelectors) {
    const selectors = [
      ...(siteSelectors || []),
      "#job-details",
      "[class*='jobs-description']",
      "[class*='job-description']",
      "[class*='description__text']",
      "[data-automation-id='jobPostingDescription']",
      "#jobDescriptionText",
      "article",
    ].join(", ");

    let best = "";
    document.querySelectorAll(selectors).forEach((el) => {
      const t = (el.innerText || el.textContent || "").trim();
      if (t.length > best.length) best = t;
    });
    if (best.length >= 200) return best;

    // Last resort: the main job column. Noisier (may include "Meet the hiring
    // team" etc.) but the model tolerates it and it's better than nothing.
    const main = document.querySelector("main") || document.body;
    const mainText = (main.innerText || "").trim();
    return mainText.length > best.length ? mainText.slice(0, 6000) : best;
  }

  // ── Floating button ──────────────────────────────────────────────────────
  function injectButton() {
    if ($("#jobcopilot-fab")) return;
    const btn = document.createElement("button");
    btn.id = "jobcopilot-fab";
    btn.type = "button";
    btn.textContent = "✦ Tailor this job";
    btn.addEventListener("click", onTailorClick);
    document.body.appendChild(btn);
  }

  // ── Panel ────────────────────────────────────────────────────────────────
  function ensurePanel() {
    let panel = $("#jobcopilot-panel");
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "jobcopilot-panel";
    panel.innerHTML = `
      <div id="jobcopilot-panel-head">
        <span id="jobcopilot-panel-title">JobCopilot</span>
        <button id="jobcopilot-close" type="button" aria-label="Close">✕</button>
      </div>
      <div id="jobcopilot-panel-body"></div>`;
    document.body.appendChild(panel);
    panel.querySelector("#jobcopilot-close")
         .addEventListener("click", () => panel.classList.remove("open"));
    return panel;
  }

  function openPanel(html) {
    const panel = ensurePanel();
    panel.querySelector("#jobcopilot-panel-body").innerHTML = html;
    panel.classList.add("open");
  }

  const esc = (s) =>
    String(s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function onTailorClick() {
    const job = readJob();
    if (!job.description || job.description.length < 60) {
      openPanel(`<p class="jc-msg">Couldn't read a job description on this page.
        Open a specific job posting first, then click again.</p>`);
      return;
    }
    openPanel(`<p class="jc-msg">✦ Tailoring your application for
      <b>${esc(job.title || "this role")}</b>…<br/><span class="jc-dim">This takes a few seconds.</span></p>`);

    chrome.runtime.sendMessage({ type: "TAILOR", job }, (resp) => {
      if (chrome.runtime.lastError) {
        openPanel(`<p class="jc-msg">Extension error: ${esc(chrome.runtime.lastError.message)}</p>`);
        return;
      }
      if (!resp) {
        openPanel(`<p class="jc-msg">No response from the background worker.</p>`);
        return;
      }
      if (!resp.ok) {
        if (resp.error === "NO_KEY" || resp.error === "NO_CV") {
          openPanel(`<p class="jc-msg">Set up JobCopilot first: click the
            extension icon in your toolbar and paste your <b>Groq API key</b> and
            your <b>CV</b>.</p>`);
        } else {
          openPanel(`<p class="jc-msg">Couldn't tailor: ${esc(resp.error)}</p>`);
        }
        return;
      }
      renderResult(job, resp.result, resp.warnings || [], resp);
    });
  }

  // Build a clean, print-ready A4 document: tailored highlights on page 1,
  // cover letter on page 2. Opened in a new tab; the user hits "Save as PDF".
  // Zero dependencies — the browser's own print-to-PDF does the work.
  function buildPrintDoc(job, r) {
    const exp = (r.relevant_experience || [])
      .map((e) => `<li>${esc(e.bullet)}</li>`).join("");
    const skills = (r.matched_keywords || []).map((k) => esc(k)).join(" · ");
    const today = new Date().toLocaleDateString();
    return `<!doctype html><html><head><meta charset="utf-8">
<title>Tailored application — ${esc(job.title || "")}</title>
<style>
  @page { size: A4; margin: 20mm; }
  body { font: 11.5pt/1.55 Georgia, "Times New Roman", serif; color: #111; }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .05em;
       border-bottom: 1px solid #999; padding-bottom: 3px; margin: 16pt 0 7pt; }
  .muted { color: #555; font-size: 10pt; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 5pt; }
  pre.letter { white-space: pre-wrap; font: 11.5pt/1.6 Georgia, serif; margin: 0; }
  .page-break { page-break-before: always; }
  .bar { font-family: sans-serif; margin-bottom: 14px; }
  .bar button { padding: 8px 16px; font-size: 13px; cursor: pointer;
    border: none; border-radius: 6px; background: #4f46e5; color: #fff; }
  @media print { .bar { display: none; } }
</style></head><body>
  <div class="bar">
    <button onclick="window.print()">Save as PDF / Print</button>
    <span class="muted"> — in the dialog, choose “Save as PDF”.</span>
  </div>

  <h1>Tailored highlights</h1>
  <div class="muted">For: ${esc(job.title || "")} — ${esc(job.company || "")} · ${esc(today)}</div>

  <h2>Summary</h2>
  <p>${esc(r.tailored_summary)}</p>

  <h2>Most relevant experience</h2>
  <ul>${exp}</ul>
  ${skills ? `<h2>Key matching skills</h2><p>${skills}</p>` : ""}

  <div class="page-break"></div>
  <h1>Cover letter</h1>
  <div class="muted">${esc(job.company || "")}</div>
  <pre class="letter">${esc(r.cover_letter)}</pre>
</body></html>`;
  }

  function openPrintDoc(job, r) {
    const w = window.open("", "_blank");
    if (!w) {
      alert("Pop-up blocked — allow pop-ups for LinkedIn, then click Download again.");
      return;
    }
    w.document.open();
    w.document.write(buildPrintDoc(job, r));
    w.document.close();
  }

  function renderResult(job, r, warnings, meta = {}) {
    const chips = (arr, cls) =>
      (arr || []).map((x) => `<span class="jc-chip ${cls}">${esc(x)}</span>`).join("") || "<span class='jc-dim'>—</span>";

    const exp = (r.relevant_experience || []).map((e) => `
      <li><div class="jc-bullet">${esc(e.bullet)}</div>
      ${e.from_cv ? `<div class="jc-source">↳ from CV: ${esc(e.from_cv)}</div>` : ""}</li>`).join("");

    const suggestions = (r.suggestions || []).map((s) => `<li>${esc(s)}</li>`).join("");

    const warnHtml = warnings.length
      ? `<div class="jc-warn"><b>⚠️ Grounding check:</b> ${warnings.length} bullet(s) may not be
         supported by your CV — review before using:<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
      : `<div class="jc-okcheck">✅ Grounding check passed — every point traces to your CV.</div>`;

    const savedNote = meta.saved
      ? `<div class="jc-saved">☁️ Saved to your account &amp; tracked as <b>tailored</b>.</div>`
      : meta.signedIn
        ? `<div class="jc-saved jc-saved-warn">⚠️ Couldn't save to your account (result still shown).</div>`
        : `<div class="jc-saved jc-saved-warn">Not signed in — this result isn't saved.
           Sign in from the extension icon to keep a history.</div>`;

    openPanel(`
      <div class="jc-toolbar"><button id="jc-download" type="button">⬇ Download as PDF</button></div>
      ${savedNote}

      <div class="jc-section"><div class="jc-fit">${esc(r.fit_summary)}</div></div>

      <div class="jc-section"><h4>Tailored summary</h4>
        <p>${esc(r.tailored_summary)}</p>
        <button class="jc-copy" data-copy="${esc(r.tailored_summary)}">Copy</button></div>

      <div class="jc-section"><h4>Relevant experience</h4><ul class="jc-exp">${exp}</ul></div>

      <div class="jc-section"><h4>Matches</h4>${chips(r.matched_keywords, "jc-match")}</div>
      <div class="jc-section"><h4>Gaps</h4>${chips(r.missing_keywords, "jc-gap")}</div>

      ${suggestions ? `<div class="jc-section"><h4>Suggestions</h4><ul>${suggestions}</ul></div>` : ""}

      <div class="jc-section"><h4>Cover letter</h4>
        <pre class="jc-letter">${esc(r.cover_letter)}</pre>
        <button class="jc-copy" data-copy="${esc(r.cover_letter)}">Copy cover letter</button></div>

      ${warnHtml}`);

    // wire copy buttons
    document.querySelectorAll("#jobcopilot-panel .jc-copy").forEach((b) => {
      b.addEventListener("click", () => {
        navigator.clipboard.writeText(b.getAttribute("data-copy") || "");
        b.textContent = "Copied ✓";
        setTimeout(() => (b.textContent = b.textContent.replace(" ✓", "")), 1500);
      });
    });

    // wire the PDF download
    const dl = document.querySelector("#jobcopilot-panel #jc-download");
    if (dl) dl.addEventListener("click", () => openPrintDoc(job, r));
  }

  // LinkedIn is a single-page app; the button can get wiped on navigation.
  // Keep it present with a light re-check.
  injectButton();
  setInterval(injectButton, 2000);
})();
