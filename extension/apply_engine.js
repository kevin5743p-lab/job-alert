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
    // Native constraint validation, which leaves no DOM behind at all.
    //
    // When a browser refuses a submit because `required` or `pattern` failed,
    // it paints a bubble tooltip — not an element. So the observation after the
    // click was byte-identical to the one before it, the model concluded its
    // click had simply not registered, and clicked again. And again, until the
    // step budget ran out on a form that had been telling us what was wrong the
    // whole time.
    //
    // `validationMessage` is that text, and stamping the field's id onto it
    // gives the model something to act on rather than a sentence to read.
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      if (out.size >= 15) return;
      if (el.disabled || typeof el.checkValidity !== "function") return;
      if (el.checkValidity()) return;
      if (!visible(el) && !(A?.controlVisible?.(el))) return;
      const msg = clip(el.validationMessage, 140);
      if (!msg) return;
      const label = labelFor(el);
      out.add(label ? `${msg} — "${label}" (${id(el, "f")})` : `${msg} (${id(el, "f")})`);
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
      // `readOnly` is no longer a reason to drop a field. Picker-backed inputs
      // — "Earliest start date" on Personio, softgarden and rexx — are
      // `<input readonly required>`, so the gate could not see them, the site
      // refused the submit, and there was no element id for the model to act
      // on. Serialised with the flag set, a direct FILL is still worth trying
      // (jQuery-UI and flatpickr both accept it) and the model can otherwise
      // click the calendar button next to it.
      if (!visible(el) || el.disabled) return;

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
      if (el.readOnly) {
        f.readOnly = true;
        f.note = "read-only — usually a picker. Try filling it; if the value " +
                 "doesn't take, click the button next to it and choose.";
      }
      // The format the field will actually accept. `<input type=date>` silently
      // refuses anything that is not yyyy-mm-dd, and without being told so the
      // model retries the same rejected string until the budget is gone.
      if (el.pattern) f.pattern = el.pattern;
      if (el.placeholder) f.placeholder = clip(el.placeholder, 60);
      out.push(f);
    });
    return out;
  }

  // ── ARIA widgets ──────────────────────────────────────────────────────────
  //
  // Half of every modern application form is not made of <select> and
  // <input type=radio>. Workday, Ashby, Lever's newer forms and anything built
  // on react-select or headless-ui render a `div[role=combobox]` with a popup
  // `[role=listbox]`, and those were serialised as nothing at all — the model
  // was shown a form with no way to answer half its questions, correctly
  // concluded it could not finish, and paused.

  /** The listbox a combobox trigger controls, open or not. */
  function listboxFor(trigger) {
    const ref = trigger.getAttribute("aria-controls") ||
                trigger.getAttribute("aria-owns");
    if (ref) {
      const byRef = document.getElementById(ref);
      if (byRef) return byRef;
    }
    // react-select mounts the menu as a sibling with no aria wiring at all.
    const scope = trigger.closest("[class*=control], [class*=select], [class*=field]")
                  ?.parentElement || trigger.parentElement;
    return scope?.querySelector('[role="listbox"], [class*=menu][class*=list], [class*=options]') || null;
  }

  function optionsIn(container) {
    if (!container) return [];
    const nodes = container.querySelectorAll('[role="option"], li');
    return [...nodes]
      .filter((o) => visible(o))
      .map((o) => ({ id: id(o, "o"), text: clip(o.innerText || o.textContent, 80),
                     selected: o.getAttribute("aria-selected") === "true" }))
      .filter((o) => o.text)
      .slice(0, MAX_OPTIONS);
  }

  /** What a combobox currently reads as. */
  function comboValue(trigger) {
    const active = trigger.getAttribute("aria-activedescendant");
    if (active) {
      const node = document.getElementById(active);
      if (node) return clip(node.innerText, 80);
    }
    const inner = trigger.querySelector("input")?.value;
    return clip(inner || trigger.innerText || trigger.getAttribute("aria-label") || "", 80);
  }

  function collectAriaWidgets(claimed) {
    const out = [];
    const sel = '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"][tabindex], ' +
                '[role="radiogroup"]';

    document.querySelectorAll(sel).forEach((el) => {
      if (claimed.has(el) || !visible(el) || el.getAttribute("aria-disabled") === "true") return;
      claimed.add(el);

      if (el.getAttribute("role") === "radiogroup") {
        const opts = [...el.querySelectorAll('[role="radio"]')].filter(visible);
        if (!opts.length) return;
        out.push({
          id: id(el, "c"),
          question: clip(A?.groupQuestion?.(el) || labelFor(el) ||
                         el.getAttribute("aria-label") || ""),
          type: "radio",
          widget: "aria",
          required: el.getAttribute("aria-required") === "true",
          options: opts.map((o) => ({
            id: id(o, "o"),
            text: clip(o.innerText || o.getAttribute("aria-label"), 80),
            selected: o.getAttribute("aria-checked") === "true",
          })).slice(0, MAX_OPTIONS),
          selected: opts.some((o) => o.getAttribute("aria-checked") === "true"),
        });
        return;
      }

      // A combobox's options usually do not exist in the DOM until it is
      // opened, so an empty list here is normal and is not a reason to skip it.
      // CHOOSE opens it, waits, and picks — see the ACT branch.
      out.push({
        id: id(el, "c"),
        question: clip(labelFor(el) || el.getAttribute("aria-label") || ""),
        type: "combobox",
        widget: "aria",
        required: el.getAttribute("aria-required") === "true",
        value: comboValue(el),
        options: optionsIn(listboxFor(el)),
        note: "custom dropdown — CHOOSE opens it and picks the option by text",
      });
    });
    return out;
  }

  /** Radio groups and standalone checkboxes, split into answers vs consent. */
  /**
   * The radios that genuinely belong with this one.
   *
   * NOT `input[type=radio][name="..."]`. React forms routinely omit `name`
   * entirely and drive the group from state, and the old query then became
   * `[name=""]` — which matches EVERY unnamed radio on the page. Eight separate
   * screening questions collapsed into one twenty-five-option blob, the group
   * key became the first option's label ("Yes"), and the remaining seven
   * questions were skipped as already-seen. The model was shown one nonsense
   * question and never saw the rest of the form.
   *
   * So: trust `name` when there is one, and otherwise trust the container the
   * markup actually groups them in.
   */
  function radioPeers(el) {
    if (el.name) {
      const named = [...document.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`)];
      if (named.length > 1) return named;
    }
    const box = el.closest(
      'fieldset, [role="radiogroup"], [class*="field"], [class*="question"], ' +
      '[class*="option"], [data-question], li, tr');
    const inBox = box ? [...box.querySelectorAll('input[type="radio"]')] : [];
    return inBox.length > 1 ? inBox : [el];
  }

  function collectChoices() {
    const choices = [];
    const consent = [];
    // Inputs already accounted for by a group, tracked as elements rather than
    // as label strings — two questions can legitimately share the label "Yes".
    const claimed = new Set();

    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
      .forEach((el) => {
        // controlVisible, not visible: a styled form hides the real input and
        // paints the label, and those questions were being dropped entirely.
        const isVisible = A?.controlVisible ? A.controlVisible(el) : visible(el);
        if (!isVisible || el.disabled || claimed.has(el)) return;
        const label = labelFor(el) || clip(el.closest("label")?.innerText || "");

        if (el.type === "checkbox" && isConsent(el, label)) {
          claimed.add(el);
          consent.push({
            id: id(el, "k"), text: label, checked: el.checked,
            required: el.required || el.getAttribute("aria-required") === "true",
          });
          return;
        }

        if (el.type === "radio") {
          const peers = radioPeers(el);
          peers.forEach((p) => claimed.add(p));
          const question = clip(A?.groupQuestion?.(el) || el.name || label);
          choices.push({
            id: id(el, "c"),
            question,
            type: "radio",
            // Required is a property of the group, and sites mark it on the
            // fieldset or on whichever peer they please.
            required: peers.some((p) => p.required ||
                        p.getAttribute("aria-required") === "true") ||
                      !!el.closest('fieldset[aria-required="true"], [role="radiogroup"][aria-required="true"]'),
            options: peers.map((p) => ({
              id: id(p, "o"),
              text: clip(labelFor(p) || p.value, 80),
              selected: p.checked,
            })).slice(0, MAX_OPTIONS),
            // A plain boolean. `true | null` read as "unknown" to the gate.
            selected: peers.some((p) => p.checked),
          });
        } else {
          claimed.add(el);
          choices.push({
            id: id(el, "c"), question: label, type: "checkbox",
            selected: el.checked,
            required: el.required || el.getAttribute("aria-required") === "true",
          });
        }
      });

    // Custom widgets last, so a native control is always preferred when a form
    // has both (some render a real <select> alongside an ARIA facade).
    choices.push(...collectAriaWidgets(claimed));
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * The thing a person would actually click for this control.
   *
   * Ashby, Greenhouse and every Tailwind-styled form hide the real
   * `<input type=radio>` (`sr-only`, `opacity:0`, a zero-size box) and paint a
   * styled label on top. `input.click()` still toggles it, but the *component*
   * is listening on the label, so its own state never learns about the change —
   * the box appears ticked and the site still says the question is unanswered.
   */
  function clickTarget(el) {
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return el;
    return el.closest("label") ||
           (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
           el.parentElement || el;
  }

  /**
   * Click the way a mouse does, not the way `.click()` does.
   *
   * `HTMLElement.click()` dispatches a lone `click` event and nothing else.
   * react-select — and most headless-UI menus, combobox and tag inputs — open
   * on `mousedown` and never see it, so a CHOOSE on one of those did precisely
   * nothing and the run spent its whole budget retrying an untouched dropdown.
   *
   * Real coordinates matter too: handlers routinely read `clientX/clientY`, and
   * a synthetic event at 0,0 gets treated as an outside-click that closes the
   * very menu we just opened.
   */
  function realClick(el) {
    const target = clickTarget(el);
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: 1,
    };

    try {
      target.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerType: "mouse", isPrimary: true }));
    } catch { /* older engines: MouseEvent alone is enough */ }
    target.dispatchEvent(new MouseEvent("mousedown", base));
    try {
      target.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerType: "mouse", isPrimary: true }));
    } catch { /* as above */ }
    target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));

    // Belt and braces for plain controls: if nothing above triggered the
    // element's default behaviour (a checkbox that is still unchecked, a link
    // that did not navigate), fall back to the native activation.
    return target;
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

  /** Text match used when picking from a custom dropdown. */
  function optionMatches(text, want) {
    const a = norm(text).toLowerCase();
    const b = norm(want).toLowerCase();
    return a === b || a.startsWith(b) || a.includes(b);
  }

  /**
   * Open a custom dropdown, wait for its options, and pick one.
   *
   * A CHOOSE that only opened the menu left the run exactly as stuck as one
   * that did nothing — the next observation showed an open listbox, the model
   * clicked the trigger again, and it closed. The whole interaction has to
   * happen inside one action.
   */
  async function chooseFromCombobox(el, want) {
    realClick(el);

    let box = null, opts = [];
    for (let i = 0; i < 12; i++) {                 // ~1.8s, polled
      await sleep(150);
      box = listboxFor(el) ||
            document.querySelector('[role="listbox"]:not([hidden])');
      opts = box ? [...box.querySelectorAll('[role="option"], li')].filter(visible) : [];
      if (opts.length) break;
    }
    if (!opts.length) {
      return { ok: false, error: "the dropdown didn't open, or has no options" };
    }

    const hit = opts.find((o) => optionMatches(o.innerText || o.textContent, want));
    if (!hit) {
      return {
        ok: false,
        error: `no option matching "${want}". Available: ` +
               opts.slice(0, 12).map((o) => `"${clip(o.innerText, 40)}"`).join(", "),
      };
    }
    realClick(hit);
    await sleep(150);
    return { ok: true, value: clip(hit.innerText || hit.textContent, 80) };
  }

  async function act(action) {
    const el = byId(action.jcaId);
    if (!el) return { ok: false, error: `no element ${action.jcaId}` };
    el.scrollIntoView({ block: "center", behavior: "instant" });

    switch (action.type) {
      case "CLICK": {
        const target = realClick(el);
        // Plain controls whose default action the synthetic sequence did not
        // trigger — some frameworks call preventDefault on mousedown.
        if (target === el && el.tagName === "INPUT" &&
            (el.type === "checkbox" || el.type === "radio") && !el.checked) {
          el.click();
        }
        return { ok: true };
      }

      case "FILL": {
        setValue(el, action.value);
        // Report what the field actually holds now. `<input type=date>` and
        // masked inputs silently discard a value they don't like, and without
        // the read-back the run believed a field was filled that was empty —
        // then failed the gate several steps later with no idea why.
        const now = clip(el.value, 120);
        const wanted = String(action.value || "");
        const rejected = wanted && !now;
        return {
          ok: !rejected, value: now,
          error: rejected
            ? `the field discarded that value — it expects ${el.type || "text"}` +
              `${el.pattern ? ` matching ${el.pattern}` : ""}` +
              `${el.validationMessage ? ` (${el.validationMessage})` : ""}`
            : undefined,
          validationMessage: el.validationMessage || undefined,
        };
      }

      case "TYPE": {
        // For widgets that filter as you type — tag inputs, autocompletes —
        // where assigning a value produces no keystrokes and no filtering.
        const input = el.matches("input, textarea") ? el : el.querySelector("input, textarea");
        if (!input) return { ok: false, error: "nothing typeable here" };
        input.focus();
        setValue(input, "");
        for (const ch of String(action.text || "")) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          setValue(input, input.value + ch);
          input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          await sleep(25);
        }
        await sleep(400);                          // let the filter settle
        if (action.thenEnter) {
          for (const t of ["keydown", "keypress", "keyup"]) {
            input.dispatchEvent(new KeyboardEvent(t, {
              key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
            }));
          }
        }
        return { ok: true, value: clip(input.value, 120) };
      }

      case "CHOOSE": {
        if (el.tagName === "SELECT") {
          const want = String(action.option).toLowerCase();
          const opt = [...el.options].find((o) =>
            o.text.toLowerCase().trim() === want || o.value.toLowerCase() === want) ||
            [...el.options].find((o) => o.text.toLowerCase().includes(want));
          if (!opt) {
            return { ok: false,
              error: `no option matching "${action.option}". Available: ` +
                     [...el.options].slice(0, 12).map((o) => `"${clip(o.text, 40)}"`).join(", ") };
          }
          el.value = opt.value;
          fire(el, "input", "change");
          return { ok: true, value: opt.text };
        }

        // A custom dropdown: no <option> anywhere, options usually not even in
        // the DOM until it is opened.
        if (el.getAttribute("role") === "combobox" ||
            el.getAttribute("aria-haspopup") === "listbox") {
          return await chooseFromCombobox(el, action.option);
        }

        // Radio: the option carries its own id, so click that rather than
        // re-deriving which peer was meant.
        const target = action.optionId ? byId(action.optionId) : el;
        if (!target) return { ok: false, error: `no option ${action.optionId}` };

        // ARIA radio — a div, not an input. Clicking is the whole interaction.
        if (!target.matches("input")) {
          realClick(target);
          await sleep(80);
          return { ok: true, value: clip(target.innerText, 80) };
        }

        // A real radio. `.click()` runs the activation behaviour, which is what
        // updates React's value tracker — assigning `.checked` does not, and
        // the component then never sees the change.
        realClick(target);
        if (!target.checked) target.click();
        if (!target.checked) {                     // last resort
          target.checked = true;
          fire(target, "input", "change");
        }
        return { ok: target.checked, value: clip(labelFor(target), 80),
                 error: target.checked ? undefined : "the option would not take" };
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
        // `act` became async when CHOOSE had to open a custom dropdown, wait
        // for its options to mount, and click one — an interaction that cannot
        // be expressed synchronously. `return true` below already keeps the
        // channel open; this makes sure a rejection answers rather than
        // hanging the run for the full message timeout.
        case "ACT":
          Promise.resolve(act(msg.action))
            .then(sendResponse)
            .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
          break;
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
