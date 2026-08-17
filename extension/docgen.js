// docgen.js — turns a tailored packet into two real PDFs on disk.
//
// This is the piece that unblocks everything else: an application form wants a
// file, and until now the extension could only ever produce HTML behind a print
// dialog. The whole pipeline reuses print_doc.js unchanged —
//
//   print_doc.build(job, packet)   the exact A4 document the user already sees
//     → hidden tab (render.html)   a surface for the renderer to rasterise
//     → Page.printToPDF            a genuine PDF, no library, no native host
//     → chrome.downloads           an absolute path, which is what CDP needs
//     → Supabase Storage           so the daemon and other devices can fetch it
//
// Results are cached in `apply_documents` keyed by (job_url, kind): re-running
// a job, or resuming one that paused, re-uses the PDFs instead of re-rendering.

import { withDebugger, printToPDF } from "./cdp.js";
import { docxToPdf } from "./pdf_bridge.js";
import {
  getApplyDocuments, recordApplyDocument, uploadApplyDoc,
} from "./supabase.js";

const DOWNLOAD_DIR = "JobCopilot";     // relative to the browser's download dir
const RENDER_TIMEOUT_MS = 20000;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Filesystem-safe, ASCII-ish, and short enough not to trip path limits. */
function slug(s, max = 40) {
  return String(s || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "") // drop diacritics
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max) || "Unknown";
}

/**
 * A readable folder name \u2014 spaces and normal capitals, not a slug.
 *
 * These become directories the user browses in Finder, so "prognum Automotive
 * GmbH" beats "prognum_Automotive_GmbH". Only the characters that are genuinely
 * unsafe in a path are replaced; Chrome sanitises whatever is left.
 *
 * Diacritics are KEPT here, unlike slug(). A German employer called Pr\u00e4zision
 * should appear in Finder as Pr\u00e4zision.
 */
function folderName(s, max = 60) {
  return String(s || "")
    .replace(/[/\\:*?"<>|]+/g, "-")        // illegal in a path on some OS
    .replace(/\.+$/, "")                   // Windows dislikes a trailing dot
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || "Unknown";
}

/**
 * Where this job's documents live on disk.
 *
 *   JobCopilot/<Company>/<YYYY-MM-DD> <Job title>/
 *
 * One folder per application, grouped by employer, so six months later the
 * question "what exactly did I send this company, and when?" has an answer that
 * doesn't involve reading filenames. Everything used to land in one flat
 * directory named by company AND title, which worked but produced a folder of
 * hundreds of long filenames.
 *
 * The date is part of the folder rather than the filename because it dates the
 * APPLICATION, not the file: a re-tailored CV overwrites within the same day's
 * folder, which is what you want, while applying to the same role again next
 * month gets its own.
 */
function applicationDir(job, when = new Date()) {
  const day = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, "0"),
    String(when.getDate()).padStart(2, "0"),
  ].join("-");
  return `${DOWNLOAD_DIR}/${folderName(job.company || "Unknown company")}/` +
         `${day} ${folderName(job.title || "Untitled role", 70)}`;
}

/**
 * Wait for render.html to announce itself.
 *
 * A tab created with `active: false` can be throttled by the browser, so a
 * fixed sleep is a race. render.js posts RENDER_READY once its listener is
 * installed; we listen for it before creating the tab so a fast load can't
 * beat us to it.
 */
function openRenderTab() {
  return new Promise((resolve, reject) => {
    let tabId = null;
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error("render tab never became ready"));
    }, RENDER_TIMEOUT_MS);

    function onReady(msg, sender) {
      if (msg?.type !== "RENDER_READY" || sender.tab?.id !== tabId) return;
      chrome.runtime.onMessage.removeListener(onReady);
      clearTimeout(timer);
      resolve(tabId);
    }
    chrome.runtime.onMessage.addListener(onReady);

    chrome.tabs.create({ url: chrome.runtime.getURL("render.html"), active: false })
      .then((tab) => { tabId = tab.id; })
      .catch((e) => {
        chrome.runtime.onMessage.removeListener(onReady);
        clearTimeout(timer);
        reject(e);
      });
  });
}

