// onboarding.js — the application-answers wizard.
//
// Renders entirely from profile_schema.js and writes into
// profiles.application_profile, which is exactly what autofill.js reads and
// what apply_agent.js is handed as <saved_profile>. Every key asked here has a
// consumer named in the schema's `proof` field; nothing is collected for its
// own sake.
//
// WHAT CHANGED AND WHY
//
// The old version was one scroll of nineteen inputs with a single Save at the
// end and a button labelled "Close" whose handler was window.close(). There was
// no autosave and no dirty flag, so answering fifteen questions and closing the
// tab destroyed all fifteen without a word. That is the first thing fixed here:
// every keystroke is debounced to chrome.storage.local, so the secondary button
// can honestly say "Finish later" — and does.
//
// The second is that the form now knows what it costs to leave a question
// blank. confidence.js refuses to let the engine submit a legal or contractual
// answer it cannot quote from this profile, so an unanswered "willing to
// travel" is not an incomplete profile, it is a paused application. Those
// questions are marked, counted, and listed on a review step at the end.

import * as sb from "./supabase.js";
import { hasAllSites, requestAllSites } from "./host_access.js";
import {
  STEPS, ANSWERABLE_TOTAL, answeredCount, missingBlocking, fieldFor,
} from "./profile_schema.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// The wizard's steps plus one synthetic review step on the end. Review is not
// in the schema because it asks nothing — it reports.
const REVIEW = { id: "review", title: "Check and finish" };
const PAGES = [...STEPS, REVIEW];

/** The answers themselves. Every write goes through set(). */
let profile = {};
let current = 0;
let signedIn = false;

// ── Persistence ─────────────────────────────────────────────────────────────
//
// Two tiers, deliberately different speeds. Local is the safety net and must be
// fast enough that closing the tab mid-word cannot lose the word. The account
// copy is the shared truth and is written less often, because it is a network
// round trip per save and the user is typing.

let localTimer = null;
let remoteTimer = null;

function markSaved(text) {
  $("saved").textContent = text;
}

function saveLocalSoon() {
  clearTimeout(localTimer);
  localTimer = setTimeout(async () => {
    await chrome.storage.local.set({ applicationProfile: profile });
    markSaved("Saved on this computer");
    saveRemoteSoon();
  }, 400);
}

function saveRemoteSoon() {
  if (!signedIn) return;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => { pushToAccount(); }, 2500);
}

async function pushToAccount({ loud = false } = {}) {
  if (!signedIn) {
    if (loud) setStatus("Saved on this computer — sign in to sync it.", "warn");
    return;
  }
  try {
    await sb.saveProfile({ application_profile: profile });
    markSaved("Saved to your account");
    if (loud) setStatus("Saved ✓", "good");
  } catch (e) {
    markSaved("Saved locally — sync failed");
    if (loud) setStatus(`Couldn't sync: ${e.message}`, "bad");
  }
}

/** The only way a value enters the profile. */
function set(key, value) {
  const empty = value === undefined || value === null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && !value.length);
  if (empty) delete profile[key];
  else profile[key] = typeof value === "string" ? value.trim() : value;
  saveLocalSoon();
  refreshProgress();
}

