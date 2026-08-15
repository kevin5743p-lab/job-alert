# Phase 3 — unattended daemon (not built yet)

Empty on purpose. The plan is to build this only once the extension engine has
proven itself on real postings, because it shares the same brain and there is no
point hardening a loop twice.

What goes here:

- **Playwright `connectOverCDP`** against dedicated Chrome profiles, so
  applications continue while Chrome is closed. You sign in once per profile and
  the session persists.
- **One profile per tier** (`profile-ats`, `profile-social`) — this is what makes
  the isolation physical rather than just logical: a cookie-level flag on one
  platform cannot correlate to another.
- **The same queue.** It polls `apply_runs` exactly as the extension does, so
  both can run without handing the same job to both — `claim_apply_run()` uses
  `FOR UPDATE SKIP LOCKED` for precisely this.
- **The same brain.** `apply_agent.js` and `confidence.js` get extracted here
  rather than reimplemented. Two copies of a submit gate is two gates that drift,
  and the one that drifts is the one that sends a bad application.
- **A `launchd` plist**, on the scraper's existing 2-hour cadence and quiet hours.
