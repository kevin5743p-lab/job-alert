// tailor_run.js — one tailoring, start to finish.
//
// This used to live inside background.js's TAILOR message handler, which meant
// only a person clicking "✦ Tailor this job" on a posting could ever produce a
// packet. The apply engine could not: it is a module, not a message, and it
// cannot send itself a message and wait. So a job had to be tailored by hand
// before it could be applied to, and the Apply button in the dashboard sat
// disabled until someone had gone and done that.
//
// Extracted here, unchanged in behaviour, so both callers share it:
//
//   background.js   the TAILOR message — the in-page button, as before
//   apply_agent.js  an apply run that finds no packet, and makes its own
//
// The Groq path is injected rather than imported. Groq is the signed-out
// fallback and all of its plumbing (the key, the retry/quota handling, the
// shared JSON helper six other calls use) lives in background.js; hauling it
// over here to satisfy one branch would have been the larger change. Callers
// that can be signed out pass `groqTailor`; the apply engine cannot — applying
// requires an account — so it passes nothing and never reaches that branch.

import {
  buildTailorMessages, buildDocxPrompt, extractJson, normalize,
  groundingWarnings, cvGroundingWarnings, coverLetterWarnings,
  coverLetterLengthWarning, cvFingerprint, TAILOR_MAX_TOKENS,
} from "./tailor_core.js";
import { callClaude } from "./ai_client.js";
import { readCvBlocks } from "./docgen.js";
import * as sb from "./supabase.js";

