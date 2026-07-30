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

  function open_(job, r) {
    const w = window.open("", "_blank");
    if (!w) {
      alert("Pop-up blocked — allow pop-ups for this site, then click Download again.");
      return;
    }
    w.document.open();
    w.document.write(build(job, r));
    w.document.close();
  }

  window.JobCopilotPrintDoc = { build, open: open_ };
})();
