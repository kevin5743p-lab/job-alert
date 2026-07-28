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
     background.js   reads your key + CV from local storage, calls Groq,
       │             runs the no-fabrication grounding check
       ▼
     tailor_core.js  the shared "brain" — same prompt/logic as tailor.py
```

Your Groq key and CV live in `chrome.storage.local` (this browser only) and never
touch the web page. The Groq call is made from the background worker, from your
own machine and IP.

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
