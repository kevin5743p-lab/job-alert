// render.js — the page half of the PDF pipeline.
//
// docgen.js (background) opens render.html in a hidden tab and drives it:
//
//   RENDER_DOC  {job, packet, mode}  → paint the document, reply when laid out
//   SAVE_PDF    {base64, filename}   → write it to disk, reply with the path
//
// Two reasons this runs in a page rather than the service worker:
//
//   - Page.printToPDF needs a real document to rasterise.
//   - `URL.createObjectURL` does not exist in an MV3 service worker, and
//     chrome.downloads needs a URL. A page context has it.
//
// print_doc.js is loaded verbatim and never modified — it builds one combined
// document (CV → highlights → cover letter). Splitting that into the two
// separate PDFs an application form asks for is done here, by DOM surgery on
// the rendered output, so the shared builder stays the single source of truth
// for how an application actually looks.

const MODE_CV = "cv";
const MODE_COVER = "cover_letter";

/**
 * Paint the built document into this page and isolate the requested half.
 *
 * print_doc.js emits the cover letter as loose siblings — a page break, an
 * <h1>, a company line, and <pre class="letter"> — rather than one container,
 * so there is nothing to toggle. We wrap them here and hide one side or the
 * other. Walking backwards from `pre.letter` rather than matching on the "Cover
 * letter" heading text keeps this working if that wording is ever translated.
 */
function paint(job, packet, mode, profile) {
  // appendix:false — the "Tailored highlights" section is a working document
  // for the dashboard, not something to staple to an employer's copy of the CV.
  // See print_doc.js's build().
  const html = window.JobCopilotPrintDoc.build(job, packet,
    { appendix: false, profile });
  const parsed = new DOMParser().parseFromString(html, "text/html");

  // ── clear the last pass ───────────────────────────────────────────────────
  //
  // docgen.js opens ONE render tab and drives both documents through it, so
  // this runs twice: CV first, then cover letter. The mode styles are opposites
  // — the CV pass hides `#jca-cover`, the cover pass hides everything that
  // isn't it — and they were appended, never removed. So on the second pass the
  // CV's rule was still live: the cover pass hid all the CV content, the CV's
  // leftover rule hid the letter, and printToPDF rendered a page with nothing
  // on it. That is a valid PDF, so nothing failed and nothing was logged; it
  // just meant every cover letter this pipeline produced was a blank sheet.
  //
  // Everything injected is tagged and cleared here, so a repaint starts from
  // the same state as a fresh tab regardless of what ran before it.
  document.querySelectorAll("style[data-jca-render]").forEach((el) => el.remove());

  // Append rather than replace <head>: this script's element lives there, and
  // although removing it wouldn't stop the already-running script, leaving the
  // DOM intact avoids depending on that subtlety.
  parsed.querySelectorAll("style").forEach((s) => {
    const copy = s.cloneNode(true);
    copy.setAttribute("data-jca-render", "doc");
    document.head.appendChild(copy);
  });
  document.body.innerHTML = parsed.body.innerHTML;

  // The "Save as PDF / untick headers and footers" toolbar is guidance for a
  // human at a print dialog. There is no dialog here.
  document.querySelector(".bar")?.remove();

  const letter = document.querySelector("pre.letter");
  if (letter) {
    const group = document.createElement("div");
    group.id = "jca-cover";
    // Collect the letter and its preceding siblings up to and including the
    // page break that starts the section.
    const parts = [letter];
    let prev = letter.previousElementSibling;
    while (prev) {
      parts.unshift(prev);
      const done = prev.classList.contains("page-break");
      prev = prev.previousElementSibling;
      if (done) break;
    }
    parts[0].before(group);
    parts.forEach((el) => group.appendChild(el));
  }

  const style = document.createElement("style");
  style.setAttribute("data-jca-render", "mode");
  style.textContent = mode === MODE_COVER
    // Cover letter only. `body > :not(#jca-cover)` rather than restyling the
    // group, so anything print_doc.js adds later is excluded by default rather
    // than silently leaking into the letter.
    ? `body > *:not(#jca-cover) { display: none !important; }
       #jca-cover .page-break { page-break-before: auto !important; }`
    // Everything except the cover letter.
    : `#jca-cover { display: none !important; }`;
  document.head.appendChild(style);

  document.title = mode === MODE_COVER ? "Cover letter" : "CV";
}

/**
 * Paint the cover letter through the user's chosen template.
 *
 * The whole document — letterhead, date, subject line, salutation, sign-off —
 * comes from cover_templates.js, which is what the dashboard's "open cover
 * letter" button has always used. The auto-apply path did not: it took the
 * combined print_doc.js document and cut the letter out of it, which meant the
 * file attached to real applications was an <h1> reading "Cover letter", the
 * company name, and the raw body in a <pre>. No name, no contact details, no
 * greeting and nothing to sign off with.
 *
 * Falls back to the print_doc half if the template builder is unavailable, so
 * a missing script degrades to the old behaviour rather than to a blank page.
 */
function paintCover(job, packet, profile, language) {
  const T = window.JobCopilotCoverTemplates;
  if (!T) { paint(job, packet, MODE_COVER); return; }

  const html = T.buildCoverLetter(job, packet, profile || {}, language || "en");
  const parsed = new DOMParser().parseFromString(html, "text/html");

  document.querySelectorAll("style[data-jca-render]").forEach((el) => el.remove());
  parsed.querySelectorAll("style").forEach((s) => {
    const copy = s.cloneNode(true);
    copy.setAttribute("data-jca-render", "doc");
    document.head.appendChild(copy);
  });
  document.body.innerHTML = parsed.body.innerHTML;
  // The template's own print toolbar is guidance for a human at a dialog.
  document.querySelector(".bar")?.remove();
  document.title = "Cover letter";
}

