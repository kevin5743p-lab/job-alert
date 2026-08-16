// apply_engine.js — the page half of the apply loop.
//
// Two jobs:
//
//   OBSERVE   Turn the live DOM into a compact JSON description of the form —
//             roughly 1–3K tokens instead of the ~200K a raw innerHTML would
//             cost. The model reasons about labels and questions, which are the
//             stable part of an ATS; class names and markup are not.
//
//   ACT       Carry out one instruction against a stable element id.
//
// A plain (non-module) content script, like autofill.js, and it builds on it
// rather than duplicating: field labelling, the blocked-field list, and the
// profile matching all stay in autofill.js as the single implementation.
//
// Element identity is a `data-jca-id` attribute stamped on anything we
// serialise. One name, shared by the content script, the model, and CDP — so
// nothing anywhere has to re-derive a selector and hope it still matches.

(function () {
  // ── one engine per frame, no matter how we got here ───────────────────────
  //
  // This file arrives two ways: the manifest's content_scripts on a matched
  // host, and chrome.scripting.executeScript from ensureEngine — which now
  // injects into every frame, because the application is so often in an embed.
  // Both land in the same isolated world, so on a matched host the second copy
  // can see the first.
  //
  // Two live copies is not harmless duplication. Each registers its own
  // onMessage listener and both call sendResponse for the same message, and
  // `seq` below restarts at 0 while the data-jca-id attributes from the first
  // copy are still on the elements — so a freshly stamped `f1` collides with an
  // older, different `f1`. The model is then shown one element and acts on
  // another.
  if (window.JobCopilotApplyEngine) return;

  const A = window.JobCopilotAutofill;
  const MAX_LABEL = 160;
  const MAX_OPTIONS = 25;
  const MAX_FIELDS = 120;

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n = MAX_LABEL) => norm(s).slice(0, n);

  let seq = 0;
  function id(el, prefix) {
    if (!el.dataset.jcaId) el.dataset.jcaId = `${prefix}${++seq}`;
    return el.dataset.jcaId;
  }
  // Ambiguity is treated as "not found" on purpose. If two elements ever carry
  // the same id — the double-injection case above, or a form that re-mounted
  // while we were reading it — acting on `[0]` silently fills the wrong box,
  // and the run looks like it worked. A visible "no element" error is the
  // better failure: the model retries, and the step log records it.
  const byId = (jcaId) => {
    const all = document.querySelectorAll(`[data-jca-id="${CSS.escape(jcaId)}"]`);
    return all.length === 1 ? all[0] : null;
  };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The question a control is asking, using autofill's labeller. */
  function labelFor(el) {
    return clip(A?.fieldLabel?.(el) || el.getAttribute("aria-label") ||
                el.placeholder || el.name || "");
  }

  // ── consent ───────────────────────────────────────────────────────────────
  //
  // Consent is a decision, not data entry, and the engine never makes it. These
  // are surfaced so the confidence gate can refuse to submit rather than tick
  // a box on the user's behalf and hope they meant it.
  const CONSENT_RE = new RegExp([
    "consent", "agree", "terms", "privacy", "policy",
    "datenschutz", "einwillig", "zustimm", "akzeptier",
    "gdpr", "dsgvo",
    "background ?check", "newsletter", "marketing", "subscribe",
  ].join("|"), "i");

  function isConsent(el, label) {
    return CONSENT_RE.test(`${label} ${el.name || ""} ${el.id || ""}`);
  }

  // ── buttons ───────────────────────────────────────────────────────────────
  //
  // The submit/next distinction is load-bearing: the confidence gate blocks a
  // submit but not a "Next", and getting that backwards either strands every
  // multi-page form on page 1 or lets an unchecked application go out.
  const SUBMIT_RE   = /^(submit|apply|send|absenden|bewerbung abschicken|senden|finish|complete|bewerben)\b/i;
  const NEXT_RE     = /^(next|continue|weiter|save and continue|proceed|forward|nächste)\b/i;
  const BACK_RE     = /^(back|previous|zurück|prev)\b/i;
  const DISMISS_RE  = /^(cancel|close|abbrechen|schließen|dismiss|not now|later|save (and )?exit|save draft)\b/i;

  /**
   * `onForm` matters: an "Apply" button on a job *listing* opens the form, it
   * doesn't send anything. Classifying it as a submit would drive it into the
   * confidence gate, which would correctly find the (non-existent) form
   * incomplete and pause the run before it ever started. A button only submits
   * if there is something on this page to submit.
   */
  function buttonKind(text, el, onForm) {
    if (BACK_RE.test(text)) return "back";
    if (DISMISS_RE.test(text)) return "dismiss";
    if (NEXT_RE.test(text)) return "next";
    if (!onForm) return "open";                 // navigation, not submission
    if (SUBMIT_RE.test(text)) return "submit";
    if ((el.type || "").toLowerCase() === "submit") return "submit";
    return "other";
  }

  // A link that is really an application control. Plenty of postings render
  // "Apply" as an <a> — an off-site apply on a job board is a link by nature —
  // and the old selector only caught `a.btn`, so on those pages the one control
  // that mattered was the one the model was never shown. Matching on the text
  // rather than on markup keeps the ordinary navigation out of the list.
  const LINK_ACTION_RE =
    /\b(apply|bewerb|bewerbung|application|submit|absenden|weiter|continue|next)\b/i;

  const MAX_BUTTONS = 40;

  function collectButtons(onForm) {
    const sel = 'button, input[type="submit"], input[type="button"], [role="button"], ' +
                'a.btn, a[href]';
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!visible(el) || el.disabled) return;
      const text = clip(el.innerText || el.value || el.getAttribute("aria-label") || "", 60);
      if (!text) return;

      // Anchors are only interesting when they read like an application
      // control. Without this, a site's header and footer alone would fill the
      // list before the page's own content got a look in.
      const isPlainLink = el.tagName === "A" && !el.classList.contains("btn");
      if (isPlainLink && !LINK_ACTION_RE.test(text)) return;

      const entry = {
        id: id(el, "b"),
        text,
        kind: buttonKind(text, el, onForm),
        primary: /primary|submit|cta/i.test(el.className || ""),
      };
      // Where a link actually goes. An off-site apply is an anchor with
      // target="_blank", so this is both the "does this leave the site" signal
      // and the destination to fall back to if the click opens no new tab.
      if (el.tagName === "A" && el.href) {
        entry.href = clip(el.href, 300);
        if (el.target === "_blank") entry.opensNewTab = true;
      }
      out.push(entry);
    });

    // The cap used to cut in DOM order, which on a page with a long header
    // meant the submit button could be the one dropped. Rank the controls that
    // move an application forward above the rest before trimming.
    const rank = (b) =>
      (b.kind === "submit" || b.kind === "next" ? 0 :
       b.kind === "open" && LINK_ACTION_RE.test(b.text) ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_BUTTONS);
  }

  // ── validation errors ─────────────────────────────────────────────────────
  function collectErrors() {
    const out = new Set();
    document.querySelectorAll(
      '[role="alert"], [aria-invalid="true"], .error, .is-invalid, .invalid-feedback, ' +
      '[class*="error-message"], [class*="errorMessage"], [class*="field-error"]'
    ).forEach((el) => {
      if (!visible(el)) return;
      const t = clip(el.innerText || el.getAttribute("aria-label") || "", 140);
      // aria-invalid lands on the input itself, whose innerText is empty —
      // reach for the message the field points at instead.
      if (t) { out.add(t); return; }
      const described = el.getAttribute("aria-describedby");
      if (described) {
        described.split(/\s+/).forEach((refId) => {
          const m = document.getElementById(refId);
          if (m && visible(m)) { const mt = clip(m.innerText, 140); if (mt) out.add(mt); }
        });
      }
    });
    return [...out].slice(0, 15);
  }

  // ── step indicator ────────────────────────────────────────────────────────
  // Multi-page ATS flows almost always say where you are. Feeding that back
  // lets the loop tell "the Next click worked" from "the page re-rendered with
  // errors", which is otherwise surprisingly hard to see.
  function stepIndicator() {
    const m = document.body.innerText?.match(
      /\b(?:step|page|schritt|seite)\s+(\d+)\s*(?:of|von|\/)\s*(\d+)/i);
    if (m) return `Step ${m[1]} of ${m[2]}`;
    const cur = document.querySelector('[aria-current="step"], [aria-current="page"]');
    return cur ? clip(cur.innerText, 60) : null;
  }

  // ── fields, choices, consent ──────────────────────────────────────────────

  function collectFields() {
    const out = [];
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      if (out.length >= MAX_FIELDS) return;
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file",
           "checkbox", "radio"].includes(type)) return;
      if (!visible(el) || el.disabled || el.readOnly) return;

      const label = labelFor(el);
      // autofill's BLOCKED list — passwords, government IDs, financial details.
      // Not serialised at all: the model is never shown a field it must not
      // touch, rather than being told not to touch it.
      if (A?.isBlockedField?.(el)) {
        out.push({ id: id(el, "f"), label, type, blocked: true, value: "" });
        return;
      }

      const f = {
        id: id(el, "f"),
        label,
        type: el.tagName === "TEXTAREA" ? "textarea" : (el.tagName === "SELECT" ? "select" : type),
        required: el.required || el.getAttribute("aria-required") === "true",
        value: clip(el.value, 120),
      };
      if (el.tagName === "SELECT") {
        f.options = [...el.options].map((o) => clip(o.text, 60))
          .filter(Boolean).slice(0, MAX_OPTIONS);
      }
      if (el.maxLength > 0) f.maxLength = el.maxLength;
      out.push(f);
    });
    return out;
  }

  /** Radio groups and standalone checkboxes, split into answers vs consent. */
  function collectChoices() {
    const choices = [];
    const consent = [];
    const seenGroup = new Set();

    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .forEach((el) => {
        if (!visible(el) || el.disabled) return;
        const label = labelFor(el) || clip(el.closest("label")?.innerText || "");

        if (el.type === "checkbox" && isConsent(el, label)) {
          consent.push({
            id: id(el, "k"), text: label, checked: el.checked,
            required: el.required || el.getAttribute("aria-required") === "true",
          });
          return;
        }

        if (el.type === "radio") {
          const group = el.name || label;
          if (seenGroup.has(group)) return;
          seenGroup.add(group);
          const peers = [...document.querySelectorAll(
            `input[type="radio"][name="${CSS.escape(el.name || "")}"]`)];
          const question = clip(A?.groupQuestion?.(el) || group);
          choices.push({
            id: id(el, "c"),
            question,
            type: "radio",
            options: peers.map((p) => ({
              id: id(p, "o"),
              text: clip(labelFor(p) || p.value, 80),
              selected: p.checked,
            })).slice(0, MAX_OPTIONS),
            selected: peers.find((p) => p.checked) ? true : null,
          });
        } else {
          choices.push({
            id: id(el, "c"), question: label, type: "checkbox",
            selected: el.checked,
            required: el.required,
          });
        }
      });
    return { choices, consent };
  }

  /** The whole page as the model sees it. */
  function observe() {
    const { choices, consent } = collectChoices();
    // `isForm` decides whether a control called "Apply" is understood to SEND
    // an application, so it stays strict. `isFillable` decides whether the free
    // rule-based pass is worth running, and is deliberately looser — a Lever
    // quick-apply is three controls and a dropzone. See autofill.js.
    const isForm = !!A?.findForm?.();
    const isFillable = A?.looksFillable ? !!A.looksFillable() : isForm;
    return {
      url: location.href,
      title: clip(document.title, 120),
      step: stepIndicator(),
      isForm,
      isFillable,
      fields: collectFields(),
      choices,
      consent,
      files: A?.collectFileInputs?.() || [],
      buttons: collectButtons(isForm),
      errors: collectErrors(),
      // For domain_health.detectBlockSignal. Bounded hard — this is a smoke
      // detector, not content, and a challenge page is tiny anyway.
      text: clip(document.body?.innerText || "", 2500),
      html: (document.head?.innerHTML || "").slice(0, 4000),
    };
  }

  // ── acting ────────────────────────────────────────────────────────────────

  function fire(el, ...types) {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
  }

  /**
   * Set a value the way a framework will notice.
   *
   * React tracks the last value it wrote on the DOM node and skips its onChange
   * when `el.value = x` leaves that tracker untouched — the field looks filled
   * and the component's state is still empty. Going through the native setter
   * is what makes the change real.
   */
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    setter ? setter.call(el, value) : (el.value = value);
    fire(el, "input", "change");
    el.blur();
  }

  function act(action) {
    const el = byId(action.jcaId);
    if (!el) return { ok: false, error: `no element ${action.jcaId}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });

    switch (action.type) {
      case "CLICK":
        el.click();
        return { ok: true };

      case "FILL":
        setValue(el, action.value);
        return { ok: true, value: clip(el.value, 120) };

      case "CHOOSE": {
        if (el.tagName === "SELECT") {
          const want = String(action.option).toLowerCase();
          const opt = [...el.options].find((o) =>
            o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want) ||
            [...el.options].find((o) => o.text.toLowerCase().includes(want));
          if (!opt) return { ok: false, error: `no option matching "${action.option}"` };
          el.value = opt.value;
          fire(el, "input", "change");
          return { ok: true, value: opt.text };
        }
        // Radio: the option carries its own id, so click that rather than
        // re-deriving which peer was meant.
        const target = action.optionId ? byId(action.optionId) : el;
        if (!target) return { ok: false, error: `no option ${action.optionId}` };
        target.click();
        fire(target, "input", "change");
        return { ok: true, value: clip(labelFor(target), 80) };
      }

      case "RECT": {
        const r = el.getBoundingClientRect();
        return { ok: true, rect: { x: r.x + r.width / 2, y: r.y + r.height / 2,
                                   w: r.width, h: r.height } };
      }

      default:
        return { ok: false, error: `unknown action ${action.type}` };
    }
  }

  // ── file attachment (Path A) ──────────────────────────────────────────────

  // `mime` matters now that documents can come from the user's own library
  // rather than only from the PDF renderer: a photo is a JPEG and a reference
  // may be a Word file, and plenty of upload widgets read file.type and reject
  // anything their `accept` doesn't cover. Defaulted, so older callers that
  // pass nothing still get the PDF they were assuming.
  function attachFile(jcaId, name, base64, mime) {
    const el = byId(jcaId);
    if (!el) return { ok: false, error: `no element ${jcaId}` };

    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mime || "application/pdf" });

    const dt = new DataTransfer();
    dt.items.add(file);

    if (el.tagName === "INPUT" && el.type === "file") {
      el.files = dt.files;
      const took = !!el.files.length;
      fire(el, "input", "change");
      // `accepted` records that the assignment landed BEFORE the change handler
      // ran. A React uploader typically reads the file in that handler, posts
      // it, and then clears `input.files` — so re-reading afterwards says
      // "empty" for an upload that in fact succeeded. upload.js needs to tell
      // that apart from an assignment the browser refused outright.
      return { ok: took, accepted: took, cleared: took && !el.files.length };
    }

    // A drop zone with no reachable input. Sending the drop sequence the
    // component is already listening for beats trying to find a hidden input
    // that may not exist.
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
      }));
    }
    return { ok: true, viaDrop: true };
  }

  function fileState(jcaId) {
    const el = byId(jcaId);
    const f = el?.files?.[0];
    return { attached: !!f, name: f?.name || null };
  }

  // ── which frame is the application in? ────────────────────────────────────
  //
  // A great many employers embed the ATS — Greenhouse, SmartRecruiters,
  // Personio, Workday — in an iframe on their own careers page. The top frame
  // is then marketing copy with no form in it at all, and the form lives in a
  // child frame on a different origin.
  //
  // The engine runs in every frame, so "which frame do we drive" has to be
  // decided rather than assumed. This scores the frame it runs in; the worker
  // asks every frame and drives the winner. Cheap on purpose — it runs once per
  // frame per navigation and must not walk the whole DOM.
  function frameScore() {
    const inputs = document.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), " +
      "select, textarea, [contenteditable=true]");
    const files = document.querySelectorAll("input[type=file]");
    const forms = document.querySelectorAll("form");

    const APPLY_RE =
      /\b(apply|bewerben|bewerbung|submit|absenden|senden|continue|weiter|next)\b/i;
    let controls = 0;
    for (const b of document.querySelectorAll(
      "button, input[type=submit], [role=button], a[href]")) {
      const t = (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
      if (t && t.length < 60 && APPLY_RE.test(t)) controls++;
    }

    // A frame nobody can see is never the right answer, however many inputs it
    // has — tracking pixels and prefetch frames are 0x0 and full of them.
    const visible = window.innerWidth > 40 && window.innerHeight > 40;

    return {
      score: visible
        ? inputs.length * 3 + files.length * 6 + forms.length * 2 + controls * 4
        : 0,
      inputs: inputs.length,
      files: files.length,
      controls,
      area: window.innerWidth * window.innerHeight,
      url: location.href,
      isTop: window.top === window,
    };
  }

  // ── message bridge ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "jca-engine") return;
    try {
      switch (msg.type) {
        case "FRAME_SCORE": sendResponse({ ok: true, ...frameScore() }); break;
        case "OBSERVE":     sendResponse({ ok: true, state: observe() }); break;
        case "ACT":         sendResponse(act(msg.action)); break;
        case "ATTACH_FILE": sendResponse(attachFile(msg.jcaId, msg.name, msg.base64, msg.mime)); break;
        case "FILE_STATE":  sendResponse(fileState(msg.jcaId)); break;
        case "AUTOFILL":    sendResponse({ ok: true, report: A.fill(msg.profile, msg.packet) }); break;
        case "PING":        sendResponse({ ok: true }); break;
        default:            sendResponse({ ok: false, error: `unknown ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  });

  window.JobCopilotApplyEngine = { observe, act, attachFile, fileState };
})();
