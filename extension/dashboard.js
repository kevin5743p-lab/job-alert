// dashboard.js — "My applications": the job pipeline, without opening a database.
//
// Reads from Supabase (RLS means this only ever returns the signed-in user's
// rows) and lets them move a job through the pipeline, re-open the tailored
// packet, or drop it.

import * as sb from "./supabase.js";
import { helpForPause, pauseLabel } from "./pause_help.js";
import { hasAllSites, requestAllSites } from "./host_access.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function showMessage(text, isError = false) {
  const el = $("message");
  el.textContent = text;
  el.className = `msg${isError ? " err" : ""}`;
  el.classList.toggle("hidden", !text);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}

// Always the clock, not just for today. fmtDate drops the time once a row is a
// day old, which makes two scans on the same past day indistinguishable — and
// "which run brought this in" is the whole reason the Found column exists.
// Released keeps fmtDate: job boards publish a date, and a time there would be
// precision the source never had.
function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// Stats double as filters: clicking one narrows the list to that stage.
let activeFilter = "all";
let allRows = [];

// Job URL -> row, rebuilt whenever allRows changes. The apply poll runs every
// 2.5 seconds and used to do a linear scan of allRows *per visible row* to find
// the record behind it — fine at twenty jobs, and quadratic at five hundred.
let rowsByUrl = new Map();

function setRows(rows) {
  allRows = rows;
  rowsByUrl = new Map(rows.map((r) => [r.job_url, r]));
}

// ── Paging ─────────────────────────────────────────────────────────────────
// Rendering the whole list in one innerHTML was survivable at fifty rows and is
// not at five hundred: every row carries a status <select> and up to five
// buttons, so the browser is asked to build several thousand elements and wire
// listeners to them before anything appears — on every keystroke in the search
// box. A page at a time keeps that bounded no matter how long the list gets.
const PAGE_PREF = "dashboardPageSize";
const PAGE_SIZES = [25, 50, 100, 0];        // 0 = show everything
let pageSize = 50;
let page = 1;
try {
  // Read the raw string first. Number(null) is 0, and 0 is a *valid* page size
  // here meaning "show everything" — so testing the parsed value alone turns
  // "no preference saved" into "render all five hundred rows".
  const raw = localStorage.getItem(PAGE_PREF);
  if (raw !== null && PAGE_SIZES.includes(Number(raw))) pageSize = Number(raw);
} catch { /* a corrupt preference is not worth failing the page over */ }

/** Repaint from the rows already in memory; `resetPage` for anything that
    changes what the list contains rather than just how it's ordered. */
function repaint(resetPage = false) {
  if (resetPage) page = 1;
  renderTable(allRows);
}

// ── Sorting ────────────────────────────────────────────────────────────────
// The list only ever came back in whatever order the query returned, which is
// no use once there are more rows than fit on screen — the best-fitting job and
// the one that moved most recently are two different questions.
//
// Each column says how to read a value out of a row and which way round it
// should start: scores and dates are most useful highest-first, text A-Z.
const SORTS = {
  job: { label: "Job", get: (r) => (r.job_title || "").toLowerCase(), dir: 1 },
  fit: { label: "Fit", get: (r) => (r.score === null || r.score === undefined ? -1 : r.score), dir: -1 },
  status: { label: "Status", get: (r) => sb.APPLICATION_STATUSES.indexOf(r.status), dir: 1 },
  source: { label: "Source", get: (r) => (r.job_source || "").toLowerCase(), dir: 1 },
  // When the employer published it, which is a different question from when
  // this row last changed — a posting found today may have been up for weeks.
  // A third of rows have no posted_at (SuccessFactors carries no date, and
  // hand-tailored jobs have none), so unknown sorts to the bottom either way
  // rather than pretending to be 1970.
  posted: { label: "Released", get: (r) => Date.parse(r.posted_at) || 0, dir: -1 },
  // When a scan brought this in. Shown because it is the date the seven-day
  // archive rule counts from — a job that disappears on a timer should at least
  // display the clock it is being measured against. It also says which run a
  // job arrived on: two scans an hour apart show as different times.
  found: { label: "Found", get: (r) => Date.parse(r.discovered_at) || 0, dir: -1 },
  updated: { label: "Updated", get: (r) => Date.parse(r.updated_at) || 0, dir: -1 },
};
const SORT_PREF = "dashboardSort";

let sortKey = "updated";
let sortDir = SORTS.updated.dir;
try {
  const saved = JSON.parse(localStorage.getItem(SORT_PREF) || "null");
  if (saved && SORTS[saved.key]) { sortKey = saved.key; sortDir = saved.dir === 1 ? 1 : -1; }
} catch { /* a corrupt preference is not worth failing the page over */ }

// ── Filtering ──────────────────────────────────────────────────────────────
// The status chips already narrow by stage. These are the other questions the
// list can't otherwise answer: is it any good, is it still fresh, where did it
// come from, and where is that one job I remember seeing.
const FILTER_PREF = "dashboardFilters";
const NO_FILTERS = { search: "", fit: "", released: "", source: "" };
let filters = { ...NO_FILTERS };
try {
  const saved = JSON.parse(localStorage.getItem(FILTER_PREF) || "null");
  if (saved) filters = { ...NO_FILTERS, ...saved };
} catch { /* a corrupt preference is not worth failing the page over */ }

const DAY_MS = 86400000;

function matchesFilters(r) {
  const f = filters;

  if (f.search) {
    const hay = `${r.job_title || ""} ${r.job_company || ""} ${r.job_location || ""}`
      .toLowerCase();
    if (!hay.includes(f.search.toLowerCase())) return false;
  }

  if (f.fit === "unscored") {
    if (r.score !== null && r.score !== undefined) return false;
  } else if (f.fit === "scored") {
    if (r.score === null || r.score === undefined) return false;
  } else if (f.fit) {
    // A minimum fit is a question about scored jobs, so unscored ones drop out
    // rather than counting as zero.
    if (r.score === null || r.score === undefined) return false;
    if (r.score < Number(f.fit)) return false;
  }

  if (f.released === "unknown") {
    if (r.posted_at) return false;
  } else if (f.released) {
    // "Released in the last N days" can only mean rows that say when they were
    // released; a missing date is not evidence of freshness.
    const t = Date.parse(r.posted_at);
    if (!t || Date.now() - t > Number(f.released) * DAY_MS) return false;
  }

  if (f.source && (r.job_source || "") !== f.source) return false;

  return true;
}