function setStatus(text, tone = "") {
  const el = $("status");
  el.textContent = text;
  el.style.color = tone === "good" ? "var(--good)"
    : tone === "bad" ? "var(--bad)"
      : tone === "warn" ? "var(--warn)" : "var(--text-2)";
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

// ── Field rendering ─────────────────────────────────────────────────────────

const filled = (v) =>
  Array.isArray(v) ? v.length > 0
    : typeof v === "boolean" ? v
      : v !== undefined && v !== null && String(v).trim() !== "";

/** The badge after a question's label: what leaving it blank actually costs. */
function tagFor(f) {
  if (f.control === "checkbox" || f.control === "template") return "";
  const isNew = f.isNew ? `<span class="tag new">new</span>` : "";
  if (f.need === "blocks") {
    return filled(profile[f.key])
      ? `<span class="tag ok">answered</span>${isNew}`
      : `<span class="tag need">needed to auto-apply</span>${isNew}`;
  }
  return `<span class="tag opt">optional</span>${isNew}`;
}

function controlHtml(f, id, value) {
  const v = value === undefined || value === null ? "" : String(value);
  switch (f.control) {
    case "select": {
      const opts = ["<option value=\"\">Select…</option>"]
        .concat((f.options || []).map((o) =>
          `<option${o === v ? " selected" : ""}>${esc(o)}</option>`));
      return `<select id="${id}">${opts.join("")}</select>`;
    }
    case "textarea":
      return `<textarea id="${id}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
    case "checkbox":
      return `<input id="${id}" type="checkbox"${profile[f.key] ? " checked" : ""} />`;
    case "date":
      return `<input id="${id}" type="date" value="${esc(v)}" />`;
    case "month":
      return `<input id="${id}" type="month" value="${esc(v)}" />`;
    case "number":
      return `<input id="${id}" type="number" inputmode="numeric" ` +
             `placeholder="${esc(f.placeholder || "")}" value="${esc(v)}" />`;
    default:
      return `<input id="${id}" type="${f.control === "tel" ? "tel"
        : f.control === "email" ? "email" : f.control === "url" ? "url" : "text"}" ` +
        `placeholder="${esc(f.placeholder || "")}" value="${esc(v)}" />`;
  }
}

function fieldHtml(f) {
  const id = `f-${f.key}`;
  const hint = f.hint ? `<div class="hint">${esc(f.hint)}</div>` : "";
  const blockingEmpty = f.need === "blocks" && !filled(profile[f.key]);

  if (f.control === "checkbox") {
    return `<div class="field check" data-key="${esc(f.key)}">
      ${controlHtml(f, id, profile[f.key])}
      <div><label for="${id}">${esc(f.label)}</label>${hint}</div>
    </div>`;
  }

  return `<div class="field${blockingEmpty ? " blocking-empty" : ""}" data-key="${esc(f.key)}">
    <label for="${id}">${esc(f.label)}${tagFor(f)}</label>
    ${controlHtml(f, id, profile[f.key])}
    ${hint}
  </div>`;
}

// ── Repeating groups ────────────────────────────────────────────────────────
// One card per entry, add and remove, values held as an array of plain objects
// on the profile. apply_agent.js is handed the whole application_profile as
// JSON, so an array of {employer, job_title, …} is readable by the model with
// no extra plumbing; keyFromGrounding already accepts any key on the object.

function repeatingHtml(f) {
  const rows = Array.isArray(profile[f.key]) ? profile[f.key] : [];
  const hint = f.hint ? `<div class="hint" style="margin-bottom:14px">${esc(f.hint)}</div>` : "";

  const cards = rows.map((row, i) => `
    <div class="rep" data-rep="${esc(f.key)}" data-i="${i}">
      <div class="rep-head">
        <b>${esc(f.itemName || "entry")} ${i + 1}</b>
        <button type="button" class="secondary small" data-rm="${esc(f.key)}" data-i="${i}">Remove</button>
      </div>
      <div class="rep-grid">
        ${(f.columns || []).map((c) => {
          const id = `r-${f.key}-${i}-${c.key}`;
          return `<div class="field" data-w="${c.width || 1}">
            <label for="${id}">${esc(c.label)}</label>
            ${controlHtml({ ...c, key: id }, id, row[c.key])}
            ${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ""}
          </div>`;
        }).join("")}
      </div>
    </div>`).join("");

  return `<div class="field" data-key="${esc(f.key)}">
    <div class="qlabel">${esc(f.label)}${f.isNew ? `<span class="tag new">new</span>` : ""}</div>
    ${hint}
    ${cards}
    ${rows.length ? "" : `<div class="rep-empty">Nothing added yet.</div>`}
    <div style="margin-top:10px">
      <button type="button" class="secondary small" data-add="${esc(f.key)}">
        + Add ${esc(f.itemName || "entry")}
      </button>
    </div>
  </div>`;
}

