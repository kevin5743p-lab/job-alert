// cdp.js — a thin, deliberately narrow wrapper over chrome.debugger.
//
// WHY THIS EXISTS
//
// Three things an application form needs are impossible from a content script:
//
//   1. Real key and mouse events. A content script's synthesised events don't
//      drive every widget: comboboxes, tag inputs, and anything with a
//      keystroke-driven filter listen for genuine keydown/keyup, and a
//      dispatched event won't move them. `Input.dispatchKeyEvent` produces the
//      real thing, so those controls behave the way they do for a person.
//   2. Real file attachment. `DOM.setFileInputFiles` attaches a file from an
//      absolute disk path — a genuine attachment, not a synthesised
//      DataTransfer that a strict site can refuse.
//   3. PDF rendering. `Page.printToPDF` turns print_doc.js's HTML into a real
//      PDF with no library, no native host, and no print dialog.
//
// ── SCOPE: Input, DOM, Page. Nothing else. ──────────────────────────────────
//
// We hold the debugger over a page we are filling in on the user's behalf, so
// the surface is kept as small as the job allows.
//
// In particular, never enable the Runtime (or Console / Log / Debugger)
// domains. Enabling Runtime switches on console-argument serialisation: the
// inspector starts routing everything the page logs through the error
// formatting path so it can cross the protocol boundary. That perturbs the very
// page we are trying to observe — getters fire that otherwise wouldn't, and
// pages with chatty logging pay for it on every call — and we get nothing from
// it, because the DOM reading happens in the content script where it belongs.
//
// A one-off `Runtime.evaluate` is fine; it doesn't enable the domain. To keep
// the distinction from eroding the first time someone is debugging something at
// 1am, the sender below rejects the enables outright rather than relying on
// everyone remembering.
//
// We also attach as late as possible and detach in a `finally`, so the debugger
// is held for as little time as possible and a thrown error can't leave the
// infobar stuck across the user's browser.

/** Domains whose `.enable` turns on console interception. Never send these. */
const FORBIDDEN = new Set([
  "Runtime.enable",
  "Console.enable",
  "Log.enable",
  "Debugger.enable",
  "Profiler.enable",
  "HeapProfiler.enable",
]);

const PROTOCOL_VERSION = "1.3";

/** tabId -> refcount, so nested/parallel uses on one tab don't fight. */
const attached = new Map();

/**
 * Send one CDP command. Rejects rather than resolving on protocol errors, so
 * callers can use ordinary try/catch.
 */
export function send(tabId, method, params = {}) {
  if (FORBIDDEN.has(method)) {
    // A throw rather than a warning: this is the sort of line that gets added
    // "just to debug something" and then stays.
    return Promise.reject(new Error(
      `cdp: refusing to send ${method}. Enabling this domain turns on console ` +
      `interception, which perturbs the page we're filling in and buys us ` +
      `nothing. Read the DOM from the content script, or use a one-off ` +
      `Runtime.evaluate.`));
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}

async function attach(tabId) {
  const n = attached.get(tabId) || 0;
  if (n === 0) {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        // Another client (a real DevTools window, usually) already owns this
        // tab. Surface it plainly — the caller falls back to the DOM path.
        if (err) reject(new Error(`debugger.attach: ${err.message}`));
        else resolve();
      });
    });
  }
  attached.set(tabId, n + 1);
}

async function detach(tabId) {
  const n = (attached.get(tabId) || 1) - 1;
  if (n > 0) { attached.set(tabId, n); return; }
  attached.delete(tabId);
  await new Promise((resolve) => {
    // Swallow errors: the tab may already be gone, which is not a failure.
    chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
  });
}

/**
 * Run `fn` with the debugger attached, and detach no matter how it ends.
 *
 *   const pdf = await withDebugger(tabId, (cdp) =>
 *     cdp("Page.printToPDF", { printBackground: true }));
 *
 * `fn` receives a bound sender so call sites stay short.
 */
export async function withDebugger(tabId, fn) {
  await attach(tabId);
  try {
    return await fn((method, params) => send(tabId, method, params));
  } finally {
    await detach(tabId);
  }
}

/** True when we currently hold the debugger on this tab. */
export function isAttached(tabId) {
  return attached.has(tabId);
}

// If Chrome detaches us (tab closed, DevTools opened, user dismissed the
// infobar), drop our bookkeeping so the next attach starts clean.
chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (tabId != null) attached.delete(tabId);
});

// ── DOM helpers ─────────────────────────────────────────────────────────────
// Elements are addressed by the `data-jca-id` attribute that apply_engine.js
// stamps on everything it serialises. That keeps one stable identifier shared
// between the content script, the model, and CDP — no selector guessing.

/**
 * Quote a value for use inside an attribute selector.
 *
 * NOT `CSS.escape`. This file runs in the service worker, and `CSS` is a Window
 * interface — it does not exist in ServiceWorkerGlobalScope. Calling it here
 * threw `CSS is not defined` on every CDP upload, which surfaced to the user as
 * "upload failed for u2 — cdp: CSS is not defined": a fault of ours, reported as
 * if the application needed their help.
 *
 * A quoted attribute value only needs its backslashes and its closing quote
 * escaped, which is the whole job here — apply_engine mints these ids itself as
 * `prefix + counter`, so there is nothing exotic to handle.
 */
function quoteAttrValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Resolve a data-jca-id to a CDP nodeId. Returns null when not found.
 *
 * Two lookups, and the second is the one that matters on real sites.
 *
 * `DOM.querySelector` from the root searches the top document ONLY. It does not
 * cross into an iframe, and an employer embedding Greenhouse or SmartRecruiters
 * puts the entire form — the file input included — inside one. So the CV upload
 * would find nothing, report "no element for u2", and the run would stop on a
 * form that was sitting right there.
 *
 * `DOM.performSearch` searches every document in the tab, iframes included,
 * which is what "find the element the content script tagged" actually means
 * here. It is kept second because it allocates a search result set that has to
 * be discarded, and the plain path covers the single-frame majority.
 */
