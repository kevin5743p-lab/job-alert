"""
Memory stub — v1 placeholder for the learning loop.

Reads an optional state/memory.json (same schema the old email-reply system
used, and the schema a future Telegram ACCEPT/REJECT feedback loop will
write). Until that exists, the file can also be hand-edited to blacklist
companies or terms:

{
  "decisions": [],
  "patterns": {
    "rejected_companies": ["SomeConsultancy GmbH"],
    "rejected_terms": ["consulting"],
    "accepted_terms": []
  }
}
"""
import json
import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def _empty_memory() -> Dict:
    return {
        "version": 1,
        "decisions": [],
        "patterns": {
            "rejected_companies": [],
            "rejected_terms": [],
            "accepted_terms": [],
        },
    }


def load_memory(state_dir: Path) -> Dict:
    path = state_dir / "memory.json"
    if not path.exists():
        return _empty_memory()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"memory.json unreadable ({e}) — using empty memory.")
        return _empty_memory()
    empty = _empty_memory()
    for key, value in empty.items():
        data.setdefault(key, value)
    for key, value in empty["patterns"].items():
        data["patterns"].setdefault(key, value)
    return data


def has_been_rejected_pattern(memory: Dict, job: Dict) -> Optional[str]:
    """
    Check if a job matches any "rejected pattern" the user has built up.
    Returns a human-readable reason string, or None if no match.
    """
    patterns = memory.get("patterns", {})
    title = (job.get("title", "") or "").lower()
    company = (job.get("company", "") or "").strip()
    desc = (job.get("description", "") or "").lower()
    text = f"{title} {desc}"

    if company in patterns.get("rejected_companies", []):
        return f"company '{company}' rejected by user previously"

    for term in patterns.get("rejected_terms", []):
        if term in text:
            return f"matches rejected term '{term}'"

    return None
