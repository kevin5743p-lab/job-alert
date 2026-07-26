"""
Company career page fetchers.

These hit each company's actual job portal — where jobs appear FIRST,
often days before LinkedIn or aggregators pick them up.

Strategy: most large automotive companies use one of a few common
applicant tracking systems (ATS). We target those systems' public APIs.

Supported ATSs:
- SmartRecruiters (Bosch, Mercedes-Benz, etc.)
- Workday (Continental, Aptiv, etc.)
- SuccessFactors (BMW Group, Audi)
- Greenhouse (many AV startups: Apex.AI, Wayve, etc.)
- Lever (some startups)
- Personio (German Mittelstand / mobility startups — public XML feed)
- Ashby (modern AV / robotics startups — public no-auth JSON board)
- Recruitee (EU / German startups — public no-auth JSON offers feed)
"""
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from typing import List, Dict
import logging
import time
import re

logger = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}


# ──────────────────────────────────────────────────────────────────────────
# COMPANY CONFIGURATION
# ──────────────────────────────────────────────────────────────────────────
# Each entry says: which ATS the company uses + their identifier on it.
COMPANIES = [
    # OEMs / Tier 1
    # NOTE (2026-07): several boards checked — MercedesBenzGroup, Porsche1,
    # Volkswagen1 return 0 postings and ContinentalAG only has stale 2018
    # entries; those companies moved off SmartRecruiters. Kept here because
    # a dead board costs one cheap liveness request and they may return.
    {"name": "Mercedes-Benz", "ats": "smartrecruiters", "id": "MercedesBenzGroup"},
    {"name": "Bosch",         "ats": "smartrecruiters", "id": "BoschGroup"},
    {"name": "Porsche",       "ats": "smartrecruiters", "id": "Porsche1"},
    {"name": "Volkswagen",    "ats": "smartrecruiters", "id": "Volkswagen1"},
    {"name": "Continental",   "ats": "smartrecruiters", "id": "ContinentalAG"},
    {"name": "ZF",            "ats": "smartrecruiters", "id": "ZFFriedrichshafenAG"},
    {"name": "Valeo",         "ats": "smartrecruiters", "id": "Valeo"},
    # AV / software
    {"name": "Wayve",         "ats": "greenhouse",      "id": "wayve"},
    {"name": "Mobileye",      "ats": "greenhouse",      "id": "mobileye"},
    {"name": "Apex.AI",       "ats": "greenhouse",      "id": "apexai"},
    {"name": "Helm.ai",       "ats": "greenhouse",      "id": "helmai"},
    {"name": "Aurora",        "ats": "greenhouse",      "id": "aurora"},
    # Personio (German AV / mobility startups). NOTE (2026-07): slugs are the
    # companies' Personio subdomains ({id}.jobs.personio.de); on-domain for the
    # automotive profile but their live job counts weren't re-confirmed at commit
    # time (dev IP hit Personio's rate limit). A wrong slug fails safe → []. The
    # fetcher itself is verified against real feeds.
    {"name": "Kopernikus Automotive", "ats": "personio", "id": "kopernikusautomotive"},
    {"name": "Fernride",      "ats": "personio",        "id": "fernride"},
    {"name": "Vay",           "ats": "personio",        "id": "vay"},
    # Ashby (public no-auth JSON board). Verified live 2026-07: helm-ai had 9
    # open roles, oxa is a live AV org (0 open at check). Wrong slug → [].
    {"name": "Helm.ai",       "ats": "ashby",           "id": "helm-ai"},
    {"name": "Oxa",           "ats": "ashby",           "id": "oxa"},
]

# ATS boards keep postings open for weeks — that's fine — but anything older
# than this is a zombie listing (e.g. Continental's 2018 leftovers).
MAX_POSTING_AGE_DAYS = 90


