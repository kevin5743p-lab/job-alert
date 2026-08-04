// cover_templates.js — professional cover-letter layouts.
//
// A plain (non-module) script so the content script, the dashboard and the
// onboarding preview can all use it. Exposes window.JobCopilotCoverTemplates.
//
// Division of labour: the MODEL writes the body paragraphs; the TEMPLATE owns
// everything structural — letterhead, date, subject line, salutation and
// sign-off. That's why the body prompt is told not to produce them: layout is
// not the model's job, and it keeps every letter consistently formatted.

(function () {
  const esc = (s) =>
    String(s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Older saved packets contain a whole letter (greeting + sign-off). Strip
  // those so they don't appear twice once the template adds its own.
  function bodyParagraphs(text, senderName) {
    let t = String(text || "").trim();
    t = t.replace(/^\s*(dear|hello|hi|sehr geehrte[a-zä]*)\b[^\n]*\n+/i, "");
    t = t.replace(
      /\n+\s*(kind regards|best regards|sincerely|yours (sincerely|faithfully)|mit freundlichen grüßen)[\s,]*\n*[^\n]{0,60}$/i,
      "");
    if (senderName) {
      t = t.replace(new RegExp(`\\n+\\s*${senderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
    }
    return t.split(/\n\s*\n|\n(?=[A-ZÄÖÜ])/)
            .map((p) => p.trim()).filter(Boolean);
  }

  function fmtDate(locale) {
    return new Date().toLocaleDateString(
      locale === "de" ? "de-DE" : "en-GB",
      { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // Everything a template needs, assembled from the profile + job + packet.
  function makeData(job, packet, profile, language) {
    const p = profile || {};
    const name = [p.first_name, p.last_name].filter(Boolean).join(" ") ||
                 p.full_name || "";
    const de = language === "de";
    return {
      name,
      email: p.email || "",
      phone: p.phone || "",
      address: [p.address, [p.postal_code, p.city].filter(Boolean).join(" "),
                p.country].filter(Boolean).join(", "),
      links: [p.linkedin_url, p.website_url, p.github_url].filter(Boolean),
      date: fmtDate(language),
      company: job.company || "",
      jobTitle: job.title || "",
      subject: de ? `Bewerbung als ${job.title || ""}`
                  : `Application for ${job.title || ""}`,
      greeting: de ? "Sehr geehrte Damen und Herren," : "Dear Hiring Manager,",
      signOff: de ? "Mit freundlichen Grüßen" : "Kind regards,",
      paragraphs: bodyParagraphs(packet && packet.cover_letter, name),
      subjectLabel: de ? "Betreff" : "Subject",
    };
  }

  const SHARED_CSS = `
    @page { size: A4; margin: 22mm 20mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; }
    p { margin: 0 0 11pt; text-align: justify; }
    .bar { font-family: -apple-system, sans-serif; margin-bottom: 16px; }
    .bar button { padding: 8px 16px; font-size: 13px; cursor: pointer; border: none;
      border-radius: 6px; background: #4f46e5; color: #fff; }
    .bar span { color: #666; font-size: 12px; }
    @media print { .bar { display: none; } }`;

  function page(inner, css) {
    return `<!doctype html><html><head><meta charset="utf-8">
<title>Cover letter</title><style>${SHARED_CSS}${css}</style></head><body>
<div class="bar"><button onclick="window.print()">Save as PDF / Print</button>
<span> — choose “Save as PDF” in the dialog.</span></div>
${inner}</body></html>`;
  }

  const paras = (d) => d.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n");
  const contactLine = (d, sep = " · ") =>
    [d.email, d.phone, d.address].filter(Boolean).map(esc).join(sep);

  // ── The templates ────────────────────────────────────────────────────────
  const TEMPLATES = [
    {
      id: "classic",
      name: "Classic",
      blurb: "Formal serif letter, German business convention (DIN-style). Safest for traditional employers and Mittelstand.",
      render: (d) => page(`
        <div class="sender">
          <div class="nm">${esc(d.name)}</div>
          ${d.address ? `<div>${esc(d.address)}</div>` : ""}
          ${d.email ? `<div>${esc(d.email)}</div>` : ""}
          ${d.phone ? `<div>${esc(d.phone)}</div>` : ""}
        </div>
        <div class="to">${esc(d.company)}</div>
        <div class="date">${esc(d.date)}</div>
        <div class="subj">${esc(d.subject)}</div>
        <p class="greet">${esc(d.greeting)}</p>
        ${paras(d)}
        <p class="sign">${esc(d.signOff)}<br /><br />${esc(d.name)}</p>`, `
        body { font: 11pt/1.6 "Times New Roman", Georgia, serif; }
        .sender { font-size: 10pt; line-height: 1.45; margin-bottom: 26pt; }
        .sender .nm { font-weight: bold; font-size: 12pt; }
        .to { margin-bottom: 20pt; line-height: 1.5; }
        .date { text-align: right; margin-bottom: 22pt; }
        .subj { font-weight: bold; margin-bottom: 18pt; }
        .greet { margin-bottom: 14pt; }
        .sign { margin-top: 18pt; }`),
    },
    {
      id: "modern",
      name: "Modern",
      blurb: "Clean sans-serif with a coloured name header. Good default for tech, startups and international companies.",
      render: (d) => page(`
        <header>
          <h1>${esc(d.name)}</h1>
          <div class="contact">${contactLine(d)}</div>
          ${d.links.length ? `<div class="links">${d.links.map(esc).join(" · ")}</div>` : ""}
        </header>
        <div class="meta"><span>${esc(d.company)}</span><span>${esc(d.date)}</span></div>
        <div class="subj">${esc(d.subject)}</div>
        <p>${esc(d.greeting)}</p>
        ${paras(d)}
        <p class="sign">${esc(d.signOff)}<br /><br /><b>${esc(d.name)}</b></p>`, `
        body { font: 10.5pt/1.65 "Helvetica Neue", Arial, sans-serif; }
        header { border-bottom: 2.5pt solid #2563eb; padding-bottom: 9pt; margin-bottom: 16pt; }
        h1 { font-size: 21pt; margin: 0 0 4pt; color: #1e3a8a; letter-spacing: .3pt; }
        .contact, .links { font-size: 9pt; color: #444; }
        .meta { display: flex; justify-content: space-between; font-size: 10pt;
                color: #444; margin-bottom: 16pt; }
        .subj { font-weight: 600; font-size: 11.5pt; margin-bottom: 14pt; color: #1e3a8a; }
        .sign { margin-top: 16pt; }`),
    },
    {
      id: "minimal",
      name: "Minimal",
      blurb: "Centred name, generous whitespace, no colour. Understated and elegant — works everywhere.",
      render: (d) => page(`
        <header>
          <h1>${esc(d.name)}</h1>
          <div class="contact">${contactLine(d, "   |   ")}</div>
        </header>
        <div class="meta">${esc(d.company)} &nbsp;·&nbsp; ${esc(d.date)}</div>
        <div class="subj">${esc(d.subject)}</div>
        <p>${esc(d.greeting)}</p>
        ${paras(d)}
        <p class="sign">${esc(d.signOff)}<br /><br />${esc(d.name)}</p>`, `
        body { font: 11pt/1.7 Georgia, "Times New Roman", serif; }
        header { text-align: center; margin-bottom: 20pt; }
        h1 { font-size: 17pt; font-weight: normal; letter-spacing: 3pt;
             text-transform: uppercase; margin: 0 0 7pt; }
        .contact { font-size: 9pt; color: #555; letter-spacing: .4pt; }
        header { border-bottom: .5pt solid #bbb; padding-bottom: 12pt; }
        .meta { font-size: 9.5pt; color: #666; margin: 14pt 0 16pt; }
        .subj { font-weight: bold; margin-bottom: 16pt; }
        .sign { margin-top: 18pt; }`),
    },
    {
      id: "executive",
      name: "Executive",
      blurb: "Dark header band with your name reversed out. Confident and corporate — suits senior or client-facing roles.",
      render: (d) => page(`
        <header>
          <div class="nm">${esc(d.name)}</div>
          <div class="contact">${contactLine(d)}</div>
        </header>
        <div class="body">
          <div class="meta"><span>${esc(d.company)}</span><span>${esc(d.date)}</span></div>
          <div class="subj">${esc(d.subject)}</div>
          <p>${esc(d.greeting)}</p>
          ${paras(d)}
          <p class="sign">${esc(d.signOff)}<br /><br /><b>${esc(d.name)}</b></p>
        </div>`, `
        body { font: 10.5pt/1.65 "Helvetica Neue", Arial, sans-serif; }
        header { background: #1f2937; color: #fff; padding: 16pt 18pt; margin-bottom: 18pt;
                 -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        header .nm { font-size: 19pt; font-weight: 600; letter-spacing: .5pt; }
        header .contact { font-size: 9pt; color: #d1d5db; margin-top: 4pt; }
        .meta { display: flex; justify-content: space-between; font-size: 10pt;
                color: #555; margin-bottom: 14pt; }
        .subj { font-weight: 600; font-size: 11.5pt; margin-bottom: 14pt;
                border-left: 3pt solid #1f2937; padding-left: 8pt; }
        .sign { margin-top: 16pt; }`),
    },
    {
      id: "sidebar",
      name: "Sidebar",
      blurb: "Contact details in a tinted left column. Distinctive without being loud — good for design-aware teams.",
      render: (d) => page(`
        <div class="grid">
          <aside>
            <div class="nm">${esc(d.name)}</div>
            ${d.email ? `<div class="it">${esc(d.email)}</div>` : ""}
            ${d.phone ? `<div class="it">${esc(d.phone)}</div>` : ""}
            ${d.address ? `<div class="it">${esc(d.address)}</div>` : ""}
            ${d.links.map((l) => `<div class="it">${esc(l)}</div>`).join("")}
            <div class="it dt">${esc(d.date)}</div>
          </aside>
          <main>
            <div class="to">${esc(d.company)}</div>
            <div class="subj">${esc(d.subject)}</div>
            <p>${esc(d.greeting)}</p>
            ${paras(d)}
            <p class="sign">${esc(d.signOff)}<br /><br /><b>${esc(d.name)}</b></p>
          </main>
        </div>`, `
        body { font: 10.5pt/1.6 "Helvetica Neue", Arial, sans-serif; }
        .grid { display: flex; gap: 16pt; align-items: flex-start; }
        aside { width: 33%; background: #f1f5f9; padding: 14pt 12pt; border-left: 3pt solid #0f766e;
                -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        aside .nm { font-size: 14pt; font-weight: 600; color: #0f766e; margin-bottom: 9pt; line-height: 1.3; }
        aside .it { font-size: 8.5pt; color: #334155; margin-bottom: 5pt; word-break: break-word; }
        aside .dt { margin-top: 10pt; color: #64748b; }
        main { flex: 1; }
        .to { font-size: 10pt; color: #555; margin-bottom: 12pt; }
        .subj { font-weight: 600; font-size: 11.5pt; color: #0f766e; margin-bottom: 13pt; }
        .sign { margin-top: 15pt; }`),
    },
  ];

  const byId = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[1];

  function buildCoverLetter(job, packet, profile, language) {
    const tpl = byId((profile || {}).cover_template);
    return tpl.render(makeData(job, packet, profile, language));
  }

  // Uses the shared opener so the cover letter benefits from the same blob-URL
  // fix — written documents inherit the page's CSP and the print button dies.
  function openCoverLetter(job, packet, profile, language) {
    const html = buildCoverLetter(job, packet, profile, language);
    if (window.JobCopilotPrintDoc && window.JobCopilotPrintDoc.openHtml) {
      window.JobCopilotPrintDoc.openHtml(html);
      return;
    }
    const w = window.open("", "_blank");
    if (!w) {
      alert("Pop-up blocked — allow pop-ups for this site, then try again.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  window.JobCopilotCoverTemplates = {
    TEMPLATES, byId, makeData, buildCoverLetter, openCoverLetter, bodyParagraphs,
  };
})();
