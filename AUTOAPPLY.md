# JobCopilot — Auto-Apply

Click **Apply** in the dashboard and the system writes a CV and cover letter for
that posting, opens the job, walks the application flow, fills every page,
attaches the documents as real PDFs, and submits — stopping and asking you
whenever it hits something it cannot answer honestly.

Nothing has to be tailored by hand first. **Apply** is live on every row from
the moment a job appears; pressing "✦ Tailor this job" yourself is now only for
when you want to read the packet before it goes out, or write a fresh one.

This is a **separate system**. `../extension/` is untouched and still works;
it's the fallback if anything here misbehaves.

---

## What was missing before, and what fixes it

| Gap in `../extension/` | Fixed by |
|---|---|
| `type=file` inputs skipped entirely — no CV ever reached a form | `docgen.js` renders real PDFs, `upload.js` attaches them |
| "It NEVER submits", by design | `confidence.js` decides, `apply_agent.js` acts |
| One DOM snapshot, then stop — Workday's 5 pages died on page 1 | the observe → act → verify loop |
| Apply was a plain `<a href>` | a real button, a queue, and a live status panel |
| Apply needed a job tailored by hand first, so the button was greyed out on everything a scan found | `tailor_run.js` — the run writes its own packet from the posting's text |

Everything the old build did well is reused rather than rewritten:
`tailor_core.js`, `print_doc.js`, `matcher.js`, `finder.js` and the field
matcher in `autofill.js` are the same code.

---

## Setup

**1. Database.** Run `sql/001_apply_engine.sql`, then `sql/007_apply_memory.sql`,
in the Supabase SQL editor. Both are `CREATE TABLE` / `ADD COLUMN` only — the
old extension and the Python bot keep working against the same project,
unaffected. Skipping 007 costs you the feedback loop and nothing else: every
call into it is best-effort, so applications run exactly as they did before.

**2. Load the extension.** `chrome://extensions` → Developer mode → Load
unpacked → `AutoApply/extension`.

> Both extensions match the same job sites. Keep the old one installed but
> **toggled off**, or you'll get two floating buttons racing each other. One
> click re-enables it if you ever need it.

**3. Keys.** Toolbar icon → sign in → paste your **Groq** key (scanning and
field matching, as before) and your **Anthropic** key (the apply loop). Both
live in `chrome.storage.local` and never go to Supabase.

**4. Leave "When a form is complete" on _let me press submit_** for your first
several applications. Watch what it produces before you let it send one.

---

## How a single application runs

```
Apply clicked
  │
  ├─ aggregator posting?  →  resolve_ats.js finds the employer's own ATS
  │                          (or parks it for you — it is never applied to
  │                           through Indeed/StepStone/Xing)
  ▼
router.js         claims the job, checks the domain is healthy and not capped
  ▼
tailor_run.js     no packet for this job? write one — from the description the
  │               scan stored, or (job_text.js) from the posting itself
  ▼
docgen.js         print_doc.js HTML → hidden tab → Page.printToPDF → disk + Storage
  ▼
loop, ≤25 steps / 4 min
  ├─ apply_engine.js   serialise the page to ~2K tokens of JSON
  ├─ domain_health.js  block signal? → quarantine this domain, stop, leave
  ├─ autofill.js       fill everything the saved profile covers      (free)
  ├─ Groq              map leftover labels onto profile keys        (cheap)
  ├─ upload.js         attach the CV / cover letter
  └─ Claude Sonnet 5   what next, and any free text — with a citation
  ▼
confidence.js     deterministic pre-submit check
  ├─ pass → submit
  └─ fail → screenshot, pause, notify you
```

### The grounding contract

Every tool that produces a *value* must say where it came from — a profile key,
or a quote from the CV. `confidence.js` checks those claims against the real CV
before anything is submitted. A model that cannot cite has exactly one legal
move left: `pause`.

`test/confidence.test.mjs` covers this. Run it before trusting a change:

```bash
node test/confidence.test.mjs
```

### What it remembers