# ──────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ──────────────────────────────────────────────────────────────────────────
def fetch(queries: List[str], location: str,
          max_age_minutes: int = 1440,
          companies: List[str] = None,
          seen_jobs: set = None,
          targets: List[Dict] = None) -> List[Dict]:
    """
    Fetch jobs from company career pages.
    `targets` replaces the default company list entirely (each entry:
    {name, ats, id}) — set it in config.yaml to track your own field's
    employers. `companies` is an optional name filter on top of that.
    `seen_jobs` is a set of job IDs we've processed before. Skipping them
    here saves downstream work; more importantly, the per-company log lines
    show new-vs-seen so the user sees what's actually changing each run.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    seen_jobs = seen_jobs or set()
    all_jobs = []
    targets = targets or COMPANIES
    if companies:
        targets = [c for c in targets if c["name"] in companies]

    for company in targets:
        ats = company["ats"]
        try:
            if ats == "smartrecruiters":
                jobs = _fetch_smartrecruiters(company, queries, location, cutoff,
                                              seen_jobs=seen_jobs)
            elif ats == "greenhouse":
                jobs = _fetch_greenhouse(company, queries, location, cutoff)
            elif ats == "lever":
                jobs = _fetch_lever(company, queries, location, cutoff)
            elif ats == "personio":
                jobs = _fetch_personio(company, queries, location, cutoff)
            elif ats == "ashby":
                jobs = _fetch_ashby(company, queries, location, cutoff)
            elif ats == "recruitee":
                jobs = _fetch_recruitee(company, queries, location, cutoff)
            else:
                logger.warning(f"Unknown ATS '{ats}' for {company['name']}")
                continue
            new_jobs = [j for j in jobs if j["id"] not in seen_jobs]
            all_jobs.extend(new_jobs)
            already_seen = len(jobs) - len(new_jobs)
            if already_seen:
                logger.info(f"  {company['name']}: {len(new_jobs)} new "
                            f"({already_seen} already seen)")
            else:
                logger.info(f"  {company['name']}: {len(new_jobs)} new")
        except Exception as e:
            logger.warning(f"  {company['name']} failed: {e}")
        time.sleep(0.5)

    logger.info(f"Company portals: fetched {len(all_jobs)} new jobs total")
    return all_jobs


# ──────────────────────────────────────────────────────────────────────────
# SMARTRECRUITERS
# ──────────────────────────────────────────────────────────────────────────
# The postings list endpoint has no description, so job text comes from the
# per-posting detail endpoint. Only unseen postings get a detail call, capped
# per run — the first run's backlog is scored on titles, every run after that
# has full descriptions.
MAX_DETAIL_FETCHES_PER_COMPANY = 40


def _fetch_smartrecruiters(company, queries, location, cutoff, seen_jobs=None):
    """
    Use the API's server-side full-text search (`q=`) once per query, with
    `country=de`. That reaches ALL matching postings — Bosch alone has
    thousands, so client-side filtering of the first pages misses nearly
    everything. No lookback filtering beyond the zombie cap — ATS postings
    stay open for weeks and the history file handles dedup.
    """
    base = f"https://api.smartrecruiters.com/v1/companies/{company['id']}/postings"
    jobs = []
    seen = set()
    seen_jobs = seen_jobs or set()
    stale_cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POSTING_AGE_DAYS)

    # Liveness check — dead boards (company moved ATS) return totalFound=0
    resp = requests.get(base, params={"limit": 1},
                        headers=DEFAULT_HEADERS, timeout=15)
    if resp.status_code == 404:
        logger.debug(f"SmartRecruiters: {company['id']} not found")
        return []
    resp.raise_for_status()
    if int(resp.json().get("totalFound", 0)) == 0:
        logger.debug(f"SmartRecruiters: {company['id']} board is empty")
        return []

    # Brand-name queries (e.g. "Bosch" on Bosch's own board) match everything
    unique_queries = {q.lower() for q in (queries or [])
                      if q.lower() not in company["name"].lower()}

    for query in sorted(unique_queries):
        try:
            resp = requests.get(
                base,
                params={"q": query, "country": "de", "limit": 100},
                headers=DEFAULT_HEADERS, timeout=15,
            )
            resp.raise_for_status()
            content = resp.json().get("content", []) or []

            for item in content:
                job_id = item.get("id", "")
                if not job_id or job_id in seen:
                    continue
                seen.add(job_id)

                published = _parse_date(item.get("releasedDate"))
                if published and published < stale_cutoff:
                    continue

                loc_obj = item.get("location") or {}
                loc_str = ", ".join(filter(None, [
                    loc_obj.get("city"),
                    loc_obj.get("region"),
                    loc_obj.get("country"),
                ]))

                jobs.append({
                    "id": f"smartr_{company['id']}_{job_id}",
                    "title": item.get("name", "") or "Unknown",
                    "company": company["name"],
                    "location": loc_str or "Germany",
                    "description": "",  # list endpoint has no description
                    # jobs.smartrecruiters.com renders the posting directly;
                    # careers.smartrecruiters.com bounces to the company's own
                    # portal and loses the job (lands on a generic search page)
                    "url": (
                        f"https://jobs.smartrecruiters.com/"
                        f"{company['id']}/{job_id}"
                    ),
                    "published": item.get("releasedDate"),
                    "source": f"{company['name']} (Direct)",
                })
        except Exception as e:
            logger.debug(f"SmartRecruiters {company['name']} q='{query}': {e}")
        time.sleep(0.2)

    # Fill in descriptions for new postings (matchers need the text to spot
    # German-fluency and experience requirements)
    detail_budget = MAX_DETAIL_FETCHES_PER_COMPANY
    for job in jobs:
        if detail_budget <= 0:
            break
        if job["id"] in seen_jobs:
            continue
        raw_id = job["id"].rsplit("_", 1)[-1]
        desc = _fetch_sr_description(base, raw_id)
        if desc:
            job["description"] = desc
        detail_budget -= 1
        time.sleep(0.2)
    return jobs


def _fetch_sr_description(base_url: str, posting_id: str) -> str:
    """Job text from the posting detail endpoint (list endpoint has none)."""
    try:
        resp = requests.get(f"{base_url}/{posting_id}",
                            headers=DEFAULT_HEADERS, timeout=15)
        resp.raise_for_status()
        sections = (resp.json().get("jobAd") or {}).get("sections") or {}
        parts = [sections.get(k, {}).get("text", "")
                 for k in ("jobDescription", "qualifications",
                           "additionalInformation")]
        return _strip_html(" ".join(p for p in parts if p))[:2000]
    except Exception:
        return ""


# ──────────────────────────────────────────────────────────────────────────
# GREENHOUSE
# ──────────────────────────────────────────────────────────────────────────
def _fetch_greenhouse(company, queries, location, cutoff):
    """
    Greenhouse exposes ALL of a company's open jobs at one public endpoint.
    No date filtering — these companies often have jobs open for weeks.
    History file handles dedup.
    """
    url = f"https://boards-api.greenhouse.io/v1/boards/{company['id']}/jobs"
    jobs = []
    try:
        resp = requests.get(url, params={"content": "true"},
                            headers=DEFAULT_HEADERS, timeout=15)
        if resp.status_code == 404:
            logger.debug(f"Greenhouse: {company['id']} not found")
            return []
        resp.raise_for_status()
        data = resp.json()

        # Brand-name queries would match every posting on the company's own board
        query_lower = [q.lower() for q in (queries or [])
                       if q.lower() not in company["name"].lower()]
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POSTING_AGE_DAYS)

        for item in data.get("jobs", []):
            job_id = str(item.get("id", ""))
            if not job_id:
                continue

            updated = _parse_date(item.get("updated_at"))
            if updated and updated < stale_cutoff:
                continue

            title = item.get("title", "")
            content = _strip_html(item.get("content", ""))
            full_text = f"{title} {content}".lower()

            # Skip jobs that don't match any query
            if query_lower and not any(q in full_text for q in query_lower):
                continue

            location_str = (item.get("location") or {}).get("name", "")
            jobs.append({
                "id": f"gh_{company['id']}_{job_id}",
                "title": title,
                "company": company["name"],
                "location": location_str,
                "description": content[:2000],
                "url": item.get("absolute_url", ""),
                "published": item.get("updated_at"),
                "source": f"{company['name']} (Direct)",
            })
    except Exception as e:
        logger.debug(f"Greenhouse {company['name']}: {e}")
    return jobs


# ──────────────────────────────────────────────────────────────────────────
# LEVER (some smaller startups)
# ──────────────────────────────────────────────────────────────────────────
def _fetch_lever(company, queries, location, cutoff):
    url = f"https://api.lever.co/v0/postings/{company['id']}"
    jobs = []
    try:
        resp = requests.get(url, params={"mode": "json"},
                            headers=DEFAULT_HEADERS, timeout=15)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        query_lower = [q.lower() for q in queries]

        for item in data:
            job_id = item.get("id", "")
            if not job_id:
                continue

            ts = item.get("createdAt", 0)  # ms epoch
            published = (datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
                         if ts else None)
            if published and published < cutoff:
                continue

            title = item.get("text", "")
            desc = _strip_html(item.get("description", ""))
            full_text = f"{title} {desc}".lower()
            if query_lower and not any(q in full_text for q in query_lower):
                continue

            location_str = (item.get("categories") or {}).get("location", "")
            jobs.append({
                "id": f"lever_{company['id']}_{job_id}",
                "title": title,
                "company": company["name"],
                "location": location_str,
                "description": desc[:2000],
                "url": item.get("hostedUrl", ""),
                "published": published.isoformat() if published else None,
                "source": f"{company['name']} (Direct)",
            })
    except Exception as e:
        logger.debug(f"Lever {company['name']}: {e}")
    return jobs


# ──────────────────────────────────────────────────────────────────────────
# PERSONIO (German Mittelstand & mobility startups)
# ──────────────────────────────────────────────────────────────────────────
def _fetch_personio(company, queries, location, cutoff):
    """
    Personio publishes every open job at one public XML feed:
        https://{id}.jobs.personio.de/xml
    where `id` is the company's Personio subdomain (e.g. "kopernikusautomotive"
    → kopernikusautomotive.jobs.personio.de). No auth, no HTML scraping — the
    feed exists for companies to embed on their own site, so it's open by
    design. This is the German mid-market's equivalent of Greenhouse's public
    board.

    No date filtering beyond the zombie cap — Personio postings stay open for
    weeks and the history file handles dedup (same as Greenhouse).
    """
    url = f"https://{company['id']}.jobs.personio.de/xml"
    jobs = []
    try:
        resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=15)
        if resp.status_code == 404:
            logger.debug(f"Personio: {company['id']} not found")
            return []
        resp.raise_for_status()
        try:
            root = ET.fromstring(resp.content)
        except ET.ParseError as e:
            logger.debug(f"Personio {company['name']}: malformed XML ({e})")
            return []

        # Brand-name queries would match every posting on the company's own feed
        query_lower = [q.lower() for q in (queries or [])
                       if q.lower() not in company["name"].lower()]
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POSTING_AGE_DAYS)

        for pos in root.findall("position"):
            job_id = (pos.findtext("id") or "").strip()
            if not job_id:
                continue

            created = _parse_date(pos.findtext("createdAt"))
            if created and created < stale_cutoff:
                continue

            title = (pos.findtext("name") or "").strip()

            # Description lives across several <jobDescription><value> blocks,
            # each a CDATA HTML chunk ("Your profile", "Why us?", ...). Join
            # them; fall back to itertext() if a feed nests real elements.
            desc_parts = []
            jd = pos.find("jobDescriptions")
            if jd is not None:
                for d in jd.findall("jobDescription"):
                    val_el = d.find("value")
                    if val_el is None:
                        continue
                    raw = val_el.text or "".join(val_el.itertext())
                    if raw:
                        desc_parts.append(raw)
            content = _strip_html(" ".join(desc_parts))

            full_text = f"{title} {content}".lower()
            if query_lower and not any(q in full_text for q in query_lower):
                continue

            # A position may carry several <office> elements (multi-site roles)
            offices = [o.text.strip() for o in pos.findall("office")
                       if o is not None and o.text and o.text.strip()]
            location_str = ", ".join(offices)

            jobs.append({
                "id": f"personio_{company['id']}_{job_id}",
                "title": title or "Unknown",
                "company": company["name"],
                "location": location_str or "Germany",
                "description": content[:2000],
                "url": f"https://{company['id']}.jobs.personio.de/job/{job_id}",
                "published": pos.findtext("createdAt"),
                "source": f"{company['name']} (Direct)",
            })
    except Exception as e:
        logger.debug(f"Personio {company['name']}: {e}")
    return jobs


# ──────────────────────────────────────────────────────────────────────────
# ASHBY (modern AV / robotics startups)
# ──────────────────────────────────────────────────────────────────────────
def _fetch_ashby(company, queries, location, cutoff):
    """
    Ashby exposes every listed job at one public, no-auth JSON endpoint:
        https://api.ashbyhq.com/posting-api/job-board/{id}
    where `id` is the org slug (jobs.ashbyhq.com/{id}). Same open-by-design
    model as Greenhouse. `descriptionPlain` is already plain text, so no HTML
    strip is needed. History file handles dedup; only the zombie cap applies.
    """
    url = f"https://api.ashbyhq.com/posting-api/job-board/{company['id']}"
    jobs = []
    try:
        resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=15)
        if resp.status_code == 404:
            logger.debug(f"Ashby: {company['id']} not found")
            return []
        resp.raise_for_status()
        data = resp.json()

        # Brand-name queries would match every posting on the company's own board
        query_lower = [q.lower() for q in (queries or [])
                       if q.lower() not in company["name"].lower()]
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POSTING_AGE_DAYS)

        for item in data.get("jobs", []):
            if item.get("isListed") is False:
                continue
            job_id = str(item.get("id", ""))
            if not job_id:
                continue

            published = _parse_date(item.get("publishedAt"))
            if published and published < stale_cutoff:
                continue

            title = item.get("title", "") or ""
            content = (item.get("descriptionPlain")
                       or _strip_html(item.get("descriptionHtml", "")))
            full_text = f"{title} {content}".lower()
            if query_lower and not any(q in full_text for q in query_lower):
                continue

            loc = (item.get("location") or "").strip()
            if item.get("isRemote") and "remote" not in loc.lower():
                loc = f"{loc} (Remote)".strip()

            jobs.append({
                "id": f"ashby_{company['id']}_{job_id}",
                "title": title or "Unknown",
                "company": company["name"],
                "location": loc or "Unknown",
                "description": (content or "")[:2000],
                "url": item.get("jobUrl", "") or item.get("applyUrl", ""),
                "published": item.get("publishedAt"),
                "source": f"{company['name']} (Direct)",
            })
    except Exception as e:
        logger.debug(f"Ashby {company['name']}: {e}")
    return jobs


# ──────────────────────────────────────────────────────────────────────────
# RECRUITEE (EU / German startups)
# ──────────────────────────────────────────────────────────────────────────
def _fetch_recruitee(company, queries, location, cutoff):
    """
    Recruitee publishes all open roles at one public, no-auth JSON endpoint:
        https://{id}.recruitee.com/api/offers/
    where `id` is the company subdomain on recruitee.com. Popular with EU /
    German startups. History file handles dedup; only the zombie cap applies.
    """
    url = f"https://{company['id']}.recruitee.com/api/offers/"
    jobs = []
    try:
        resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=15)
        if resp.status_code == 404:
            logger.debug(f"Recruitee: {company['id']} not found")
            return []
        resp.raise_for_status()
        data = resp.json()

        query_lower = [q.lower() for q in (queries or [])
                       if q.lower() not in company["name"].lower()]
        stale_cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_POSTING_AGE_DAYS)

        for item in data.get("offers", []):
            # Only surface live roles (drafts/closed carry a non-published status)
            status = item.get("status")
            if status and status != "published":
                continue
            job_id = str(item.get("id", ""))
            if not job_id:
                continue

            published = _parse_date(item.get("published_at")
                                    or item.get("created_at"))
            if published and published < stale_cutoff:
                continue

            title = item.get("title", "") or ""
            content = _strip_html(item.get("description", ""))
            full_text = f"{title} {content}".lower()
            if query_lower and not any(q in full_text for q in query_lower):
                continue

            loc = (item.get("location")
                   or ", ".join(filter(None, [item.get("city"),
                                              item.get("country")])))

            jobs.append({
                "id": f"recruitee_{company['id']}_{job_id}",
                "title": title or "Unknown",
                "company": company["name"],
                "location": loc or "Unknown",
                "description": content[:2000],
                "url": (item.get("careers_url", "")
                        or item.get("careers_apply_url", "")),
                "published": item.get("published_at") or item.get("created_at"),
                "source": f"{company['name']} (Direct)",
            })
    except Exception as e:
        logger.debug(f"Recruitee {company['name']}: {e}")
    return jobs


# ──────────────────────────────────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────────────────────────────────
def _parse_date(date_str):
    if not date_str:
        return None
    if isinstance(date_str, (int, float)):
        # epoch
        try:
            return datetime.fromtimestamp(date_str / (1000 if date_str > 1e12 else 1),
                                          tz=timezone.utc)
        except (ValueError, OSError):
            return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
                "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def _strip_html(html):
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
