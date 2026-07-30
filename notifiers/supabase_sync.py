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

Environment (all optional — sync is skipped unless the first three are set):
  SUPABASE_URL       e.g. https://xxxx.supabase.co
  SUPABASE_ANON_KEY  the publishable/anon key
  SUPABASE_EMAIL     the account's email
  SUPABASE_PASSWORD  the account's password
"""
import logging
import os
from typing import Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

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


def sync_jobs(strong: List[Dict], worth_look: List[Dict]) -> int:
    """Entry point for main.py. Silently does nothing unless configured."""
    url = os.environ.get("SUPABASE_URL", "").strip()
    anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    email = os.environ.get("SUPABASE_EMAIL", "").strip()
    password = os.environ.get("SUPABASE_PASSWORD", "")

    if not (url and anon and email and password):
        return 0

    client = SupabaseSync(url, anon, email, password)
    if not client.sign_in():
        return 0

    sent = client.upsert_jobs(strong, worth_look)
    if sent:
        logger.info(f"☁️  Synced {sent} job(s) to the tracker.")
    return sent
