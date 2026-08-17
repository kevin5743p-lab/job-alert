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
  // See the matching guard in apply_engine.js. This file is injected both by
  // the manifest and by ensureEngine, and a second copy would reset the id
  // counter this and apply_engine both stamp with.
  if (window.JobCopilotAutofill) return;

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

    // ── Questions the submit gate blocks on ────────────────────────────────
    //
    // confidence.js COMMITMENT_RE refuses to let a run submit a legal or
    // contractual answer it cannot quote verbatim from the saved profile. Its
    // list has always included business travel, criminal record and the four
    // EEO questions — and until the questionnaire grew fields for them, there
    // was no answer to quote, so every form asking one ended the run in a
    // pause. The gate was right; the profile was empty. These specs let the
    // free rule pass answer them with no model turn at all.

    // Distinct from willing_to_relocate on purpose. "Are you willing to travel
    // up to 30%?" contains none of the relocation words, so it matched nothing
    // while still firing the gate.
    { key: "willing_to_travel",
      patterns: [/willing to travel/, /business travel/, /travel requirement/,
                 /reisebereitschaft|dienstreise/],
      loose: [/(able|prepared) to travel/, /travel up to \d+ ?%/,
              /how (much|often) .{0,20}travel/] },

    { key: "criminal_record",
      patterns: [/criminal (record|offence|offense|conviction|history)/,
                 /ever been convicted/, /vorstrafe|vorbestraft/],
      loose: [/have you .{0,30}(convicted|charged with)/,
              /pleaded (guilty|no contest)/] },

    // Voluntary self-identification. A spec here only says how to RECOGNISE the
    // field; whether it is ever filled is decided by eeo_autofill_consent in
    // fill() below, which is off unless the user turned it on.
    { key: "eeo_gender",
      patterns: [/^gender$/, /gender identity/, /geschlecht/],
      loose: [/what is your gender/, /gender.{0,20}(voluntary|optional|self-?identif)/] },
    { key: "eeo_race_ethnicity",
      patterns: [/race|ethnicity|ethnic (group|origin)/, /\beeo-?1\b/],
      loose: [/racial .{0,15}identif/, /hispanic or latino/] },
    { key: "eeo_veteran_status",
      patterns: [/veteran status/, /protected veteran/, /\bvevraa\b/],
      loose: [/are you a .{0,20}veteran/] },
    { key: "eeo_disability_status",
      patterns: [/disability status/, /\bcc-?305\b/, /schwerbehind/,
                 /voluntary self-?identification of disability/],
      loose: [/do you have a disability/, /disabilit(y|ies).{0,25}(identify|status)/] },

    // German forms ask this almost universally. It is gender data under AGG §1,
    // so it is gated with the EEO answers rather than treated as a salutation.
    { key: "de_anrede",
      patterns: [/^anrede$/, /^salutation$/, /^title$/, /^titel$/],
      loose: [/anrede/] },

    // notice_period absorbs "start date" as free text, but an <input type=date>
    // accepts nothing but yyyy-mm-dd — so a date-typed control gets the real
    // date and everything else keeps the sentence.
    { key: "earliest_start_date",
      patterns: [/earliest start date/, /available start date/,
                 /gewünschtes eintrittsdatum/],
      loose: [/when .{0,20}start.{0,10}\(date\)/] },

    { key: "date_of_birth",
      // Deliberately NOT matched by pattern: BLOCKED above vetoes every
      // date-of-birth field outright, and that veto stays. The key exists so
      // the answer can be shown to the model for a German Lebenslauf, never so
      // a form field gets filled with it.
      patterns: [], loose: [] },
  ];

  // Answers that are lawful to ask and voluntary to give. Filling one of these
  // without being asked to is the single most consequential thing this file
  // could get wrong, so it takes an explicit, separate opt-in rather than
  // riding along with the rest of the profile.
  const CONSENT_GATED = {
    eeo_gender: "eeo_autofill_consent",
    eeo_race_ethnicity: "eeo_autofill_consent",
    eeo_veteran_status: "eeo_autofill_consent",
    eeo_disability_status: "eeo_autofill_consent",
    de_anrede: "eeo_autofill_consent",
    date_of_birth: "eeo_autofill_consent",
  };

  /** May we fill this key at all, given what the user consented to? */
  function consented(profile, key) {
    const gate = CONSENT_GATED[key];
    return !gate || profile[gate] === true;
  }

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
        // Case preserved — this becomes the accessible name, which is shown.
        return n ? String(n.innerText || n.textContent || "").replace(/\s+/g, " ").trim() : "";
      })
      .filter(Boolean).join(" ").trim();
    return { text, token: ref };
  }

  function haystack(el) {
    const bits = [
      // The accessible name first: it already resolves aria-labelledby,
      // aria-label, every shape of <label>, placeholder and title in the right
      // order, so the pool no longer needs its own competing copy of that hunt.
      accessibleName(el),
      // Identifiers behind it. These are not captions — they routinely hold a
      // UUID — but they carry the field's intent on the ATSes that name them
      // ("_systemfield_email", "actionItem.firstName.idTag-error").
      labelledByText(el).token,
      el.name, el.id, el.getAttribute("autocomplete"),
      el.getAttribute("data-qa"), el.getAttribute("data-automation-id"),
    ];
    // Some ATSes don't use <label> at all, so the per-field wrapper's text is a
    // last-ditch signal. "div" is deliberately not in that list: the nearest div
    // is frequently an entire section, and pooling "Contact Information First
    // Name Last Name Email" would let a Last Name box match the rule for First
    // Name. Wrappers that name themselves as fields don't have that problem.
    const wrap = el.closest("label, .field, [class*='field'], [class*='form-group']");
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

  // The accessible name: what a screen reader would announce for this control,
  // which is also what the applicant reads on screen.
  //
  // This replaces three separate ad-hoc attempts at the same question that had
  // each grown their own priority order and disagreed with one another. The
  // order below is the one the HTML-AAM algorithm defines, and following it
  // matters: aria-labelledby OUTRANKS a native <label>, because a form that
  // sets both means the first one. We had it fourth.
  //
  // Every serious ATS is accessible — in the EU and US it is a legal
  // requirement — so this is the most reliable description of a field that
  // exists, and it is stable across sites and languages in a way that
  // hand-rolled DOM spelunking never is.
  const NAME_MAX = 80;

  // Strip the decoration a caption carries: the required marker, and the
  // "(optional)" kind of aside, neither of which identifies the field.
  // Case is preserved deliberately: this string is shown to the user in the
  // panel, and "first name" reads like a bug. Every place that matches on it
  // lowercases for itself — haystack pools through norm(), and specFor
  // lowercases the caption before testing patterns against it.
  function cleanName(text) {
    return String(text || "").replace(/\s+/g, " ").trim()
      .replace(/[\s*:]+$/, "")
      .replace(/\s*\((?:optional|required|erforderlich|optional angeben)\)\s*$/i, "")
      .trim();
  }

  function accessibleName(el) {
    if (!el || !el.getAttribute) return "";

    // 1. aria-labelledby — an explicit pointer at the caption, highest priority.
    const byRef = labelledByText(el).text;
    if (cleanName(byRef)) return cleanName(byRef).slice(0, NAME_MAX);

    // 2. aria-label — an explicit caption written inline.
    const aria = cleanName(el.getAttribute("aria-label"));
    if (aria) return aria.slice(0, NAME_MAX);

    // 3. The native label: <label for>, or one wrapping the control. el.labels
    //    covers both, so it is asked first, with an explicit lookup behind it
    //    for the controls that don't populate it.
    if (el.labels && el.labels.length) {
      for (const l of el.labels) {
        const t = cleanName(l.innerText || l.textContent);
        if (t) return t.slice(0, NAME_MAX);
      }
    }
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = forLabel && cleanName(forLabel.innerText || forLabel.textContent);
      if (t) return t.slice(0, NAME_MAX);
    }
    const wrapping = el.closest && el.closest("label");
    if (wrapping) {
      // The control's own text is part of the label element; take the label's
      // text minus any value the control itself contributes.
      const t = cleanName(wrapping.innerText || wrapping.textContent);
      if (t && t !== cleanName(el.value)) return t.slice(0, NAME_MAX);
    }

    // 4. placeholder, then title. Both are fallbacks in the algorithm because a
    //    placeholder is a hint rather than a name, but on a form that supplies
    //    nothing else it is the only thing the applicant has to go on either.
    const ph = cleanName(el.placeholder);
    if (ph) return ph.slice(0, NAME_MAX);
    const title = cleanName(el.getAttribute("title"));
    if (title) return title.slice(0, NAME_MAX);

    // 5. Beyond the algorithm: a caption sitting beside the control with no
    //    markup tying the two together. Not accessible, and not rare —
    //    Cornerstone does exactly this — so it is read last rather than not at
    //    all. A UUID is never a caption.
    const near = cleanName(nearbyLabel(el));
    if (near && !UUIDISH.test(near)) return near.slice(0, NAME_MAX);

    return "";
  }

  // Kept as the name the rest of the code already calls. Identical result,
  // capped shorter, since this one is shown to the user.
  function fieldLabel(el) {
    return accessibleName(el).slice(0, 60);
  }

  // The browser already has a standard answer to this problem, and we weren't
  // reading it. HTML defines a fixed vocabulary of autocomplete tokens for
  // exactly these fields, and a well-built ATS sets them — Ashby, Greenhouse
  // and Workday all do — though Ashby, measured on a live form, sets it on
  // nothing at all, so this helps where it is present rather than everywhere.
  // Where it is present it states outright what a box is for, instead of
  // leaving us to infer it from wording that changes with site and language.
  //
  // The attribute was already going into the haystack as raw text, which did
  // almost nothing: the token is "given-name" and the pattern was /given name/,
  // so a hyphen was the difference between certainty and guessing.
  //
  // Only tokens with a matching stored answer are listed. Anything else — the
  // payment and password tokens above all — is left unmapped and falls through
  // to the ordinary path, where BLOCKED refuses it.
  const AUTOCOMPLETE_FIELDS = {
    "given-name": "first_name",
    "family-name": "last_name",
    "name": "full_name",
    "nickname": "first_name",
    "email": "email",
    "tel": "phone",
    "tel-national": "phone",
    "tel-local": "phone",
    "street-address": "address",
    "address-line1": "address",
    "address-level2": "city",
    "postal-code": "postal_code",
    "country": "country",
    "country-name": "country",
    "url": "website_url",
    "language": "languages",
  };

  function autocompleteSpec(el) {
    const raw = (el.getAttribute && el.getAttribute("autocomplete") || "")
      .toLowerCase().trim();
    if (!raw || raw === "off" || raw === "on") return null;
    // A token can be prefixed with a section or a shipping/billing hint
    // ("shipping address-level2"); the field name is always the last part.
    const key = AUTOCOMPLETE_FIELDS[raw.split(/\s+/).pop()];
    return key ? FIELD_SPECS.find((s) => s.key === key) || null : null;
  }

  // Two passes: every unambiguous keyword first, then the natural-language
  // phrasings. See the note on FIELD_SPECS for why the order matters.
  // An explicit autocomplete token outranks both — it is a statement of intent
  // by whoever built the form, not an inference drawn from their wording.
  // What the input's own type says. Ashby names none of its fields but types
  // them properly — email, tel, url — and we were reading none of it. Only the
  // unambiguous ones are mapped: type="url" is a link, but which link is a
  // question the label answers, and there are three of them on that one form.
  //
  // Deliberately last. A field labelled "Recovery email" is still typed
  // email, so the wording has to have its say first.
  const TYPE_FIELDS = { email: "email", tel: "phone" };

  function typeSpec(el) {
    const key = TYPE_FIELDS[(el.type || "").toLowerCase()];
    return key ? FIELD_SPECS.find((s) => s.key === key) || null : null;
  }

  // What to actually type for a field key, given what the user stored.
  //
  // A form asking for one "Name" and a profile holding first and last are the
  // same fact in different shapes, and this is where they are reconciled. It
  // lived inside the rules path only, so when the rules missed a field and the
  // model correctly identified it as the full-name box, applyFieldMap looked up
  // profile.full_name, found nothing — most profiles store the two halves — and
  // silently filled nothing. The model had answered correctly and we discarded
  // it. Both paths now resolve values the same way.
  function resolveValue(profile, key) {
    // The consent gate sits at the resolver rather than at each call site, so
    // every path that can produce a value — rules, autocomplete token, input
    // type, and the model's own field map — is covered by one check. A missing
    // tick makes the answer simply unavailable, exactly as if it had never
    // been saved.
    if (!consented(profile, key)) return undefined;

    let value = profile[key];
    if (!value && key === "full_name" && (profile.first_name || profile.last_name)) {
      value = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
    }
    if (!value && (key === "first_name" || key === "last_name") && profile.full_name) {
      const parts = String(profile.full_name).trim().split(/\s+/);
      value = key === "first_name" ? parts[0] : parts.slice(1).join(" ");
    }
    return value;
  }

  function specFor(hay, el) {
    const declared = el && autocompleteSpec(el);
    if (declared) return declared;

    // The visible caption on its own, as well as the pooled haystack.
    // Several patterns are anchored — /^name$/ exists precisely to catch a box
    // labelled exactly "Name" without also claiming "Company name" — and an
    // anchored pattern can never match the pooled string, which carries the id
    // and the name attribute too. On Ashby that pooled string is
    // "name _systemfield_name _systemfield_name", so the commonest field on any
    // application form matched nothing at all.
    const caption = el ? fieldLabel(el).toLowerCase() : "";
    const sources = caption && caption !== hay ? [caption, hay] : [hay];

    for (const hs of sources) {
      for (const spec of FIELD_SPECS) {
        if (spec.patterns.some((re) => re.test(hs))) return spec;
      }
    }
    for (const hs of sources) {
      for (const spec of FIELD_SPECS) {
        if (spec.loose && spec.loose.some((re) => re.test(hs))) return spec;
      }
    }
    return (el && typeSpec(el)) || null;
  }

  // ── Does this value belong in this box? ────────────────────────────────
  //
  // The last line of defence, and the one that was missing. Nothing checked
  // that an email-shaped value wasn't going into a name box, which is how
  // "pmeet2905@gmail.com, +49 176 8592 6598" came to be typed into First Name:
  // the field was misidentified upstream, and there was nothing downstream to
  // notice that the answer made no sense for the question.
  //
  // Every fix above reduces how often a field is misidentified. None of them
  // can promise it never happens again, on a form neither of us has seen. This
  // catches the consequence rather than the cause, which is why it is worth
  // having even when the matching is good — and why it refuses rather than
  // repairs. A refusal costs a moment of typing; a wrong answer on a real
  // application costs the application.
  const EMAILISH = /\S+@\S+\.\S+/;
  const URLISH = /^(?:https?:\/\/|www\.)|\.[a-z]{2,}(?:\/|$)/i;
  const digitsIn = (v) => (String(v).match(/\d/g) || []).length;

  function nameRule(v) {
    if (EMAILISH.test(v)) return "that looks like an email address";
    if (URLISH.test(v)) return "that looks like a link";
    if (digitsIn(v) >= 4) return "that looks like a number";
    if (v.length > 80) return "too long to be a name";
    return null;
  }
  function placeRule(v) {
    if (EMAILISH.test(v)) return "that looks like an email address";
    if (digitsIn(v) >= 5) return "that looks like a number";
    return null;
  }

  // Only kinds with a shape worth asserting. Free text — notice period,
  // languages, "why this company" — is deliberately absent: there is no wrong
  // shape for a sentence, and a rule that guesses would block honest answers.
  const VALUE_RULES = {
    email: (v) => (EMAILISH.test(v) ? null : "that is not an email address"),
    phone: (v) => (digitsIn(v) >= 6 ? null : "that is not a phone number"),
    first_name: nameRule, last_name: nameRule, full_name: nameRule,
    city: placeRule, country: placeRule,
    linkedin_url: (v) => (/linkedin\./i.test(v) ? null : "that is not a LinkedIn URL"),
    github_url: (v) => (/github\./i.test(v) ? null : "that is not a GitHub URL"),
    website_url: (v) => (URLISH.test(v) ? null : "that is not a web address"),
    postal_code: (v) => (v.length <= 12 ? null : "too long to be a postcode"),
  };

  // For values the model produced, where there is no profile key to check
  // against: read the kind off the control itself. The input's own type is the
  // strongest statement available, and the caption fills in behind it.
  function fieldKind(el) {
    const t = (el.type || "").toLowerCase();
    if (t === "email") return "email";
    if (t === "tel") return "phone";
    const cap = accessibleName(el).toLowerCase();
    if (/\b(?:first|last|given|sur|full)\s?name\b|^name$|vorname|nachname/.test(cap)) {
      return "full_name";
    }
    if (/e-?mail/.test(cap)) return "email";
    if (/\bphone\b|telefon|mobile|handy/.test(cap)) return "phone";
    return null;
  }

  /** A reason the value doesn't belong here, or null if it's fine. */
  function rejectValue(el, value, key) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return null;
    const rule = VALUE_RULES[key] || VALUE_RULES[fieldKind(el)];
    return rule ? rule(v) : null;
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
      // resolveValue, not profile[key] directly: this path was the one place
      // that read the profile raw, so it saw neither the first/last-name
      // reconciliation nor the consent gate. A radio group asking for gender
      // would have been answered while the identical <select> was not.
      const value = spec && resolveValue(profile, spec.key);
      if (spec && !value && CONSENT_GATED[spec.key] && profile[spec.key]) {
        report.skipped.push({
          label, reason: "voluntary question — turn on \"let JobCopilot fill " +
                         "these in\" in your answers if you want it answered" });
        return;
      }
      if (!value) return;

      const hit = inputs.find((el) => optionMatches(labelTextFor(el), value));
      if (!hit) {
        report.skipped.push({ label, reason: `no option matching "${value}"` });
        return;
      }
      tick(hit);
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
      if (specFor(hay, el)) return;         // a rule already covers it

      // The visible question is what the model should reason about, and it is
      // the same question accessibleName answers — so it is asked once, here,
      // rather than hunted for a second time with a slightly different order.
      // Some ATSes (Ashby) name their inputs with a UUID, which is why the
      // element's name is not part of it: the model would be sent
      // "166c6ca7-41c5-…" instead of a question.
      const label = accessibleName(el);
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
            tick(hit);
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
      const badFor = rejectValue(el, value, null);
      if (badFor) {
        report && report.skipped.push({ label, reason: badFor });
        return;
      }
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
      const mapped = key && resolveValue(profile, key);
      if (!mapped) return;
      const el = document.querySelector(`[data-jc-field-id="${id}"]`);
      if (!el || !visible(el) || (el.value && el.value.trim())) return;
      if (isBlocked(haystack(el), el)) return;

      const label = fieldLabel(el);
      const badMap = rejectValue(el, mapped, key);
      if (badMap) {
        report && report.skipped.push({ label, reason: badMap });
        return;
      }
      if (el.tagName === "SELECT") {
        if (!setSelect(el, mapped)) return;
      } else {
        setValue(el, mapped);
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
      if (specFor(hay, el)) return;          // a profile field covers it
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
  /**
   * Tick a checkbox or radio so the framework behind it notices.
   *
   * `el.checked = true` is the obvious way and the wrong one. React installs a
   * value tracker on the node; assigning the property updates that tracker, so
   * when the `change` event arrives React compares old to new, sees no
   * difference, and drops it. The box is visibly ticked and the component's
   * state still says the question is unanswered — a discrepancy with no
   * symptom until the site refuses the submit.
   *
   * `.click()` runs the element's activation behaviour, which sets the value
   * through the path the tracker is watching. When the real input is hidden
   * behind a styled label — Ashby, Greenhouse, anything Tailwind — the click
   * has to land on that label instead, for the same reason.
   *
   * Note `new Event("click")` is NOT a substitute: it is not a MouseEvent, and
   * React's synthetic handlers read properties off the native event that a
   * plain Event does not carry.
   */
  function tick(el) {
    if (el.checked) return true;

    const box = el.getBoundingClientRect();
    const hidden = box.width <= 1 || box.height <= 1;
    const proxy = hidden
      ? (el.closest("label") ||
         (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)))
      : null;

    (proxy || el).click();
    if (el.checked) return true;

    // Some components stop the label's click. Go through the native setter so
    // the tracker is bypassed rather than merely updated, then say so.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "checked")?.set;
    setter ? setter.call(el, true) : (el.checked = true);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.checked;
  }

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

  // ── File inputs ───────────────────────────────────────────────────────────
  //
  // The original tool skipped `type=file` everywhere, because there was nothing
  // to put in one — it could only ever produce HTML behind a print dialog. Now
  // that docgen.js renders real PDFs, a file input is the whole point of the
  // exercise, so they are found and classified here instead of ignored.
  //
  // Note this does NOT attach anything. Reading the DOM stays in this file;
  // attaching is upload.js's job, because the two paths for it (DataTransfer
  // and CDP) need context autofill.js has no business knowing about.

  // Order matters: the first pattern that matches wins, and "Bewerbungsfoto"
  // would otherwise never be reached on a form that also says "Bewerbung".
  const FILE_KINDS = [
    { kind: "cv",           re: /\bcv\b|resum(e|é)|lebenslauf|curriculum ?vitae/ },
    { kind: "cover_letter", re: /cover ?letter|anschreiben|motivation(sschreiben)?|covering ?letter/ },
    { kind: "portfolio",    re: /portfolio|work ?sample|arbeitsprobe|writing ?sample/ },
    { kind: "certificate",  re: /certificat|zeugnis|diploma|transcript|qualification|referenz|reference ?letter/ },
    // German applications still routinely ask for a photo, and until the
    // document library existed there was nothing that could ever be attached
    // here — so classifying it would only have produced a smarter refusal.
    { kind: "photo",        re: /\bphoto\b|\bfoto\b|lichtbild|passbild|headshot|profile ?picture/ },
  ];

  // Stable per-page ids so the background, the model, and CDP all refer to the
  // same element by the same name. Shared with apply_engine.js via the DOM
  // attribute rather than a JS global, since they're in the same isolated world
  // but load independently.
  let jcaSeq = 0;
  function stampId(el, prefix) {
    if (!el.dataset.jcaId) el.dataset.jcaId = `${prefix}${++jcaSeq}`;
    return el.dataset.jcaId;
  }

  /**
   * Which document does this input want?
   *
   * Reuses the same label haystack every other field goes through, so an input
   * labelled "Lebenslauf hochladen" is understood for the same reason "First
   * name" is. Unlabelled inputs fall back to "cv": a form with exactly one
   * upload is asking for a CV in overwhelmingly the common case, and the
   * confidence gate will catch it if the form disagrees.
   */
  function classifyFile(el) {
    const hay = haystack(el);
    for (const { kind, re } of FILE_KINDS) if (re.test(hay)) return kind;
    return null;
  }

  /**
   * Every file input on the page, whether or not it is visible.
   *
   * Deliberately not filtered by visible(): most ATSes hide the real input at
   * opacity 0 behind a styled label or drop zone, so a visibility check would
   * miss exactly the ones that matter. `hidden` is reported instead, and
   * upload.js decides what to do about it.
   */
  function collectFileInputs() {
    const out = [];
    document.querySelectorAll('input[type="file"]').forEach((el) => {
      if (el.disabled) return;
      const label = fieldLabel(el) || accessibleName(el) ||
                    (haystack(el).split("|")[0] || "").slice(0, 60);
      out.push({
        id: stampId(el, "u"),
        label,
        kind: classifyFile(el),
        required: el.required || /\*/.test(label),
        multiple: !!el.multiple,
        accept: el.accept || "",
        attached: !!(el.files && el.files.length),
        attachedName: el.files && el.files[0] ? el.files[0].name : null,
        hidden: !visible(el),
      });
    });

    // A form with a single unlabelled upload is asking for a CV.
    const unknown = out.filter((f) => !f.kind);
    if (out.length === 1 && unknown.length === 1) unknown[0].kind = "cv";
    return out;
  }

  /**
   * Fill what we can. Returns a report the UI shows the user:
   *   { filled: [{label, key}], skipped: [{label, reason}], coverLetter: bool,
   *     files: [{id, label, kind, required, attached}] }
   * `profile` is the saved application profile; `packet` is the tailored result
   * (used to draft long free-text answers like a cover letter).
   */
  function fill(profile, packet) {
    const report = { filled: [], skipped: [], coverLetter: false };
    const fields = document.querySelectorAll("input, textarea, select");

    fields.forEach((el) => {
      const type = (el.type || "").toLowerCase();
      // `file` is handled by collectFileInputs below — there is no text value to
      // set on one, so it does not belong in this loop.
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

      const spec = specFor(hay, el);
      if (!spec) return;

      // Same resolver the model-mapped path uses, so a form asking for one
      // "Name" is answered identically however the field was identified.
      const value = resolveValue(profile, spec.key);
      // A stored answer withheld by the consent gate is reported rather than
      // dropped. Silence here reads as "the form didn't ask", which is the
      // opposite of what happened.
      if (!value && CONSENT_GATED[spec.key] && profile[spec.key]) {
        report.skipped.push({
          label, reason: "voluntary question — turn on \"let JobCopilot fill " +
                         "these in\" in your answers if you want it answered" });
        return;
      }
      if (!value) return;

      // Checked here too, though the rules path is the least likely to be
      // wrong: if a rule ever does misread a field, the stored answer lands in
      // it just as silently as a model's guess would.
      const bad = rejectValue(el, value, spec.key);
      if (bad) {
        report.skipped.push({ label, reason: bad });
        return;
      }

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
    report.files = collectFileInputs();
    return report;
  }

  // True when the page looks like an application form rather than a listing.
  // ── two different questions, which used to be one ─────────────────────────
  //
  // "Is there a form here I should run the rule pass over?" and "is a button
  // labelled Apply on this page SENDING an application rather than opening
  // one?" are not the same question, and answering both with one ≥3-visible-
  // inputs test was wrong in both directions.
  //
  // Too loose: a OneTrust/Cookiebot banner is four checkboxes — Necessary,
  // Performance, Functional, Targeting — so a plain job advert with a cookie
  // wall counted as a form. The run then treated the advert's "Apply" link as a
  // submit button, ran the gate against a page with no fields and no answers,
  // and stopped on step two of an application it had never opened.
  //
  // Too strict: a Lever quick-apply is name, email and a CV dropzone, and gets
  // no rule pass at all.
  //
  // So: checkboxes and radios no longer make something submittable, and the
  // fillable test is separately generous.

  /** Controls a person actually types or chooses an answer into. */
  function applicationControls() {
    return Array.from(document.querySelectorAll(
        "input, textarea, select, [contenteditable=true]"))
      .filter((el) => !["hidden", "submit", "button", "checkbox", "radio", "search", "image", "reset"]
        .includes((el.type || "").toLowerCase()))
      .filter((el) => !el.closest("header, nav, footer, [role=search]"))
      .filter(controlVisible);
  }

  /** Worth running the rule-based fill and planning uploads on? Deliberately loose. */
  function looksFillable() {
    const controls = applicationControls();
    const files = document.querySelectorAll('input[type="file"]').length;
    return controls.length >= 1 &&
           (files > 0 || !!document.querySelector("form") || controls.length >= 3);
  }

  /** Is a control labelled "Apply"/"Submit" here SENDING an application? */
  function findForm() {
    return applicationControls().length >= 3;
  }

  // Keys the model is allowed to choose from — exactly the profile fields we
  // know how to fill, so it can never map a field to something invented.
  const PROFILE_KEYS = FIELD_SPECS.map((s) => s.key);

  // apply_engine.js serialises the page for the model and needs the same
  // labelling and the same blocked-field veto this file already applies — so
  // they are shared rather than reimplemented. A second copy of the BLOCKED
  // list is a second copy that can drift, and the failure mode there is a
  // password box being offered to a model.
  const isBlockedField = (el) => isBlocked(haystack(el), el);

  window.JobCopilotAutofill = {
    fill, findForm, looksFillable, controlVisible, FIELD_SPECS, PROFILE_KEYS,
    collectOpenQuestions, applyAnswers,
    collectFileInputs, classifyFile, stampId,
    fieldLabel, groupQuestion, isBlockedField, haystack,
    collectUnmatched, applyFieldMap, applyFieldValues,
    // Exported so the field-matching rules can be exercised directly against
    // real markup without driving a whole fill.
    specFor, fieldLabel, rejectValue,
  };
})();