const activeFilterCount = () =>
  Object.keys(NO_FILTERS).filter((k) => filters[k] !== NO_FILTERS[k]).length;

function saveFilters() {
  try { localStorage.setItem(FILTER_PREF, JSON.stringify(filters)); }
  catch { /* private mode: filtering still works, it just won't persist */ }
}

// Rebuilt from the data rather than hard-coded, because the source list grows
// whenever a board is added or the Python bot writes a row of its own.
function renderSourceOptions(rows) {
  const sel = $("f-source");
  if (!sel) return;
  const sources = [...new Set(rows.map((r) => r.job_source).filter(Boolean))].sort();
  // A source that no longer appears would otherwise silently filter to nothing.
  if (filters.source && !sources.includes(filters.source)) sources.push(filters.source);
  sel.innerHTML = `<option value="">any</option>` +
    sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = filters.source;
}

function syncFilterInputs() {
  if (!$("f-search")) return;
  $("f-search").value = filters.search;
  $("f-fit").value = filters.fit;
  $("f-released").value = filters.released;
  const n = activeFilterCount();
  $("filters-toggle").textContent = n ? `⚙ Filters (${n})` : "⚙ Filters";
  $("filters").classList.toggle("on", n > 0);
}

function sortRows(rows) {
  const { get } = SORTS[sortKey];
  // Sort a copy: allRows is the unfiltered source the filters re-read.
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x < y) return -sortDir;
    if (x > y) return sortDir;
    // Same value either way — fall back to most recent so the order is stable
    // rather than shuffling between renders.
    return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
  });
}

function headerHtml() {
  const th = (key) => {
    const on = key === sortKey;
    const arrow = on ? (sortDir === 1 ? " ▲" : " ▼") : "";
    return `<th class="sortable${on ? " sorted" : ""}" data-sort="${key}" ` +
           `title="Sort by ${esc(SORTS[key].label)}">${esc(SORTS[key].label)}${arrow}</th>`;
  };
  return `<tr>${Object.keys(SORTS).map(th).join("")}<th></th></tr>`;
}

function bindSortHeaders() {
  document.querySelectorAll("th[data-sort]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.sort;
      // Clicking the active column flips it; a new column starts in whichever
      // direction is actually useful for that kind of value.
      sortDir = key === sortKey ? -sortDir : SORTS[key].dir;
      sortKey = key;
      try {
        localStorage.setItem(SORT_PREF, JSON.stringify({ key: sortKey, dir: sortDir }));
      } catch { /* private mode: sorting still works, it just won't persist */ }
      // Back to the top: re-sorting and staying on page 7 shows you the middle
      // of a list you just asked to reorder.
      repaint(true);
    });
  });
}

function renderStats(rows) {
  const counts = {};
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const chip = (key, label, n) =>
    `<div class="stat${activeFilter === key ? " on" : ""}" data-filter="${key}">
       <b>${n}</b>${esc(label)}</div>`;

  $("stats").innerHTML =
    chip("all", "all", rows.length) +
    sb.APPLICATION_STATUSES
      .filter((s) => counts[s])
      .map((s) => chip(s, s === "new" ? "found" : s, counts[s]))
      .join("");

  document.querySelectorAll("[data-filter]").forEach((el) => {
    el.addEventListener("click", () => {
      activeFilter = el.dataset.filter;
      repaint(true);
    });
  });
}

function renderTable(rows) {
  setRows(rows);
  if (!rows.length) {
    $("content").className = "";
    $("content").innerHTML = `<div class="empty">
      No jobs yet.<br />
      They'll appear here automatically once the job-alert bot runs, or as soon
      as you open a posting and click <b>✦ Tailor this job</b>.
    </div>`;
    $("stats").innerHTML = "";
    $("pager").classList.add("hidden");
    return;
  }

  // Filters apply before the status chips, so the chip counts describe what the
  // filters actually left rather than the whole table.
  renderSourceOptions(rows);
  syncFilterInputs();
  const filtered = rows.filter(matchesFilters);

  renderStats(filtered);
  const shown = activeFilter === "all"
    ? filtered : filtered.filter((r) => r.status === activeFilter);

  const n = activeFilterCount();
  // Spell out the undated ones when a release window is set. SuccessFactors
  // publishes no dates, so "last 7 days" quietly removes every BMW, Volkswagen
  // and Schaeffler posting — a third of the list here — and the count alone
  // gives no hint that a missing date, rather than an old one, is why.
  const undated = filters.released && filters.released !== "unknown"
    ? rows.filter((r) => !r.posted_at).length : 0;
  $("f-count").textContent = n
    ? `${filtered.length} of ${rows.length} shown` +
      (undated ? ` · ${undated} hidden with no release date` : "")
    : `${rows.length} job${rows.length === 1 ? "" : "s"}`;

  if (!shown.length) {
    $("content").className = "";
    $("content").innerHTML = `<div class="empty">${
      n ? "Nothing matches these filters." : "Nothing at this stage yet."}</div>`;
    $("pager").classList.add("hidden");
    return;
  }

  // Sort the whole matching set, then cut one page out of it — sorting only the
  // visible page would make "highest fit first" mean "highest fit on page 4".
  const ordered = sortRows(shown);
  const pages = pageSize ? Math.max(1, Math.ceil(ordered.length / pageSize)) : 1;
  if (page > pages) page = pages;          // filters just shrank the list
  const from = pageSize ? (page - 1) * pageSize : 0;
  const pageRows = pageSize ? ordered.slice(from, from + pageSize) : ordered;

  $("content").className = "boxed";       // the frame belongs to the scroller
  $("content").innerHTML = `
    <table>
      <thead>${headerHtml()}</thead>
      <tbody>${pageRows.map(rowHtml).join("")}</tbody>
    </table>`;
  bindSortHeaders();
  renderPager({ total: ordered.length, from, count: pageRows.length, pages });

  // The match explanation is clamped to two lines; this is how you read the
  // rest of one without leaving the page.
  document.querySelectorAll("td .why").forEach((el) => {
    el.addEventListener("click", () => el.classList.toggle("open"));
  });

  // Status dropdown → persist immediately.
  document.querySelectorAll("select[data-id]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        await sb.updateApplicationStatus(sel.dataset.id, sel.value);
        showMessage("");
        load();
      } catch (e) {
        showMessage(`Couldn't update status: ${e.message}`, true);
      }
    });
  });

  document.querySelectorAll("button[data-open]").forEach((b) => {
    b.addEventListener("click", () => openPacket(b.dataset.open, b));
  });

  document.querySelectorAll("button[data-cover]").forEach((b) => {
    b.addEventListener("click", () => openCover(b.dataset.cover, b));
  });

  document.querySelectorAll("button[data-del]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("Remove this job from your list? The tailored result is kept.")) return;
      try {
        await sb.deleteApplication(b.dataset.del);
        load();
      } catch (e) {
        showMessage(`Couldn't delete: ${e.message}`, true);
      }
    });
  });
}

