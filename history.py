"""
Job history – tracks which jobs have already been notified, so we don't
alert on the same job twice when widening the time window.

State lives in state/seen_jobs.json, which the GitHub Actions workflow
commits back to the repo after each run.
"""
import json
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

EXPIRY_DAYS = 30   # forget jobs older than this


def _history_file(state_dir: Path) -> Path:
    return state_dir / "seen_jobs.json"


def load_seen(state_dir: Path) -> set:
    """Load IDs of jobs we've already notified about."""
    path = _history_file(state_dir)
    if not path.exists():
        return set()
    try:
        with open(path, "r") as f:
            data = json.load(f)
        # Drop entries older than EXPIRY_DAYS
        cutoff = datetime.now(timezone.utc) - timedelta(days=EXPIRY_DAYS)
        return {
            job_id for job_id, ts in data.items()
            if datetime.fromisoformat(ts) > cutoff
        }
    except Exception as e:
        logger.warning(f"Could not load seen jobs file: {e}")
        return set()


def save_seen(state_dir: Path, new_ids: set):
    """Append newly-seen job IDs (with timestamp) to the history file."""
    path = _history_file(state_dir)
    existing = {}
    if path.exists():
        try:
            with open(path, "r") as f:
                existing = json.load(f)
        except Exception:
            existing = {}

    now = datetime.now(timezone.utc).isoformat()
    for job_id in new_ids:
        existing[job_id] = now

    # Drop expired entries
    cutoff = datetime.now(timezone.utc) - timedelta(days=EXPIRY_DAYS)
    existing = {
        jid: ts for jid, ts in existing.items()
        if datetime.fromisoformat(ts) > cutoff
    }

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(existing, f, indent=2, sort_keys=True)
    except Exception as e:
        logger.warning(f"Could not save seen jobs file: {e}")
