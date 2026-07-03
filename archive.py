"""
Daily archive — writes per-day folders under state/archive/.

Structure:
  state/archive/
    2026-07-03/
      strong.txt          ← human-readable
      worth_look.txt
      rejected.txt
      today.json          ← structured (also feeds the daily Telegram summary)

Append-as-you-go: each run appends to the same day's files until midnight,
when a fresh folder is started for the new day. The workflow commits these
back to the repo, so descriptions are trimmed to keep commits small.
"""
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List

logger = logging.getLogger(__name__)

DESC_TRIM = 300   # chars of description kept in today.json


def _today_dir(state_dir: Path) -> Path:
    date_str = datetime.now().strftime("%Y-%m-%d")
    d = state_dir / "archive" / date_str
    d.mkdir(parents=True, exist_ok=True)
    return d


def _format_job_line(item: Dict) -> str:
    """One block of text per job for the txt file."""
    job = item.get("job", {})
    return (
        f"────────────────────────────────────────────────\n"
        f"  Score: {item.get('score', 0):3d}/100\n"
        f"  {job.get('title', '?')}\n"
        f"  @ {job.get('company', '?')}  ·  {job.get('location', '?')}\n"
        f"  Source: {job.get('source', '?')}\n"
        f"  Reason: {item.get('reason', '—')}\n"
        f"  URL:    {job.get('url', '—')}\n"
    )


def _append_text(path: Path, header: str, items: List[Dict]) -> None:
    """Append items to a txt file. Adds a section header per run timestamp."""
    if not items:
        return
    timestamp = datetime.now().strftime("%H:%M:%S")
    is_new = not path.exists() or path.stat().st_size == 0
    with open(path, "a", encoding="utf-8") as f:
        if is_new:
            f.write(f"=== {header} ===\n\n")
        f.write(f"--- Run at {timestamp} ({len(items)} jobs) ---\n\n")
        for item in items:
            f.write(_format_job_line(item))
        f.write("\n")


def _slim(item: Dict) -> Dict:
    """Trimmed copy of a tier item for today.json (small state commits)."""
    job = dict(item.get("job", {}))
    if job.get("description"):
        job["description"] = job["description"][:DESC_TRIM]
    slim = {k: v for k, v in item.items() if k != "job"}
    slim["job"] = job
    return slim


def append_run(state_dir: Path, strong: List[Dict], worth_look: List[Dict],
               rejected: List[Dict]) -> Path:
    """
    Called once per run. Writes/appends today's archive.
    Returns the today-folder Path.
    """
    d = _today_dir(state_dir)

    _append_text(d / "strong.txt",     "STRONG MATCHES", strong)
    _append_text(d / "worth_look.txt", "WORTH A LOOK",   worth_look)
    _append_text(d / "rejected.txt",   "AUTO-REJECTED",  rejected)

    # Update structured JSON. Read existing, merge, rewrite.
    json_path = d / "today.json"
    data = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "runs": [],
    }
    if json_path.exists():
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
            data.setdefault("runs", [])
        except Exception:
            pass

    data["runs"].append({
        "timestamp": datetime.now().isoformat(),
        "strong": [_slim(i) for i in strong],
        "worth_look": [_slim(i) for i in worth_look],
        "rejected": [_slim(i) for i in rejected],
    })

    try:
        json_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8"
        )
    except Exception as e:
        logger.warning(f"Could not write today.json: {e}")

    return d


def load_today(state_dir: Path) -> Dict:
    """Today's structured archive (for the daily summary), or empty."""
    json_path = _today_dir(state_dir) / "today.json"
    if not json_path.exists():
        return {"date": datetime.now().strftime("%Y-%m-%d"), "runs": []}
    try:
        return json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        return {"date": datetime.now().strftime("%Y-%m-%d"), "runs": []}
