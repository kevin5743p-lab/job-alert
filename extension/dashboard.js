// dashboard.js — "My applications": the job pipeline, without opening a database.
//
// Reads from Supabase (RLS means this only ever returns the signed-in user's
// rows) and lets them move a job through the pipeline, re-open the tailored
// packet, or drop it.

import * as sb from "./supabase.js";

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

// Stats double as filters: clicking one narrows the list to that stage.
let activeFilter = "all";
let allRows = [];

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
  updated: { label: "Updated", get: (r) => Date.parse(r.updated_at) || 0, dir: -1 },
};
const SORT_PREF = "dashboardSort";

let sortKey = "updated";
let sortDir = SORTS.updated.dir;
try {
  const saved = JSON.parse(localStorage.getItem(SORT_PREF) || "null");
  if (saved && SORTS[saved.key]) { sortKey = saved.key; sortDir = saved.dir === 1 ? 1 : -1; }
} catch { /* a corrupt preference is not worth failing the page over */ }

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
      renderTable(allRows);
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
      renderTable(allRows);
    });
  });
}

function renderTable(rows) {
  allRows = rows;
  if (!rows.length) {
    $("content").innerHTML = `<div class="empty">
      No jobs yet.<br />
      They'll appear here automatically once the job-alert bot runs, or as soon
      as you open a posting and click <b>✦ Tailor this job</b>.
    </div>`;
    $("stats").innerHTML = "";
    return;
  }

  renderStats(rows);
  const shown = activeFilter === "all"
    ? rows : rows.filter((r) => r.status === activeFilter);

  if (!shown.length) {
    $("content").innerHTML = `<div class="empty">Nothing at this stage yet.</div>`;
    return;
  }

  $("content").innerHTML = `
    <table>
      <thead>${headerHtml()}</thead>
      <tbody>${sortRows(shown).map(rowHtml).join("")}</tbody>
    </table>`;
  bindSortHeaders();

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

  return `<tr>
    <td>
      <div class="job">${title}</div>
      <div class="co">${esc(r.job_company || "")}${r.job_location ? " · " + esc(r.job_location) : ""}</div>
      ${r.reason ? `<div class="why">${esc(r.reason)}</div>` : ""}
    </td>
    <td>${score}</td>
    <td>
      <span class="st st-${esc(r.status)}">${esc(r.status === "new" ? "found" : r.status)}</span><br />
      <select data-id="${esc(r.id)}">${options}</select>
    </td>
    <td class="muted">${esc(r.job_source || "")}</td>
    <td class="muted">${esc(fmtDate(r.updated_at))}</td>
    <td style="white-space:nowrap">
      ${r.job_url ? `<a class="btnlink" href="${esc(r.job_url)}" target="_blank" rel="noreferrer">Open &amp; apply</a>` : ""}
      ${r.tailored_result_id
        ? `<button data-cover="${esc(r.tailored_result_id)}">Cover letter</button>
           <button data-open="${esc(r.tailored_result_id)}">Packet</button>`
        : ""}
      <button class="danger" data-del="${esc(r.id)}">Delete</button>
    </td>
  </tr>`;
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
  try {
    const session = await sb.getSession();
    if (!session?.access_token) {
      $("who").textContent = "Not signed in.";
      $("content").innerHTML = `<div class="empty">
        Sign in from the JobCopilot toolbar icon to see your applications.
      </div>`;
      return;
    }
    $("who").textContent = `Signed in as ${session.user?.email || ""}`;
    renderTable((await sb.listTrackedJobs()) || []);
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

const SETUP_HELP = {
  NO_KEY: "Add your Groq API key from the JobCopilot toolbar icon first.",
  NO_CV: "Add your CV from the JobCopilot toolbar icon first.",
  NOT_SIGNED_IN: "Sign in from the JobCopilot toolbar icon first.",
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

checkVersion();
load();
