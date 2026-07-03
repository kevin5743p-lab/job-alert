"""
Quiet-hours gate. The GitHub Actions cron runs in UTC around the clock;
this decides in local (Europe/Berlin) time whether a run should proceed,
which keeps the window correct across DST changes.
"""
from datetime import datetime
from typing import Dict
from zoneinfo import ZoneInfo


def is_quiet_now(scheduler_cfg: Dict) -> bool:
    qh = scheduler_cfg.get("quiet_hours") or {}
    start = qh.get("start", 23)
    end = qh.get("end", 6)
    tz = qh.get("tz", "Europe/Berlin")
    hour = datetime.now(ZoneInfo(tz)).hour
    if start == end:
        return False
    if start < end:
        return start <= hour < end
    # Window wraps midnight (e.g. 23 → 6)
    return hour >= start or hour < end


def local_hour(scheduler_cfg: Dict) -> int:
    tz = (scheduler_cfg.get("quiet_hours") or {}).get("tz", "Europe/Berlin")
    return datetime.now(ZoneInfo(tz)).hour