/**
 * Where you are in the list, and how to move.
 *
 * Deliberately states the totals in words rather than only offering arrows: at
 * five hundred jobs the useful question is usually "how many are left", not
 * "which page is this".
 */
function renderPager({ total, from, count, pages }) {
  const el = $("pager");
  if (!pageSize && total <= 100) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");

  const range = pageSize
    ? `<b>${from + 1}–${from + count}</b> of <b>${total}</b>`
    : `all <b>${total}</b>`;

  el.innerHTML = `
    <span>Showing ${range}</span>
    <span class="spacer"></span>
    <label>Per page
      <select id="p-size">${PAGE_SIZES.map((s) =>
        `<option value="${s}"${s === pageSize ? " selected" : ""}>${s || "all"}</option>`
      ).join("")}</select>
    </label>
    ${pageSize ? `
      <button id="p-prev"${page <= 1 ? " disabled" : ""}>‹ Previous</button>
      <span>Page <b>${page}</b> of <b>${pages}</b></span>
      <button id="p-next"${page >= pages ? " disabled" : ""}>Next ›</button>` : ""}`;

  $("p-size").addEventListener("change", (e) => {
    pageSize = Number(e.target.value);
    try { localStorage.setItem(PAGE_PREF, String(pageSize)); }
    catch { /* private mode: paging still works, it just won't persist */ }
    repaint(true);
  });
  $("p-prev")?.addEventListener("click", () => { page--; repaint(); scrollToTop(); });
  $("p-next")?.addEventListener("click", () => { page++; repaint(); scrollToTop(); });
}

