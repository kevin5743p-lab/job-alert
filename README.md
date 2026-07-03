# 🚗 Job Alert System

Automated job hunt for automotive engineering students in Germany. Runs on
GitHub Actions every 2 hours, grades every posting 0–100 against your CV with
a free Groq LLM, and pushes tiered alerts to Telegram.

- **Multi-source fetching:** Arbeitnow, Adzuna, LinkedIn (guest API), Xing,
  company ATS portals (Mercedes-Benz, Bosch, Continental, ZF, Porsche,
  Volkswagen, Valeo, Wayve, Mobileye, Apex.AI, Helm.ai, Aurora) and
  SAP SuccessFactors career sites (BMW, Audi, CARIAD, Schaeffler)
- **Two-stage matching:** free rule-based pre-filter cuts the noise → Groq
  scores survivors against your actual CV (`cv.md`)
- **Three tiers:** 🟢 strong (≥75) and 🟡 worth a look (≥50) are alerted
  immediately; 🔴 rejected is archived, with one compact daily summary at 21:00
- **Bilingual EN+DE**, rejects postings that demand fluent German
- **Deduplication:** never see the same job twice (`state/seen_jobs.json`)
- **Quiet hours:** no pings 23:00–06:00 Berlin time (DST-safe)
- **Free:** GitHub Actions + Groq free tier + public job APIs

## ⚠️ Before anything else: rotate old credentials

If you used the previous version of this project, its `config.yaml` contained
live credentials. Treat all of them as compromised:

1. **Groq key** — revoke at https://console.groq.com → API Keys
2. **Gemini key** — revoke at https://aistudio.google.com/apikey
3. **Gmail app password** — remove at https://myaccount.google.com/apppasswords
4. **LinkedIn `li_at` cookie** — log out of all LinkedIn sessions
   (Settings → Sign in & security → Where you're signed in)

This repo never stores secrets in files. `main.py` refuses to run if
`config.yaml` looks like it contains an API key.

## Setup (~20 minutes, all free)

### 1. Groq API key (the AI grader)
Sign up at https://console.groq.com → **API Keys** → Create. Copy the
`gsk_...` key. Without it the system still works using rule-based scoring only.

### 2. Telegram bot (the alerts)
1. Message **@BotFather** in Telegram → `/newbot` → pick a name → copy the
   **bot token** (`123456:ABC-...`).
2. **Send any message to your new bot** (bots can't message you first).
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser
   and copy `message.chat.id` — that's your **chat ID**.

### 3. Adzuna (optional, recommended — reliable German job board API)
Sign up at https://developer.adzuna.com/signup (free, 1000 calls/month,
no credit card) → note the **app ID** and **app key**.

### 4. Personalize
- `profile.yaml` — your name, skills, target titles, locations, thresholds
- `cv.md` — paste your real CV (big quality boost for the AI grading)
- `config.yaml` — search queries, platform toggles, schedule

The shipped profile/CV is a **reference template** for a typical automotive
masters student (ADAS/sensor skills, German ~B1) — edit it to match you.

### 5. Local test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python main.py --source arbeitnow        # smoke-test one fetcher (no AI, prints only)
python main.py --dry-run --no-ai         # full pipeline, rule scores only
export GROQ_API_KEY=gsk_...              # then with AI:
python main.py --dry-run

export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
python main.py --test-telegram           # one test message
python main.py                           # first real run
```

### 6. GitHub (the every-2-hours automation)
1. Create a **private** repository (this repo contains your CV).
2. Push this project to it.
3. Repo **Settings → Secrets and variables → Actions → New repository secret**,
   add:

   | Secret | Required | From |
   |---|---|---|
   | `GROQ_API_KEY` | recommended | step 1 |
   | `TELEGRAM_BOT_TOKEN` | yes | step 2 |
   | `TELEGRAM_CHAT_ID` | yes | step 2 |
   | `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | optional | step 3 |
   | `LINKEDIN_LI_AT` | optional | browser cookie, richer LinkedIn results |

4. **Actions** tab → enable workflows → select **job-alert** → **Run
   workflow** (tick *force* to ignore quiet hours) for a first cloud test.
5. Done — the cron (`23 */2 * * *` UTC) takes over from here.

> GitHub disables scheduled workflows after 60 days without repo activity.
> The state commits made by each run keep the repo active automatically, and
> GitHub emails you before disabling anything.

## How it works

```
fetch (6 sources, isolated) → dedup (30-day history)
  → rule pre-filter (free, threshold 15)
  → domain classify (rules ~80% free, Groq for ambiguous)
  → Groq score 0-100 with CV context (≤60 calls/run, 2.2s pacing)
  → tier: strong ≥75 / worth_look ≥50 / rejected
  → Telegram alert + archive → commit state back to repo
```

Graceful degradation: any fetcher can fail without killing the run; if the
Groq daily quota runs out mid-run, remaining jobs surface in 🟡 with an
"unscored" flag; with no `GROQ_API_KEY` at all, rule-based scores drive the
tiers.

## Layout

| Path | Purpose |
|---|---|
| `main.py` | single-run pipeline + CLI |
| `fetchers/` | one module per job source, `fetch_all` isolates failures |
| `matchers/` | rule pre-filter, domain classifier, Groq client/scorer, tier router |
| `notifiers/telegram.py` | message formatting, packing, rate-limit handling |
| `state/` | `seen_jobs.json`, daily archives — committed back by the workflow |
| `.github/workflows/job-alert.yml` | the every-2-hours cron |

## v2 ideas (designed, not built)

- Telegram inline 👍/👎 buttons on borderline jobs; each run polls
  `getUpdates` and learns rejection patterns into `state/memory.json`
  (the scoring prompt already reads learned patterns if that file exists —
  you can hand-edit it today).
