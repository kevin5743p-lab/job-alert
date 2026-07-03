"""
Domain classifier — the "is this in my field?" stage.

This runs BEFORE skill scoring. Its only job: decide whether a job is
automotive / mobility-related, adjacent, or completely out of domain.

Two layers for efficiency and reliability:
  1. Rule-based pass — handles ~80% of jobs instantly using keyword/company
     signals. No API call. No cost.
  2. AI fallback (Groq) — only for genuinely ambiguous cases.

Output classes (one of these is always returned):
  - core_auto                  : direct automotive work
  - auto_adjacent_in_company   : non-auto role at an auto company
  - tech_adjacent              : robotics, drones, aerospace, industrial sensors
  - engineering_general        : mech/electrical at non-auto company
  - out_of_domain              : web dev, finance, marketing, etc.
"""
import logging
import re
from typing import Dict, Tuple, Optional

from matchers import groq_client

logger = logging.getLogger(__name__)

# ── Lists used by the rule layer ──────────────────────────────────────────────
# These are intentionally conservative. When the rules don't match strongly,
# we let the AI decide. Better to defer than to misclassify.

AUTO_COMPANIES = {
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
    # Engineering services (often the realistic entry point for graduates)
    "edag", "bertrandt", "fev", "avl", "iav", "akkodis", "alten",
    "capgemini engineering", "expleo", "segula",
    # Specialized auto / mobility
    "rivian", "lucid", "tesla", "polestar", "lilium", "volocopter",
}

# Words that strongly suggest automotive content — these alone don't classify
# (since "automotive cybersecurity" might appear in an IT firm's posting),
# but combined with other signals they help.
AUTO_DOMAIN_TERMS = {
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
}

# Sensor / hardware terms — relevant to the CV but ambiguous on their own
# (could be in robotics, aerospace, or auto). Used as supporting evidence.
SENSOR_TERMS = {
    "lidar", "radar", "camera sensor", "sensor fusion",
    "sensorik", "sensordaten", "kameradaten",
}

# Strong signals that a job is OUTSIDE the auto domain — even at an auto company.
# E.g. "Backend Developer at Mercedes" is still backend dev.
OUT_OF_DOMAIN_TITLE_TERMS = {
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
    # Trades unrelated to auto
    "electrician unrelated", "plumber", "carpenter", "chef", "barista",
}

# Adjacent-tech sectors (robotics, aerospace, drones, industrial sensors).
ADJACENT_COMPANIES = {
    "magazino", "kuka", "fanuc", "abb robotics",
    "airbus", "lufthansa technik", "rolls-royce aerospace", "mtu aero",
    "dji", "parrot", "skydio",
    "ifm", "sick", "balluff", "pepperl+fuchs",  # industrial sensors
}

ADJACENT_TERMS = {
    "warehouse robot", "warehouse robotics",
    "drone", "uav", "unmanned aerial",
    "aerospace", "luft- und raumfahrt", "aviation",
    "industrial robot", "industrieroboter",
    "agricultural robot", "agribot",
    "mobile robot", "mobile robotik",
}


