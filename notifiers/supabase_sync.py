"""
Push scored jobs into the Supabase tracker.

This is what connects the two halves of the system: the fetchers discover jobs,
and this writes them into the same table the browser extension's dashboard reads
from. A job found by the overnight cron therefore shows up in the dashboard with
its score, and the user tailors and applies from there.

Authentication uses the user's OWN email + password against the public anon key,
never a service-role key. That matters for the public template: each adopter puts
their own credentials in their own repo's secrets, writes land under their own
user id, and row-level security keeps every account's rows separate. A leaked
anon key on its own grants nothing.

Everyone shares ONE hosted project, so an adopter does not need a Supabase
account of their own: they sign up inside the extension, and their rows live
under their own user id in the shared database. The project URL and anon key are
therefore build-time defaults — only the two personal values must be supplied.

Environment:
  SUPABASE_EMAIL     required — the account's email  (repo secret)
  SUPABASE_PASSWORD  required — the account's password (repo secret)
  SUPABASE_URL       optional — override the shared project
  SUPABASE_ANON_KEY  optional — override the shared project's anon key
"""
import logging
import os
from typing import Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# The shared JobCopilot project. Safe to ship: the anon key is a *publishable*
# key and grants nothing on its own — every table has row-level security, so a
# request only ever reads or writes the signed-in user's own rows.
DEFAULT_URL = "https://jiryqdcmukmbflahtptv.supabase.co"
DEFAULT_ANON_KEY = "sb_publishable_G1Mf9PySGYmp2YLqfj4FWg_BzdAnHJ_"

TIMEOUT = 30
# Postgres rejects a whole batch if one row is bad, so keep batches modest and
# let a failure cost only that chunk.
BATCH = 50
# Jobs carry full descriptions; store enough to be useful without bloating rows.
DESCRIPTION_LIMIT = 4000


class SupabaseSync:
    """Thin PostgREST client scoped to what the tracker needs."""

    def __init__(self, url: str, anon_key: str, email: str, password: str):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.email = email
        self.password = password
        self.token: Optional[str] = None
        self.user_id: Optional[str] = None

    # ── auth ────────────────────────────────────────────────────────────────
    def sign_in(self) -> bool:
        try:
            resp = requests.post(
                f"{self.url}/auth/v1/token?grant_type=password",
                headers={"apikey": self.anon_key, "Content-Type": "application/json"},
                json={"email": self.email, "password": self.password},
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            logger.warning(f"Supabase sign-in failed: {e}")
            return False

        if resp.status_code != 200:
            logger.warning(f"Supabase sign-in rejected (HTTP {resp.status_code}): "
                           f"{resp.text[:160]}")
            return False

        data = resp.json()
        self.token = data.get("access_token")
        self.user_id = (data.get("user") or {}).get("id")
        return bool(self.token and self.user_id)

    def _headers(self) -> Dict[str, str]:
        return {
            "apikey": self.anon_key,
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            # Insert-or-update on (user_id, job_url): re-running a scan refreshes
            # a posting instead of duplicating it.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }

    # ── reading ─────────────────────────────────────────────────────────────
    def fetch_cv(self) -> str:
        """The CV stored on the account, or '' if there isn't one."""
        try:
            resp = requests.get(
                f"{self.url}/rest/v1/profiles?select=cv_text&limit=1",
                headers={"apikey": self.anon_key,
                         "Authorization": f"Bearer {self.token}"},
                timeout=TIMEOUT,
            )
            if resp.status_code != 200:
                return ""
            rows = resp.json()
            return (rows[0].get("cv_text") or "").strip() if rows else ""
        except (requests.RequestException, ValueError, KeyError, IndexError):
            return ""

    # ── writing ─────────────────────────────────────────────────────────────
    def _row(self, item: Dict, tier: str) -> Optional[Dict]:
        job = item.get("job") or {}
        url = (job.get("url") or "").strip()
        if not url:
            return None  # job_url is the dedup key; a row without one would pile up
        return {
            "user_id": self.user_id,
            "job_title": (job.get("title") or "")[:300],
            "job_company": (job.get("company") or "")[:200],
            "job_location": (job.get("location") or "")[:200],
            "job_url": url,
            "job_source": (job.get("source") or "")[:100],
            "description": (job.get("description") or "")[:DESCRIPTION_LIMIT],
            "posted_at": job.get("published") or None,
            "score": item.get("score"),
            "tier": tier,
            "reason": (item.get("reason") or "")[:500],
        }

    def upsert_jobs(self, strong: List[Dict], worth_look: List[Dict]) -> int:
        """Write discovered jobs to the tracker. Returns the number sent.

        Only strong / worth-a-look jobs are synced: rejected ones would bury the
        good ones, and they're already summarised in the daily Telegram digest.
        Existing rows keep their status — the merge only refreshes the posting's
        details, so a job you've already applied to is not reset to 'new'.
        """
        rows = []
        for items, tier in ((strong, "strong"), (worth_look, "worth_look")):
            for item in items:
                row = self._row(item, tier)
                if row:
                    rows.append(row)
        if not rows:
            return 0

        sent = 0
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            try:
                resp = requests.post(
                    f"{self.url}/rest/v1/applications?on_conflict=user_id,job_url",
                    headers=self._headers(), json=chunk, timeout=TIMEOUT,
                )
                if resp.status_code in (200, 201, 204):
                    sent += len(chunk)
                else:
                    logger.warning(f"Supabase upsert failed (HTTP {resp.status_code}): "
                                   f"{resp.text[:200]}")
            except requests.RequestException as e:
                logger.warning(f"Supabase upsert failed: {e}")
        return sent


def _client() -> Optional["SupabaseSync"]:
    """A signed-in client, or None when not configured / sign-in failed."""
    email = os.environ.get("SUPABASE_EMAIL", "").strip()
    password = os.environ.get("SUPABASE_PASSWORD", "")
    if not (email and password):
        return None
    client = SupabaseSync(
        os.environ.get("SUPABASE_URL", "").strip() or DEFAULT_URL,
        os.environ.get("SUPABASE_ANON_KEY", "").strip() or DEFAULT_ANON_KEY,
        email, password,
    )
    return client if client.sign_in() else None


def fetch_cv() -> str:
    """The CV saved from the extension, so both halves match the same person.

    Keeping the CV in one place matters: if the bot hunts from cv.md while the
    extension tailors from the account's CV, the two disagree about the
    candidate's field and the scan looks for the wrong jobs entirely.
    """
    client = _client()
    if not client:
        return ""
    cv = client.fetch_cv()
    if cv:
        logger.info(f"📄 Using the CV from your JobCopilot account ({len(cv)} chars).")
    return cv


def sync_jobs(strong: List[Dict], worth_look: List[Dict]) -> int:
    """Entry point for main.py.

    Does nothing unless SUPABASE_EMAIL / SUPABASE_PASSWORD are set, so a repo
    that only wants Telegram alerts is unaffected.
    """
    url = os.environ.get("SUPABASE_URL", "").strip() or DEFAULT_URL
    anon = os.environ.get("SUPABASE_ANON_KEY", "").strip() or DEFAULT_ANON_KEY
    email = os.environ.get("SUPABASE_EMAIL", "").strip()
    password = os.environ.get("SUPABASE_PASSWORD", "")

    if not (email and password):
        return 0

    client = SupabaseSync(url, anon, email, password)
    if not client.sign_in():
        return 0
    sent = client.upsert_jobs(strong, worth_look)
    if sent:
        logger.info(f"☁️  Synced {sent} job(s) to the tracker.")
    return sent
