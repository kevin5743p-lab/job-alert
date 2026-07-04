"""
Domain classifier — the "is this in my field?" stage.

This runs BEFORE skill scoring. Its only job: decide whether a job is in the
candidate's field, adjacent to it, or completely out of domain. The field is
defined by a `domain:` block in profile.yaml (see DEFAULT_DOMAIN below for
the schema); without one, the automotive defaults apply.

Two layers for efficiency and reliability:
  1. Rule-based pass — handles most jobs instantly using keyword/company
     signals from the domain block. No API call. No cost.
  2. AI fallback (Groq) — only for genuinely ambiguous cases.

Output classes (one of these is always returned):
  - core_field           : directly in the candidate's field
  - adjacent_in_company  : different role at a company central to the field
  - skill_adjacent       : different industry, strong skill overlap
  - broader_field        : same broad profession, different specialty
  - out_of_domain        : unrelated (hard-rejected by the tier router)
"""
import logging
import re
from typing import Dict, Tuple, Optional

from matchers import groq_client

logger = logging.getLogger(__name__)

VALID_CLASSES = {"core_field", "adjacent_in_company", "skill_adjacent",
                 "broader_field", "out_of_domain"}

# ── Default domain: automotive engineering ────────────────────────────────────
# Serves two purposes: keeps existing installs working unchanged, and shows
# the schema a profile.yaml `domain:` block can override per field.
DEFAULT_DOMAIN = {
    "name": "automotive engineering",

    # Companies central to the field. Word-boundary matched against the
    # normalized employer name.
    "core_companies": [
        # OEMs
        "bmw", "mercedes-benz", "mercedes benz", "mercedes", "daimler",
        "audi", "porsche", "volkswagen", "vw", "skoda", "seat", "cupra",
        "opel", "ford germany", "ford-werke",
        # Auto software / AV
        "cariad", "mobileye", "wayve", "apex.ai", "apex ai", "helm.ai",
        "aurora innovation", "argo ai", "zoox", "cruise", "waymo",
        # Tier-1 suppliers
        "bosch", "robert bosch", "continental", "zf", "zf friedrichshafen",
        "valeo", "magna", "aptiv", "denso", "hella", "schaeffler",
        "mahle", "brose", "leoni", "knorr-bremse", "thyssenkrupp",
        "webasto", "marquardt", "preh", "kostal",
        # Engineering services
        "edag", "bertrandt", "fev", "avl", "iav", "akkodis", "alten",
        "capgemini engineering", "expleo", "segula",
        # Specialized auto / mobility
        "rivian", "lucid", "tesla", "polestar", "lilium", "volocopter",
    ],

    # Words that strongly suggest the field's content. 2+ hits classify a
    # job as core_field on their own.
    "core_terms": [
        "automotive", "automobil", "automobile", "automobiltechnik",
        "vehicle", "fahrzeug", "fahrzeugtechnik", "kfz",
        "adas", "fahrerassistenz", "driver assistance",
        "autonomous driving", "autonomes fahren", "self-driving", "selbstfahrend",
        "perception", "perzeption", "wahrnehmung",
        "powertrain", "antriebsstrang",
        "e-mobility", "elektromobilität", "elektromobilitaet",
        "battery management", "batteriemanagement", "bms",
        "vehicle dynamics", "fahrdynamik",
        "in-vehicle", "im fahrzeug",
        "can bus", "lin bus", "flexray", "automotive ethernet",
        "autosar", "iso 26262", "asil",
        "homologation", "homologierung",
        "ecu", "steuergerät",
    ],

    # Relevant but ambiguous on their own (could be another industry).
    # Supporting evidence only; alone they defer to the AI.
    "supporting_terms": [
        "lidar", "radar", "camera sensor", "sensor fusion",
        "sensorik", "sensordaten", "kameradaten",
    ],

    # Related industries with transferable skills → skill_adjacent.
    "adjacent_terms": [
        "warehouse robot", "warehouse robotics",
        "drone", "uav", "unmanned aerial",
        "aerospace", "luft- und raumfahrt", "aviation",
        "industrial robot", "industrieroboter",
        "agricultural robot", "agribot",
        "mobile robot", "mobile robotik",
    ],
    "adjacent_companies": [
        "magazino", "kuka", "fanuc", "abb robotics",
        "airbus", "lufthansa technik", "rolls-royce aerospace", "mtu aero",
        "dji", "parrot", "skydio",
        "ifm", "sick", "balluff", "pepperl+fuchs",
    ],

    # Title terms that signal a job is OUTSIDE the field — even at a core
    # company ("Backend Developer at Mercedes" is still backend dev).
    # Word-boundary matched against the title.
    "reject_title_terms": [
        # Web / general software
        "web developer", "frontend developer", "front-end developer",
        "fullstack developer", "full-stack developer",
        "backend developer", "back-end developer", "back end developer",
        "react developer", "angular developer", "vue developer",
        "wordpress", "shopify", "magento",
        # Business / finance
        "accountant", "buchhalter", "controller", "tax", "steuerberater",
        "financial analyst", "investment banker",
        # Marketing / sales
        "marketing manager", "sales manager", "account executive",
        "social media manager", "seo specialist", "copywriter",
        # HR / admin
        "recruiter", "hr manager", "personalreferent", "office manager",
        # Healthcare
        "nurse", "krankenpfleger", "doctor", "arzt", "physician",
        # Legal
        "lawyer", "anwalt", "rechtsanwalt", "paralegal",
        # Trades / hospitality
        "plumber", "carpenter", "chef", "barista",
    ],

    # Terms from the candidate's core strengths — small scoring bonus in the
    # rule pre-filter.
    "bonus_terms": [
        "lidar", "radar", "perception", "sensor fusion",
        "adas", "autonomous", "self-driving", "grafana", "influxdb",
    ],
}