# ──────────────────────────────────────────────────────────────────────────────
#  Rule layer
# ──────────────────────────────────────────────────────────────────────────────
def classify_with_rules(job: Dict) -> Tuple[Optional[str], str]:
    """
    Try to classify using fast rules. Returns (class, reason) or (None, '')
    if confidence is too low and the AI should be consulted.
    """
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
            # Exact match OR known company is a complete phrase within company_norm
            if known == company_norm:
                return True
            # Phrase match: "bmw" in "bmw m gmbh" yes; "lufthansa" in "lufthansa technik" yes
            # but reject the reverse (where company is a substring of the known name)
            if re.search(rf"\b{re.escape(known)}\b", company_norm):
                return True
        return False

    is_auto_company = _company_matches(AUTO_COMPANIES)
    is_adjacent_company = _company_matches(ADJACENT_COMPANIES)

    auto_term_hits = sum(1 for t in AUTO_DOMAIN_TERMS if t in text)
    sensor_term_hits = sum(1 for t in SENSOR_TERMS if t in text)
    adjacent_term_hits = sum(1 for t in ADJACENT_TERMS if t in text)

    # Strong out-of-domain title signal (regardless of company)
    for pattern in OUT_OF_DOMAIN_TITLE_TERMS:
        if re.search(rf"\b{pattern}\b", title):
            # Override: at an auto company, treat as auto_adjacent_in_company
            if is_auto_company:
                return ("auto_adjacent_in_company",
                        f"non-auto role title at automotive company '{company}'")
            return ("out_of_domain",
                    f"title contains out-of-domain term: '{pattern}'")

    # Clear core_auto: auto company AND multiple auto/sensor terms
    if is_auto_company and (auto_term_hits + sensor_term_hits) >= 1:
        return ("core_auto",
                f"automotive company '{company}' with {auto_term_hits} auto + "
                f"{sensor_term_hits} sensor terms")

    # Clear core_auto: any company but clearly automotive content
    if auto_term_hits >= 2:
        return ("core_auto",
                f"strong automotive context ({auto_term_hits} auto terms)")

    # Auto company, but the role doesn't sound auto — adjacent
    if is_auto_company and auto_term_hits == 0 and sensor_term_hits == 0:
        return ("auto_adjacent_in_company",
                f"automotive company '{company}' but role lacks auto context")

    # Clear adjacent (robotics/aerospace/industrial sensors)
    if is_adjacent_company or adjacent_term_hits >= 1:
        return ("tech_adjacent",
                f"adjacent tech: {adjacent_term_hits} adjacent terms"
                + (f", company '{company}'" if is_adjacent_company else ""))

    # Sensor work without auto context — could be robotics/aerospace.
    # Weak or no signals → defer to AI.
    return (None, "")


# ──────────────────────────────────────────────────────────────────────────────
#  AI layer
# ──────────────────────────────────────────────────────────────────────────────
def classify_with_ai(job: Dict, api_key: str,
                     model: str = "llama-3.3-70b-versatile") -> Tuple[str, str]:
    """
    Ask Groq to classify a job that the rules couldn't decide on.
    Returns (class, reason).
    Raises groq_client.DailyQuotaExhausted when the daily quota is gone.
    """
    prompt = f"""Classify this job for an automotive engineering student.
The student specializes in sensor data (LiDAR, Radar, Camera), Python, and
data visualization (Grafana/InfluxDB). They're open to all of automotive
including mechanical, electrical, embedded, ADAS, and EV roles.

Job title: {job.get("title", "")}
Company: {job.get("company", "")}
Description (excerpt): {(job.get("description", "") or "")[:1200]}

Pick exactly ONE class:
- core_auto: direct automotive work (OEM, Tier-1, ADAS, EV, vehicle software,
  embedded auto, BMS, vehicle dynamics, powertrain, etc.)
- auto_adjacent_in_company: non-automotive-sounding role (e.g. backend, HR,
  data engineer) at a clearly automotive company
- tech_adjacent: robotics, drones, aerospace, industrial sensors, autonomous
  machinery (similar skills, different industry)
- engineering_general: mechanical/electrical engineering at a non-automotive
  company (e.g. Siemens turbines, BSH appliances)
- out_of_domain: web dev, finance, marketing, healthcare, consulting (non-auto),
  gaming, education, retail, etc.

Respond with a JSON object in exactly this format:
{{"class": "<one of the 5>", "reason": "<one short sentence>"}}"""

    result = groq_client.chat_json(prompt, api_key, model=model,
                                   max_tokens=120, temperature=0.1)
    if result is None:
        return ("out_of_domain", "Classification failed (AI unavailable)")
    klass = result.get("class", "out_of_domain")
    if klass not in {"core_auto", "auto_adjacent_in_company",
                     "tech_adjacent", "engineering_general", "out_of_domain"}:
        klass = "out_of_domain"
    return (klass, result.get("reason", "AI classification"))
