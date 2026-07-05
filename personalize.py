"""
Profile generator — turns cv.md into a complete profile.yaml.

The user maintains ONE file (cv.md: their CV plus an "Additional Information"
section with interests, target cities, work preferences). This module asks
Groq to derive everything the matchers need from it: persona, skills, target
titles, keyword filters, the field's domain block, and job-board search
queries.

Triggered automatically on a real run while profile.yaml still contains
template placeholders, or manually via `python main.py --personalize`.
The generated file is plain YAML — edit it freely afterwards; it is never
overwritten unless placeholders reappear or --personalize is used.
"""
import logging
from pathlib import Path
from typing import Dict

import yaml

from matchers import groq_client

logger = logging.getLogger(__name__)

# Keys the LLM must return; missing ones fail validation and abort generation.
REQUIRED_KEYS = [
    "name", "persona", "career_level", "years_of_experience",
    "skills", "target_titles", "must_have_keywords", "exclude_keywords",
    "preferred_locations", "language_preference", "search_queries", "domain",
]
REQUIRED_DOMAIN_KEYS = [
    "name", "core_terms", "supporting_terms", "adjacent_terms",
    "core_companies", "adjacent_companies", "reject_title_terms", "bonus_terms",
]

PROMPT = """You are configuring an automated job-alert system for the candidate
whose CV (including an additional-information section) follows.

=== CV AND ADDITIONAL INFO ===
{cv}
=== END ===

Derive the candidate's field, level, and preferences, then return a JSON
object with EXACTLY these keys:

- "name": the candidate's full name
- "email": the candidate's email address, or "" if not in the CV
- "persona": one line, e.g. "a master's student in <programme> (<specialty / strongest tools>)"
- "career_level": "student" or "graduate" or "professional"
- "years_of_experience": integer, professional full-time experience only
- "skills": 15-30 skill keywords from the CV. Where an important German
  equivalent exists, include it as an additional list item.
- "target_titles": 20-40 job titles worth targeting, mixed English and German.
  If the candidate is a student, include student variants (Working Student,
  Werkstudent, Intern, Praktikum, Pflichtpraktikum, Masterarbeit, Thesis,
  Abschlussarbeit) both bare and combined with the field.
- "must_have_keywords": 10-20 words of which at least one should appear in a
  relevant job posting (bilingual)
- "exclude_keywords": 8-15 seniority/mismatch terms to instantly reject
  (e.g. Senior, Lead, Principal, "10+ years", mehrjährige Berufserfahrung)
- "preferred_locations": cities/regions from the CV or additional info, plus
  country names
- "language_preference": "english_only" or "no_german_required" or "any".
  If the candidate's German is below C1 and the market is Germany, use
  "no_german_required" unless the additional info says otherwise.
- "search_queries": 15-25 short search strings for job boards (1-3 words
  each, bilingual, e.g. "Werkstudent Automotive", "Junior Perception Engineer")
- "domain": an object describing the candidate's FIELD so rule-based filters
  can pre-sort jobs without AI:
  - "name": the field, e.g. "automotive engineering", "corporate law"
  - "core_terms": 15-30 terms that strongly signal a job is in this field (bilingual)
  - "supporting_terms": 5-10 relevant but ambiguous terms
  - "adjacent_terms": 5-12 terms of neighboring industries with transferable skills
  - "core_companies": 15-30 real, well-known employers central to this field
    in the target country (lowercase names)
  - "adjacent_companies": 5-15 employers in neighboring industries (lowercase)
  - "reject_title_terms": 20-40 job-title fragments clearly NOT this field
    (e.g. for an engineer: "marketing manager", "nurse", "recruiter";
    for a lawyer: "software developer", "mechanical engineer")
  - "bonus_terms": 5-10 of the candidate's strongest specialty terms

Target market: infer the country from the CV/additional info; if unclear,
assume Germany and produce bilingual English+German terms throughout.

Respond with ONLY the JSON object."""


def profile_is_template(profile: Dict) -> bool:
    """True while profile.yaml still carries factory placeholders."""
    if not profile:
        return True
    name = ((profile.get("personal") or {}).get("name") or "")
    persona = profile.get("persona") or ""
    return "[" in name or "[" in persona or not name.strip()


def generate(cv_text: str, api_key: str,
             model: str = "llama-3.3-70b-versatile") -> Dict:
    """Ask Groq for the personalization JSON and shape it into a profile dict."""
    result = groq_client.chat_json(PROMPT.format(cv=cv_text[:6000]), api_key,
                                   model=model, max_tokens=4000, temperature=0.3)
    if result is None:
        raise RuntimeError("Groq did not return usable JSON for profile "
                           "generation — try again (or check GROQ_API_KEY).")

    missing = [k for k in REQUIRED_KEYS if k not in result]
    dom = result.get("domain") or {}
    missing += [f"domain.{k}" for k in REQUIRED_DOMAIN_KEYS if k not in dom]
    if missing:
        raise RuntimeError(f"Generated profile is missing fields: {missing}")

    if result.get("language_preference") not in ("english_only",
                                                 "no_german_required", "any"):
        result["language_preference"] = "no_german_required"

    return {
        "personal": {
            "name": result["name"],
            "email": result.get("email", ""),
        },
        "persona": result["persona"],
        "domain": {k: dom[k] for k in REQUIRED_DOMAIN_KEYS},
        "skills": result["skills"],
        "target_titles": result["target_titles"],
        "must_have_keywords": result["must_have_keywords"],
        "exclude_keywords": result["exclude_keywords"],
        "preferred_locations": result["preferred_locations"],
        "language_preference": result["language_preference"],
        "years_of_experience": int(result.get("years_of_experience", 0)),
        "career_level": result.get("career_level", "student"),
        "search_queries": result["search_queries"],
        "prefilter_min_score": 15,
        "tier_thresholds": {"strong": 75, "worth_look": 50},
    }


def write(profile: Dict, path: Path) -> None:
    header = (
        "# ============================================================\n"
        "#  YOUR PROFILE — auto-generated from cv.md\n"
        "#  Edit freely: this file is only regenerated if placeholders\n"
        "#  reappear or you run `python main.py --personalize`.\n"
        "# ============================================================\n\n"
    )
    body = yaml.safe_dump(profile, allow_unicode=True, sort_keys=False,
                          width=100, default_flow_style=False)
    path.write_text(header + body, encoding="utf-8")


def ensure_profile(cv_text: str, api_key: str, model: str,
                   path: Path) -> Dict:
    """Generate profile.yaml from cv.md, write it, and return it."""
    if not cv_text:
        raise SystemExit("cv.md is empty or still contains placeholder text — "
                         "fill in your CV first, then re-run.")
    if not api_key:
        raise SystemExit("Profile generation needs GROQ_API_KEY "
                         "(free at console.groq.com).")
    logger.info("🪄 Generating profile.yaml from cv.md via Groq...")
    profile = generate(cv_text, api_key, model)
    write(profile, path)
    logger.info(f"🪄 profile.yaml generated for {profile['personal']['name']} "
                f"— field: {profile['domain']['name']}, "
                f"{len(profile['search_queries'])} search queries. "
                "Review and tweak it any time.")
    return profile
