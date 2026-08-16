// docx_edit.js — tailoring a CV by editing the user's own Word file in place.
//
// The alternative, and what this replaces, was to have the model emit a CV as
// JSON and render it into our layout. That produces a document that is not the
// user's: their fonts, their spacing, their two-column skills block and their
// carefully-fought one-page fit are all gone, replaced by ours. For anyone who
// has a decent CV that is a downgrade no matter how good our template is.
//
// So: don't generate, edit. A .docx is a zip of XML; the text lives in <w:t>
// elements inside <w:r> runs inside <w:p> paragraphs. Rewrite the text of a
// paragraph and every formatting property around it survives untouched, because
// we never touch it.
//
// THE EDIT SURFACE IS SMALL, AND THAT IS THE WHOLE TRICK.
//
// The tailoring rules already require role, employer, dates and location to be
// verbatim, and skills to be words the CV already uses. So the only things that
// legitimately change for a given job are: the summary paragraph, the wording
// of bullets, which bullets are dropped, and the order of entries. That is
// find-and-replace over a bounded set of paragraphs — not document generation —
// which is why it fits in a browser with no LibreOffice anywhere in sight.
//
// AND IT IS WHY PAGE COUNT SURVIVES. A rewritten bullet is held to within a few
// percent of the original's length, and blocks may be dropped but never added.
// Nothing grows, so nothing reflows onto a new page. A one-page CV stays one
// page by construction, with no renderer and no page measurement — which is
// fortunate, because neither is available here.
//
// Exposes window.JobCopilotDocx.