// Turning the page and landing at the bottom of the next one is disorienting.
function scrollToTop() {
  document.getElementById("content")
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function rowHtml(r) {
  const options = sb.APPLICATION_STATUSES
    .map((s) => `<option value="${s}"${s === r.status ? " selected" : ""}>${s}</option>`)
    .join("");
  // The title links straight to the posting — that's the jumping-off point for
  // tailoring and applying, where the in-page buttons take over.
  const title = r.job_url
    ? `<a href="${esc(r.job_url)}" target="_blank" rel="noreferrer">${esc(r.job_title || "(untitled)")}</a>`
    : esc(r.job_title || "(untitled)");

  const score = r.score === null || r.score === undefined
    ? `<span class="muted">—</span>`
    : `<span class="score s-${r.score >= 75 ? "hi" : r.score >= 50 ? "mid" : "lo"}">${r.score}</span>`;

  // data-url is how a status poll finds this row again without re-rendering the
  // table — see refreshApplyCells().
  return `<tr data-url="${esc(r.job_url || "")}">
    <td>
      <div class="job">${title}</div>
      <div class="co">${esc(r.job_company || "")}${r.job_location ? " · " + esc(r.job_location) : ""}</div>
      ${r.reason
        ? `<div class="why" title="Click to expand">${esc(r.reason)}</div>` : ""}
    </td>
    <td>${score}</td>
    <td>
      <span class="st st-${esc(r.status)}">${esc(r.status === "new" ? "found" : r.status)}</span><br />
      <select data-id="${esc(r.id)}">${options}</select>
    </td>
    <td class="muted">${esc(r.job_source || "")}</td>
    <td class="muted">${r.posted_at ? esc(fmtDate(r.posted_at)) : "—"}</td>
    <td class="muted" style="white-space:nowrap">${
      r.discovered_at ? esc(fmtWhen(r.discovered_at)) : "—"}</td>
    <td class="muted">${esc(fmtDate(r.updated_at))}</td>
    <td class="acts">
      <span class="apply-cell">${applyCell(r)}</span>
      ${r.job_url ? `<a class="btnlink" href="${esc(r.job_url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      ${r.tailored_result_id
        ? `<button data-cover="${esc(r.tailored_result_id)}" title="Open the tailored cover letter">Letter</button>
           <button data-open="${esc(r.tailored_result_id)}" title="Open the tailored CV and cover letter together">Packet</button>`
        : ""}
      <button class="danger" data-del="${esc(r.id)}" title="Remove this job from your list">Delete</button>
    </td>
  </tr>`;
}

// ── Apply ───────────────────────────────────────────────────────────────────
//
// The old build could only hand you a link to the posting. This is the button
// the whole engine hangs off: it queues the job and the router takes it from
// there. What it shows depends on where that job already is, so a second click
// can't queue a duplicate application.

/** runId/status by job_url, refreshed by pollApplyStatus(). */
const applyState = new Map();

const APPLY_LABEL = {
  queued:             ["Queued",   "muted"],
  running:            ["Applying…", "busy"],
  paused_needs_human: ["Needs you", "warn"],
  submitted:          ["Applied ✓", "good"],
  blocked:            ["Blocked",  "warn"],
  failed:             ["Failed",   "warn"],
  aborted:            ["Stopped",  "muted"],
};

function applyCell(r) {
  if (!r.job_url) return "";
  const st = applyState.get(r.job_url);

  if (!st) {
    // Applying needs the tailored packet — that's where the CV, the cover
    // letter, and the grounding all come from. Say so rather than offering a
    // button that would fail.
    return r.tailored_result_id
      ? `<button class="primary" data-apply="${esc(r.job_url)}">Apply</button>`
      : `<button disabled title="Tailor this job first — the engine applies with the tailored CV and cover letter">Apply</button>`;
  }

  let [label, cls] = APPLY_LABEL[st.status] || [st.status, "muted"];
  // A run that stopped on our own crash is not waiting on the user, and saying
  // "Needs you" over it sends them hunting for a form problem that isn't there.
  if (st.status === "paused_needs_human" && st.pause_reason) {
    label = pauseLabel(st.pause_reason);
  }
  // The tooltip carries the next action, because that is what the user is
  // looking for when they hover a stopped run — the reason is already in the
  // panel above.
  const detail = st.pause_reason
    ? ` title="${esc(`${helpForPause(st.pause_reason).headline}\n\n${st.pause_reason}`)}"`
    : "";
  const actions =
    st.status === "running"  ? `<button data-abort="${esc(st.id)}">Stop</button>` :
    st.status === "queued"   ? `<button data-abort="${esc(st.id)}">Cancel</button>` :
    ["paused_needs_human", "failed", "blocked", "aborted"].includes(st.status)
      ? `<button data-retry="${esc(st.id)}">Retry</button>` : "";

  return `<span class="apply-state ${cls}"${detail}>${label}</span> ${actions}`;
}

async function send(msg) {
  const resp = await chrome.runtime.sendMessage(msg);
  if (!resp?.ok) throw new Error(resp?.error || "no response from the extension");
  return resp;
}

/**
 * `refreshApplyCells` re-runs this over the whole document every few seconds,
 * and only the cells whose HTML changed are new elements. Every other button
 * would collect a second listener per poll — so an Apply button on screen for a
 * minute fired ~24 enqueues on one click. Wire each element exactly once.
 */
const wireOnce = (el, fn) => {
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", fn);
};

function wireApplyButtons(root) {
  root.querySelectorAll("[data-apply]").forEach((b) => {
    wireOnce(b, async () => {
      const url = b.dataset.apply;
      const row = rowsByUrl.get(url);
      b.disabled = true;
      b.textContent = "Queueing…";
      try {
        const res = await send({
          type: "APPLY_START",
          job: { url, title: row?.job_title, company: row?.job_company,
                 applicationId: row?.id },
        });
        if (res.rerouted) {
          showMessage(`Applying on the company's own site instead of the aggregator ` +
                      `(found via ${res.rerouted.via}).`);
        } else if (res.parked) {
          showMessage(`${res.reason} — open it and apply directly; your tailored ` +
                      `documents are ready.`, true);
        }
        await pollApplyStatus();
      } catch (e) {
        showMessage(`Couldn't queue that: ${e.message}`, true);
        b.disabled = false;
        b.textContent = "Apply";
      }
    });
  });

  root.querySelectorAll("[data-abort]").forEach((b) => {
    wireOnce(b, async () => {
      try { await send({ type: "APPLY_ABORT", runId: b.dataset.abort }); await pollApplyStatus(); }
      catch (e) { showMessage(`Couldn't stop that: ${e.message}`, true); }
    });
  });

  root.querySelectorAll("[data-retry]").forEach((b) => {
    wireOnce(b, async () => {
      try { await send({ type: "APPLY_RETRY", runId: b.dataset.retry }); await pollApplyStatus(); }
      catch (e) { showMessage(`Couldn't retry that: ${e.message}`, true); }
    });
  });
}

/**
 * Refresh the queue and the per-domain health strip.
 *
 * Polled rather than pushed because the service worker sleeps: a run that
 * finishes while the dashboard tab is in the background would otherwise leave
 * the row showing "Applying…" forever.
 */
async function pollApplyStatus() {
  let st;
  try { st = await send({ type: "APPLY_STATUS" }); }
  catch { return; }                    // not signed in yet, or worker restarting

  applyState.clear();
  for (const run of st.runs || []) {
    // original_job_url is set when an aggregator posting was rerouted, so the
    // row the user clicked still lights up even though the run is against a
    // different URL.
    applyState.set(run.job_url, run);
    if (run.original_job_url) applyState.set(run.original_job_url, run);
  }

  renderApplyPanel(st);
  refreshApplyCells();
}

/**
 * Repaint only the Apply cells.
 *
 * Deliberately not a full re-render: this runs every few seconds, and redrawing
 * the table would reset the sort, drop focus, and clobber a status dropdown the
 * user is halfway through changing. Rows are found by their job URL rather than
 * by position, so filtering or sorting between polls can't misalign them.
 */
function refreshApplyCells() {
  document.querySelectorAll("tbody tr[data-url]").forEach((tr) => {
    const r = rowsByUrl.get(tr.dataset.url);
    const cell = tr.querySelector(".apply-cell");
    if (!r || !cell) return;
    const html = applyCell(r);
    if (cell.innerHTML !== html) cell.innerHTML = html;   // avoid pointless churn
  });
  wireApplyButtons(document);
}

let applyPollTimer = null;

/**
 * Poll while there's anything in flight, and stop when there isn't.
 *
 * A permanently-running timer on a tab people leave open all day is rude to
 * both the browser and Supabase, so this idles down and is woken again by the
 * router's progress messages.
 */
function startApplyPolling() {
  if (applyPollTimer) return;
  const tick = async () => {
    await pollApplyStatus();
    const busy = [...applyState.values()].some((r) =>
      r.status === "queued" || r.status === "running");
    if (busy) { applyPollTimer = setTimeout(tick, 2500); }
    else { applyPollTimer = null; }
  };
  tick();
}

// The router broadcasts as it works. Any progress means something is moving, so
// pick the polling back up if it had idled down.
//
// The error branch matters as much as the progress one: the router refuses to
// start without an API key, and until this existed that refusal went nowhere —
// the row sat at "Queued" with no explanation anywhere in the UI. A component
// that can decline to work has to say so.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "APPLY_PROGRESS" || !msg.event) return;
  const ev = msg.event;
  if (ev.type === "error") showMessage(ev.text, true);
  applyEvents.unshift({ at: Date.now(), ...ev });
  applyEvents.length = Math.min(applyEvents.length, 30);
  renderActivity();
  startApplyPolling();
});

