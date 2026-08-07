// print_doc.js — builds the printable A4 application document.
//
// A plain (non-module) script so BOTH the content script and the dashboard page
// can use it: content scripts can't import ES modules, and duplicating this
// would guarantee the two copies drift apart.
//
// Exposes window.JobCopilotPrintDoc = { build, open }.

(function () {
  const esc = (s) =>
    String(s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Page 1: tailored highlights. Page 2: cover letter.
  function build(job, r) {
    const exp = (r.relevant_experience || [])
      .map((e) => `<li>${esc(e.bullet)}</li>`).join("");
    const skills = (r.matched_keywords || []).map((k) => esc(k)).join(" · ");
    const today = new Date().toLocaleDateString();
    return `<!doctype html><html><head><meta charset="utf-8">
<title>Tailored application — ${esc(job.title || "")}</title>
<style>
  /* Zero page margin, with the body's own padding restoring the white space.
     This makes a clean page the default, but it does NOT remove Chrome's
     header and footer — the date along the top and the document's URL along
     the bottom. Those follow the "Headers and footers" tick-box in the print
     dialog, which is a saved user preference that no page can override; a
     zero margin only changes what the dialog opens with. Hence the notice in
     the toolbar telling the user where the box is. Verified the hard way: with
     that box ticked, a letter still printed with a blob: URL across the foot. */
  @page { size: A4; margin: 0; }
  body { font: 11.5pt/1.55 Georgia, "Times New Roman", serif; color: #111;
         padding: 20mm; }
  @media print { body { padding: 20mm; } }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .05em;
       border-bottom: 1px solid #999; padding-bottom: 3px; margin: 16pt 0 7pt; }
  .muted { color: #555; font-size: 10pt; }
  ul { margin: 0; padding-left: 18px; }
  li { margin-bottom: 5pt; }
  pre.letter { white-space: pre-wrap; font: 11.5pt/1.6 Georgia, serif; margin: 0; }
  .page-break { page-break-before: always; }
  /* CV page. Deliberately plain: a CV is read by people in a hurry and by
     parsers that choke on columns, boxes and colour. Structure comes from
     spacing and weight, not decoration. */
  .cv-head { margin-bottom: 4pt; }
  .cv-headline { font-size: 11.5pt; color: #333; margin: 0 0 2pt; }
  .cv-contact { font-size: 9.5pt; color: #555; }
  .cv-summary { margin: 8pt 0 0; }
  .cv-entry { margin: 0 0 10pt; page-break-inside: avoid; }
  .cv-entry-head { display: flex; justify-content: space-between; gap: 12pt; }
  .cv-role { font-weight: bold; }
  .cv-org { font-style: italic; }
  .cv-dates { white-space: nowrap; color: #444; font-size: 10pt; }
  .cv-entry ul { margin: 3pt 0 0; padding-left: 16px; }
  .cv-entry li { margin-bottom: 2pt; }
  .cv-skills { margin: 0; }
  .bar { font-family: sans-serif; margin-bottom: 14px; }
  .bar .note { display: block; margin-top: 8px; padding: 8px 10px; max-width: 640px;
               background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px;
               font-size: 12.5px; line-height: 1.5; color: #4d2d00; }
  .bar button { padding: 8px 16px; font-size: 13px; cursor: pointer;
    border: none; border-radius: 6px; background: #4f46e5; color: #fff; }
  @media print { .bar { display: none; } }
</style></head><body>
  <div class="bar">
    <button onclick="window.print()">Save as PDF / Print</button>
    <span class="muted"> — in the dialog, choose “Save as PDF”.</span>
    <!-- Chrome's headers and footers are a saved user preference, and no page
         can switch them off for you: with the box ticked it stamps the date on
         the top of the letter and the blob: URL along the bottom. It is a
         one-time change, so say exactly where it is rather than leaving an
         employer to receive a letter with a URL printed across it. -->
    <span class="note"><b>Before saving, untick “Headers and footers”</b> in the
    print dialog — under <i>More settings</i> if you don't see it. Otherwise
    Chrome prints today's date and this page's address onto your letter. Chrome
    remembers the choice, so this is only needed once.<br />
    If the button above does nothing, the site's security policy has blocked
    it: press Ctrl&nbsp;+&nbsp;P (⌘&nbsp;+&nbsp;P on a Mac) instead.</span>
  </div>

  ${cvHtml(r.tailored_cv, job)}
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

  // Opened as a blob rather than written into a blank window. A document
  // produced with document.write inherits the opener page's CSP, so on sites
  // that forbid inline handlers — Ashby and Workday among them — the "Save as
  // PDF" button silently did nothing. A blob URL carries its own origin and no
  // inherited policy, so the button works everywhere.
  // The new tab may not have parsed its document yet when window.open returns,
  // and printing an empty page produces a blank PDF. Wait for load, with a
  // timed fallback for the case where the event has already fired, and give up
  // quietly rather than throwing if the window is closed in the meantime.
  function printWhenReady(w) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      try { w.focus(); w.print(); } catch { /* closed, or blocked: the button remains */ }
    };
    try {
      if (w.document && w.document.readyState === "complete") { setTimeout(go, 150); return; }
      w.addEventListener("load", () => setTimeout(go, 100));
    } catch { /* cross-origin for reasons we can't see: fall through to the timer */ }
    setTimeout(go, 1500);
  }

  function openHtml(html) {
    let url;
    try {
      url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    } catch {
      url = null;
    }
    const w = url ? window.open(url, "_blank") : null;
    if (w) {
      // Open the print dialog from here rather than relying on the button in
      // the document. That button is an inline onclick, and inline handlers are
      // refused wherever a content-security policy forbids them — which is not
      // only strict career sites but the extension's own pages, whose default
      // policy is script-src 'self'. The blob was meant to escape that, but a
      // blob inherits the origin and the policy of whatever created it, so the
      // button stayed dead in exactly the places it needed to work.
      //
      // This call is our own script in our own context, and the blob is
      // same-origin with its opener, so it is allowed where the handler is not.
      // The button stays for printing a second time.
      printWhenReady(w);
      // Freed once the tab has it; revoking immediately can race the load.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return true;
    }
    if (url) URL.revokeObjectURL(url);

    // Pop-up blocked, or blobs unavailable — fall back to the old path, which
    // still works on pages with a permissive policy.
    const fallback = window.open("", "_blank");
    if (!fallback) {
      alert("Pop-up blocked — allow pop-ups for this site, then click Download again.");
      return false;
    }
    fallback.document.open();
    fallback.document.write(html);
    fallback.document.close();
    printWhenReady(fallback);
    return true;
  }

  // The CV, rendered only when the model returned one that survived
  // normalisation. Anything it did return that could not be traced back to the
  // source CV has already been raised as a warning in the panel — this renders
  // what it was given and does not quietly repair it, because silently
  // correcting a CV is how a wrong fact becomes an invisible one.
  function cvEntry(e) {
    const head = [
      e.role ? `<span class="cv-role">${esc(e.role)}</span>` : "",
      e.org ? `<span class="cv-org">${esc(e.org)}</span>` : "",
    ].filter(Boolean).join(" — ");
    const right = [e.location, e.dates].filter(Boolean).map(esc).join(", ");
    const bullets = (e.bullets || []).length
      ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
    return `<div class="cv-entry">
      <div class="cv-entry-head"><div>${head}</div>
        ${right ? `<div class="cv-dates">${right}</div>` : ""}</div>
      ${bullets}
    </div>`;
  }

  function cvHtml(cv, job) {
    if (!cv || !cv.sections || !cv.sections.length) return "";
    const contact = [job.applicantContact || ""].filter(Boolean).join(" · ");
    const sections = cv.sections.map((sec) => {
      const body = sec.entries && sec.entries.length
        ? sec.entries.map(cvEntry).join("")
        : `<p class="cv-skills">${(sec.items || []).map(esc).join(" · ")}</p>`;
      return `<h2>${esc(sec.title || "")}</h2>${body}`;
    }).join("");

    return `
  <div class="cv-head">
    <h1>${esc(cv.name || job.applicantName || "")}</h1>
    ${cv.headline ? `<div class="cv-headline">${esc(cv.headline)}</div>` : ""}
    ${contact ? `<div class="cv-contact">${esc(contact)}</div>` : ""}
  </div>
  ${cv.summary ? `<p class="cv-summary">${esc(cv.summary)}</p>` : ""}
  ${sections}
  <div class="page-break"></div>`;
  }

  function open_(job, r) {
    openHtml(build(job, r));
  }

  window.JobCopilotPrintDoc = { build, open: open_, openHtml };
})();
