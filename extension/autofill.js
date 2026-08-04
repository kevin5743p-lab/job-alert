// autofill.js — fills an application form from the user's saved details.
//
// A plain (non-module) script so the content script can use it directly.
// Exposes window.JobCopilotAutofill = { fill, findForm, FIELD_SPECS }.
//
// DESIGN / SAFETY
//  - It NEVER submits. Filling and submitting are separate acts; the person
//    reviews the form and presses the site's own button.
//  - It refuses to touch sensitive inputs (passwords, government IDs, financial
//    details) even if the user somehow stored something matching — see BLOCKED.
//    Those belong in the user's password manager, not in this tool.
//  - It only ever writes values the user typed into the extension themselves.
//  - Every field it changes is highlighted, so nothing is filled invisibly.
//
// Matching strategy: for each input we build a "haystack" from the field's
// label, name, id, placeholder, aria-label and autocomplete attributes, then
// test each spec's patterns against it. This generalises across ATSes far
// better than per-site selectors, because the words applicants see ("First
// name", "Vorname") are stable even when the markup is not.

(function () {
  // Inputs we must never fill, matched against the same haystack. Ordered
  // first — a match here vetoes any other spec.
  const BLOCKED = [
    /\bpassword\b|\bpasswort\b|\bpasse?wort\b/,
    /social security|\bssn\b|sozialversicherung/,
    /passport|reisepass|national id|personalausweis|identity number/,
    /credit card|kreditkarte|\bcvv\b|\bcvc\b|card number|kartennummer/,
    /\biban\b|bank account|kontonummer|routing number|sort code/,
    /\btax id\b|steuer-?id|steuernummer|\bvat\b/,
    /date of birth|geburtsdatum|\bdob\b/,
  ];

  // key    : the field in the saved application profile
  // patterns: unambiguous keywords ("city", "Ort") — checked first
  // loose   : natural-language phrasings ("where do you currently live?")
  //
  // The two tiers exist because forms ask questions, not keywords, but a loose
  // phrase can collide with a stronger one: "In which country do you live?"
  // contains both "country" and "…do you live". Matching every strong pattern
  // before any loose one lets the explicit word win.
  const FIELD_SPECS = [
    { key: "first_name",
      patterns: [/first ?name/, /vorname/, /given name/, /forename/],
      loose: [/^name.{0,12}$/] },
    { key: "last_name",
      patterns: [/last ?name/, /nachname/, /surname/, /family name/, /familienname/] },
    { key: "full_name",
      patterns: [/full ?name/, /^name$/, /your name/, /vollständiger name/],
      loose: [/what.{0,12}(is|s) your name/, /wie hei(ß|ss)en sie/] },
    { key: "email",
      patterns: [/e-?mail/],
      loose: [/where can we (reach|contact|email) you/] },
    { key: "phone",
      patterns: [/phone/, /telefon/, /\bmobile\b/, /handy/, /\bmobil\b/],
      loose: [/(contact|best|reach).{0,15}number/, /rufnummer/,
              /how can we (best )?reach you/] },
    { key: "postal_code",
      patterns: [/post(al)? ?code/, /\bzip\b/, /\bplz\b|postleitzahl/] },
    { key: "country",
      patterns: [/country/, /\bland\b(?!es)/, /staat\b/],
      loose: [/which country/, /in welchem land/] },
    { key: "city",
      patterns: [/\bcity\b/, /\btown\b/, /\bort\b/, /wohnort/, /\bstadt\b/, /standort/],
      // The phrasings that were being missed.
      loose: [/where .{0,20}(do you |are you )?(currently )?(live|living|based|located|reside)/,
              /current (city|location|residence)/, /place of residence/,
              /where are you (from|based)/, /wo (wohnen|leben) sie/, /wohnhaft/] },
    { key: "address",
      patterns: [/street|address|adresse|anschrift|stra(ß|ss)e/],
      loose: [/where do you live.{0,10}(street|address)/] },
    { key: "linkedin_url", patterns: [/linked ?in/] },
    { key: "website_url",
      patterns: [/website|portfolio|personal site|homepage|webseite/],
      loose: [/link to your work/] },
    { key: "github_url", patterns: [/git ?hub/] },
    { key: "work_authorization",
      patterns: [/work (authoriz|authoris|permit)/, /arbeitserlaubnis|aufenthaltstitel/,
                 /right to work|visa status/],
      loose: [/(legally )?(authorized|authorised|eligible|entitled|permitted) to work/,
              /do you have .{0,25}(work permit|working visa)/,
              /dürfen sie .{0,20}arbeiten/] },
    // Sponsorship is asked separately from authorisation and often inverted
    // ("do you require sponsorship?"), so it gets its own answer.
    { key: "requires_sponsorship",
      patterns: [/sponsorship|sponsor(ing)?\b/, /visa support/, /visum|arbeitsvisum/],
      loose: [/will you (now or in the future )?(require|need)/,
              /do you (require|need) .{0,20}(visa|sponsor)/] },
    { key: "notice_period",
      patterns: [/notice period/, /kündigungsfrist/, /availability|verfügbar/,
                 /start date|eintrittsdatum|eintrittstermin|earliest start/],
      loose: [/when (can|could|would) you (start|begin|join)/, /how soon can you start/,
              /earliest possible/, /ab wann (können|könnten) sie/] },
    { key: "salary_expectation",
      patterns: [/salary|gehalt|compensation|vergütung|gehaltsvorstellung/],
      loose: [/what are your .{0,15}expectations/, /expected (pay|remuneration)/] },
    { key: "languages",
      patterns: [/languages?( spoken| skills)?/, /sprachkenntnisse|sprachen/],
      loose: [/which languages do you speak/, /welche sprachen/] },
    { key: "remote_preference",
      patterns: [/remote|hybrid|on-?site|work setup|arbeitsmodell|working model/],
      loose: [/where would you (like to|prefer to) work/] },
    { key: "willing_to_relocate",
      patterns: [/relocat|umzug|umziehen|umzugsbereit/],
      loose: [/willing to move/, /would you move/] },
    { key: "hours_per_week",
      patterns: [/hours per week|wochenstunden|stunden pro woche|weekly hours/],
      loose: [/how many hours/, /wie viele stunden/] },
    { key: "driving_licence",
      patterns: [/driv(er'?s|ing) licen[cs]e/, /führerschein|fahrerlaubnis/] },
    { key: "how_heard",
      patterns: [/how did you (hear|find|learn)/, /wie haben sie von uns erfahren/,
                 /referral source/, /\bsource\b/],
      loose: [/where did you (hear|find|see)/, /wie sind sie auf uns/] },
  ];

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // Everything the user would read as this field's name.
  // aria-labelledby names the element holding the caption. Cornerstone points
  // it at an error span that is empty until something goes wrong, so resolving
  // it the proper way yields nothing — but the attribute itself reads
  // "actionItem.firstName.idTag-error", which names the field outright. Both
  // are returned: the referenced text when there is any, and the raw token,
  // which is an identifier exactly like name and id.
  function labelledByText(el) {
    const ref = el.getAttribute && el.getAttribute("aria-labelledby");
    if (!ref) return { text: "", token: "" };
    const text = ref.split(/\s+/)
      .map((id) => {
        const n = id && document.getElementById(id);
        return n ? norm(n.innerText || n.textContent || "") : "";
      })
      .filter(Boolean).join(" ").trim();
    return { text, token: ref };
  }

  function haystack(el) {
    const lb = labelledByText(el);
    const bits = [
      lb.text, lb.token,
      el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"), el.getAttribute("data-qa"),
      el.getAttribute("data-automation-id"),
      // Without this the rules never saw Cornerstone's "First Name", so the
      // field fell through to the model instead of being filled from the
      // stored answer — which is how an email address ended up in it.
      nearbyLabel(el),
    ];
    if (el.labels && el.labels.length) {
      for (const l of el.labels) bits.push(l.innerText || l.textContent);
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) bits.push(lab.innerText || lab.textContent);
    }
    // Some ATSes don't use <label> at all — fall back to the nearest wrapper's text.
    const wrap = el.closest("label, .field, [class*='field'], [class*='form-group'], div");
    if (wrap) bits.push((wrap.innerText || "").slice(0, 120));
    return norm(bits.filter(Boolean).join(" | "));
  }

  function isBlocked(hay, el) {
    if (el.type === "password") return true;
    return BLOCKED.some((re) => re.test(hay));
  }

  // What to call this field when reporting back to the user. Some ATSes name
  // their inputs with a UUID (Ashby), and "168c6ca1-41c5-42ac…" tells nobody
  // anything — so a hex-looking name is rejected in favour of visible text.
  const UUIDISH = /^[0-9a-f-]{16,}$/i;

  // Plenty of ATSes render a label as a plain element next to the input rather
  // than a <label for>. Cornerstone does, which left "First Name" invisible to
  // both the rules and the model. This looks only at immediate neighbours and
  // only accepts something short that isn't wrapping another field, so it finds
  // the caption without ever swallowing a whole section.
  const LABELISH_MAX = 40;

  function nearbyLabel(el) {
    const clean = (node) => {
      if (!node) return "";
      if (node.querySelector && node.querySelector("input, select, textarea")) return "";
      const t = norm(node.innerText || node.textContent || "").replace(/\s*\*$/, "").trim();
      return t && t.length <= LABELISH_MAX && !UUIDISH.test(t) ? t : "";
    };
    // The caption usually sits just before the input, or just before its wrapper.
    for (const start of [el, el.parentElement]) {
      if (!start) continue;
      let sib = start.previousElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
        const t = clean(sib);
        if (t) return t;
      }
    }
    return "";
  }

  // A caption for one field, or the text of a whole section? Two required
  // markers mean it spans more than one input, and that is exactly what was
  // being sent to the model as though it described a single box.
  const MULTI_FIELD_RE = /\*[\s\S]*\*/;
  const looksLikeSection = (s) =>
    !s || s.length > 80 || MULTI_FIELD_RE.test(s) ||
    (s.match(/\b(first|last|given|sur)\s?name\b/gi) || []).length > 1;

  function fieldLabel(el) {
    const candidates = [];
    if (el.labels && el.labels[0]) candidates.push(el.labels[0].innerText);
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) candidates.push(lab.innerText);
    }
    // The resolved caption only — never the raw aria-labelledby token, which is
    // an internal id and has no business being shown to anyone.
    candidates.push(el.getAttribute("aria-label"), labelledByText(el).text,
                    el.placeholder, nearbyLabel(el), el.name);
    for (const c of candidates) {
      const t = norm(c || "").replace(/\s*\*$/, "").trim();
      if (t && !UUIDISH.test(t)) return t.slice(0, 60);
    }
    return "";
  }

  // Two passes: every unambiguous keyword first, then the natural-language
  // phrasings. See the note on FIELD_SPECS for why the order matters.
  function specFor(hay) {
    for (const spec of FIELD_SPECS) {
      if (spec.patterns.some((re) => re.test(hay))) return spec;
    }
    for (const spec of FIELD_SPECS) {
      if (spec.loose && spec.loose.some((re) => re.test(hay))) return spec;
    }
    return null;
  }

  // React/Vue track their own state, so setting .value directly is ignored on
  // re-render. Setting through the native setter and then dispatching input +
  // change makes the framework observe it.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelect(el, value) {
    const want = norm(value);
    const opt = Array.from(el.options).find(
      (o) => norm(o.textContent) === want || norm(o.value) === want) ||
      Array.from(el.options).find(
        (o) => norm(o.textContent).includes(want) && want.length > 2);
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function highlight(el) {
    el.classList.add("jobcopilot-filled");
    setTimeout(() => el.classList.remove("jobcopilot-filled"), 4000);
  }

  // ── Multiple choice (radios / checkboxes) ────────────────────────────────
  // Consent-style boxes are never ticked automatically: agreeing to terms,
  // privacy policies or background checks is a decision, not data entry.
  const CONSENT = new RegExp([
    "consent", "agree", "terms", "privacy", "policy",
    "datenschutz", "einwillig", "zustimm", "akzeptier",
    "accept", "acknowledg", "background check", "gdpr", "dsgvo",
    "subscribe", "newsletter",
  ].join("|"));

  // Equivalent answers, so a stored "No" still ticks "Nein" / "No, I don't".
  const SYNONYMS = [
    [/^(yes|ja|true|y)\b/, /^(yes|ja|true|y)\b/],
    [/^(no|nein|false|n)\b/, /^(no|nein|false|n)\b/],
  ];

  function labelTextFor(input) {
    const bits = [];
    if (input.labels) for (const l of input.labels) bits.push(l.innerText || l.textContent);
    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) bits.push(lab.innerText || lab.textContent);
    }
    const wrap = input.closest("label");
    if (wrap) bits.push(wrap.innerText || wrap.textContent);
    if (!bits.length) bits.push(input.value);
    return norm(bits.filter(Boolean)[0] || "");
  }

  // The question a radio group is asking: its fieldset legend, or the nearest
  // preceding heading/label text above the group.
  function groupQuestion(input) {
    const fs = input.closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend) return norm(legend.innerText || legend.textContent);

    const group = input.closest("[role='radiogroup'], .field, [class*='field'], [class*='question'], div");
    if (group) {
      // Take the group's text minus the option labels themselves.
      const optionText = Array.from(
        group.querySelectorAll("input[type=radio], input[type=checkbox]"))
        .map(labelTextFor).join(" ");
      const all = norm(group.innerText || "");
      const q = all.replace(new RegExp(optionText.split(/\s+/).filter(w => w.length > 2)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "").trim();
      if (q) return q.slice(0, 160);
    }
    return norm(input.name || "");
  }

  function optionMatches(optLabel, want) {
    const o = norm(optLabel), w = norm(want);
    if (!o || !w) return false;
    if (o === w) return true;
    for (const [a, b] of SYNONYMS) if (a.test(w) && b.test(o)) return true;
    return o.includes(w) || (w.length > 3 && w.includes(o));
  }

  function fillChoices(profile, report) {
    const groups = new Map();
    document.querySelectorAll("input[type=radio]").forEach((el) => {
      if (!controlVisible(el)) return;
      const key = el.name || el.closest("fieldset, [role='radiogroup']");
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    });

    groups.forEach((inputs) => {
      if (inputs.some((el) => el.checked)) return;      // already answered
      const question = groupQuestion(inputs[0]);
      const label = question.slice(0, 48);

      if (isBlocked(question, inputs[0]) || CONSENT.test(question)) {
        report.skipped.push({ label, reason: "your decision — answer this yourself" });
        return;
      }
      const spec = specFor(question);
      const value = spec && profile[spec.key];
      if (!value) return;

      const hit = inputs.find((el) => optionMatches(labelTextFor(el), value));
      if (!hit) {
        report.skipped.push({ label, reason: `no option matching "${value}"` });
        return;
      }
      hit.checked = true;
      hit.dispatchEvent(new Event("click", { bubbles: true }));
      hit.dispatchEvent(new Event("change", { bubbles: true }));
      highlight(hit.closest("label") || hit);
      report.filled.push({ label, key: spec.key });
    });

    // Standalone checkboxes are almost always consent/marketing — never auto-tick.
    document.querySelectorAll("input[type=checkbox]").forEach((el) => {
      if (!controlVisible(el) || el.checked) return;
      const q = labelTextFor(el) || groupQuestion(el);
      if (CONSENT.test(q)) {
        report.skipped.push({ label: q.slice(0, 48), reason: "consent — tick it yourself" });
      }
    });
  }

  // ── Fields the rules didn't recognise ────────────────────────────────────
  // Rules can't anticipate every wording an ATS invents. These are handed to
  // the model to CLASSIFY (which profile field is this?) — never to invent a
  // value. The value always comes from the user's saved profile, so a wrong
  // guess can only put the wrong saved answer in a box, not fabricate data.
  function collectUnmatched() {
    const out = [];

    // Radio groups the rules couldn't answer. Questions like "What is your
    // German level?" with options "A1-A2 / B1-B2 / C1-C2" need the stored
    // answer ("English C1, German B1") interpreted, not copied — which is
    // reasoning, so the model gets them. Consent is never included.
    const groups = new Map();
    document.querySelectorAll("input[type=radio]").forEach((el) => {
      if (!controlVisible(el)) return;
      const key = el.name || "";
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    });
    let g = 0;
    groups.forEach((inputs) => {
      if (inputs.some((el) => el.checked)) return;         // already answered
      const question = groupQuestion(inputs[0]);
      if (!question || question.length > 200) return;
      if (isBlocked(question, inputs[0]) || CONSENT.test(question)) return;
      const id = `r${g++}`;
      inputs.forEach((el) => { el.dataset.jcFieldId = id; });
      out.push({
        id, label: question, type: "radio",
        options: inputs.map(labelTextFor).filter(Boolean).slice(0, 12),
      });
    });

    // Checkbox questions that offer a choice ("Which of these apply to you?")
    // rather than asking for consent. Grouped by name, and only when there is
    // more than one — a lone checkbox is a confirmation, not a choice.
    const boxes = new Map();
    document.querySelectorAll("input[type=checkbox]").forEach((el) => {
      if (!visible(el) || !el.name) return;
      if (!boxes.has(el.name)) boxes.set(el.name, []);
      boxes.get(el.name).push(el);
    });
    boxes.forEach((inputs) => {
      if (inputs.length < 2 || inputs.some((el) => el.checked)) return;
      const question = groupQuestion(inputs[0]);
      if (!question || question.length > 200) return;
      if (isBlocked(question, inputs[0]) || CONSENT.test(question)) return;
      if (inputs.some((el) => CONSENT.test(labelTextFor(el)))) return;
      const id = `c${g++}`;
      inputs.forEach((el) => { el.dataset.jcFieldId = id; });
      out.push({
        id, label: question, type: "checkbox-group",
        options: inputs.map(labelTextFor).filter(Boolean).slice(0, 15),
      });
    });

    // Choice widgets built out of divs and buttons rather than inputs — how
    // Ashby and Workday render most of theirs. They expose the same meaning
    // through ARIA, so that is what we read.
    document.querySelectorAll("[role='radiogroup']").forEach((grp) => {
      const opts = Array.from(grp.querySelectorAll("[role='radio']"))
        .filter(visible);
      if (opts.length < 2) return;
      if (opts.some((o) => o.getAttribute("aria-checked") === "true")) return;
      const question =
        (grp.getAttribute("aria-label") || "").trim() || groupQuestion(grp);
      if (!question || question.length > 200) return;
      if (isBlocked(question, grp) || CONSENT.test(question)) return;
      const id = `a${g++}`;
      opts.forEach((o) => { o.dataset.jcFieldId = id; });
      out.push({
        id, label: question, type: "radio",
        options: opts.map((o) => norm(o.innerText || o.getAttribute("aria-label") || ""))
          .filter(Boolean).slice(0, 12),
      });
    });

    document.querySelectorAll("input, select").forEach((el, i) => {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file",
           "checkbox", "radio"].includes(type)) return;
      if (!visible(el)) return;
      if (el.value && el.value.trim()) return;

      const hay = haystack(el);
      if (isBlocked(hay, el)) return;      // never offer sensitive fields up
      if (specFor(hay)) return;            // a rule already covers it

      // The visible question is what the model should reason about. Some ATSes
      // (Ashby) name their inputs with a UUID, so falling back to the element's
      // name would send the model "166c6ca7-41c5-…" instead of the question.
      let label = "";
      if (el.labels && el.labels[0]) label = (el.labels[0].innerText || "").trim();
      if (!label) label = (el.getAttribute("aria-label") || el.placeholder || "").trim();
      if (!label) label = nearbyLabel(el);
      // groupQuestion falls back to closest("div").innerText, which for a plain
      // text input is the whole surrounding section — on Cornerstone, the entire
      // "Contact Information / First Name / Last Name / Email" block. Handing
      // that to the model as one field's label is why it answered with the whole
      // contact block: an email, a phone number and a LinkedIn URL, in the box
      // marked First Name. A section is not a caption, and a field we cannot
      // name is left for the user rather than guessed at.
      if (!label || looksLikeSection(label) || /^[0-9a-f-]{16,}$/i.test(label)) return;

      el.dataset.jcFieldId = `f${i}`;
      const max = parseInt(el.getAttribute("maxlength") || "", 10);
      out.push({
        id: `f${i}`,
        label,
        type: el.tagName === "SELECT" ? "select" : type || "text",
        options: el.tagName === "SELECT"
          ? Array.from(el.options).map((o) => o.textContent.trim())
              .filter(Boolean).slice(0, 25)
          : undefined,
        maxLength: Number.isFinite(max) && max > 0 && max < 500 ? max : undefined,
      });
    });
    return out;
  }

  // Write model-produced values into the form. Everything arriving here is
  // treated as a suggestion and re-checked: sensitive fields are refused again,
  // existing values are never overwritten, and a select only accepts a value
  // that genuinely matches one of its options.
  function applyFieldValues(fills, report) {
    let n = 0;
    Object.entries(fills || {}).forEach(([id, raw]) => {
      const value = String(raw == null ? "" : raw).trim();
      if (!value) return;
      const nodes = Array.from(document.querySelectorAll(`[data-jc-field-id="${id}"]`));
      const el = nodes[0];
      if (!el) return;
      const type = (el.type || "").toLowerCase();
      const isAria = el.getAttribute && el.getAttribute("role") === "radio";
      const isChoice = type === "radio" || type === "checkbox" || isAria;
      if (!(isChoice ? controlVisible(el) : visible(el))) return;

      // Choice question. Consent groups are never collected, so nothing here
      // can tick one. Checkboxes are a multi-select, so the answer may name
      // several options; a radio or ARIA group takes exactly one.
      if (isChoice) {
        const answered = nodes.some(
          (r) => r.checked || r.getAttribute("aria-checked") === "true");
        if (answered) return;

        const optionText = (r) => (isAria || !r.type)
          ? norm(r.innerText || r.getAttribute("aria-label") || "")
          : labelTextFor(r);

        const wanted = type === "checkbox"
          ? value.split(/[,;]|\band\b/).map((s) => s.trim()).filter(Boolean)
          : [value];

        const hits = [];
        for (const w of wanted) {
          const hit = nodes.find((r) => !hits.includes(r) && optionMatches(optionText(r), w));
          if (hit) hits.push(hit);
        }
        const q = (groupQuestion(el) || "").slice(0, 48);
        if (!hits.length) {
          report && report.skipped.push({ label: q, reason: `no option matching "${value}"` });
          return;
        }
        for (const hit of hits) {
          if (isAria || !hit.type) {
            hit.click();          // a custom widget only updates via its handler
          } else {
            hit.checked = true;
            hit.dispatchEvent(new Event("click", { bubbles: true }));
            hit.dispatchEvent(new Event("change", { bubbles: true }));
          }
          highlight(hit.closest("label") || hit);
        }
        n++;
        report && report.filled.push({ label: q, key: "AI" });
        return;
      }

      if (el.value && el.value.trim()) return;
      if (isBlocked(haystack(el), el)) return;

      const label = fieldLabel(el);
      if (el.tagName === "SELECT") {
        if (!setSelect(el, value)) {
          report && report.skipped.push({ label, reason: "no matching option" });
          return;
        }
      } else {
        const max = parseInt(el.getAttribute("maxlength") || "", 10);
        setValue(el, Number.isFinite(max) && max > 0 ? value.slice(0, max) : value);
      }
      highlight(el);
      n++;
      if (report) report.filled.push({ label, key: "AI" });
    });
    return n;
  }

  // Apply a {fieldId: profileKey} mapping. Every safety rule is re-checked
  // here: the mapping comes from outside, so it is treated as a suggestion.
  function applyFieldMap(map, profile, report) {
    let n = 0;
    Object.entries(map || {}).forEach(([id, key]) => {
      if (!key || !profile[key]) return;
      const el = document.querySelector(`[data-jc-field-id="${id}"]`);
      if (!el || !visible(el) || (el.value && el.value.trim())) return;
      if (isBlocked(haystack(el), el)) return;

      const label = fieldLabel(el);
      if (el.tagName === "SELECT") {
        if (!setSelect(el, profile[key])) return;
      } else {
        setValue(el, profile[key]);
      }
      highlight(el);
      n++;
      if (report) report.filled.push({ label, key: `${key} (AI)` });
    });
    return n;
  }

  // ── Free-text questions ──────────────────────────────────────────────────
  // Long-answer boxes the profile can't answer ("Why do you want to work
  // here?"). Collected so the model can draft them; nothing is filled here.
  function collectOpenQuestions() {
    const out = [];
    document.querySelectorAll("textarea").forEach((el, i) => {
      if (!visible(el) || (el.value && el.value.trim())) return;
      const hay = haystack(el);
      if (isBlocked(hay, el)) return;
      if (specFor(hay)) return;              // a profile field covers it
      const q = (el.labels && el.labels[0]
        ? (el.labels[0].innerText || "") : "").trim() || groupQuestion(el);
      if (!q) return;
      el.dataset.jcQuestionId = `q${i}`;
      out.push({ id: `q${i}`, question: q.slice(0, 300) });
    });
    return out;
  }

  // Write drafted answers back. Answers are keyed by the ids from
  // collectOpenQuestions().
  function applyAnswers(answers) {
    let n = 0;
    Object.entries(answers || {}).forEach(([id, text]) => {
      if (!text) return;
      const el = document.querySelector(`[data-jc-question-id="${id}"]`);
      if (!el || (el.value && el.value.trim())) return;
      setValue(el, text);
      highlight(el);
      n++;
    });
    return n;
  }

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Radios and checkboxes are routinely hidden behind a styled circle — Ashby
  // does this — so the input itself has no size even though the control is
  // plainly on screen. Judge those by their visible label or wrapper instead,
  // otherwise every custom-styled choice question looks absent.
  function controlVisible(el) {
    if (el.disabled) return false;
    if (visible(el)) return true;
    const proxy = el.closest("label") ||
                  (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
                  el.parentElement;
    if (!proxy) return false;
    const r = proxy.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * Fill what we can. Returns a report the UI shows the user:
   *   { filled: [{label, key}], skipped: [{label, reason}], coverLetter: bool }
   * `profile` is the saved application profile; `packet` is the tailored result
   * (used to draft long free-text answers like a cover letter).
   */
  function fill(profile, packet) {
    const report = { filled: [], skipped: [], coverLetter: false };
    const fields = document.querySelectorAll("input, textarea, select");

    fields.forEach((el) => {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset", "file"].includes(type)) return;
      if (!visible(el)) return;
      if (el.value && el.value.trim()) return;  // never overwrite the user's own input

      const hay = haystack(el);
      const label = fieldLabel(el) || (hay.split("|")[0] || hay).slice(0, 48);

      if (isBlocked(hay, el)) {
        report.skipped.push({ label, reason: "sensitive — fill this yourself" });
        return;
      }

      // Long free-text boxes: offer the tailored cover letter.
      const looksLikeLetter =
        el.tagName === "TEXTAREA" &&
        /cover letter|anschreiben|motivation|why (do )?you|warum|tell us|about you/.test(hay);
      if (looksLikeLetter && packet && packet.cover_letter) {
        setValue(el, packet.cover_letter);
        highlight(el);
        report.filled.push({ label, key: "cover_letter" });
        report.coverLetter = true;
        return;
      }

      const spec = specFor(hay);
      if (!spec) return;

      let value = profile[spec.key];
      // Fall back to splitting/joining the name if the form asks differently.
      if (!value && spec.key === "full_name" && (profile.first_name || profile.last_name)) {
        value = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      }
      if (!value && (spec.key === "first_name" || spec.key === "last_name") && profile.full_name) {
        const parts = profile.full_name.trim().split(/\s+/);
        value = spec.key === "first_name" ? parts[0] : parts.slice(1).join(" ");
      }
      if (!value) return;

      if (el.tagName === "SELECT") {
        if (setSelect(el, value)) { highlight(el); report.filled.push({ label, key: spec.key }); }
        else report.skipped.push({ label, reason: "no matching option" });
        return;
      }
      setValue(el, value);
      highlight(el);
      report.filled.push({ label, key: spec.key });
    });

    fillChoices(profile, report);
    report.openQuestions = collectOpenQuestions();
    report.unmatched = collectUnmatched();
    return report;
  }

  // True when the page looks like an application form rather than a listing.
  function findForm() {
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter((el) => !["hidden", "submit", "button"].includes((el.type || "").toLowerCase()))
      .filter(visible);
    return inputs.length >= 3;
  }

  // Keys the model is allowed to choose from — exactly the profile fields we
  // know how to fill, so it can never map a field to something invented.
  const PROFILE_KEYS = FIELD_SPECS.map((s) => s.key);

  window.JobCopilotAutofill = {
    fill, findForm, FIELD_SPECS, PROFILE_KEYS,
    collectOpenQuestions, applyAnswers,
    collectUnmatched, applyFieldMap, applyFieldValues,
  };
})();
