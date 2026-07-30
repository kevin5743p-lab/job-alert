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
      <thead><tr>
        <th>Job</th><th>Fit</th><th>Status</th><th>Source</th><th>Updated</th><th></th>
      </tr></thead>
      <tbody>${shown.map(rowHtml).join("")}</tbody>
    </table>`;

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
    $("find").disabled = false;
    $("find").textContent = "🔍 Find jobs";
    if (!msg.error) load();          // pull in whatever the scan saved
  }
});

$("find").addEventListener("click", async () => {
  const btn = $("find");
  btn.disabled = true;
  btn.textContent = "Searching…";
  setScan("Starting…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "FIND_JOBS" });
    if (resp && !resp.ok) {
      const msg = resp.error === "NO_KEY"
        ? "Add your Groq API key from the JobCopilot toolbar icon first."
        : resp.error === "NO_CV"
          ? "Add your CV from the JobCopilot toolbar icon first."
          : resp.error === "NOT_SIGNED_IN"
            ? "Sign in from the JobCopilot toolbar icon first."
            : resp.error;
      setScan("Scan failed", msg, true);
    }
  } catch (e) {
    setScan("Scan failed", String(e.message || e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Find jobs";
  }
});

$("refresh").addEventListener("click", load);
load();
