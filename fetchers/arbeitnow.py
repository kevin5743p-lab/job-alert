"""
Arbeitnow fetcher – uses arbeitnow.com's free, public job API.

Why this exists:
- Indeed killed their RSS feed
- Stepstone has aggressive bot protection
- LinkedIn is unreliable without authentication

Arbeitnow is a German-based aggregator that pulls remote/Germany jobs
from many sources and offers a clean, free, no-key public API.
This is the most reliable free option for jobs in Germany.
"""
import requests
from datetime import datetime, timezone, timedelta
from typing import List, Dict
import logging
import time

logger = logging.getLogger(__name__)

ARBEITNOW_API = "https://www.arbeitnow.com/api/job-board-api"


def fetch(queries: List[str], location: str,
          max_age_minutes: int = 60) -> List[Dict]:
    """
    Fetch recent jobs from Arbeitnow.
    Their API returns ALL recent jobs; we filter client-side by query.
    """
    jobs = []
    seen_ids = set()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
    }

    try:
        # Fetch first 3 pages to get more jobs
        for page in range(1, 4):
            resp = requests.get(
                ARBEITNOW_API,
                params={"page": page},
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()

            items = data.get("data", [])
            if not items:
                break

            for item in items:
                job_id = item.get("slug", "")
                if not job_id or job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                # Filter by age
                created_at = item.get("created_at")
                published = _parse_timestamp(created_at)
                if published and published < cutoff:
                    continue

                title = item.get("title", "")
                description = _strip_html(item.get("description", ""))
                location_str = ", ".join(item.get("location", "").split(","))

                # Filter by query keywords (any match)
                full_text = f"{title} {description}".lower()
                if queries and not any(q.lower() in full_text for q in queries):
                    continue

                jobs.append({
                    "id": f"arbeitnow_{job_id}",
                    "title": title or "Unknown",
                    "company": item.get("company_name", "Unknown"),
                    "location": location_str or location,
                    "description": description[:2000],
                    "url": item.get("url", ""),
                    "published": published.isoformat() if published else created_at,
                    "source": "Arbeitnow",
                })

            time.sleep(0.5)

    except Exception as e:
        logger.warning(f"Arbeitnow fetch failed: {e}")

    logger.info(f"Arbeitnow: fetched {len(jobs)} matching jobs")
    return jobs


def _parse_timestamp(ts) -> datetime:
    """Parse Arbeitnow's timestamp (Unix int or ISO string)."""
    if not ts:
        return None
    try:
        if isinstance(ts, (int, float)):
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        if isinstance(ts, str):
            for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
                try:
                    dt = datetime.strptime(ts, fmt)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    return dt
                except ValueError:
                    continue
    except Exception:
        pass
    return None


def _strip_html(html: str) -> str:
    """Quick HTML tag removal."""
    import re
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"\s+", " ", text)
    return text.strip()