export async function nodeForId(cdp, jcaId) {
  const selector = `[data-jca-id="${quoteAttrValue(jcaId)}"]`;

  // Populates the node map that both lookups below depend on.
  const { root } = await cdp("DOM.getDocument", { depth: 1 });

  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (nodeId) return nodeId;     // CDP returns 0 for "no match"

  let searchId = null;
  try {
    const search = await cdp("DOM.performSearch", {
      query: selector, includeUserAgentShadowDOM: true,
    });
    searchId = search?.searchId;
    if (!searchId || !search.resultCount) return null;

    const { nodeIds } = await cdp("DOM.getSearchResults", {
      searchId, fromIndex: 0, toIndex: 1,
    });
    return nodeIds?.[0] || null;
  } catch {
    return null;                 // older protocol, or the node went away
  } finally {
    if (searchId) {
      await cdp("DOM.discardSearchResults", { searchId }).catch(() => {});
    }
  }
}

/**
 * Attach real files to an <input type=file>.
 *
 * `paths` are ABSOLUTE local paths — this is why docgen.js writes the PDFs to
 * disk as well as to Supabase Storage. CDP hands the paths to the browser
 * process, which reads them the same way it would after a file picker.
 */
export async function setFileInputFiles(cdp, jcaId, paths) {
  const nodeId = await nodeForId(cdp, jcaId);
  if (nodeId) {
    await cdp("DOM.setFileInputFiles", { nodeId, files: paths });
    return;
  }

  // Shadow DOM, most likely.
  //
  // Both lookups above are CSS-selector searches over the DOM tree, and a file
  // input that lives inside a web component's shadow root is not reliably in
  // it. SAP's application wizard is built that way — several hundred shadow
  // roots on one page — so on those forms the upload had no element to attach
  // to at all.
  //
  // Runtime.evaluate has no such blind spot: the expression runs in the page
  // and can walk the roots itself, and DOM.setFileInputFiles takes an objectId
  // just as happily as a nodeId. Second rather than first only because it
  // allocates a remote object that has to be released.
  const selector = `[data-jca-id="${quoteAttrValue(jcaId)}"]`;
  const expression = `(() => {
    const find = (root, depth) => {
      if (!root || depth > 10) return null;
      const hit = root.querySelector(${JSON.stringify(selector)});
      if (hit) return hit;
      for (const el of root.querySelectorAll("*")) {
        if (!el.shadowRoot) continue;
        const deep = find(el.shadowRoot, depth + 1);
        if (deep) return deep;
      }
      return null;
    };
    return find(document, 0);
  })()`;

  let objectId = null;
  try {
    const { result } = await cdp("Runtime.evaluate", { expression });
    objectId = result?.objectId || null;
    if (!objectId) throw new Error(`setFileInputFiles: no element for ${jcaId}`);
    await cdp("DOM.setFileInputFiles", { objectId, files: paths });
  } finally {
    if (objectId) {
      await cdp("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}

/** Render the current page to a PDF. Returns base64. */
export async function printToPDF(cdp, opts = {}) {
  const { data } = await cdp("Page.printToPDF", {
    printBackground: true,
    paperWidth: 8.27,            // A4 in inches
    paperHeight: 11.69,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    preferCSSPageSize: true,     // honour print_doc.js's `@page { size: A4 }`
    ...opts,
  });
  return data;
}

/** Screenshot the viewport. Returns base64 PNG. Used when a run pauses. */
export async function captureScreenshot(cdp) {
  const { data } = await cdp("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false,
  });
  return data;
}

// ── Trusted input ───────────────────────────────────────────────────────────
// Low-level primitives only: each function emits one event. Nothing here
// decides when or how often to act — that's the actuator's job, and the pacing
// between whole applications is domain_health.js's.

export function mouseMove(cdp, x, y) {
  return cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0,
    pointerType: "mouse",
  });
}

export async function mouseClick(cdp, x, y) {
  const base = { x, y, button: "left", buttons: 1, clickCount: 1,
                 pointerType: "mouse" };
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
}

/**
 * Type one character as a real key press.
 *
 * `Input.insertText` would be one call instead of three, but it produces no
 * keydown/keyup — and plenty of ATS widgets (comboboxes, tag inputs, anything
 * with a keystroke-driven filter) only react to those. Doing it properly also
 * means the keystroke rhythm evasion.js generates is actually observable,
 * which is the point.
 */
export async function typeChar(cdp, ch) {
  const common = { text: ch, unmodifiedText: ch, key: ch };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await cdp("Input.dispatchKeyEvent", { type: "char", ...common });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Named keys: Backspace, Tab, Enter, Escape. */
export async function pressKey(cdp, key) {
  const map = {
    Backspace: { windowsVirtualKeyCode: 8,  code: "Backspace" },
    Tab:       { windowsVirtualKeyCode: 9,  code: "Tab" },
    Enter:     { windowsVirtualKeyCode: 13, code: "Enter", text: "\r" },
    Escape:    { windowsVirtualKeyCode: 27, code: "Escape" },
  };
  const spec = map[key];
  if (!spec) throw new Error(`pressKey: unsupported key ${key}`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key, ...spec });
  if (spec.text) await cdp("Input.dispatchKeyEvent", { type: "char", key, ...spec });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, ...spec });
}

/** Wheel scroll at a point, in CSS pixels. */
export function scrollBy(cdp, x, y, deltaY) {
  return cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: 0, deltaY,
    button: "none", buttons: 0, pointerType: "mouse",
  });
}
