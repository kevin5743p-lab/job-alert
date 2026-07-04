"""
Fetcher registry.

fetch_all() runs every enabled source, isolating each one so a blocked or
broken source (LinkedIn 999s, SuccessFactors endpoint changes, ...) never
kills the run. Returns the combined job list plus per-source stats for the
run summary / Telegram footer.
"""
import logging
import os
from typing import Dict, List, Optional, Set, Tuple

from fetchers import arbeitnow, adzuna, linkedin, xing
from fetchers import companies as company_fetcher
from fetchers import successfactors as sf_fetcher

logger = logging.getLogger(__name__)


def fetch_all(config: Dict, lookback_minutes: int,
              seen_jobs: Optional[Set[str]] = None,
              only_source: str = "") -> Tuple[List[Dict], Dict[str, Dict]]:
    """
    Returns (jobs, stats) where stats maps source name to
    {"count": int, "error": str | None}.

    only_source limits the run to a single fetcher (for smoke tests).
    """
    seen_jobs = seen_jobs or set()
    search = config["search"]
    queries = search.get("queries", [])
    location = search.get("location", "Germany")
    platforms = config.get("platforms", {})

    sources = []  # (name, enabled, callable)

    sources.append((
        "arbeitnow",
        platforms.get("arbeitnow", {}).get("enabled", True),
        lambda: arbeitnow.fetch(queries, location, max_age_minutes=lookback_minutes),
    ))

    adzuna_cfg = platforms.get("adzuna", {})
    adzuna_id = os.environ.get("ADZUNA_APP_ID", "")
    adzuna_key = os.environ.get("ADZUNA_APP_KEY", "")
    adzuna_enabled = adzuna_cfg.get("enabled", False) and bool(adzuna_id and adzuna_key)
    if adzuna_cfg.get("enabled", False) and not adzuna_enabled:
        logger.info("Adzuna enabled in config but ADZUNA_APP_ID/ADZUNA_APP_KEY "
                    "not set — skipping.")
    sources.append((
        "adzuna",
        adzuna_enabled,
        lambda: adzuna.fetch(
            queries, location,
            app_id=adzuna_id, app_key=adzuna_key,
            country_code=adzuna_cfg.get("country_code", "de"),
            max_age_minutes=lookback_minutes,
        ),
    ))

    li_cfg = platforms.get("linkedin", {})
    sources.append((
        "linkedin",
        li_cfg.get("enabled", True),
        lambda: linkedin.fetch(
            queries, location,
            li_at_cookie=os.environ.get("LINKEDIN_LI_AT", ""),
            max_age_minutes=lookback_minutes,
            fetch_details=li_cfg.get("fetch_details", True),
            seen_jobs=seen_jobs,
        ),
    ))

    sources.append((
        "xing",
        platforms.get("xing", {}).get("enabled", True),
        lambda: xing.fetch(queries, location, max_age_minutes=lookback_minutes),
    ))

    cc = platforms.get("companies", {})
    sources.append((
        "companies",
        cc.get("enabled", True),
        lambda: company_fetcher.fetch(
            queries, location,
            max_age_minutes=lookback_minutes,
            companies=cc.get("include"),
            seen_jobs=seen_jobs,
        ),
    ))

    sf_cfg = platforms.get("successfactors", {})
    sources.append((
        "successfactors",
        sf_cfg.get("enabled", False),
        lambda: sf_fetcher.fetch_all(
            sf_cfg.get("companies", []),
            queries,
            max_age_minutes=lookback_minutes,
            seen_jobs=seen_jobs,
        ),
    ))

    all_jobs: List[Dict] = []
    stats: Dict[str, Dict] = {}

    for name, enabled, fn in sources:
        if only_source and name != only_source:
            continue
        if not enabled:
            continue
        logger.info(f"Fetching from {name}...")
        try:
            jobs = fn() or []
            all_jobs += jobs
            stats[name] = {"count": len(jobs), "error": None}
        except Exception as e:
            logger.warning(f"Source '{name}' failed: {e}")
            stats[name] = {"count": 0, "error": str(e)[:120]}

    return all_jobs, stats
