# JobCopilot — Tailor (browser extension, v0.1)

The first slice of the copilot's browser interface: on a LinkedIn job page, click
**✦ Tailor this job** and get a tailored summary, CV bullets (each grounded in your
real CV), a match/gap analysis, and a cover letter — in a side panel.

This is a **proof-of-concept**: LinkedIn only, CV pasted into the popup, no
Supabase yet. It reuses the exact prompt from the Python `tailor.py`.

## How it works

```
LinkedIn job page
  └─ content.js      reads the job off the page, injects the button + panel
       │ (chrome message)
       ▼
     background.js   gets your CV (Supabase profile, or local fallback),
       │             calls Groq, runs the no-fabrication grounding check,
       │             saves the result + tracks the job
       ├─ tailor_core.js  the shared "brain" — same prompt/logic as tailor.py
       └─ supabase.js     auth + storage (REST/Auth, no SDK bundle)
```

**Where your data lives**

| Thing | Where | Why |
|---|---|---|
| Groq API key | `chrome.storage.local` only | A secret — never leaves your machine |
| CV | Supabase profile (+ local fallback) | Follows you across devices |
| Tailored results & tracked jobs | Supabase | History + application pipeline |

The Groq call runs from the background worker — your own machine and IP, never
the page context. Every Supabase table has Row Level Security, so each account
can only ever read or write its own rows.

## Account (optional)

Sign in from the popup to sync your CV and save results. Without an account the
extension still works — the CV just stays local and nothing is saved.

**You do not need a Supabase account.** Everyone shares one hosted project, and
you simply sign up inside the extension with an email and password. Your rows
live under your own user id; row-level security means an account can only ever
read or write its own data — verified by trying: a second account cannot list,
query by id, insert as, or update another account's rows.

What stays on your machine regardless: your **Groq API key** (a secret, never
uploaded) and a local copy of your CV for offline use.

### Connecting the job-alert bot to your tracker

If you also run the Python job-alert bot, add two repository secrets and its
scans will populate the same tracker:

| Secret | Value |
|---|---|
| `SUPABASE_EMAIL` | the email you signed up with |
| `SUPABASE_PASSWORD` | your password |

The project URL and anon key are already built in. (Set `SUPABASE_URL` and
`SUPABASE_ANON_KEY` only if you want to point at a different project.)

## Supported sites

"Tailor" needs a job description on the page; "Fill" needs an application form.
Anywhere else, the buttons simply don't appear.

| Site | Tailor | Fill | Notes |
|---|:--:|:--:|---|
| LinkedIn | ✅ | ✅ | both the job page and the search split-view |
| Indeed | ✅ | ✅ | |
| Workday (`myworkdayjobs`, `myworkdaysite`) | ✅ | ✅ | most German corporates apply here |
| Greenhouse | ✅ | ✅ | |
| Ashby | ✅ | ✅ | |
| Lever | ✅ | ✅ | |
| Personio | ✅ | ✅ | German Mittelstand |
| Recruitee | ✅ | ✅ | |
| SmartRecruiters | ✅ | ✅ | |

Adding a site is a few lines: a match pattern in `manifest.json` and an entry in
the `SITES` registry in `content.js`. Even without one, the generic reader
(longest text block + `document.title`) often works.

## What autofill will and won't do

Fills your saved answers into text fields, dropdowns and multiple-choice
questions (English and German), and drafts free-text answers from your CV.

**How fields are recognised.** Rules first: each profile field knows the
keywords ("city", "Ort") and the phrasings forms actually use ("where do you
currently live?"). Anything left over is sent to the model to *classify* — it
picks which of your saved answers belongs in the box. It is never asked to
produce a value, so it cannot invent personal data; the worst a wrong guess can
do is put the wrong saved answer somewhere, which you'll see highlighted.

Each new label costs one AI call and is then remembered, so repeat forms fill
instantly and for free — the tool gets better the more forms you use it on.

It deliberately refuses to:

- **submit anything** — you review and press the site's own button;
- **tick consent boxes** — terms, privacy, background checks, newsletters are
  decisions, not data entry;
- **fill passwords or ID/financial fields** — SSN, passport, IBAN, card, tax id,
  date of birth. Those belong in your password manager.

It also never overwrites a value you already typed, and highlights every field
it changes so nothing happens invisibly. Drafted free-text answers are drafts:
read them before submitting.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the JobCopilot icon in the toolbar → paste your **Groq API key**
   (free at console.groq.com) and your **CV** → **Save**.

## Use

1. Open any LinkedIn job posting (`linkedin.com/jobs/...`).
2. Click **✦ Tailor this job** (bottom-right).
3. Read the tailored packet in the side panel; use the **Copy** buttons.

## Known limits (v0.1)

- **LinkedIn only.** Reading the job relies on LinkedIn's DOM selectors
  (`content.js` → `readJob()`); if LinkedIn reshuffles its markup, update those.
- **CV is pasted manually** (Supabase sync comes later).
- **No PDF/DOCX export yet** — copy/paste for now.
- **Not published to the Web Store** — load-unpacked only.

## Keep in sync

`tailor_core.js` mirrors `../tailor.py`. If you tune the prompt in one, mirror it
in the other (later: extract the prompt to a single shared template both load).