// The same tailoring, on Claude, through ai-proxy. No API key here or anywhere
// else in the extension: the proxy holds it, picks the model, and bills the
// call against this user's monthly allowance.
//
// Uses TAILOR_MAX_TOKENS, not the Groq path's MAX_TOKENS. See the comment on
// that constant: the two providers need very different ceilings for the same
// prompt, and sharing one silently truncated every packet.
async function callClaudeTailor(job, cvText, language) {
  const { system, messages } = buildTailorMessages(job, cvText, language);

  const reply = await callClaude({
    task: "tailor",
    system,
    messages,
    max_tokens: TAILOR_MAX_TOKENS,
    jobUrl: job?.url || null,
  });

  const text = (reply?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (reply?.stop_reason === "max_tokens") {
    // Should not happen now there is real headroom, so if it does, the ceiling
    // is wrong again rather than this packet being unusual. The token count
    // goes in the message because that is the number that identifies which.
    const used = reply?.usage?.output_tokens ?? "?";
    console.warn("Tailoring hit max_tokens", { used, cap: TAILOR_MAX_TOKENS });
    throw new Error(
      `The tailored packet was cut short at ${used} tokens. This is a bug — ` +
      `please report it rather than retrying, since each attempt is charged.`);
  }

  return normalize(extractJson(text));
}

/**
 * The user's Word CV, parsed into blocks — or null if they haven't got one.
 *
 * Parsing costs a background tab, so it is only done for users who actually
 * have a .docx on file, and only on the path that can use the result.
 */
async function docxCvBlocks() {
  const library = await sb.primaryDocuments().catch(() => ({}));
  const cv = library.cv;
  if (!cv?.storagePath) return null;
  const isDocx = /officedocument\.wordprocessingml/.test(cv.mime || "") ||
                 /\.docx$/i.test(cv.filename || "");
  if (!isDocx) return null;

  const base64 = await sb.downloadApplyDoc(cv.storagePath);
  const { blocks, fingerprint, text } = await readCvBlocks(base64);

  // The user's review-panel choices, honoured only for the document they were
  // made against. A block they unticked is not offered to the model at all —
  // no point spending tokens on an edit the applier will refuse.
  const p = (await sb.getProfile().catch(() => null))?.application_profile || {};
  const overrides = p.cv_blocks_fingerprint === fingerprint
    ? (p.cv_block_overrides || null) : null;
  const offered = blocks.map((b) => (
    b.editable && overrides && b.id in overrides && !overrides[b.id]
      ? { ...b, editable: false, why: "you locked this one" }
      : b));

  // A document with nothing safe to rewrite is not worth a different prompt:
  // the model would have no edits to make and we'd lose the JSON path's
  // tailored_cv for nothing.
  if (!offered.some((b) => b.editable)) return null;
  return { blocks: offered, text };
}

/** Tailoring against the user's own Word CV. See buildDocxPrompt. */
async function callClaudeTailorDocx(job, docxCv, language) {
  const reply = await callClaude({
    task: "tailor",
    system: "You are an expert career coach and CV writer. You answer with a " +
            "single JSON object and nothing else — no prose, no code fences.",
    messages: [{ role: "user",
                 content: buildDocxPrompt(job, docxCv.blocks, docxCv.text, language) }],
    max_tokens: TAILOR_MAX_TOKENS,
    jobUrl: job?.url || null,
  });

  const text = (reply?.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("");

  if (reply?.stop_reason === "max_tokens") {
    const used = reply?.usage?.output_tokens ?? "?";
    throw new Error(
      `The tailored packet was cut short at ${used} tokens. This is a bug — ` +
      `please report it rather than retrying, since each attempt is charged.`);
  }

  return normalize(extractJson(text));
}

/**
 * Tailor one posting: pick the CV, call the model, ground-check the result,
 * save it, and hand it back.
 *
 * @param {object} job  { url, title, company, location?, source?, description }
 * @param {object} [opts]
 * @param {boolean} [opts.force]   Skip the saved packet and pay for a fresh one
 *                                 — the "Tailor again" button.
 * @param {boolean} [opts.reuse]   Look for a saved packet at all. The apply
 *                                 engine has already looked, by a wider set of
 *                                 identities than this does, so it turns the
 *                                 second lookup off rather than paying for it.
 * @param {Function} [opts.groqTailor]  (job, cv, key, model, lang) => packet,
 *                                 for the signed-out path. Without it, a user
 *                                 with no session gets NO_KEY.
 * @param {Function} [opts.onProgress]  Called with a short status line. The
 *                                 apply run puts these in its activity panel;
 *                                 the message handler ignores them.
 *
 * @returns {Promise<{result, warnings, saved, signedIn, reused, tailoredAt, tailoredId}>}
 * @throws  Error("NO_CV") | Error("NO_KEY") | whatever the model call threw
 */
export async function tailorJob(job, {
  force = false, reuse = true, groqTailor = null, onProgress = null,
} = {}) {
  const say = (text) => { try { onProgress?.(text); } catch { /* never fatal */ } };

  const { groqApiKey, cvText, language, model } =
    await chrome.storage.local.get(["groqApiKey", "cvText", "language", "model"]);

  // The CV comes from Supabase when signed in (so it follows the user across
  // devices); the locally-stored copy is the offline/signed-out fallback so the
  // extension keeps working without an account.
  let cv = cvText;
  let lang = language;
  let signedIn = false;
  try {
    if (await sb.getSession()) {
      signedIn = true;
      const profile = await sb.getProfile();
      if (profile?.cv_text?.trim()) cv = profile.cv_text;
      if (profile?.language) lang = profile.language;
    }
  } catch (e) {
    // Never let a backend hiccup block tailoring — fall back to local.
    console.warn("Supabase profile fetch failed, using local CV:", e);
  }

  if (!cv || !cv.trim()) throw new Error("NO_CV");

  // Signed in, tailoring runs on Claude through ai-proxy — better packets, and
  // it costs the user nothing because the shared key is metered against their
  // monthly allowance rather than their own quota. Signed out there is no
  // allowance to meter, so it falls back to the user's own Groq key, which is
  // also what keeps the extension usable without an account.
  if (!signedIn && !(groqApiKey && groqTailor)) throw new Error("NO_KEY");

  const fingerprint = cvFingerprint(cv);

  // Re-opening a posting that was already tailored used to pay for the whole
  // packet again. The result was being saved all along; nothing ever read it
  // back. Reuse it instead — but only when it was written from the CV in use
  // now, because a packet built from a replaced CV is worse than no packet: it
  // is wrong in a way the user cannot see. A row with no fingerprint is treated
  // as unknown and re-tailored.
  //
  // `force` is the "Tailor again" button, for when the posting or the mood has
  // changed rather than the CV.
  //
  // Matched on job identity rather than URL alone: a user who tailors on
  // LinkedIn and then follows "Apply on company site" lands on the employer's
  // own board, where the URL is different but the job is not. Keying on the URL
  // charged them a second time for the same posting.
  if (signedIn && reuse && job && !force) {
    try {
      const prev = await sb.tailoredForJob({
        url: job.url, company: job.company, title: job.title,
      });
      if (prev?.packet && prev.cv_fingerprint &&
          prev.cv_fingerprint === fingerprint) {
        return {
          result: prev.packet,
          warnings: Array.isArray(prev.warnings) ? prev.warnings : [],
          saved: true, signedIn: true, reused: true,
          tailoredAt: prev.created_at || null,
          tailoredId: prev.id || null,
        };
      }
    } catch (e) {
      // A lookup failure must never block tailoring — fall through and
      // generate, which costs tokens but always produces something.
      console.warn("Couldn't check for a saved packet:", e);
    }
  }

  // If this user keeps their CV as a Word file, tailor THAT rather than writing
  // a new one from scratch. Their formatting, their layout, their page count —
  // see docx_edit.js. Only on the signed-in path: it needs the document
  // library, which lives behind the account.
  const docxCv = signedIn ? await docxCvBlocks().catch((e) => {
    // A CV we can't parse is a reason to fall back to the JSON path, not to
    // fail the tailoring the user is waiting on.
    console.warn("Couldn't read the Word CV, using the renderer path:", e);
    return null;
  }) : null;

  say(docxCv
    ? "Tailoring your Word CV and writing the cover letter…"
    : "Writing your tailored CV and cover letter…");

  const result = docxCv
    ? await callClaudeTailorDocx(job, docxCv, lang || "en")
    : signedIn
      ? await callClaudeTailor(job, cv, lang || "en")
      : await groqTailor(job, cv, groqApiKey, model, lang || "en");

  // The CV's facts are checked separately and more strictly than the letter's
  // claims: an employer verifies a CV, so a title or employer that isn't in the
  // source has to be surfaced, not smoothed over.
  //
  // The letter gets its own pass. It used to get none — the two checks above
  // cover relevant_experience and tailored_cv, so the one part of the packet
  // written as free prose was the one part nothing verified.
  const warnings = groundingWarnings(result, cv)
    .concat(cvGroundingWarnings(result.tailored_cv, cv))
    .concat(coverLetterWarnings(result, cv))
    .concat(coverLetterLengthWarning(result) || []);

  // Persist the run + track the job. Best-effort: a save failure must not lose
  // the result the caller is waiting for.
  let saved = false;
  let tailoredId = null;
  if (signedIn) {
    try {
      const row = await sb.saveTailoredResult(job, result, warnings, fingerprint);
      tailoredId = row?.id || null;
      await sb.upsertApplication(job, tailoredId, result);
      saved = true;
    } catch (e) {
      console.warn("Supabase save failed:", e);
    }
  }

  return { result, warnings, saved, signedIn, reused: false,
           tailoredAt: null, tailoredId };
}
