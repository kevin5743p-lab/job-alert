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

function renderStats(rows) {
  const counts = {};
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  $("stats").innerHTML =
    `<div class="stat"><b>${rows.length}</b>total</div>` +
    sb.APPLICATION_STATUSES
      .filter((s) => counts[s])
      .map((s) => `<div class="stat"><b>${counts[s]}</b>${esc(s)}</div>`)
      .join("");
}

function renderTable(rows) {
  if (!rows.length) {
    $("content").innerHTML = `<div class="empty">
      No applications yet.<br />
      Open a job posting and click <b>✦ Tailor this job</b> — it'll show up here.
    </div>`;
    $("stats").innerHTML = "";
    return;
  }

  renderStats(rows);
  $("content").innerHTML = `
    <table>
      <thead><tr>
        <th>Job</th><th>Status</th><th>Source</th><th>Updated</th><th></th>
      </tr></thead>
      <tbody>${rows.map(rowHtml).join("")}</tbody>
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
  const title = r.job_url
    ? `<a href="${esc(r.job_url)}" target="_blank" rel="noreferrer">${esc(r.job_title || "(untitled)")}</a>`
    : esc(r.job_title || "(untitled)");
  return `<tr>
    <td>
      <div class="job">${title}</div>
      <div class="co">${esc(r.job_company || "")}${r.job_location ? " · " + esc(r.job_location) : ""}</div>
    </td>
    <td>
      <span class="st st-${esc(r.status)}">${esc(r.status)}</span><br />
      <select data-id="${esc(r.id)}">${options}</select>
    </td>
    <td class="muted">${esc(r.job_source || "")}</td>
    <td class="muted">${esc(fmtDate(r.updated_at))}</td>
    <td style="white-space:nowrap">
      ${r.tailored_result_id
        ? `<button data-open="${esc(r.tailored_result_id)}">Open packet</button>`
        : `<span class="muted">—</span>`}
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
    renderTable((await sb.listApplications()) || []);
  } catch (e) {
    if (e.message === "NOT_SIGNED_IN") {
      $("who").textContent = "Session expired — sign in again from the toolbar icon.";
      $("content").innerHTML = "";
      return;
    }
    showMessage(`Couldn't load your applications: ${e.message}`, true);
  }
}

$("refresh").addEventListener("click", load);
load();