/** Recent router events, newest first — the "what is it doing" log. */
const applyEvents = [];

const EVENT_TEXT = {
  queued:    (e) => `Queued ${e.job || ""}`,
  resolving: (e) => `Looking for ${e.job || "this job"} on the employer's own site…`,
  rerouted:  (e) => `Applying via ${e.to} instead of ${e.from}`,
  parked:    (e) => `${e.job || "A job"} needs applying by hand`,
  running:   (e) => `Applying — ${e.company || ""} ${e.job || ""}`.trim(),
  step:      (e) => e.text,
  skipped:   (e) => `${e.domain} skipped: ${e.reason}`,
  reclaimed: (e) => e.text,
  finished:  (e) => `${e.domain}: ${e.status}`,
  aborted:   () => "Stopped",
  stopped:   () => "Stopped",
  idle:      () => "Idle",
  error:     (e) => `⚠ ${e.text}`,
};

function renderActivity() {
  const el = document.getElementById("applyActivity");
  if (!el) return;
  const lines = applyEvents.slice(0, 8).map((e) => {
    const fn = EVENT_TEXT[e.type];
    const text = fn ? fn(e) : (e.text || "");
    if (!text) return "";
    const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `<li><span class="muted">${t}</span> ${esc(text)}</li>`;
  }).filter(Boolean).join("");
  el.innerHTML = lines ? `<h3>Activity</h3><ul class="queue">${lines}</ul>` : "";
  el.hidden = !lines;
}

/** Queue every strong match that's been tailored and not yet applied to. */
async function applyToAllStrong() {
  const btn = $("applyAll");
  const eligible = allRows.filter((r) =>
    r.job_url && r.tailored_result_id && (r.score ?? 0) >= 75 &&
    !applyState.has(r.job_url) &&
    !["applied", "rejected", "dismissed"].includes(r.status));

  if (!eligible.length) {
    showMessage("Nothing to queue — strong matches need to be tailored first.", true);
    return;
  }
  if (!confirm(
    `Queue ${eligible.length} application${eligible.length === 1 ? "" : "s"}?\n\n` +
    `They'll be spaced out per site and each one stops for you if anything ` +
    `can't be answered from your profile and CV.`)) return;

  btn.disabled = true;
  try {
    const { results } = await send({
      type: "APPLY_MANY",
      jobs: eligible.map((r) => ({ url: r.job_url, title: r.job_title,
                                   company: r.job_company, applicationId: r.id })),
    });
    const parked = results.filter((r) => r.parked).length;
    showMessage(`Queued ${results.length - parked}.` +
      (parked ? ` ${parked} need${parked === 1 ? "s" : ""} applying to by hand — see the panel above.` : ""));
    startApplyPolling();
  } catch (e) {
    showMessage(`Couldn't queue those: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * Show the all-sites grant until it is given, then never again.
 *
 * This is the difference between "auto-apply works on LinkedIn and Greenhouse"
 * and "auto-apply works on the site this particular employer happens to use",
 * and until now the only place to discover that was a run dying halfway.
 */
async function refreshGrantBanner() {
  const el = $("grantBanner");
  if (!el) return;

  if (await hasAllSites()) { el.hidden = true; el.innerHTML = ""; return; }

  el.hidden = false;
  el.innerHTML =
    `<div>
       <b>Auto-apply is limited to the job boards right now</b>
       <span class="muted">Most employers host the actual form on their own
       website. Chrome needs one permission to let applying work there — it asks
       once, and nothing is sent anywhere.</span>
     </div>
     <button class="primary" id="grantAll">Enable on all sites</button>`;

  $("grantAll").addEventListener("click", async () => {
    // First statement in the handler: see the note in wireHandOffButtons about
    // spending the user gesture.
    let granted = false;
    try { granted = await requestAllSites(); }
    catch (e) { showMessage(`Chrome wouldn't ask: ${e.message}`, true); return; }

    if (granted) {
      await refreshGrantBanner();
      // Everything that stopped for want of this goes back in the queue. A plain
      // APPLY_PUMP would not have touched them: the pump only looks at rows that
      // are `queued`, and these are all `paused_needs_human`.
      const r = await send({ type: "APPLY_RESUME_AFTER_GRANT" }).catch(() => null);
      showMessage(r?.resumed
        ? `Enabled — ${r.resumed} application${r.resumed === 1 ? "" : "s"} that were ` +
          `waiting for this are running again.`
        : "Enabled — auto-apply now works on any employer's site.");
      await pollApplyStatus();
    } else {
      showMessage("Not granted. Applying will keep working on the job boards, " +
                  "and anything on an employer's own site gets handed back to you.", true);
    }
  });
}

function renderApplyPanel(st) {
  const el = document.getElementById("applyPanel");
  if (!el) return;

  const active = (st.runs || []).filter((r) =>
    ["queued", "running", "paused_needs_human"].includes(r.status));
  const blocked = (st.health || []).filter((h) => h.state !== "healthy");

  if (!active.length && !blocked.length) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;

  const queue = active.map((r) => {
    const [label] = APPLY_LABEL[r.status] || [r.status];
    // `error` as well as `pause_reason`. A run that ended `failed` had neither a
    // reason shown nor a button offered — a red row and nothing to do about it.
    // No run should ever be able to stop without saying why.
    const why = r.pause_reason || r.error;
    return `<li><b>${esc(r.job_company || "")}</b> — ${esc(r.job_title || "")}
      <span class="muted">${esc(why ? pauseLabel(why) : label)}</span>
      ${why ? `<div class="why">${esc(why)}</div>${handOff({ ...r, pause_reason: why })}` : ""}</li>`;
  }).join("");

  // The health strip exists to make the isolation visible: when a domain is
  // quarantined you can see that it is the only one, and that everything else
  // is still moving.
  // Every paused site gets a Resume button. The breaker is deliberately
  // cautious and sometimes rests a domain for something the user has already
  // fixed — a permission they have now granted, a tab they closed themselves.
  // Making them wait out a day they know is unnecessary is not caution, it is
  // just a dead end with a countdown on it.
  const health = blocked.map((h) =>
    `<li><b>${esc(h.domain)}</b> — ${esc(h.state)}${
       h.signal ? ` <span class="muted" title="${esc(h.signal)}">(${esc(shortSignal(h.signal))})</span>` : ""}
     ${h.retryAt ? `<span class="muted">back ${esc(fmtWhen(h.retryAt))}</span>` : ""}
     <button class="resume-site" data-domain="${esc(h.domain)}">Resume now</button></li>`)
    .join("");

  el.innerHTML =
    `${active.length ? `<h3>Applying (${active.length})</h3><ul class="queue">${queue}</ul>` : ""}
     ${blocked.length ? `<h3>Paused sites</h3><ul class="queue health">${health}</ul>
        <p class="muted">Only these are paused — every other site keeps applying.</p>` : ""}`;

  for (const btn of el.querySelectorAll(".resume-site")) {
    btn.addEventListener("click", () => resumeSite(btn.dataset.domain, btn));
  }
  wireHandOffButtons(el);
}

