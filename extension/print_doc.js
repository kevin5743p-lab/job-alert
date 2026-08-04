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
  /* Zero page margin, and the page's own padding instead. With any non-zero
     @page margin Chrome prints its own header and footer into it — the source
     URL along one edge and the date and time along the other. On a cover letter
     going to an employer that is not a small blemish, and no employer should be
     receiving a document stamped "chrome-extension://…". Margin 0 is what
     suppresses them; the padding below restores the same 20mm of white space. */
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
  .bar { font-family: sans-serif; margin-bottom: 14px; }
  .bar button { padding: 8px 16px; font-size: 13px; cursor: pointer;
    border: none; border-radius: 6px; background: #4f46e5; color: #fff; }
  @media print { .bar { display: none; } }
</style></head><body>
  <div class="bar">
    <button onclick="window.print()">Save as PDF / Print</button>
    <span class="muted"> — in the dialog, choose “Save as PDF”. If this button
    does nothing, the site's security policy has blocked it: press
    Ctrl&nbsp;+&nbsp;P (⌘&nbsp;+&nbsp;P on a Mac) instead.</span>
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

  function open_(job, r) {
    openHtml(build(job, r));
  }

  window.JobCopilotPrintDoc = { build, open: open_, openHtml };
})();