(function () {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const DOC_PART = "word/document.xml";

  // How much longer a rewritten block may be than the one it replaces. 8% plus
  // a small absolute allowance: the percentage alone is too tight on a short
  // bullet, where swapping one word for a better one can be a 20% swing.
  const GROWTH = 1.08;
  const GROWTH_SLACK = 12;

  // Below this, a paragraph is a label or a fragment rather than prose, and
  // rewriting it is more likely to damage the layout than to help.
  const MIN_EDITABLE = 25;

  const HEADING_STYLE = /^(heading|title|subtitle|berschrift)/i;

  // Contact details, which must never be rewritten under any circumstances.
  // The first live test marked "Ingolstadt, Germany | meet@example.com" as
  // editable prose — it is 38 characters, carries no date and no heading style,
  // so it fell through every other rule and landed in the one bucket where the
  // model is allowed to rewrite. A CV that goes out with a reworded email
  // address is worse than one that was never tailored.
  const CONTACT = new RegExp([
    /\S+@\S+\.\S+/.source,                       // email
    /\b(https?:\/\/|www\.|linkedin\.|github\.|xing\.)/.source,
    /(\+\d|\(\d)[\d\s()/.\-]{6,}/.source,        // phone
    /\b\d{5}\s+[A-ZÄÖÜ]/.source,                 // German postcode + town
  ].join("|"), "i");
  // A date range in any of the shapes a CV uses. Its presence is strong
  // evidence the paragraph is an entry header — employer, role and dates — and
  // those must never be rewritten.
  const DATE_RANGE =
    /(\b\d{2}[./]\d{4}\b|\b\d{4}\s*[–—-]\s*(\d{4}|present|current|heute|jetzt|now)\b|\b(19|20)\d{2}\b\s*[–—-])/i;

  const text = (el) => el.textContent || "";

  // ── reading ───────────────────────────────────────────────────────────────

  function parseXml(bytes) {
    const xml = new TextDecoder().decode(bytes);
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("this .docx has a malformed document.xml");
    }
    return doc;
  }

  const tag = (el, name) => el.getElementsByTagNameNS(W, name);

  /**
   * The formatting signature of a run, used to decide whether a paragraph's
   * runs can be safely merged.
   *
   * Word splits a single sentence into several runs for reasons that have
   * nothing to do with how it looks — a spell-check pass, an edit session, a
   * language marker. Those runs carry identical <w:rPr>, so collapsing them is
   * invisible. Runs with DIFFERENT rPr are a different matter: a bold lead-in
   * followed by normal text is a deliberate choice, and merging it would bold
   * the whole line. Paragraphs like that are locked instead — see classify().
   */
  function runSignature(run) {
    const rPr = tag(run, "rPr")[0];
    return rPr ? new XMLSerializer().serializeToString(rPr) : "";
  }

  function paragraphRuns(p) {
    // Only runs that actually carry text. A run holding just a <w:br>, a field
    // code or a PICTURE has no <w:t> and must be left exactly where it is.
    return Array.from(tag(p, "r")).filter((r) => tag(r, "t").length > 0);
  }

  /**
   * Does this paragraph carry a picture?
   *
   * German CVs put a Bewerbungsfoto in the document far more often than not,
   * usually in a table cell in the header block. Rewriting such a paragraph is
   * safe — the image lives in a run of its own with no <w:t>, so the text
   * collapse never touches it, and word/media is copied through untouched.
   *
   * DELETING one is not safe, and that is the hole this closes. A photo
   * paragraph that also carries a caption is long enough to be classified as
   * editable, and "editable" includes the model returning null to drop it. That
   * would remove the <w:drawing> along with the caption and silently strip the
   * candidate's photo out of their CV — leaving an orphaned image in
   * word/media that nothing references. Tested: a drop of an image paragraph is
   * now refused and reported.
   *
   * Both element names, because <w:pict> is the older VML form and plenty of
   * CVs are still built from templates that emit it.
   */
  function hasImage(p) {
    return tag(p, "drawing").length > 0 || tag(p, "pict").length > 0;
  }

  /**
   * Decide what a paragraph IS, so we know whether the model may touch it.
   *
   * Conservative by design: anything we cannot confidently identify as prose is
   * locked. A CV that comes back with one bullet un-rewritten is a small loss;
   * one with its employer name rewritten is a false document.
   */
  function classify(p, beforeFirstHeading) {
    const content = text(p).trim();
    if (!content) return { kind: "blank", editable: false, why: "empty" };

    const styleEl = tag(p, "pStyle")[0];
    const style = styleEl ? (styleEl.getAttributeNS(W, "val") || "") : "";

    if (HEADING_STYLE.test(style)) {
      return { kind: "heading", editable: false, why: "section heading" };
    }
    // Everything above the first section heading is the letterhead — name,
    // title, address, email, phone, links. Structural rather than pattern-based,
    // so it catches the ones CONTACT doesn't think to look for. A CV whose
    // summary sits up there loses the chance to tailor it, which is the safe
    // direction to be wrong in.
    if (beforeFirstHeading) {
      return { kind: "header", editable: false, why: "name / contact block" };
    }
    if (CONTACT.test(content)) {
      return { kind: "contact", editable: false, why: "contact details" };
    }
    if (tag(p, "numPr").length) {
      // A list item. The single most reliably editable thing in a CV.
      return finishEditable(p, "bullet");
    }
    if (DATE_RANGE.test(content)) {
      return { kind: "entry", editable: false, why: "employer / role / dates" };
    }
    // A short line where every run is bold reads as a heading whatever style
    // Word recorded, and plenty of CVs are built entirely out of those.
    const runs = paragraphRuns(p);
    if (content.length < 60 && runs.length &&
        runs.every((r) => tag(r, "b").length)) {
      return { kind: "entry", editable: false, why: "bold heading line" };
    }
    if (content.length < MIN_EDITABLE) {
      return { kind: "short", editable: false, why: "too short to rewrite" };
    }
    // Prose. Usually the profile/summary near the top, sometimes a paragraph-
    // style role description.
    return finishEditable(p, "text");
  }

  function finishEditable(p, kind) {
    const runs = paragraphRuns(p);
    if (!runs.length) {
      return { kind, editable: false, why: "no editable text runs" };
    }
    const signature = runSignature(runs[0]);
    if (!runs.every((r) => runSignature(r) === signature)) {
      // See runSignature: merging these would flatten a deliberate mix of
      // formatting. Locked rather than damaged.
      return { kind, editable: false, why: "mixed formatting within the line" };
    }
    return { kind, editable: true, why: "" };
  }

  /**
   * Turn a .docx into the list of blocks the model will be shown.
   *
   * IDs are positional (`p0`, `p1`, …) and stable for a given file, which is
   * what lets a classification the user confirmed at upload time be reused for
   * every tailoring afterwards. `fingerprint` is stored alongside so a replaced
   * CV can't silently inherit the previous one's map.
   */
  function readBlocks(entries) {
    const part = entries.find((e) => e.name === DOC_PART);
    if (!part) throw new Error("not a Word document (no word/document.xml)");

    const doc = parseXml(part.bytes);
    const paragraphs = Array.from(tag(doc.documentElement, "p"));

    // The "everything above the first heading is letterhead" rule needs there
    // to BE a first heading. Plenty of CVs are built with bold text and no
    // heading styles at all, and in those the rule would never stop applying —
    // every paragraph would be locked and tailoring would silently do nothing.
    // So it is switched off entirely for documents that have no headings, which
    // fall back to the CONTACT, date-range and bold-line rules.
    const hasHeadings = paragraphs.some((p) => {
      const s = tag(p, "pStyle")[0];
      return s && HEADING_STYLE.test(s.getAttributeNS(W, "val") || "");
    });

    const blocks = [];
    let sawHeading = false;

    paragraphs.forEach((p, i) => {
      const content = text(p).trim();
      const info = classify(p, hasHeadings && !sawHeading);
      if (info.kind === "heading") sawHeading = true;
      const image = hasImage(p);
      blocks.push({
        id: `p${i}`,
        text: content,
        chars: content.length,
        kind: image && !content ? "photo" : info.kind,
        editable: info.editable,
        // Worth saying out loud in the review panel: a German CV's photo is the
        // thing users most expect an automated tool to lose.
        why: image && !content ? "your photo — kept as is" : info.why,
        image,
      });
    });

    return { blocks, fingerprint: fingerprintBlocks(blocks) };
  }

  /** djb2 over the block structure — detects a different CV, not a reformat. */
  function fingerprintBlocks(blocks) {
    const s = blocks.map((b) => `${b.kind}:${b.chars}`).join("|");
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${blocks.length}:${h.toString(36)}`;
  }

  /** The CV as plain text, for the tailoring prompt and the grounding checks. */
  function extractText(entries) {
    const part = entries.find((e) => e.name === DOC_PART);
    if (!part) throw new Error("not a Word document (no word/document.xml)");
    const doc = parseXml(part.bytes);
    return Array.from(tag(doc.documentElement, "p"))
      .map((p) => text(p).trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ── writing ───────────────────────────────────────────────────────────────

  /**
   * Put new text into a paragraph without disturbing anything around it.
   *
   * All the text goes into the first run and the remaining runs are emptied
   * rather than removed. Emptying is deliberate: a run can carry more than text
   * — a bookmark, a comment anchor, a language setting — and deleting it can
   * invalidate a reference elsewhere in the document. An empty <w:t> renders as
   * nothing and offends no one.
   *
   * Only ever called for paragraphs classify() proved have uniform run
   * formatting, so the collapse is invisible.
   */
  function setParagraphText(p, value) {
    const runs = paragraphRuns(p);
    if (!runs.length) return false;

    const first = tag(runs[0], "t")[0];
    first.textContent = value;
    // Without this, Word eats leading and trailing spaces.
    first.setAttribute("xml:space", "preserve");

    for (let i = 0; i < runs.length; i++) {
      const ts = Array.from(tag(runs[i], "t"));
      for (const t of ts) {
        if (i === 0 && t === first) continue;
        t.textContent = "";
      }
    }
    return true;
  }

  /** Would this edit make the document longer? */
  function tooLong(next, original) {
    return next.length > original.length * GROWTH + GROWTH_SLACK;
  }

  /**
   * Apply the model's edits to the document part and return new zip entries.
   *
   * `edits` is { id: newText | null }, where null drops the block.
   *
   * Every edit is checked here as well as asked for in the prompt, because the
   * page-count guarantee is only as good as its weakest enforcement and a
   * prompt is not enforcement. A rejected edit falls back to the original text,
   * which is always a valid CV line — the failure mode is "less tailored", not
   * "broken" and never "longer".
   */
  function applyEdits(entries, edits, allowed) {
    const part = entries.find((e) => e.name === DOC_PART);
    if (!part) throw new Error("not a Word document (no word/document.xml)");

    const doc = parseXml(part.bytes);
    const paragraphs = Array.from(tag(doc.documentElement, "p"));
    const report = { edited: 0, dropped: 0, rejected: [], skipped: [] };

    for (const [id, value] of Object.entries(edits || {})) {
      const index = Number(String(id).replace(/^p/, ""));
      const p = paragraphs[index];
      if (!p) { report.skipped.push(`${id}: no such block`); continue; }

      // The model may only touch blocks the classifier marked editable and the
      // user left enabled. This is the guard that stops an employer name or a
      // date being rewritten, and it is checked here rather than trusted to the
      // prompt for the same reason as the length budget.
      if (allowed && !allowed.has(id)) {
        report.skipped.push(`${id}: not an editable block`);
        continue;
      }

      const original = text(p).trim();

      if (value === null || value === "") {
        // Never delete a paragraph holding a picture — see hasImage(). The
        // caption goes, the photo stays.
        if (hasImage(p)) {
          report.rejected.push(
            `${id}: refused to delete a line containing a photo`);
          continue;
        }
        p.parentNode.removeChild(p);
        report.dropped++;
        continue;
      }

      const next = String(value).trim();
      if (next === original) continue;
      if (tooLong(next, original)) {
        report.rejected.push(
          `${id}: rewrite was ${next.length} chars vs ${original.length} — ` +
          `kept the original so the page count holds`);
        continue;
      }
      if (setParagraphText(p, next)) report.edited++;
    }

    const xml = new XMLSerializer().serializeToString(doc);
    const out = entries.map((e) =>
      e.name === DOC_PART ? { name: e.name, bytes: new TextEncoder().encode(xml) } : e);

    return { entries: out, report };
  }

  /**
   * Apply the user's own decisions on top of the classifier's.
   *
   * The classifier is a set of heuristics and it is wrong at the margins in
   * both directions — it locks a bullet whose formatting it can't merge, and it
   * may offer up a line the user considers untouchable. The review panel in
   * settings lets them say so once, and this is where that answer is honoured.
   *
   * Only valid for the document the overrides were recorded against: block ids
   * are positional, so applying one CV's choices to another would unlock
   * whichever paragraph happens to sit at that index. The caller checks the
   * fingerprint; this function trusts that it did.
   *
   * A user may only ever RESTRICT what is editable, never widen it. Ticking a
   * line the classifier locked as an employer name would hand the model the one
   * thing the whole design exists to keep it away from.
   */
  function allowedIds(blocks, overrides) {
    const allowed = new Set();
    for (const b of blocks) {
      if (!b.editable) continue;
      if (overrides && b.id in overrides && !overrides[b.id]) continue;
      allowed.add(b.id);
    }
    return allowed;
  }

  window.JobCopilotDocx = {
    readBlocks, extractText, applyEdits, fingerprintBlocks, allowedIds,
    GROWTH, GROWTH_SLACK, MIN_EDITABLE,
  };
})();
