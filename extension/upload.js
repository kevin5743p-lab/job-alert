// upload.js — attaching a generated PDF to an application form.
//
// Two paths, cheapest first.
//
//   A. DataTransfer (Tier 0). The content script builds a File from the PDF's
//      bytes, assigns it to `input.files`, and fires `change`. This is what an
//      ordinary ATS form needs, and it means the debugger is never attached on
//      the sites that make up most of the queue.
//
//   B. DOM.setFileInputFiles (Tier 1, or when A doesn't take). CDP hands the
//      browser process an absolute path and it reads the file the same way it
//      would after a file picker. Needed where a widget won't accept a
//      synthesised File, and it's why docgen.js writes to disk as well as to
//      Storage.
//
// Both paths verify afterwards by reading `input.files` back. A silent no-op
// here is the worst failure mode available: the form looks filled, the run
// looks clean, and the employer receives an application with no CV attached.

import { withDebugger, setFileInputFiles } from "./cdp.js";
import { downloadApplyDoc } from "./supabase.js";

// Storage path -> base64. One download per document per service-worker life;
// a multi-page form asks for the same CV on more than one step.
const bytesCache = new Map();

async function docBytes(storagePath) {
  if (!bytesCache.has(storagePath)) {
    bytesCache.set(storagePath, await downloadApplyDoc(storagePath));
  }
  return bytesCache.get(storagePath);
}

export function clearDocCache() { bytesCache.clear(); }

/** Ask the page whether the input actually holds a file now. */
async function verify(tabId, jcaId) {
  const resp = await chrome.tabs.sendMessage(tabId, {
    target: "jca-engine", type: "FILE_STATE", jcaId,
  }).catch(() => null);
  return { attached: !!resp?.attached, name: resp?.name || null };
}

/**
 * Attach `doc` to the file input identified by `jcaId`.
 *
 * `doc` is one entry from docgen.ensureDocuments() — { diskPath, storagePath } —
 * or one from the user's own library, which has { storagePath, filename } and
 * no local copy.
 *
 * Returns { path: "datatransfer" | "cdp", name } or throws.
 */
export async function attachDocument(tabId, { jcaId, doc, tier = 0, filename }) {
  if (!doc) throw new Error(`upload: no document to attach for ${jcaId}`);

  const name = filename || doc.filename ||
               doc.diskPath?.split("/").pop() || "document.pdf";
  const errors = [];

  // ── Path A ────────────────────────────────────────────────────────────────
  // Normally skipped on Tier 1 — not because it fails there, but because those
  // forms are the ones with custom widgets that inspect the file, and doing the
  // round trip twice on every upload is wasted time.
  //
  // The exception is a document from the user's library: it was uploaded from
  // their machine straight to Storage and was never rendered locally, so there
  // is no disk path for Path B to hand to CDP. For those this is the only path
  // there is, whatever the tier.
  if (doc.storagePath && (tier === 0 || !doc.diskPath)) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        target: "jca-engine", type: "ATTACH_FILE",
        jcaId, name, mime: doc.mime || "application/pdf",
        base64: await docBytes(doc.storagePath),
      });
      if (resp?.ok) {
        const state = await verify(tabId, jcaId);
        if (state.attached) return { path: "datatransfer", name: state.name };
        errors.push("DataTransfer reported success but the input stayed empty");
      } else {
        errors.push(resp?.error || "content script declined");
      }
    } catch (e) {
      errors.push(`datatransfer: ${e.message}`);
    }
  }

  // ── Path B ────────────────────────────────────────────────────────────────
  if (doc.diskPath) {
    try {
      await withDebugger(tabId, (cdp) => setFileInputFiles(cdp, jcaId, [doc.diskPath]));
      const state = await verify(tabId, jcaId);
      if (state.attached) return { path: "cdp", name: state.name };
      errors.push("setFileInputFiles ran but the input stayed empty");
    } catch (e) {
      errors.push(`cdp: ${e.message}`);
    }
  }

  throw new Error(`upload failed for ${jcaId} — ${errors.join("; ")}`);
}

/**
 * Decide which generated document each file input on the page wants.
 *
 * `fileInputs` is autofill's report.files; `docs` is docgen's output. Returns
 * one plan entry per input we can satisfy, plus the ones we can't so the
 * confidence gate can refuse to submit rather than quietly leaving a required
 * upload empty.
 */
export function planUploads(fileInputs = [], docs = {}) {
  const plan = [];
  const unmet = [];

  for (const f of fileInputs) {
    if (f.attached) continue;                 // already has something; leave it

    // An unclassified input on a form that also has a clearly-labelled CV slot
    // is something else — a portfolio, a certificate, an ID scan. Guessing "CV"
    // there would attach the wrong document to a labelled field.
    const kind = f.kind;
    const doc = kind && docs[kind];

    if (doc) plan.push({ jcaId: f.id, kind, doc, label: f.label });
    else if (f.required) {
      unmet.push({
        jcaId: f.id, label: f.label,
        reason: kind ? `no generated ${kind} to attach`
                     : "required upload we can't identify",
      });
    }
  }
  return { plan, unmet };
}