// ── Cover-letter template picker ────────────────────────────────────────────
// Unchanged in spirit: each card previews the real template rendered with the
// user's own details, so the choice is made on what it actually looks like.

const SAMPLE_LETTER = [
  "I am currently completing my Master's degree and am writing to express my",
  "interest in this role, where I can build on the analysis and simulation work",
  "that has shaped my studies so far.",
  "",
  "In a recent project I analysed sensor degradation under adverse weather,",
  "using Python for the time-series work and Grafana for the dashboards. That",
  "work taught me how much careful data handling matters to a reliable result.",
  "",
  "I work comfortably both independently and in cross-functional teams, and I",
  "would be glad to discuss how I could contribute to yours.",
].join("\n");

function templateHtml(id) {
  const T = window.JobCopilotCoverTemplates;
  const p = { ...profile, cover_template: id };
  p.first_name = p.first_name || "Your";
  p.last_name = p.last_name || "Name";
  p.email = p.email || "you@example.com";
  p.phone = p.phone || "+49 000 000000";
  p.city = p.city || "Munich";
  p.country = p.country || "Germany";
  return T.buildCoverLetter(
    { title: "Finance Analyst", company: "Example GmbH" },
    { cover_letter: SAMPLE_LETTER }, p, "en");
}

function templatePickerHtml() {
  const T = window.JobCopilotCoverTemplates;
  const sel = profile.cover_template || "modern";
  return `<div class="field">
    <div class="qlabel">Cover letter style</div>
    <div class="hint" style="margin-bottom:14px">Previewed with your own details.
      You can change it any time.</div>
    <div class="tpl-grid">${T.TEMPLATES.map((t) => `
      <div class="tpl${t.id === sel ? " sel" : ""}" data-tpl="${esc(t.id)}">
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.blurb)}</p>
        <div class="thumb"><iframe data-frame="${esc(t.id)}" sandbox=""></iframe></div>
        <span class="preview-link" data-full="${esc(t.id)}">Open full preview →</span>
      </div>`).join("")}</div>
  </div>`;
}

function paintTemplateFrames() {
  const T = window.JobCopilotCoverTemplates;
  if (!T) return;
  T.TEMPLATES.forEach((t) => {
    const f = document.querySelector(`iframe[data-frame="${t.id}"]`);
    // srcdoc rather than innerHTML: the preview is a whole document, and the
    // sandboxed frame keeps its styles from leaking into this page.
    if (f) f.srcdoc = templateHtml(t.id);
  });
}

// ── Review step ─────────────────────────────────────────────────────────────

function reviewHtml() {
  const missing = missingBlocking(profile);
  const answered = answeredCount(profile);

  const head = missing.length
    ? `<div class="note" style="border-left-color:var(--warn)">
         <b>${missing.length} question${missing.length === 1 ? "" : "s"} left that
         ${missing.length === 1 ? "will stall" : "will stall"} an application.</b>
         The engine is not allowed to invent an answer to any of these — it stops
         and hands the form back to you instead. Each one below jumps to its field.
       </div>`
    : `<div class="note" style="border-left-color:var(--good)">
         <b>Nothing is left that would stall an application.</b>
         Every question the submit gate blocks on has an answer it can quote.
       </div>`;

  const list = missing.length
    ? `<ul class="review-list">${missing.map((f) => {
        const stepIdx = PAGES.findIndex((p) => (p.fields || []).some((x) => x.key === f.key));
        return `<li>
          <span>${esc(f.label)}</span>
          <button class="go" data-goto="${stepIdx}" data-focus="${esc(f.key)}">
            ${esc(PAGES[stepIdx]?.title || "Open")} →
          </button>
        </li>`;
      }).join("")}</ul>`
    : "";

  return `<section class="step">
    <h2>Check and finish</h2>
    <p class="blurb">${answered} of ${ANSWERABLE_TOTAL} questions answered.
      Everything here is already saved — this is a summary, not a last chance.</p>
    ${head}
    ${list}
    <div id="grantBox" class="note">
      <b>Applying on employers' own sites.</b>
      Job boards work out of the box. Most employers put the real application
      form on their own website, and Chrome needs one permission before
      auto-apply can fill those in. It asks once, and nothing is sent anywhere.
      <div style="margin-top:12px">
        <button id="grantHosts" type="button">Enable auto-apply on all sites</button>
        <span class="hint" id="grantHint" style="margin-left:10px"></span>
      </div>
    </div>
  </section>`;
}

