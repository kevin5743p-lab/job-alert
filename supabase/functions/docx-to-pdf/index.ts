// docx-to-pdf — turning a tailored Word CV into a PDF, with nothing to install.
//
// WHY THIS EXISTS
//
// The extension tailors a CV by editing the user's own .docx in place, which is
// the only way to keep their layout, fonts and page count exactly as they made
// them. Most application forms then want a PDF, and no browser can produce one
// from a .docx without re-rendering through HTML — a different layout engine
// that has never seen their template, which moves margins, reflows tables and
// turns one page into two. That is not a conversion, it is a redraw.
//
// Only a real word processor converts Word properly. The first version of this
// asked each user to install LibreOffice and run a local helper, which is fine
// for the developer and absurd for everybody else: people install an extension,
// sign up, and expect it to work. So the word processor runs on OUR
// infrastructure instead, and users never learn it exists.
//
// WHAT IT TALKS TO
//
// Gotenberg (https://gotenberg.dev) — an Apache-2.0 container wrapping
// LibreOffice behind an HTTP API. Deploy it once; see DEPLOY below. This
// function is the gatekeeper in front of it, for the same reason ai-proxy
// stands in front of Anthropic: a converter reachable from the open internet is
// a free file-conversion service for the whole internet, billed to us.
//
// WHAT THIS ADDS OVER CALLING GOTENBERG DIRECTLY
//
//   - the Gotenberg URL and token stay server-side
//   - the caller must be a signed-in user of this app
//   - a per-user daily cap, so one person cannot burn the budget
//   - a size cap, because a CV is not 40 MB
//
// PRIVACY. The document passes through this function and Gotenberg in memory
// and is never written to disk or logged. Users who would rather it never left
// their machine can still run tools/docx2pdf.py, which the extension prefers
// when it is available.
//
// DEPLOY
//   1. Deploy Gotenberg somewhere that can run a container. Cloud Run's free
//      tier covers a large number of conversions; Fly.io and Render also work.
//
//        gcloud run deploy gotenberg \
//          --image gotenberg/gotenberg:8 \
//          --region europe-west1 --memory 2Gi --cpu 2 \
//          --no-allow-unauthenticated \
//          --args="gotenberg,--api-timeout=60s"
//
//      Keep it private and give this function a service identity, or put it
//      behind a shared secret with --allow-unauthenticated and GOTENBERG_TOKEN.
//
//   2. supabase secrets set GOTENBERG_URL=https://gotenberg-xxxx.run.app
//      supabase secrets set GOTENBERG_TOKEN=<a long random string>   # optional
//      supabase functions deploy docx-to-pdf
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A two-page CV with a photo is comfortably under a megabyte. Ten is room for
// an unusually image-heavy one and still far below anything worth worrying
// about; the request is held in memory, so this is also the memory ceiling.
const MAX_BYTES = 10 * 1024 * 1024;

// Per user, per rolling day. Someone applying hard sends perhaps thirty
// applications in a day and re-tailors a few, so this is generous for real use
// and still bounds a runaway loop.
const DAILY_LIMIT = 120;

const CONVERT_TIMEOUT_MS = 55_000;

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }

  const gotenberg = Deno.env.get("GOTENBERG_URL");
  if (!gotenberg) {
    // Not an error the user can act on, and not a reason to fail their
    // application: the extension reads this and keeps the .docx.
    return json({ error: "not_configured" }, 503, origin);
  }

  // ── who is calling ────────────────────────────────────────────────────────
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "not_signed_in" }, 401, origin);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: "not_signed_in" }, 401, origin);

  // ── how much they have used ───────────────────────────────────────────────
  // Best-effort. If the counter table is missing or unreachable we convert
  // anyway: refusing a real user's CV because bookkeeping is down is the wrong
  // way round. The cap exists to stop a loop, not to police anyone.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await admin
    .from("conversion_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", since);

  if ((count ?? 0) >= DAILY_LIMIT) {
    return json({ error: "daily_limit", limit: DAILY_LIMIT }, 429, origin);
  }

  // ── the document ──────────────────────────────────────────────────────────
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return json({ error: "empty_body" }, 400, origin);
  if (body.byteLength > MAX_BYTES) {
    return json({ error: "payload_too_large", limit: MAX_BYTES }, 413, origin);
  }

  const bytes = new Uint8Array(body);
  // A .docx is a zip, so it starts with "PK". Checking here means a mistake in
  // the client shows up as a clear 400 rather than a puzzling LibreOffice error.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return json({ error: "not_a_docx" }, 400, origin);
  }

  // ── convert ───────────────────────────────────────────────────────────────
  const form = new FormData();
  // Gotenberg picks the converter from the extension, so the name matters.
  form.append("files", new Blob([bytes], { type: DOCX_MIME }), "cv.docx");
  // Keep LibreOffice's own PDF export rather than a re-print through Chromium.
  form.append("pdfa", "");

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), CONVERT_TIMEOUT_MS);

  let pdf: Uint8Array;
  try {
    const token = Deno.env.get("GOTENBERG_TOKEN");
    const resp = await fetch(
      `${gotenberg.replace(/\/+$/, "")}/forms/libreoffice/convert`,
      {
        method: "POST",
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: control.signal,
      },
    );

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(`gotenberg ${resp.status}: ${detail.slice(0, 400)}`);
      return json({ error: "conversion_failed", status: resp.status }, 502, origin);
    }
    pdf = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    console.error("gotenberg unreachable:", (e as Error)?.message);
    return json({ error: aborted ? "conversion_timeout" : "converter_unreachable" },
                504, origin);
  } finally {
    clearTimeout(timer);
  }

  // Never hand back something that isn't a PDF. The extension checks this too,
  // because a Gotenberg error page attached to an application as a "CV" is the
  // worst outcome available here.
  if (pdf.length < 5 ||
      String.fromCharCode(...pdf.subarray(0, 5)) !== "%PDF-") {
    return json({ error: "conversion_failed" }, 502, origin);
  }

  // Bookkeeping after the fact, so a logging failure cannot cost the user a
  // conversion they are waiting on. Records that a conversion happened and how
  // big it was — never the document.
  admin.from("conversion_log").insert({
    user_id: user.id, in_bytes: bytes.length, out_bytes: pdf.length,
  }).then(({ error }) => {
    if (error) console.error("conversion_log insert failed:", error.message);
  });

  return new Response(pdf, {
    status: 200,
    headers: { ...cors(origin), "Content-Type": "application/pdf" },
  });
});
