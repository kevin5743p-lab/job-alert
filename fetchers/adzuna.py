"""
Adzuna API fetcher.

Free signup at https://developer.adzuna.com/signup
- 1000 API calls/month free
- No credit card required
- Excellent Germany coverage

Once signed up, copy your APP_ID and APP_KEY to config.yaml.
"""
import requests
from datetime import datetime, timezone, timedelta
from typing import List, Dict
import logging
import time

logger = logging.getLogger(__name__)

ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs"


def fetch(queries: List[str], location: str, app_id: str, app_key: str,
          country_code: str = "de", max_age_minutes: int = 60,
          results_per_query: int = 25) -> List[Dict]:
    """
    Fetch jobs from Adzuna's API.
    `country_code` is "de" for Germany, "gb" for UK, "us" for USA, etc.
    """
    if not app_id or not app_key or app_id.startswith("YOUR_"):
        logger.info("Adzuna: skipped (no credentials configured)")
        return []

    jobs = []
    seen_ids = set()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    # Adzuna uses "max_days_old" — we convert minutes → days, min 1
    max_days_old = max(1, int(max_age_minutes / 1440) + 1)

    for query in queries:
        try:
            url = f"{ADZUNA_BASE}/{country_code}/search/1"
            params = {
                "app_id": app_id,
                "app_key": app_key,
                "results_per_page": results_per_query,
                "what": query,
                "where": location,
                "max_days_old": max_days_old,
                "sort_by": "date",
                "content-type": "application/json",
            }
            resp = requests.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()

            for item in data.get("results", []):
                job_id = str(item.get("id", ""))
                if not job_id or job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                published = _parse_date(item.get("created", ""))
                if published and published < cutoff:
                    continue

                jobs.append({
                    "id": f"adzuna_{job_id}",
                    "title": item.get("title", "Unknown"),
                    "company": (item.get("company") or {}).get("display_name", "Unknown"),
                    "location": (item.get("location") or {}).get("display_name", location),
                    "description": item.get("description", "")[:2000],
                    "url": item.get("redirect_url", ""),
                    "published": published.isoformat() if published else item.get("created"),
                    "source": "Adzuna",
                })

        except requests.HTTPError as e:
            if e.response.status_code == 401:
                logger.error("Adzuna: invalid credentials – check app_id and app_key")
                return []
            elif e.response.status_code == 429:
                logger.warning("Adzuna: rate limit reached – wait or upgrade")
                break
            else:
                logger.warning(f"Adzuna error for '{query}': {e}")
        except Exception as e:
            logger.warning(f"Adzuna fetch failed for query '{query}': {e}")
        time.sleep(0.5)

    logger.info(f"Adzuna: fetched {len(jobs)} jobs")
    return jobs


def _parse_date(date_str: str):
    if not date_str:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None