// ── Step rendering ──────────────────────────────────────────────────────────

function stepBodyHtml(page) {
  if (page.id === "review") return reviewHtml();

  const gated = page.consentKey;
  const consentOn = gated ? !!profile[gated] : true;

  const body = page.fields.map((f) => {
    if (f.control === "repeating") return repeatingHtml(f);
    if (f.control === "template") return templatePickerHtml();
    if (gated && f.key === page.consentKey) return fieldHtml(f);
    if (gated) return null;            // rendered inside the gated block below
    return fieldHtml(f);
  });

  if (!gated) {
    return `<section class="step">
      <h2>${esc(page.title)}</h2>
      ${page.blurb ? `<p class="blurb">${esc(page.blurb)}</p>` : ""}
      ${groupRows(page, body)}
    </section>`;
  }

  const rest = page.fields.filter((f) => f.key !== page.consentKey);
  return `<section class="step">
    <h2>${esc(page.title)}</h2>
    ${page.blurb ? `<p class="blurb">${esc(page.blurb)}</p>` : ""}
    ${fieldHtml(fieldFor(page.consentKey))}
    <p class="gate-note">${consentOn
      ? "These answers will be used on voluntary self-identification sections."
      : "Answers below are saved for your reference only. The engine will hand " +
        "every voluntary section back to you until you tick the box above."}</p>
    <div class="${consentOn ? "gated-on" : "gated"}">
      ${rest.map((f) => fieldHtml(f)).join("")}
    </div>
  </section>`;
}

// Pair the short fields into rows so a step of eight text boxes is not eight
// full-width lines. Only genuinely narrow controls are paired.
const NARROW = new Set(["text", "email", "tel", "url", "date", "month", "number", "select"]);

function groupRows(page, htmlList) {
  const out = [];
  let bucket = [];
  page.fields.forEach((f, i) => {
    const html = htmlList[i];
    if (html === null) return;
    const narrow = NARROW.has(f.control) && !f.hint;
    if (narrow) {
      bucket.push(html);
      if (bucket.length === 2) { out.push(`<div class="row">${bucket.join("")}</div>`); bucket = []; }
      return;
    }
    if (bucket.length) { out.push(`<div class="row">${bucket.join("")}</div>`); bucket = []; }
    out.push(html);
  });
  if (bucket.length) out.push(`<div class="row">${bucket.join("")}</div>`);
  return out.join("");
}

