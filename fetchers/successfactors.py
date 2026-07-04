"""
SAP SuccessFactors fetcher.

SuccessFactors is the ATS used by BMW, Audi, parts of Volkswagen Group,
Schaeffler, and many others. Unlike SmartRecruiters/Greenhouse it does NOT
have a clean public API. But there are two semi-public XML endpoints we can
use:

  Endpoint 1 (official, documented in SAP KBA 2428902):
    {host}/career?company=ID&career_ns=job_listing_summary&resultType=XML

  Endpoint 2 (undocumented "sitemal.xml" — legitimate, used by recruiters):
    {host}/sitemal.xml?company=ID

We try Endpoint 1 first, fall back to Endpoint 2 if it fails.

Both return RSS-like XML with all currently-posted jobs. We filter
client-side by query keywords. The history file handles dedup.
"""
import requests
import logging
import re
import time
from datetime import datetime, timezone
from typing import List, Dict, Optional
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/xml, text/xml, application/rss+xml, */*;q=0.1",
}


def fetch(company: Dict, queries: List[str],
          max_age_minutes: int = 1440) -> List[Dict]:
    """
    Fetch jobs from a SuccessFactors company page.

    Required `company` keys:
      - name: display name (e.g. "BMW Group")
      - host: SuccessFactors host (e.g. "career5.successfactors.eu")
      - id:   SuccessFactors company ID (e.g. "bmwag")
    """
    name = company.get("name", "?")
    host = company.get("host", "career5.successfactors.eu").rstrip("/")
    cid = company.get("id", "")
    if not cid:
        logger.warning(f"SuccessFactors {name}: no company ID configured")
        return []

    # Try official XML feed first, then sitemal.xml as fallback
    endpoints = [
        f"https://{host}/career?company={cid}&career_ns=job_listing_summary&resultType=XML",
        f"https://{host}/sitemal.xml?company={cid}",
    ]

    xml_text = None
    for url in endpoints:
        try:
            resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=20)
            if resp.status_code == 200 and len(resp.text) > 200:
                # Quick sanity check: must contain XML and at least one item/url tag
                lowered = resp.text.lower()
                if ("<rss" in lowered or "<urlset" in lowered or
                        "<job" in lowered or "<item" in lowered):
                    xml_text = resp.text
                    logger.debug(f"SuccessFactors {name}: got data from {url[:80]}")
                    break
        except Exception as e:
            logger.debug(f"SuccessFactors {name}: {url[:60]} failed: {e}")

    if not xml_text:
        logger.info(f"SuccessFactors {name}: no data from any endpoint")
        return []

    return _parse_xml(xml_text, company, queries)


def _parse_xml(xml_text: str, company: Dict, queries: List[str]) -> List[Dict]:
    """Parse the XML feed and filter by query keywords."""
    name = company.get("name", "?")
    cid = company.get("id", "")
    host = company.get("host", "career5.successfactors.eu").rstrip("/")
    # Brand-name queries (e.g. "BMW" while fetching BMW's own feed) would
    # match every posting — drop them for this company's filtering.
    query_lower = [q.lower() for q in (queries or [])
                   if q.lower() not in name.lower()]

    jobs = []
    seen = set()

    try:
        # Strip namespace declarations AND prefixes from element tags.
        # Real-world feeds use Google's <g:id>, <g:locations>, etc.
        xml_clean = re.sub(r'\sxmlns(:\w+)?="[^"]+"', '', xml_text)
        # Strip prefix from element tags: <g:id> → <id>, </g:id> → </id>
        xml_clean = re.sub(r"<(/?)\w+:", r"<\1", xml_clean)
        # Some real-world SF feeds have unescaped & in URLs (technically invalid).
        xml_clean = re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+);)", "&amp;", xml_clean)
        root = ET.fromstring(xml_clean)
    except ET.ParseError as e:
        logger.warning(f"SuccessFactors {name}: XML parse failed: {e}")
        return []

    # Three structures we may see:
    # 1. RSS with <item> elements
    # 2. Sitemap with <url><loc> elements
    # 3. job_listing_summary with <Job-Listing><Job> elements (BMW uses this):
    #    <Job><JobTitle>...<Job-Description>...<ReqId>...</Job>
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//url")
    if not items:
        items = root.findall(".//Job")

    for item in items:
        title = _text(item, "title") or _text(item, "loc") or ""
        if not title:
            continue
        link = _text(item, "link") or _text(item, "loc") or ""
        description = _text(item, "description") or ""

        # Some SF instances use Google feed extensions like <g:locations>, <g:id>
        google_id = _text(item, "id")
        location = (_text(item, "locations")
                    or _text(item, "address")
                    or _text(item, "region")
                    or "")

        # Build a stable job ID
        job_id = google_id or _extract_req_id_from_link(link) or title[:60]
        if job_id in seen:
            continue
        seen.add(job_id)

        # Filter by query (case-insensitive, in title or description)
        full_text = f"{title} {description}".lower()
        if query_lower and not any(q in full_text for q in query_lower):
            continue

        # Build posting URL — prefer the link if it's a real URL, otherwise
        # build one. career_ns=job_listing shows the posting;
        # career_ns=job_application lands on a Sign In page.
        if link and link.startswith("http"):
            url = link
        else:
            url = (f"https://{host}/career?company={cid}"
                   f"&career_job_req_id={job_id}&career_ns=job_listing")

        jobs.append({
            "id": f"sf_{cid}_{job_id}",
            "title": _clean(title),
            "company": name,
            "location": _clean(location) or "Germany",
            "description": _clean(description)[:2000],
            "url": url,
            "published": _text(item, "pubDate") or "",
            "source": f"{name} (Direct)",
        })

    logger.info(f"SuccessFactors {name}: fetched {len(jobs)} matching jobs")
    return jobs


# ── Helpers ───────────────────────────────────────────────────────────────────
def _text(parent, tag: str) -> Optional[str]:
    """Find a child element by tag name (case-insensitive) and return its text."""
    if parent is None:
        return None
    for child in parent:
        if child.tag.lower().endswith(tag.lower()):
            return child.text
    return None


def _clean(text: str) -> str:
    if not text:
        return ""
    # Strip HTML tags and normalize whitespace
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;|&#160;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _extract_req_id_from_link(link: str) -> Optional[str]:
    """Pull a numeric job-req-id from a SuccessFactors apply URL."""
    if not link:
        return None
    m = re.search(r"career_job_req_id=(\d+)", link)
    if m:
        return m.group(1)
    m = re.search(r"/(\d{4,})(?:[/?]|$)", link)
    if m:
        return m.group(1)
    return None


# ──────────────────────────────────────────────────────────────────────────────
#  Multi-company convenience wrapper
# ──────────────────────────────────────────────────────────────────────────────
def fetch_all(companies: List[Dict], queries: List[str],
              max_age_minutes: int = 1440,
              seen_jobs: set = None) -> List[Dict]:
    """Fetch from a list of SuccessFactors companies. Logs per-company counts."""
    seen_jobs = seen_jobs or set()
    all_jobs = []
    for company in companies:
        try:
            jobs = fetch(company, queries, max_age_minutes)
            new_jobs = [j for j in jobs if j["id"] not in seen_jobs]
            all_jobs.extend(new_jobs)
            already_seen = len(jobs) - len(new_jobs)
            if already_seen:
                logger.info(f"  {company.get('name','?')}: {len(new_jobs)} new "
                            f"({already_seen} already seen)")
            else:
                logger.info(f"  {company.get('name','?')}: {len(new_jobs)} new")
        except Exception as e:
            logger.warning(f"  {company.get('name','?')} failed: {e}")
        time.sleep(0.5)
    logger.info(f"SuccessFactors total: {len(all_jobs)} new jobs")
    return all_jobs