/** Resolve once the layout has settled, so printToPDF sees a finished page. */
function settled() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Fonts are all system serif here, but if that ever changes an unloaded
      // face would reflow the document mid-render.
      (document.fonts?.ready ?? Promise.resolve()).then(resolve, resolve);
    }));
  });
}

/**
 * Write the PDF to disk and resolve with its absolute path.
 *
 * The path is the point: CDP's DOM.setFileInputFiles takes filesystem paths,
 * not blobs, so a file that exists only in Storage cannot be attached to a
 * form. chrome.downloads reports the final absolute path once the write
 * completes — including any "(1)" Chrome appended — which is why we wait for
 * the completed state instead of assuming the name we asked for.
 */
function savePdf(base64, filename) {
  return saveFile(base64, filename, "application/pdf");
}

/**
 * The same writer, for any file type.
 *
 * Split out when the .docx path arrived: a tailored Word CV is attached to the
 * form directly rather than being converted, because nothing in a browser can
 * turn a .docx into a PDF without re-rendering it through HTML and discarding
 * the formatting the whole feature exists to preserve. Most ATS accept .docx,
 * and parse it more reliably than PDF.
 */
function saveFile(base64, filename, mime) {
  return new Promise((resolve, reject) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/pdf" }));

    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "overwrite" },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          URL.revokeObjectURL(url);
          reject(new Error(chrome.runtime.lastError?.message || "download failed"));
          return;
        }
        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            URL.revokeObjectURL(url);
            chrome.downloads.search({ id: downloadId }, ([item]) => {
              item?.filename
                ? resolve({ diskPath: item.filename, bytes: bytes.length })
                : reject(new Error("download completed but reported no path"));
            });
          } else if (delta.state?.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            URL.revokeObjectURL(url);
            reject(new Error(`download interrupted: ${delta.error?.current || "unknown"}`));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });
  });
}

/**
 * Tailor the user's own .docx and hand back the edited file.
 *
 * The whole job is three calls into docx_edit.js; it lives here rather than in
 * the service worker because parsing WordprocessingML needs DOMParser, which
 * MV3 workers do not have. Same reason this tab exists for PDFs.
 *
 * Returns base64 so it can cross the message boundary, plus the applier's
 * report — how many blocks were rewritten, dropped, or rejected for being too
 * long. That report is the evidence the page-count guarantee held, so it is
 * logged rather than discarded.
 */
async function tailorDocx(base64, edits, overrides, fingerprint) {
  const Z = window.JobCopilotZip, D = window.JobCopilotDocx;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const entries = await Z.read(bytes.buffer);

  // Re-classify rather than trusting an allow-list sent over the wire: the
  // classifier is the thing that knows which paragraphs are employer names and
  // dates, and it costs a few milliseconds to ask it again. An allow-list that
  // arrived stale — from a CV the user has since replaced — would let an edit
  // through onto a block that is no longer what it was.
  const { blocks, fingerprint: actual } = D.readBlocks(entries);

  // The user's own choices, but only if they were made against THIS document.
  // Block ids are positional, so a stale set would unlock whichever paragraph
  // now sits at that index — which could be anything.
  const mine = fingerprint && fingerprint === actual ? overrides : null;
  const allowed = D.allowedIds(blocks, mine);

  const { entries: out, report } = D.applyEdits(entries, edits, allowed);
  const written = await Z.write(out);

  let binary = "";
  for (const b of written) binary += String.fromCharCode(b);
  return { base64: btoa(binary), report };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "jca-render") return;

  (async () => {
    try {
      if (msg.type === "RENDER_DOC") {
        paint(msg.job, msg.packet, msg.mode, msg.profile);
        await settled();
        sendResponse({ ok: true });
      } else if (msg.type === "RENDER_COVER") {
        // The cover letter through the user's chosen template, not through
        // print_doc.js's bare <pre>.
        paintCover(msg.job, msg.packet, msg.profile, msg.language);
        await settled();
        sendResponse({ ok: true });
      } else if (msg.type === "READ_DOCX_BLOCKS") {
        const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
        const entries = await window.JobCopilotZip.read(bytes.buffer);
        const { blocks, fingerprint } = window.JobCopilotDocx.readBlocks(entries);
        sendResponse({ ok: true, blocks, fingerprint,
                       text: window.JobCopilotDocx.extractText(entries) });
      } else if (msg.type === "TAILOR_DOCX") {
        sendResponse({ ok: true, ...(await tailorDocx(
          msg.base64, msg.edits, msg.overrides, msg.fingerprint)) });
      } else if (msg.type === "SAVE_PDF") {
        sendResponse({ ok: true, ...(await savePdf(msg.base64, msg.filename)) });
      } else if (msg.type === "SAVE_FILE") {
        sendResponse({ ok: true, ...(await saveFile(msg.base64, msg.filename, msg.mime)) });
      } else {
        sendResponse({ ok: false, error: `unknown type ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;                     // async sendResponse
});

// Tell docgen.js the surface is live. It waits for this rather than guessing at
// a load delay, because a tab created in the background can be throttled.
chrome.runtime.sendMessage({ type: "RENDER_READY" }).catch(() => {});