function renderStep(focusKey = null) {
  const page = PAGES[current];
  $("step").innerHTML = stepBodyHtml(page);
  wireStep(page);
  if (page.id === "finishing") paintTemplateFrames();
  if (page.id === "review") wireGrant();
  refreshProgress();                       // draws the rail too

  $("back").disabled = current === 0;
  $("next").textContent = current === PAGES.length - 1 ? "Done" : "Next →";

  if (focusKey) {
    const el = document.getElementById(`f-${focusKey}`);
    if (el) { el.focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function wireStep(page) {
  if (page.id === "review") {
    $("step").querySelectorAll("[data-goto]").forEach((b) => {
      b.addEventListener("click", () => {
        current = Number(b.dataset.goto);
        renderStep(b.dataset.focus);
      });
    });
    return;
  }

  for (const f of page.fields) {
    if (f.control === "repeating") { wireRepeating(f); continue; }
    if (f.control === "template") { wireTemplates(); continue; }

    const el = document.getElementById(`f-${f.key}`);
    if (!el) continue;

    if (f.control === "checkbox") {
      el.addEventListener("change", () => {
        set(f.key, el.checked ? true : "");
        // The consent tick re-renders the step: everything below it changes
        // from saved-only to actually-used, and the note has to say so.
        if (page.consentKey === f.key) renderStep();
      });
      continue;
    }

    const commit = () => set(f.key, el.value);
    el.addEventListener("input", commit);
    el.addEventListener("change", commit);
    // The "needed to auto-apply" badge should stop nagging the moment the
    // question is answered, not on the next render.
    el.addEventListener("blur", () => {
      const wrap = el.closest(".field");
      if (!wrap || f.need !== "blocks") return;
      const now = filled(profile[f.key]);
      wrap.classList.toggle("blocking-empty", !now);
      const tag = wrap.querySelector(".tag.need, .tag.ok");
      if (tag) {
        tag.className = `tag ${now ? "ok" : "need"}`;
        tag.textContent = now ? "answered" : "needed to auto-apply";
      }
    });
  }
}

function wireRepeating(f) {
  const root = $("step");

  root.querySelectorAll(`[data-add="${f.key}"]`).forEach((b) =>
    b.addEventListener("click", () => {
      const rows = Array.isArray(profile[f.key]) ? [...profile[f.key]] : [];
      rows.push({});
      profile[f.key] = rows;
      saveLocalSoon();
      renderStep();
    }));

  root.querySelectorAll(`[data-rm="${f.key}"]`).forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      const rows = (profile[f.key] || []).filter((_, n) => n !== i);
      set(f.key, rows);
      renderStep();
    }));

  (profile[f.key] || []).forEach((_, i) => {
    (f.columns || []).forEach((c) => {
      const el = document.getElementById(`r-${f.key}-${i}-${c.key}`);
      if (!el) return;
      const commit = () => {
        const rows = [...(profile[f.key] || [])];
        rows[i] = { ...rows[i], [c.key]: el.value.trim() };
        // An entry the user added and then left completely blank is noise in
        // the JSON handed to the model; it is dropped on the next render.
        profile[f.key] = rows;
        saveLocalSoon();
        refreshProgress();
      };
      el.addEventListener("input", commit);
      el.addEventListener("change", commit);
    });
  });
}

function wireTemplates() {
  document.querySelectorAll(".tpl").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.dataset.full) {
        const w = window.open("", "_blank");
        if (w) { w.document.open(); w.document.write(templateHtml(e.target.dataset.full)); w.document.close(); }
        return;
      }
      profile.cover_template = card.dataset.tpl;
      saveLocalSoon();
      document.querySelectorAll(".tpl").forEach((c) => c.classList.toggle("sel", c === card));
    });
  });
}

// ── The all-sites grant ─────────────────────────────────────────────────────

async function refreshGrant() {
  const btn = $("grantHosts");
  if (!btn) return;
  const granted = await hasAllSites();
  btn.textContent = granted
    ? "Enabled ✓ — auto-apply works on any employer's site"
    : "Enable auto-apply on all sites";
  btn.disabled = granted;
  $("grantHint").textContent = granted
    ? "Revoke any time from chrome://extensions → JobCopilot → Site access."
    : "";
}

function wireGrant() {
  const btn = $("grantHosts");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    // First statement: chrome.permissions.request has to see the user gesture,
    // and anything awaited before it spends that gesture.
    let granted = false;
    try { granted = await requestAllSites(); }
    catch (e) { $("grantHint").textContent = `Chrome wouldn't ask: ${e.message}`; return; }

    await refreshGrant();
    if (!granted) {
      $("grantHint").textContent =
        "Not granted. Auto-apply will still work on LinkedIn and the major job " +
        "boards; anything on an employer's own site will be handed back to you " +
        "to finish. You can turn this on later in Settings.";
    }
  });
  refreshGrant();
}

// ── Rail and progress ───────────────────────────────────────────────────────