/**
 * What the user should actually do about a stopped run.
 *
 * The reason above this says what happened; on its own that left people reading
 * "cdp: CSS is not defined" under a heading saying "Needs you" with no idea
 * what was being asked of them. This block answers the two questions that
 * follow — what do I do, and does it carry on afterwards — and puts the button
 * for it right there instead of in a column further down the page.
 *
 * The primary action differs by cause, and pretending otherwise would be worse
 * than saying nothing: Retry is right when the obstacle is upstream of the form
 * (a crash, a missing profile answer) and wrong when the form itself is filled
 * in and waiting on a signature, where a fresh run would only fill it again.
 */
function handOff(run) {
  const help = helpForPause(run.pause_reason);

  // More than one cause gets more than one heading. Merging two different
  // problems into one list of steps reads as a single procedure, and the user
  // does the first two steps and stops.
  const body = help.parts.length === 1
    ? `<b>${esc(help.parts[0].headline)}</b>
       <ol>${help.parts[0].todo.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>`
    : `<b>Two things are in the way here:</b>` + help.parts.map((p) =>
        `<div class="todo-part"><b>${esc(p.headline)}</b>
           <ol>${p.todo.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div>`).join("");

  // The run's own tab, which was left open precisely because it holds the
  // half-filled form. Falling back to the job URL opens a fresh, empty copy —
  // correct only when that tab is already gone.
  const pauseStep = [...(run.steps || [])].reverse().find((s) => s?.kind === "pause");
  const open = run.job_url || pauseStep?.tabId != null
    ? `data-open-tab="${esc(pauseStep?.tabId ?? "")}" data-open-url="${esc(run.job_url || "")}"`
    : null;

  // Primary first: it is the one that gets clicked without reading. Which one
  // that is depends on the cause — see `resume` in pause_help.js.
  const btn = (primary, attrs, text) =>
    `<button ${primary ? 'class="primary" ' : ""}${attrs}>${text}</button>`;
  const openBtn = open ? btn(help.resume === "manual", open, "Open the tab") : "";
  const retryBtn = btn(help.resume === "retry", `data-panel-retry="${esc(run.id)}"`,
                       "Retry — start it again");
  // The grant carries the run id so the same click can hand the permission over
  // and put the job back in the queue. Asking the user to press a second button
  // for the retry would be asking them to finish our job.
  const grantBtn = help.resume === "grant"
    ? btn(true, `data-grant-retry="${esc(run.id)}"`, "Enable it now") : "";

  const order = help.resume === "grant" ? grantBtn + retryBtn + openBtn
    : help.resume === "retry" ? retryBtn + openBtn
    : openBtn + retryBtn;

  return `<div class="todo${help.mine ? " ours" : ""}">
      ${body}
      <div class="todo-actions">${order}</div>
    </div>`;
}

