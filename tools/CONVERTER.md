# PDF conversion — how a tailored Word CV becomes a PDF

The extension tailors a CV by editing the user's own `.docx` in place, so their
layout, fonts and page count survive exactly. Application forms usually want a
PDF, and that conversion is the one part of the pipeline a browser genuinely
cannot do: every JavaScript converter re-renders the document through HTML,
which is a different layout engine and undoes the whole point.

So a real word processor has to do it. There are three ways that can happen,
and the extension tries them in this order.

| | Who runs it | User installs | Cost | Document leaves the machine |
|---|---|---|---|---|
| 1. Local helper | the user | LibreOffice | free | no |
| 2. Hosted converter | you | nothing | ~free at this scale | to your server |
| 3. No conversion | — | nothing | free | no |

Option 3 is not a failure. Greenhouse, Lever, Ashby, Personio, Workday and
SmartRecruiters all accept `.docx`, and their parsers generally read Word better
than PDF. When neither converter is reachable the `.docx` is attached and the
application proceeds normally.

---

## For everyone else: the hosted converter

This is the one to deploy before sharing the extension. Users sign up, upload a
CV and get PDFs; nothing on this page is visible to them.

### 1. Deploy Gotenberg

[Gotenberg](https://gotenberg.dev) is an Apache-2.0 container wrapping
LibreOffice behind an HTTP API. Cloud Run is the cheapest place to put it
because it scales to zero — you pay only while a conversion is running.

```bash
gcloud run deploy gotenberg \
  --image gotenberg/gotenberg:8 \
  --region europe-west1 \
  --memory 2Gi --cpu 2 \
  --allow-unauthenticated \
  --set-env-vars "GOTENBERG_API_BASIC_AUTH_USERNAME=x" \
  --args="gotenberg,--api-timeout=60s"
```

Fly.io, Render and any VPS with Docker work the same way.

**A note on cost.** Cloud Run's free tier is 180,000 vCPU-seconds a month. A CV
conversion takes roughly 2–3 seconds of CPU, so the free tier covers something
like 60,000 conversions a month. For a few dozen users this is free.

**A note on cold starts.** Scaled to zero, the first conversion after an idle
period waits for the container to boot — 10–20 seconds for this image. The
extension allows 60 seconds and falls back to `.docx` beyond that, so a cold
start costs one Word attachment rather than a failure. If that bothers you,
`--min-instances=1` keeps one warm for a few dollars a month.

### 2. Point the edge function at it

```bash
supabase secrets set GOTENBERG_URL=https://gotenberg-xxxx.run.app
supabase secrets set GOTENBERG_TOKEN=<a long random string>
supabase functions deploy docx-to-pdf
```

`GOTENBERG_TOKEN` is optional and only needed if your Gotenberg is reachable
from the internet — which it is with `--allow-unauthenticated` above. Set it,
and configure Gotenberg to require it, or lock the service down with IAM
instead. **Do not leave an open converter on the internet**: it is a free
file-conversion service for anyone who finds it, billed to you.

### 3. Run the migration

```bash
psql "$DATABASE_URL" -f sql/006_conversion_log.sql
```

This creates the per-user daily counter the function checks (120 conversions per
user per rolling day). Without the table the function still converts — the count
is best-effort, because refusing a real CV over bookkeeping is the wrong trade —
but nothing is capped.

### Why it goes through an edge function

Same reason model calls go through `ai-proxy`: the endpoint you pay for should
not be reachable by anyone who reads the extension source, and every request
should be attributable to a signed-in user before it costs anything. The
function checks the JWT, enforces the cap and the size limit, verifies the
result really is a PDF, and keeps the Gotenberg URL and token server-side.

### What is stored

Nothing of the document. The `.docx` passes through the function and Gotenberg
in memory. `conversion_log` records the user id, the byte counts and a
timestamp — enough to enforce a cap and see what the thing costs, and nothing
worth reading if it leaked.

---

## For yourself: the local helper

Faster, free, and the CV never leaves the machine. Worth running on your own
laptop; not something to ask users for.

```bash
brew install --cask libreoffice
```

```bash
python3 tools/docx2pdf.py
```

The extension probes `127.0.0.1:8765` first and uses it when it answers. Nothing
listening refuses the connection immediately, so users who never run it pay no
measurable delay.

To start it at login:

```bash
python3 tools/docx2pdf.py --install-help
```

---

## Checking which path ran

`docgen.js` returns `converted: true` when a PDF was produced. The saved file
tells you too — a `.pdf` in the application folder means a converter answered, a
`.docx` means neither did. The service worker console logs a warning for every
failure except `503 not_configured`, which is silent because it is the ordinary
state before you deploy.