Every finished run is read back. `apply_runs.steps` was always a faithful audit
trail and nothing ever looked at it, so the eleventh application to an
employer's Workday tenant repeated the first one's mistakes exactly.

Two kinds of memory, because they answer different questions:

| | |
|---|---|
| **a lesson** | a problem and the fix that worked, scoped to where it holds. "Workday hides the CV upload behind Continue" is true of every tenant; "this employer wants a photograph" is true of one |
| **a playbook** | what applying to *one employer* involves — the documents they want, whether their system needs an account, the screening questions they ask and the answers that went through |

Scope is what makes a lesson worth more than a note. Learn something about
Greenhouse once, at any employer, and every Greenhouse application benefits.
Company keys come from `job_key.js`, so the playbook written by a Greenhouse
application is found by a later Workday one at the same employer — "BMW AG" and
"BMW Group" are the same company.

```
run finishes
  │
  ├─ settle      credit or blame the remedies this run was carrying
  ├─ extract     deterministic, from the step log            (free)
  ├─ distil      one Haiku call — only if the run stopped    (~0.1¢)
  ▼
apply_lessons · company_playbooks · apply_outcomes
  │
  ▼
next run at the same employer
  ├─ <learned> block in the prompt, after the cache breakpoint
  ├─ label → profile-key mappings warmed into the local field cache
  ├─ known-required documents enforced by confidence.js
  └─ "needs an account" said upfront instead of four minutes in
```

### When it stops, and what picking it up again does

A paused run leaves its tab open on the page it stopped on, and the desktop
notification now opens that tab when you click it. Doing whatever it asked —
signing in, clicking the real Apply button, ticking a box — and then pressing
**Resume** on the row carries on *in that same tab*, from the page you left it
on. It does not reopen the posting or re-do the pages already filled.

The button says **Resume** when there is a tab to go back to and **Retry** when
there is not.

Two guards decide when to stop rather than keep going:

| | |
|---|---|
| **the page didn't move** | Every action is fingerprinted by the *text* of what it acted on, not the element id — a page with two buttons both reading "Apply now" is one action, not two. A move that changes nothing on screen twice is refused a third time, and four dead moves hand the run back |
| **the credential wall** | A required password or ID field stops the run — unless something is already in it, in which case the browser filled it and there is nothing to write |

**The loop closes on evidence, not on writing things down.** Every run records
which remedies it carried and how far it got, on a coarse scale from "nothing"
to "submitted". The next run at the same problem compares the two. A remedy that
stops moving runs further along is retired after three failures — kept as a
tombstone, not deleted, so the next run does not rediscover and rewrite it.

Two rules keep the memory honest, and both are enforced rather than requested:

- **A lesson must cite the step it came from.** Same contract the apply agent
  lives under. One that cites a step index that does not exist was not read off
  the trail, and is dropped.
- **A remedy must be one of six shapes** the system can actually act on
  (`REMEDY_KINDS` in `learn.js`). Prose advice with no reader is a diary entry.

Nothing learned here can put a value into a form. The `<learned>` block is a
hint about how a *form* behaves; every value still has to come from the profile
or the CV, and still passes `confidence.js`.

The dashboard shows all of it under **What it has learned**, with a Forget
button — a wrong lesson is followed by every future run at that employer, so it
has to be visible and removable. "Always keep" pins a lesson so no later run can
overwrite or retire it.

Cost: nothing on a clean submit — everything worth keeping from a successful
application is already structured in the step log. The model is asked only about
a run that stopped.

### What it will never do

- Tick a consent, terms, privacy, or marketing checkbox — always yours
- Answer a visa, salary, notice-period, or demographic question from reasoning
  rather than from your saved profile
- Fill a password, passport number, IBAN, or tax ID. A sign-in page your own
  password manager has already filled is the one thing it will click through:
  the fields are reported as `blocked` with a `prefilled` flag and nothing
  else — never their contents — so there is nothing left for the run to type
- Attempt a CAPTCHA or bot check. If a site puts one up, that domain is
  quarantined for 24h and the run stops