def get_domain(profile: Dict) -> Dict:
    """The profile's domain block over the automotive defaults."""
    return {**DEFAULT_DOMAIN, **(profile.get("domain") or {})}


# ──────────────────────────────────────────────────────────────────────────────
#  Rule layer
# ──────────────────────────────────────────────────────────────────────────────
def classify_with_rules(job: Dict, domain: Optional[Dict] = None
                        ) -> Tuple[Optional[str], str]:
    """
    Try to classify using fast rules. Returns (class, reason) or (None, '')
    if confidence is too low and the AI should be consulted.
    """
    domain = domain or DEFAULT_DOMAIN
    title = (job.get("title") or "").lower()
    company = (job.get("company") or "").lower().strip()
    desc = (job.get("description") or "").lower()
    text = f"{title} {desc}"

    company_norm = re.sub(r"\s+(gmbh|ag|se|kg|co|inc|ltd|llc|group|usa|deutschland)\b", "",
                          company).strip()

    # Match company against known lists: require word-boundary match, not substring
    def _company_matches(c_list):
        for known in c_list:
            if not known:
                continue
            known = known.lower()
            if known == company_norm:
                return True
            if re.search(rf"\b{re.escape(known)}\b", company_norm):
                return True
        return False

    is_core_company = _company_matches(domain.get("core_companies", []))
    is_adjacent_company = _company_matches(domain.get("adjacent_companies", []))

    core_hits = sum(1 for t in domain.get("core_terms", []) if t.lower() in text)
    support_hits = sum(1 for t in domain.get("supporting_terms", []) if t.lower() in text)
    adjacent_hits = sum(1 for t in domain.get("adjacent_terms", []) if t.lower() in text)

    # Strong out-of-field title signal (regardless of company)
    for pattern in domain.get("reject_title_terms", []):
        if re.search(rf"\b{re.escape(pattern.lower())}\b", title):
            if is_core_company:
                return ("adjacent_in_company",
                        f"off-field role title at core company '{company}'")
            return ("out_of_domain",
                    f"title contains out-of-field term: '{pattern}'")

    # Clear core: core company AND field/supporting terms present
    if is_core_company and (core_hits + support_hits) >= 1:
        return ("core_field",
                f"core company '{company}' with {core_hits} field + "
                f"{support_hits} supporting terms")

    # Clear core: any company but clearly in-field content
    if core_hits >= 2:
        return ("core_field", f"strong field context ({core_hits} field terms)")

    # Core company, but the role doesn't sound in-field — adjacent
    if is_core_company and core_hits == 0 and support_hits == 0:
        return ("adjacent_in_company",
                f"core company '{company}' but role lacks field context")

    # Clear adjacent industry
    if is_adjacent_company or adjacent_hits >= 1:
        return ("skill_adjacent",
                f"adjacent industry: {adjacent_hits} adjacent terms"
                + (f", company '{company}'" if is_adjacent_company else ""))

    # Weak or no signals → defer to AI
    return (None, "")


# ──────────────────────────────────────────────────────────────────────────────
#  AI layer
# ──────────────────────────────────────────────────────────────────────────────
def classify_with_ai(job: Dict, api_key: str,
                     model: str = "llama-3.3-70b-versatile",
                     domain: Optional[Dict] = None,
                     persona: str = "") -> Tuple[str, str]:
    """
    Ask Groq to classify a job that the rules couldn't decide on.
    Returns (class, reason).
    Raises groq_client.DailyQuotaExhausted when the daily quota is gone.
    """
    domain = domain or DEFAULT_DOMAIN
    field = domain.get("name", "the candidate's field")
    who = persona or f"a student in {field}"

    prompt = f"""Classify this job for {who}.

Job title: {job.get("title", "")}
Company: {job.get("company", "")}
Description (excerpt): {(job.get("description", "") or "")[:1200]}

Pick exactly ONE class:
- core_field: directly in the candidate's field ({field})
- adjacent_in_company: a different kind of role, but at a company central
  to {field}
- skill_adjacent: different industry with strong overlap with the
  candidate's skills
- broader_field: same broad profession as the candidate, different specialty
- out_of_domain: unrelated to {field} and to the candidate's skills

Respond with a JSON object in exactly this format:
{{"class": "<one of the 5>", "reason": "<one short sentence>"}}"""

    result = groq_client.chat_json(prompt, api_key, model=model,
                                   max_tokens=120, temperature=0.1)
    if result is None:
        return ("out_of_domain", "Classification failed (AI unavailable)")
    klass = result.get("class", "out_of_domain")
    if klass not in VALID_CLASSES:
        klass = "out_of_domain"
    return (klass, result.get("reason", "AI classification"))