async function ask(tabId, message) {
  const resp = await chrome.tabs.sendMessage(tabId, { target: "jca-render", ...message });
  if (!resp?.ok) throw new Error(resp?.error || "render tab returned no result");
  return resp;
}

/**
 * Render one half of the document and land it on disk + in Storage.
 * `kind` is "cv" or "cover_letter".
 */
async function renderOne(tabId, { job, packet, kind, applicantName, tailoredId,
                                  profile, language }) {
  if (kind === "cover_letter") {
    // Through the user's chosen template — letterhead, date, subject line,
    // salutation, sign-off — rather than print_doc.js's bare body text.
    await ask(tabId, { type: "RENDER_COVER", job, packet, profile, language });
  } else {
    await ask(tabId, { type: "RENDER_DOC", job, packet, mode: kind, profile });
  }

  const base64 = await withDebugger(tabId, (cdp) => printToPDF(cdp));

  // The folder carries the company and the role, so the filename no longer has
  // to. It still carries the applicant's name, because this is the file an
  // employer receives and downloads into a directory full of other people's:
  // "Meet Dodiya - CV.pdf" is findable there, "CV.pdf" is not.
  //
  // Two openings at one company used to collide — downloads use
  // conflictAction "overwrite", so applying to the second silently replaced the
  // first one's PDF and the earlier job's recorded disk_path pointed at the
  // wrong file. Distinct folders per role now keep them apart.
  const label = kind === "cv" ? "CV" : "Cover letter";
  const filename = `${applicationDir(job)}/` +
    `${folderName(applicantName, 40)} - ${label}.pdf`;

  const { diskPath, bytes } = await ask(tabId, { type: "SAVE_PDF", base64, filename });
  const storagePath = await uploadApplyDoc(job.url, kind, base64, tailoredId);

  await recordApplyDocument({
    job_url: job.url, kind, storage_path: storagePath,
    disk_path: diskPath, filename: filename.split("/").pop(), bytes,
  });

  return { kind, diskPath, storagePath, bytes };
}

/**
 * Ensure a tailored CV and cover letter exist for this job, and return where
 * they live.
 *
 *   { cv:           { diskPath, storagePath },
 *     cover_letter: { diskPath, storagePath } }
 *
 * `diskPath` is the absolute path DOM.setFileInputFiles needs.
 */
/**
 * Classify a .docx into editable and locked blocks.
 *
 * Exported because tailoring needs the block list BEFORE the model is called —
 * the prompt is built from it — while the applier needs it again afterwards.
 * Parsing happens in the render tab because WordprocessingML needs DOMParser,
 * which an MV3 service worker doesn't have; opening a background tab for a few
 * hundred milliseconds is the price of not shipping an XML parser.
 *
 * Returns { blocks, fingerprint, text } — `text` being the CV as plain prose,
 * which is what the grounding checks compare the model's claims against.
 */
