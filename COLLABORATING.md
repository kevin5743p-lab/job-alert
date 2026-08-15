# Working on this together

Written for two people who have not used git from a terminal. Nothing here
needs a terminal, and none of it is hard — it is three buttons.

The one thing to understand up front: **the GitHub website cannot send changes
down to your computer.** You can upload through it, but there is no "download
the latest into my folder" button. That is why editing on the website stops
working the moment two people are involved — and it is exactly how this project
ended up as two folders, `AutoApply` and `AutoApply1`, that had to be merged by
hand. The desktop app fixes this because it works in both directions.

---

## One-time setup

Both of us do this once.

1. Install **GitHub Desktop** — <https://desktop.github.com>. Free, official.
   *(If you would rather use VS Code, its Source Control panel does the same
   job. Pick one and stick with it.)*
2. Open it and sign in with your GitHub account.
3. **File → Clone repository → kevin5743p-lab/job-alert**. Pick a folder you
   will remember, for example `Documents/job-alert`. Click Clone.

That folder is now the project. It stays in sync by itself once you use the
buttons below.

4. Point Chrome at it: `chrome://extensions` → turn on **Developer mode** →
   **Load unpacked** → select the **`extension`** folder *inside the clone*.

   This step is the payoff. Because Chrome now loads the extension from the
   synced folder, getting your partner's latest work is Pull, then Reload.

5. Stop using the old folders. Rename `AutoApply` and `AutoApply1` to
   `AutoApply-OLD` and `AutoApply1-OLD` so nothing gets edited there by
   accident. Everything in them is already in this repo. Delete them once you
   are comfortable.

---

## Every time you sit down to work

Three buttons, always in this order.

| When | Button | Why |
|---|---|---|
| **Before you start** | **Fetch origin**, then **Pull** | Gets your partner's latest. Skip this and you are editing an old copy — the original problem. |
| **When something works** | Write a short message, **Commit to main** | Saves a checkpoint. It is still only on your machine. |
| **Right after committing** | **Push origin** | Sends it to GitHub. Until you push, your partner cannot see it. |

Then in Chrome: `chrome://extensions` → **Reload** on JobCopilot. Chrome does
not notice file changes on its own.

---

## Four rules that keep us out of trouble

1. **Pull before you start. Every time.** Ten seconds, and it prevents nearly
   every problem in this document.
2. **Push the same day.** Small and frequent beats one big drop. The two-folder
   mess happened because work sat unpushed for days.
3. **Stay in your lane where you can.** Roughly: `*.css`, `*.html` and anything
   visual on one side; `*.js` logic and `supabase/` on the other. Git can merge
   two people editing *different* files with no drama at all.
4. **Say what you are touching.** A message before starting on a shared file
   costs nothing.

---

## If GitHub Desktop says there is a conflict

It means you both changed the same lines. It is not damage and nothing is lost.

- It lists the affected files and offers **Open in editor**.
- In the file you will see both versions marked with `<<<<<<<`, `=======` and
  `>>>>>>>`. Delete the markers and leave the code you want — often both parts.
- Save, then **Commit merge**, then **Push origin**.

If it looks wrong, stop and ask before pushing. Nothing is lost until it is
pushed, and even then it is recoverable.

---

## Two things git does *not* do

Pushing code is not deploying it.

- **The backend.** Changes to `supabase/functions/ai-proxy` need
  `supabase functions deploy ai-proxy`, and files in `sql/` have to be run
  against the database by hand. Git only versions them.
- **Chrome.** An extension loaded with *Load unpacked* never auto-updates.
  Pull, then hit Reload. Real auto-update would mean publishing to the Chrome
  Web Store.

---

## Making a downloadable build

For handing a build to someone who is not working from the repo.

1. Bump `"version"` in `extension/manifest.json`.
2. Commit and push.
3. Create a tag named `ext-v` plus that version — e.g. `ext-v1.0.1`. In GitHub
   Desktop: **History**, right-click the newest commit, **Create tag**, then
   **Push origin**.

CI runs the tests and, if they pass, publishes a release with the zip attached
on the repo's Releases page. If the tests fail there is no release — that is
deliberate.