function wireHandOffButtons(root) {
  for (const btn of root.querySelectorAll("[data-grant-retry]")) {
    btn.addEventListener("click", async () => {
      // `permissions.request` must see the user gesture, so it goes FIRST —
      // before any await, before disabling the button. An await here spends the
      // gesture and Chrome rejects the request with a message about it having
      // to be called from a user action, which is maddening to debug because
      // the code plainly is in a click handler.
      let granted = false;
      try { granted = await requestAllSites(); }
      catch (e) { showMessage(`Chrome wouldn't ask: ${e.message}`, true); return; }

      if (!granted) {
        showMessage("Not granted — so jobs on employers' own sites will keep " +
                    "being handed back to you. You can enable it later in Settings.", true);
        return;
      }
      btn.disabled = true;
      btn.textContent = "Enabled ✓ starting…";
      await refreshGrantBanner();
      try {
        // Resume everything that was waiting on this, not just the row whose
        // button was pressed — they were all stopped by the same thing, and
        // making the user click through them one at a time would be busywork.
        const r = await send({ type: "APPLY_RESUME_AFTER_GRANT" }).catch(() => null);
        if (!r?.resumed) await send({ type: "APPLY_RETRY", runId: btn.dataset.grantRetry });
        showMessage(r?.resumed > 1
          ? `Enabled — this and ${r.resumed - 1} other application${r.resumed === 2 ? "" : "s"} ` +
            `waiting on it are running again.`
          : "Enabled, and this job is running again. It won't ask a second time.");
        await pollApplyStatus();
      } catch (e) {
        showMessage(`Enabled, but couldn't start the job again: ${e.message}`, true);
      }
    });
  }
  for (const btn of root.querySelectorAll("[data-open-tab]")) {
    btn.addEventListener("click", async () => {
      const tabId = Number(btn.dataset.openTab);
      // Foregrounded on purpose. Everywhere else this engine keeps its tabs in
      // the background; here the user has just been asked to go and do
      // something in that exact page.
      if (Number.isFinite(tabId) && tabId > 0) {
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
          return;
        } catch { /* closed since the run paused — fall through */ }
      }
      if (btn.dataset.openUrl) {
        showMessage("That tab is gone, so this is a fresh copy of the form — " +
                    "what the run filled in isn't in it.");
        chrome.tabs.create({ url: btn.dataset.openUrl, active: true });
      }
    });
  }
  for (const btn of root.querySelectorAll("[data-panel-retry]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Starting…";
      try {
        await send({ type: "APPLY_RETRY", runId: btn.dataset.panelRetry });
        await send({ type: "APPLY_PUMP" }).catch(() => {});
        showMessage("Back in the queue — it starts again from the top of the form.");
        await pollApplyStatus();
      } catch (e) {
        showMessage(`Couldn't start that again: ${e.message}`, true);
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }
}

/**
 * Why a site is resting, in a form that fits on a line.
 *
 * The breaker records whatever signal it saw, and when that signal is an API
 * failure the raw text is a paragraph of protocol detail — the banner was
 * showing users "messages.8: `tool_use` ids were found without `tool_result`
 * blocks immediately after: toolu_01RHqnpouFp6…". True, and unreadable, and it
 * pushed the Resume button off the line. The full text stays on the title
 * attribute, where it is there for a bug report and nowhere else.
 */
const SIGNAL_LABEL = [
  [/captcha|challenge|cloudflare|are you a (human|robot)/i, "bot check"],
  [/\b(401|403)\b|forbidden|unauthori[sz]ed|access denied/i, "refused us"],
  [/\b429\b|rate ?limit|too many requests/i, "rate limited"],
  [/\b5\d\d\b|internal server|bad gateway|unavailable/i, "site error"],
  [/timeout|timed out|took too long/i, "timed out"],
  [/tool_use|tool_result|messages\.\d|anthropic|claude call failed/i, "AI call failed"],
  [/network|fetch failed|offline|dns/i, "network problem"],
];

function shortSignal(signal) {
  const text = String(signal || "").trim();
  for (const [re, label] of SIGNAL_LABEL) if (re.test(text)) return label;
  // Unrecognised, so say the first clause and stop — better a short true
  // fragment than three lines of someone else's stack trace.
  const first = text.split(/[:\n]/)[0].trim();
  return first.length > 48 ? `${first.slice(0, 45)}…` : (first || "unknown");
}

/** Lift a quarantine and immediately try the queue again. */
async function resumeSite(domain, btn) {
  btn.disabled = true;
  btn.textContent = "Resuming…";
  try {
    await send({ type: "APPLY_RESUME_SITE", domain });
    showMessage(`${domain} resumed — it will run at half speed until it has a clean day.`);
    // Kick the queue rather than waiting for the next poll: the user clicked
    // this because they want it to go now.
    await send({ type: "APPLY_PUMP" }).catch(() => {});
  } catch (e) {
    showMessage(`Couldn't resume ${domain}: ${e.message}`, true);
    btn.disabled = false;
    btn.textContent = "Resume now";
  }
}

// Re-open a saved packet as the same printable document the panel produces.
async function openPacket(resultId, btn) {
  const original = btn.textContent;
  btn.textContent = "Loading…";
  try {
    const row = await sb.getTailoredResult(resultId);
    if (!row) { showMessage("That tailored result no longer exists.", true); return; }
    window.JobCopilotPrintDoc.open(
      { title: row.job_title, company: row.job_company }, row.packet || {});
    showMessage("");
  } catch (e) {
    showMessage(`Couldn't open the packet: ${e.message}`, true);
  } finally {
    btn.textContent = original;
  }
}

// Re-export a saved letter through the user's chosen template.
async function openCover(resultId, btn) {
  const original = btn.textContent;
  btn.textContent = "Loading…";
  try {
    const [row, profile] = await Promise.all([
      sb.getTailoredResult(resultId), sb.getProfile(),
    ]);
    if (!row) { showMessage("That tailored result no longer exists.", true); return; }
    window.JobCopilotCoverTemplates.openCoverLetter(
      { title: row.job_title, company: row.job_company },
      row.packet || {}, profile?.application_profile || {},
      profile?.language || "en");
    showMessage("");
  } catch (e) {
    showMessage(`Couldn't open the cover letter: ${e.message}`, true);
  } finally {
    btn.textContent = original;
  }
}

async function load() {
  // Before the sign-in check: the grant is a browser-level thing and has
  // nothing to do with having an account. Someone who signs in later should
  // already have been offered it.
  refreshGrantBanner().catch(() => {});
  // Granting from Settings, or revoking from chrome://extensions, should be
  // reflected here without a reload.
  chrome.permissions?.onAdded?.addListener(() => refreshGrantBanner().catch(() => {}));
  chrome.permissions?.onRemoved?.addListener(() => refreshGrantBanner().catch(() => {}));

  try {
    const session = await sb.getSession();
    if (!session?.access_token) {
      $("who").textContent = "Not signed in.";
      $("content").className = "";
    $("content").innerHTML = `<div class="empty">
        Sign in from the JobCopilot toolbar icon to see your applications.
      </div>`;
      return;
    }
    $("who").textContent = `Signed in as ${session.user?.email || ""}`;
    const rows = (await sb.listTrackedJobs()) || [];
    renderTable(rows);
    // A cap that silently truncates the list is worse than a smaller list: for
    // as long as the fetch stopped at 300 rows, someone with more than that
    // simply never saw the rest and nothing anywhere said so.
    if (rows.length >= sb.TRACKED_JOBS_LIMIT) {
      showMessage(`Showing the ${sb.TRACKED_JOBS_LIMIT} most relevant jobs — ` +
                  `there are more. Delete or dismiss what you've finished with, ` +
                  `or narrow it down with Filters.`);
    }
    startApplyPolling();
  } catch (e) {
    if (e.message === "NOT_SIGNED_IN") {
      $("who").textContent = "Session expired — sign in again from the toolbar icon.";
      $("content").innerHTML = "";
      return;
    }
    showMessage(`Couldn't load your applications: ${e.message}`, true);
  }
}

// ── Find jobs ──────────────────────────────────────────────────────────────
// The scan runs in the background worker and streams progress here, so a long
// wait shows what it's doing rather than looking frozen.
function setScan(text, sub = "", isError = false) {
  const el = $("scan");
  el.className = `scan${isError ? " err" : ""}`;
  el.innerHTML = `<div>${esc(text)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  el.classList.remove("hidden");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "SCAN_PROGRESS") return;
  setScan(msg.text, (msg.stats || []).join(" · "), Boolean(msg.error));
  if (msg.done) {
    scanFinished();
    // A changed CV means everything already in the tracker was found for the
    // previous one. Say so and offer to clear it, rather than leaving two
    // people's results mixed together.
    if (msg.cvChanged) showStaleNotice();
    if (!msg.error) load();          // pull in whatever the scan saved
  }
});

function showStaleNotice() {
  const el = $("scan");
  el.insertAdjacentHTML("beforeend", `
    <div class="sub" style="margin-top:8px">
      Your CV changed, so the search was rebuilt. Jobs found before that were
      matched against the old CV.
      <button id="clear-stale" style="margin-left:6px">Clear those</button>
    </div>`);
  const btn = document.getElementById("clear-stale");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!confirm("Remove jobs found for the previous CV?\n\n" +
                 "Anything you tailored, applied to or moved along is kept.")) return;
    btn.disabled = true;
    try {
      await sb.clearUntouchedFinds();
      showMessage("");
      load();
    } catch (e) {
      showMessage(`Couldn't clear those: ${e.message}`, true);
    }
  });
}

