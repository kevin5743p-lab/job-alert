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

  // key: the field in the saved application profile
  // patterns: what the form calls it (English + German)
  const FIELD_SPECS = [
    { key: "first_name", patterns: [/first ?name/, /vorname/, /given name/] },
    { key: "last_name", patterns: [/last ?name/, /nachname/, /surname/, /family name/] },
    { key: "full_name", patterns: [/full ?name/, /^name$/, /your name/, /vollständiger name/] },
    { key: "email", patterns: [/e-?mail/, /email address/] },
    { key: "phone", patterns: [/phone/, /telefon/, /mobile/, /handy/, /telephone/] },
    { key: "city", patterns: [/\bcity\b/, /\bort\b/, /wohnort/, /\bstadt\b/] },
    { key: "country", patterns: [/country/, /\bland\b/] },
    { key: "address", patterns: [/street|address|adresse|anschrift/] },
    { key: "postal_code", patterns: [/post(al)? ?code/, /\bzip\b/, /plz|postleitzahl/] },
    { key: "linkedin_url", patterns: [/linked ?in/] },
    { key: "website_url", patterns: [/website|portfolio|personal site|homepage/] },
    { key: "github_url", patterns: [/git ?hub/] },
    { key: "work_authorization", patterns: [/work (authoriz|authoris|permit)/, /arbeitserlaubnis/,
                                            /legally authorized|right to work|visa status/] },
    // Sponsorship is asked separately from authorisation and often inverted
    // ("do you require sponsorship?"), so it gets its own answer.
    { key: "requires_sponsorship", patterns: [/sponsorship|sponsor(ing)?\b/, /visa support/,
                                              /visum|arbeitsvisum benötigt/] },
    { key: "notice_period", patterns: [/notice period/, /kündigungsfrist/,
                                       /availability|verfügbar|start date|eintrittsdatum|earliest start/] },
    { key: "salary_expectation", patterns: [/salary|gehalt|compensation|vergütung/] },
    { key: "languages", patterns: [/languages?( spoken| skills)?/, /sprachkenntnisse|sprachen/] },
    { key: "remote_preference", patterns: [/remote|hybrid|on-?site|work setup|arbeitsmodell/] },
    { key: "willing_to_relocate", patterns: [/relocat|umzug|umziehen/] },
    { key: "hours_per_week", patterns: [/hours per week|wochenstunden|stunden pro woche|weekly hours/] },
    { key: "driving_licence", patterns: [/driv(er'?s|ing) licen[cs]e/, /führerschein/] },
    { key: "how_heard", patterns: [/how did you (hear|find)/, /wie haben sie von uns erfahren/,
                                   /source|referral source/] },
  ];

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // Everything the user would read as this field's name.
  function haystack(el) {
    const bits = [
      el.name, el.id, el.placeholder, el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"), el.getAttribute("data-qa"),
      el.getAttribute("data-automation-id"),
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

  function specFor(hay) {
    for (const spec of FIELD_SPECS) {
      if (spec.patterns.some((re) => re.test(hay))) return spec;
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

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
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
      const label = (hay.split("|")[0] || hay).slice(0, 48);

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

    return report;
  }

  // True when the page looks like an application form rather than a listing.
  function findForm() {
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter((el) => !["hidden", "submit", "button"].includes((el.type || "").toLowerCase()))
      .filter(visible);
    return inputs.length >= 3;
  }

  window.JobCopilotAutofill = { fill, findForm, FIELD_SPECS };
})();