function renderRail() {
  $("rail").innerHTML = PAGES.map((p, i) => {
    const fields = (p.fields || []).filter((f) => f.control !== "template");
    const blocking = fields.filter((f) => f.need === "blocks");
    const open = blocking.filter((f) => !filled(profile[f.key])).length;
    const answered = fields.filter((f) => filled(profile[f.key])).length;
    const done = blocking.length > 0 && open === 0;

    const tally = p.id === "review" ? ""
      : `<span class="tally${open ? " blocked" : ""}">${
          open ? `${open} left` : `${answered}/${fields.length}`}</span>`;

    return `<li>
      <button data-step="${i}"${i === current ? ` aria-current="step"` : ""}>
        <span class="n${done ? " done" : ""}">${done ? "✓" : i + 1}</span>
        <span class="grow">${esc(p.title)}</span>
        ${tally}
      </button>
    </li>`;
  }).join("");

  $("rail").querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => { current = Number(b.dataset.step); renderStep(); }));
}

function refreshProgress() {
  // The rail is redrawn here, not only on step change. Answering a question
  // moved the footer counter but left the rail claiming "2 left" for the step
  // you were looking at — two counts of the same thing, disagreeing on screen.
  renderRail();

  const answered = answeredCount(profile);
  const pct = Math.round((answered / ANSWERABLE_TOTAL) * 100);
  $("meter-fill").style.width = `${pct}%`;
  const open = missingBlocking(profile).length;
  $("count").textContent = open
    ? `${answered} of ${ANSWERABLE_TOTAL} · ${open} needed`
    : `${answered} of ${ANSWERABLE_TOTAL} answered`;
}

// ── Bar ─────────────────────────────────────────────────────────────────────

$("back").addEventListener("click", () => {
  if (current > 0) { current--; renderStep(); }
});

$("next").addEventListener("click", async () => {
  if (current < PAGES.length - 1) { current++; renderStep(); return; }
  clearTimeout(remoteTimer);
  await chrome.storage.local.set({ applicationProfile: profile });
  await pushToAccount({ loud: true });
  window.close();
});

$("done").addEventListener("click", async () => {
  // "Finish later" has to mean it. Flush both tiers before the tab goes.
  clearTimeout(localTimer);
  clearTimeout(remoteTimer);
  await chrome.storage.local.set({ applicationProfile: profile });
  await pushToAccount();
  window.close();
});

$("to-docs").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#documents") });
});

// A last-ditch flush. The debounce is 400ms and a fast tab close can beat it.
window.addEventListener("beforeunload", () => {
  if (localTimer) chrome.storage.local.set({ applicationProfile: profile });
});

// ── Load ────────────────────────────────────────────────────────────────────

async function load() {
  // Local first so the form is never empty, then let the account's copy win.
  const { applicationProfile } = await chrome.storage.local.get("applicationProfile");
  if (applicationProfile) profile = { ...applicationProfile };

  try {
    const session = await sb.getSession();
    signedIn = !!session;
    if (signedIn) {
      const row = await sb.getProfile();
      if (row?.application_profile) profile = { ...profile, ...row.application_profile };
      // The one field we can fill in for them. Confirming beats retyping.
      if (!profile.email && session?.user?.email) profile.email = session.user.email;
    } else {
      setStatus("Not signed in — answers are kept on this computer only.", "warn");
    }
  } catch (e) {
    setStatus(`Couldn't load your saved answers: ${e.message}`, "bad");
  }

  // Keys this page does not render are left strictly alone. application_profile
  // is a shared object: settings.js keeps cv_blocks_fingerprint and
  // cv_block_overrides on it (settings.js:554), which drive Word-CV tailoring,
  // and the model may have been taught others through "Other saved answers".
  // Pruning to the schema here would have silently destroyed all of that on the
  // first autosave.

  // Open on the first step with an unanswered blocking question, so a return
  // visit lands on the work rather than on the name they typed last week.
  const firstOpen = PAGES.findIndex((p) =>
    (p.fields || []).some((f) => f.need === "blocks" && !filled(profile[f.key])));
  current = firstOpen === -1 ? PAGES.length - 1 : firstOpen;

  renderStep();
  markSaved("");
}

load();
