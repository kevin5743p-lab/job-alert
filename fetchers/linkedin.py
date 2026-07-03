"""
LinkedIn job fetcher.
Uses the public LinkedIn job search endpoint (no login required for basic info).
Optionally uses li_at cookie for richer results.

Datacenter IPs (e.g. GitHub Actions) often get 999/429 or login redirects;
those are treated as "source degraded": partial results are returned and the
run continues.
"""
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta
from typing import List, Dict
import logging
import time
import re

logger = logging.getLogger(__name__)

LINKEDIN_SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
LINKEDIN_JOB_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"

# HTTP statuses that mean LinkedIn is refusing this client, not this query —
# retrying other queries would only dig the hole deeper.
_BLOCKED_STATUSES = {999, 429, 403}


def fetch(queries: List[str], location: str, li_at_cookie: str = "",
          max_age_minutes: int = 60, fetch_details: bool = True) -> List[Dict]:
    """
    Fetch recent LinkedIn jobs using the guest API.

    fetch_details=False skips the per-job description request (halves request
    volume — recommended on CI). Cards still yield title/company/location.
    """
    jobs = []
    seen_ids = set()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    cookies = {}
    if li_at_cookie:
        cookies["li_at"] = li_at_cookie

    for query in queries:
        params = {
            "keywords": query,
            "location": location,
            # Posted within the lookback window, in seconds
            "f_TPR": f"r{max_age_minutes * 60}",
            "sortBy": "DD",     # Sort by date
            "start": 0,
        }
        try:
            resp = requests.get(
                LINKEDIN_SEARCH_URL, params=params,
                headers=headers, cookies=cookies, timeout=15,
                allow_redirects=False,
            )
            if resp.status_code in _BLOCKED_STATUSES:
                logger.warning(f"LinkedIn blocked this client (HTTP {resp.status_code}) — "
                               f"returning {len(jobs)} jobs fetched so far.")
                break
            if resp.status_code in (301, 302, 303, 307, 308):
                logger.warning("LinkedIn redirected to login — treating source as "
                               f"degraded, returning {len(jobs)} jobs fetched so far.")
                break
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")
            cards = soup.find_all("div", class_=re.compile("job-search-card"))

            for card in cards:
                job_id = card.get("data-entity-urn", "").split(":")[-1]
                if not job_id or job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                title_el = card.find("h3", class_=re.compile("base-search-card__title"))
                company_el = card.find("h4", class_=re.compile("base-search-card__subtitle"))
                location_el = card.find("span", class_=re.compile("job-search-card__location"))
                time_el = card.find("time")

                published = None
                if time_el and time_el.get("datetime"):
                    try:
                        published = datetime.fromisoformat(
                            time_el["datetime"].replace("Z", "+00:00")
                        )
                        # Ensure timezone-aware
                        if published.tzinfo is None:
                            published = published.replace(tzinfo=timezone.utc)
                    except ValueError:
                        pass

                # We're already filtering by f_TPR in the URL, so trust
                # LinkedIn's filter rather than failing on date parse.
                if published and published < cutoff:
                    continue

                description = ""
                if fetch_details:
                    description = _fetch_description(job_id, headers, cookies)
                    time.sleep(0.5)

                jobs.append({
                    "id": f"linkedin_{job_id}",
                    "title": title_el.get_text(strip=True) if title_el else "Unknown",
                    "company": company_el.get_text(strip=True) if company_el else "Unknown",
                    "location": location_el.get_text(strip=True) if location_el else location,
                    "description": description,
                    "url": f"https://www.linkedin.com/jobs/view/{job_id}",
                    "published": published.isoformat() if published else None,
                    "source": "LinkedIn",
                })

        except Exception as e:
            logger.warning(f"LinkedIn fetch failed for query '{query}': {e}")
        time.sleep(2)

    logger.info(f"LinkedIn: fetched {len(jobs)} jobs")
    return jobs


def _fetch_description(job_id: str, headers: dict, cookies: dict) -> str:
    try:
        resp = requests.get(
            LINKEDIN_JOB_URL.format(job_id=job_id),
            headers=headers, cookies=cookies, timeout=10
        )
        soup = BeautifulSoup(resp.text, "html.parser")
        desc_el = soup.find("div", class_=re.compile("description__text"))
        return desc_el.get_text(separator=" ", strip=True)[:2000] if desc_el else ""
    except Exception:
        return ""
