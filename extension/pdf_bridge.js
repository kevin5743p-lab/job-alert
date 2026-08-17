// pdf_bridge.js — turning the tailored .docx into a PDF, faithfully.
//
// THE PROBLEM. Editing the user's own Word file preserves their layout exactly
// (see docx_edit.js), but most application forms want a PDF. Nothing available
// inside a browser can convert one to the other without losing the very thing
// the edit-in-place approach exists to keep: every JavaScript converter —
// mammoth, docx-preview and the rest — re-renders the document through HTML and
// CSS, which is a different layout engine that has never seen the user's
// template. Margins move, tables reflow, a one-page CV becomes two, and the
// photo lands somewhere else. That is not a conversion, it is a redraw.
//
// THE ANSWER. Convert with something that genuinely understands Word documents,
// and the only such thing that is free, offline and installable is LibreOffice.
// It runs on the user's own machine — which is where this extension already
// runs — behind a tiny local server (see tools/docx2pdf.py). We POST the .docx
// to 127.0.0.1 and get a PDF back rendered by a real word processor.
//
// WHY LOCAL RATHER THAN A CLOUD API. CloudConvert and friends would work and
// need no install, but a CV is the single most personal document a person owns
// and this would send every version of it, for every application, to a third
// party. A localhost round trip sends it nowhere. It is also free and has no
// daily cap, which matters when the whole point is applying to a lot of jobs.
//
// IT IS ALWAYS OPTIONAL. If LibreOffice isn't installed, or the helper isn't
// running, this returns null and docgen attaches the .docx instead. Greenhouse,
// Lever, Ashby, Personio and SmartRecruiters all accept Word files, and their
// parsers generally read them better than PDFs. Nothing breaks; the user simply
// sends a .docx that day. An application must never fail because a convenience
// was unavailable.

// callFunction() is JSON-only and this sends raw bytes, so the URL and the
// session are taken directly rather than reusing it.
import { FUNCTIONS_URL, SUPABASE_ANON_KEY, getSession } from "./supabase.js";

const BRIDGE = "http://127.0.0.1:8765";
const CONVERT_TIMEOUT_MS = 25000;
const PING_TIMEOUT_MS = 1200;
// The hosted converter does the same work on a bigger machine, but a cold
// container has to start LibreOffice first, so it gets longer.
const HOSTED_TIMEOUT_MS = 60000;

// Remembered for the life of the service worker. Probing costs a round trip and
// the answer doesn't change mid-session; without this every document would pay
// the timeout again on a machine that has no helper running.
let available = null;

/** Forget the cached probe — called when the user changes the setting. */
export function resetBridge() { available = null; }

async function withTimeout(promise, ms) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await promise(control.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the converter running?
 *
 * A short timeout on purpose. When nothing is listening on the port the fetch
 * fails immediately, but a machine with a firewall prompt or a stalled helper
 * can hang, and the user is waiting on an application.
 */
export async function bridgeAvailable() {
  if (available !== null) return available;
  try {
    const resp = await withTimeout(
      (signal) => fetch(`${BRIDGE}/health`, { signal }), PING_TIMEOUT_MS);
    // The body matters, not just the status. The helper answers 200 with
    // "no-libreoffice" when it is running but has nothing to convert with —
    // it stays up so the user gets that message rather than a dead port. A
    // status-only check would read that as success and pay a full upload and a
    // 500 for every document before falling back.
    available = resp.ok && (await resp.text()).trim() === "ok";
  } catch {
    available = false;
  }
  return available;
}

/**
 * Convert a .docx (base64) to a PDF (base64), or null if that isn't possible.
 *
 * Never throws. Every failure here — helper absent, LibreOffice missing,
 * conversion crashed, timeout — has the same correct response: fall back to
 * attaching the Word file. Turning any of them into an exception would let a
 * missing optional dependency abort a real application.
 */
export async function docxToPdf(base64) {
  // Local first. It is free, it is instant, and the document never leaves the
  // machine — but almost nobody has it, so the probe has to be cheap. It is:
  // nothing listening on a loopback port refuses the connection immediately
  // rather than timing out, and the answer is cached for the life of the worker.
  const local = await localConvert(base64);
  if (local) return local;

  // Then the hosted converter, which is the path every ordinary user takes.
  return hostedConvert(base64);
}

async function localConvert(base64) {
  if (!(await bridgeAvailable())) return null;

  try {
    const resp = await withTimeout((signal) => fetch(`${BRIDGE}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      signal,
    }), CONVERT_TIMEOUT_MS);

    if (!resp.ok) {
      console.warn(`pdf_bridge: converter returned ${resp.status}`,
                   await resp.text().catch(() => ""));
      return null;
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());
    // Checking costs nothing and catches the case where the helper returns an
    // error page with a 200, which would otherwise be attached to an
    // application as a "CV".
    if (!looksLikePdf(bytes)) {
      console.warn("pdf_bridge: local response was not a PDF, keeping the .docx");
      return null;
    }
    return toBase64(bytes);
  } catch (e) {
    // An abort lands here too, which is why this is a warning and not an error.
    console.warn("pdf_bridge: local conversion unavailable:", e?.message || e);
    available = null;               // re-probe next time; it may have restarted
    return null;
  }
}

/**
 * The hosted converter — the one that means users install nothing.
 *
 * Goes through the docx-to-pdf edge function rather than straight at the
 * converter, for the same reason model calls go through ai-proxy: the endpoint
 * we pay for is not something to leave open to the internet, and the request
 * has to be attributable to a signed-in user before it costs us anything.
 *
 * Returns null on every failure. Not signed in, converter not deployed, daily
 * cap reached, cold start too slow — all of them mean the same thing here, and
 * it is never "abandon the application": the .docx is attached instead and the
 * user is none the wiser.
 */
async function hostedConvert(base64) {
  let session;
  try {
    session = await getSession();
  } catch {
    return null;
  }
  if (!session?.access_token) return null;      // signed out: nothing to bill

  try {
    const resp = await withTimeout((signal) => fetch(`${FUNCTIONS_URL}/docx-to-pdf`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/octet-stream",
      },
      body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      signal,
    }), HOSTED_TIMEOUT_MS);

    if (!resp.ok) {
      // 503 not_configured is the ordinary state before the converter is
      // deployed, so it is not worth shouting about on every document.
      const detail = await resp.text().catch(() => "");
      if (resp.status !== 503) {
        console.warn(`pdf_bridge: hosted converter ${resp.status}`, detail.slice(0, 200));
      }
      return null;
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (!looksLikePdf(bytes)) {
      console.warn("pdf_bridge: hosted response was not a PDF, keeping the .docx");
      return null;
    }
    return toBase64(bytes);
  } catch (e) {
    console.warn("pdf_bridge: hosted conversion unavailable:", e?.message || e);
    return null;
  }
}

/** A PDF starts with %PDF-. Cheap, and it catches an error page returned as 200. */
function looksLikePdf(bytes) {
  return bytes.length >= 5 &&
         String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