export async function readCvBlocks(base64) {
  const tabId = await openRenderTab();
  try {
    const { blocks, fingerprint, text } =
      await ask(tabId, { type: "READ_DOCX_BLOCKS", base64 });
    return { blocks, fingerprint, text };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/**
 * Tailor the user's own Word CV and land it on disk + in Storage.
 *
 * Runs instead of the CV renderer whenever the user has a .docx on file and
 * the packet came back with edits for it. The output is a .docx, not a PDF,
 * and that is deliberate: nothing available in a browser converts Word to PDF
 * without re-rendering through HTML, which would discard the formatting this
 * whole path exists to keep. Most ATS accept .docx and parse it more reliably
 * than PDF; upload.js has attached arbitrary MIME types since the document
 * library landed.
 */
async function tailorCvDocx(tabId, { job, source, edits, applicantName, tailoredId }) {
  const { base64: docx, report } = await ask(tabId, {
    type: "TAILOR_DOCX", base64: source.base64, edits,
    overrides: source.overrides || null, fingerprint: source.fingerprint || null,
  });

  // The report is the evidence the page-count guarantee held. A rejected edit
  // means the model tried to make a block longer than its budget and the
  // original was kept, which is a quieter failure than it sounds — the CV is
  // simply less tailored there — but it is worth seeing in the log if it starts
  // happening on every run.
  if (report.rejected.length || report.skipped.length) {
    console.warn("docx tailoring held some edits back", report);
  }

  // A PDF if the local converter is running, the Word file if it isn't. The
  // conversion is LibreOffice's, so the PDF is a faithful rendering of the
  // user's own layout rather than an HTML redraw of it — see pdf_bridge.js.
  const pdf = await docxToPdf(docx);
  const base64 = pdf || docx;
  const mime = pdf ? "application/pdf" : DOCX_MIME;
  const ext = pdf ? "pdf" : "docx";

  const filename = `${applicationDir(job)}/` +
    `${folderName(applicantName, 40)} - CV.${ext}`;

  const { diskPath, bytes } = await ask(tabId, {
    type: "SAVE_FILE", base64, filename, mime,
  });
  const storagePath = await uploadApplyDoc(job.url, "cv", base64, tailoredId, mime);

  await recordApplyDocument({
    job_url: job.url, kind: "cv", storage_path: storagePath,
    disk_path: diskPath, filename: filename.split("/").pop(), bytes, mime,
  });

  return { diskPath, storagePath, mime, report, converted: !!pdf };
}

export async function ensureDocuments({ job, packet, applicantName, tailoredId,
                                        profile, language, cvDocx,
                                        force = false }) {
  if (!packet) throw new Error("docgen: no tailored packet for this job");

  const wanted = ["cv"];
  // Only produce a cover letter when the packet actually has one — attaching an
  // empty page is worse than attaching nothing.
  if (packet.cover_letter && String(packet.cover_letter).trim()) wanted.push("cover_letter");

  const have = {};
  if (!force) {
    for (const row of await getApplyDocuments(job.url).catch(() => [])) {
      // A Storage row whose file was deleted off disk (cleared Downloads, moved
      // machine) is only half useful. Re-render rather than hand CDP a path
      // that no longer resolves.
      if (!row.disk_path) continue;
      // And a PDF rendered from a different packet is worse than useless: the
      // cache used to key on (job_url, kind) alone, so re-tailoring a job
      // produced a new packet that no document was ever rendered from, and
      // every later application went out with the CV and cover letter from the
      // first tailoring. Re-rendering costs one hidden tab. Sending last week's
      // letter costs the application.
      if (!isCurrent(row, tailoredId)) continue;
      have[row.kind] = { diskPath: row.disk_path, storagePath: row.storage_path };
    }
  }

  const missing = wanted.filter((k) => !have[k]);
  if (!missing.length) return have;

  // Does this user have their own Word CV, and did the model return edits for
  // it? Both have to hold. A packet with no cv_edits is one tailored down the
  // JSON path, and applying nothing to a .docx would attach an untailored CV
  // while reporting success.
  const useDocx = !!(cvDocx && cvDocx.base64 && packet.cv_edits &&
                     Object.keys(packet.cv_edits).length);

  const tabId = await openRenderTab();
  try {
    for (const kind of missing) {
      if (kind === "cv" && useDocx) {
        have.cv = await tailorCvDocx(tabId, {
          job, source: cvDocx, edits: packet.cv_edits, applicantName, tailoredId,
        });
        continue;
      }
      const out = await renderOne(tabId, {
        job, packet, kind, applicantName, tailoredId, profile, language,
      });
      have[kind] = { diskPath: out.diskPath, storagePath: out.storagePath };
    }
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
  return have;
}

/**
 * Was this stored document rendered from the packet we are about to apply with?
 *
 * uploadApplyDoc writes the tailored_results id into the object path, so the
 * row answers this itself. A document stored before that — or one whose packet
 * we can't identify — is treated as stale, because "probably still current" is
 * not a good enough reason to attach a CV to someone's application.
 */
function isCurrent(row, tailoredId) {
  return !!tailoredId && String(row.storage_path || "").includes(tailoredId);
}

/**
 * Confirm a recorded disk path still exists.
 *
 * chrome.downloads is the only way to ask, and it can only answer about files
 * it created — which is fine, because every path we hand out came from there.
 */
export function diskPathStillExists(diskPath) {
  return new Promise((resolve) => {
    chrome.downloads.search({ filenameRegex: escapeForRegex(diskPath), exists: true },
      (items) => resolve(items.some((i) => i.filename === diskPath && i.exists)));
  });
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
