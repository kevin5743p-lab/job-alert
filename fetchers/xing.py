"""
Xing job fetcher – scrapes the Xing job search page.
Xing is popular for German-speaking markets.
"""
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional
import logging
import time
import json
import re

logger = logging.getLogger(__name__)

XING_SEARCH_URL = "https://www.xing.com/jobs/search"


def fetch(queries: List[str], location: str,
          max_age_minutes: int = 60) -> List[Dict]:
    """
    Fetch recent Xing jobs.
    """
    jobs = []
    seen_ids = set()
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    }

    for query in queries:
        try:
            params = {
                "keywords": query,
                "location": location,
                "radius": 50,
                "sort": "date",
            }
            resp = requests.get(
                XING_SEARCH_URL, params=params,
                headers=headers, timeout=15
            )
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            # Try to extract JSON-LD structured data
            json_ld_scripts = soup.find_all("script", type="application/ld+json")
            for script in json_ld_scripts:
                try:
                    data = json.loads(script.string or "")
                    if isinstance(data, list):
                        items = data
                    elif data.get("@type") == "ItemList":
                        items = data.get("itemListElement", [])
                    else:
                        continue

                    for item in items:
                        job_data = item.get("item", item)
                        if job_data.get("@type") != "JobPosting":
                            continue

                        job_id = job_data.get("url", "").split("/")[-1]
                        if job_id in seen_ids:
                            continue
                        seen_ids.add(job_id)

                        date_posted = job_data.get("datePosted", "")
                        published = _parse_date(date_posted)
                        if published and published < cutoff:
                            continue

                        jobs.append({
                            "id": f"xing_{job_id}",
                            "title": job_data.get("title", "Unknown"),
                            "company": job_data.get("hiringOrganization", {}).get("name", "Unknown"),
                            "location": _extract_location(job_data),
                            "description": job_data.get("description", "")[:2000],
                            "url": job_data.get("url", ""),
                            "published": published.isoformat() if published else date_posted,
                            "source": "Xing",
                        })
                except (json.JSONDecodeError, AttributeError):
                    continue

            # Fallback: parse HTML cards if no JSON-LD found
            if not jobs:
                _parse_html_cards(soup, jobs, seen_ids, cutoff, location)

        except Exception as e:
            logger.warning(f"Xing fetch failed for query '{query}': {e}")
        time.sleep(2)

    logger.info(f"Xing: fetched {len(jobs)} jobs")
    return jobs


def _parse_html_cards(soup, jobs, seen_ids, cutoff, location):
    cards = soup.find_all("article", attrs={"data-xds": re.compile("JobCard")})
    for card in cards:
        title_el = card.find("h2") or card.find(["h3", "a"], class_=re.compile("title"))
        link_el = card.find("a", href=re.compile("/jobs/"))
        if not title_el or not link_el:
            continue
        url = "https://www.xing.com" + link_el["href"] if link_el["href"].startswith("/") else link_el["href"]
        job_id = url.split("/")[-1]
        if job_id in seen_ids:
            continue
        seen_ids.add(job_id)
        company_el = card.find(class_=re.compile("company"))
        jobs.append({
            "id": f"xing_{job_id}",
            "title": title_el.get_text(strip=True),
            "company": company_el.get_text(strip=True) if company_el else "Unknown",
            "location": location,
            "description": "",
            "url": url,
            "published": None,
            "source": "Xing",
        })


def _parse_date(date_str: str) -> Optional[datetime]:
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def _extract_location(job_data: dict) -> str:
    loc = job_data.get("jobLocation", {})
    if isinstance(loc, list) and loc:
        loc = loc[0]
    addr = loc.get("address", {})
    parts = filter(None, [addr.get("addressLocality"), addr.get("addressRegion"), addr.get("addressCountry")])
    return ", ".join(parts) or "Unknown"