---

## Site tiers

| Tier | Sites | Behaviour |
|---|---|---|
| **0** | Greenhouse, Ashby, Lever, Personio, Recruitee, SmartRecruiters, Workable, Teamtailor… | Plain DOM. The debugger is never attached. 40/day |
| **1** | Workday, LinkedIn, SuccessFactors, iCIMS, Taleo, Avature… | Real key/mouse events via CDP, needed for custom widgets. 15/day |
| **2** | Indeed, StepStone, Xing | **Never applied to directly.** Resolved to the employer's own ATS, or handed to you |

Applications are spaced 45s–3m (tier 0) or 4–12m (tier 1) apart, jittered, and
pause overnight (23:00–06:00).

### Why Tier 2 works this way

Most aggregator listings are "Apply on company site" — a pointer to a
Greenhouse or Lever posting the employer actually owns. `resolve_ats.js` asks
those boards' public APIs by company and title and applies there instead. That
is the better application anyway: it lands in the ATS the recruiter reads, it
carries the real attachments, and it doesn't depend on an aggregator's apply
flow staying put. Anything that exists nowhere else is surfaced for you with
one click, with its tailored documents already generated.

### The isolation guarantee

`router.js` walks the queue **per domain**. If a domain is quarantined, capped,
or pacing, it is skipped and the loop continues with the next one. There is no
global pause flag anywhere.

Concretely: LinkedIn going quiet does not slow a single Greenhouse application.
The dashboard's "Paused sites" panel exists to make that visible.

---

## Cost

| Component | Model | Notes |
|---|---|---|
| Scanning, scoring | Groq | unchanged |
| Field → profile mapping | Groq | unchanged, with the learned-label cache |
| Navigation + grounded answers | `claude-sonnet-5` | prompt-cached prefix |
| Hard Workday flows | `claude-opus-5` | only after 2 failed attempts |
| Post-mortem, on a stopped run | `claude-haiku-4-5` | capped at 1.5K out; never on a clean submit |

The system prompt, tools, profile, and CV are identical on every step of every
job, so a cache breakpoint after the CV turns a ~6K-token prefix into a ~600
token read. Roughly **2–8¢ per application**; ~£3–8 for 100.

---

## Files

**New**

| File | |
|---|---|
| `apply_agent.js` | the loop, the Claude client, the tool contract |
| `apply_engine.js` | content script: page → JSON, and the actuator |
| `confidence.js` | the pre-submit gate |
| `router.js` | the queue, and the per-domain isolation |
| `domain_health.js` | tiers, caps, pacing, circuit breaker |
| `resolve_ats.js` | aggregator → employer's own ATS |
| `docgen.js` + `render.html/js` | the PDF pipeline |
| `upload.js` | DataTransfer and CDP attachment paths |
| `cdp.js` | `chrome.debugger` wrapper, scoped to Input/DOM/Page |
| `learn.js` | the feedback loop: recall before a run, record after one |

**Extended:** `manifest.json`, `autofill.js` (file inputs), `background.js`
(message surface), `supabase.js` (queue + Storage), `dashboard.*`, `popup.*`

**Verbatim from the old build:** `tailor_core.js`, `print_doc.js`,
`cover_templates.js`, `matcher.js`, `finder.js`, `content.js`, `content.css`,
`theme.css`, `onboarding.*`

---

## Known limits

- **Workday tenants that require an account.** Signup with a password is out of
  scope; the run pauses. Once you have an account for that tenant, later
  applications run clean.
- **LinkedIn and Indeed forbid automation in their terms.** Real browser, your
  session, low volume — the risk is account restriction, reduced but not
  removed. Tier 2 sidesteps it entirely by applying on the employer's site.
- **An auto-submitted mistake is final.** The gate is strict and every answer is
  logged with its grounding in `apply_runs.steps`, so you can audit what went
  out — but you cannot recall it.
- **`../extension/` is frozen.** Fixes made here do not flow back to it. That's
  the trade: it's a known-good snapshot, not a maintained twin.