// These used to say "from the JobCopilot toolbar icon", which was a dead end:
// the settings were three scrolls down a popup, and nothing on this page led
// there. There is a Settings button in the header now, so they can point at it.
const SETUP_HELP = {
  NO_KEY: "Add your Groq API key first — Settings, top right, under AI.",
  NO_CV: "Add your CV first — Settings, top right.",
  NOT_SIGNED_IN: "Sign in first, from the JobCopilot toolbar icon.",
};

function scanFinished() {
  $("find").disabled = false;
  $("find").textContent = "🔍 Find jobs";
}

$("find").addEventListener("click", async () => {
  const btn = $("find");
  btn.disabled = true;
  btn.textContent = "Searching…";
  setScan("Starting…");
  try {
    // This reply only confirms the scan started; the run itself reports over
    // SCAN_PROGRESS, and it is that listener which re-enables the button.
    const resp = await chrome.runtime.sendMessage({ type: "FIND_JOBS" });
    if (resp && !resp.ok) {
      setScan("Scan failed", SETUP_HELP[resp.error] || resp.error, true);
      scanFinished();
    }
  } catch (e) {
    // The worker went away before even acknowledging. A scan that has already
    // started reports through SCAN_PROGRESS and must not be declared failed
    // here — that is exactly the false alarm this used to show.
    const m = String(e.message || e);
    if (/message channel closed|message port closed/i.test(m)) {
      setScan("Still searching…",
              "This scan takes a few minutes. Progress will appear here.");
    } else {
      setScan("Scan failed", m, true);
      scanFinished();
    }
  }
});

// ── Filter controls ────────────────────────────────────────────────────────
// Bound once, not on every render: the panel lives in the page rather than
// inside the table HTML, so rebinding would stack duplicate listeners and,
// worse, drop focus out of the search box on every keystroke.
$("filters-toggle").addEventListener("click", () => {
  $("filters").classList.toggle("hidden");
  if (!$("filters").classList.contains("hidden")) $("f-search").focus();
});

function onFilterChange(key, value) {
  filters[key] = value;
  saveFilters();
  // Filtering changes what the list contains, so page 4 of the old list is
  // meaningless against the new one.
  repaint(true);
}

// Typing filters as you go. Debounced now — the filtering itself is in-memory
// and instant, but each keystroke rebuilds a table of rows, and doing that
// eight times while someone types "engineer" is work nobody sees.
let searchTimer = null;
$("f-search").addEventListener("input", (e) => {
  const value = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => onFilterChange("search", value), 140);
});
$("f-fit").addEventListener("change", (e) => onFilterChange("fit", e.target.value));
$("f-released").addEventListener("change", (e) => onFilterChange("released", e.target.value));
$("f-source").addEventListener("change", (e) => onFilterChange("source", e.target.value));

$("f-clear").addEventListener("click", () => {
  filters = { ...NO_FILTERS };
  saveFilters();
  repaint(true);
});

$("settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Is this page still the extension that's running? ───────────────────────
// An open dashboard tab keeps executing the code it was loaded with. Reload or
// update the extension and this page carries on against a worker that is now a
// different build — messages to it fail with "Extension context invalidated"
// or a dead port, which is unreadable if you don't already know the cause.
// Checked on load and on every Refresh, so the answer is "reload this page",
// not a mystery.
const PAGE_VERSION = chrome.runtime.getManifest().version;

function showStale(text) {
  const el = $("stale");
  el.className = "scan err";
  el.innerHTML = `<div>${esc(text)}</div>` +
    `<div class="sub" style="margin-top:6px">` +
    `<button id="reload-page">Reload this page</button></div>`;
  el.classList.remove("hidden");
  const btn = document.getElementById("reload-page");
  if (btn) btn.addEventListener("click", () => location.reload());
}

async function checkVersion() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "PING" });
    if (resp && resp.version && resp.version !== PAGE_VERSION) {
      showStale(`This page is running JobCopilot ${PAGE_VERSION}, but the ` +
                `installed extension is now ${resp.version}.`);
      return false;
    }
    $("stale").classList.add("hidden");
    return true;
  } catch {
    // The worker wouldn't answer at all. After an extension reload that's
    // exactly what an orphaned page sees.
    showStale("The extension was reloaded or updated, so this page is out of " +
              "date and its buttons won't work.");
    return false;
  }
}

$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.disabled = true;
  try {
    await checkVersion();
    await load();
  } finally {
    btn.disabled = false;
  }
});

// Opening the tracker is the moment new finds have been seen, so the count on
// the toolbar icon comes off. Failure is fine — the badge is a nicety.
chrome.runtime.sendMessage({ type: "DASHBOARD_OPENED" }).catch(() => {});

$("applyAll").addEventListener("click", applyToAllStrong);

// Filters persist, so open the panel when some are already on — otherwise the
// list looks short for no visible reason on the next visit.
if (activeFilterCount()) $("filters").classList.remove("hidden");

checkVersion();
load();
