"""
Rule-based matcher – NO API key required, 100% free.

Scores jobs using keyword overlap, title similarity, and skill matching.
Less nuanced than an LLM but very reliable for well-defined criteria.
"""
import logging
import re
from typing import Dict, Tuple

logger = logging.getLogger(__name__)


def score_job(job: Dict, profile: Dict, api_key: str = None) -> Tuple[int, str]:
    """
    Score a job (0-100) against the profile using rules only.
    `api_key` is accepted but ignored (kept for compatibility).
    """
    title = (job.get("title") or "").lower()
    desc = (job.get("description") or "").lower()
    location = (job.get("location") or "").lower()
    text = f"{title} {desc}"

    # ── HARD FILTER 0: Obvious out-of-domain titles ──────────────────────────
    # Reject these instantly — no need to spend AI tokens classifying them.
    # We only check the title (not description) and require a word boundary
    # so "Marketing Manager" matches but "Marketing-Coordinator at BMW" still
    # gets classified by the AI (because it's a different role).
    OBVIOUS_NON_AUTO_TITLES = [
        # Marketing & sales
        "marketing manager", "marketing coordinator", "marketing specialist",
        "sales manager", "sales executive", "account executive", "account manager",
        "social media manager", "seo specialist", "copywriter", "content writer",
        "growth manager", "brand manager",
        # Legal
        "legal engineer", "lawyer", "rechtsanwalt", "paralegal", "legal counsel",
        "rechtsanwaltsfachangestellte", "syndikusanwalt",
        # HR / recruiting
        "recruiter", "talent acquisition", "hr manager", "personalreferent",
        "personalmanager", "hr business partner",
        # Finance / accounting (NOT financial engineering, just admin)
        "accountant", "buchhalter", "tax", "steuerberater", "controller",
        "buchhaltung", "lohnbuchhalter",
        # Real estate
        "real estate", "immobilien",
        # Pure consulting (non-automotive)
        "managementberatung",  # but only when company is clearly consulting
        # Healthcare
        "krankenpfleger", "krankenschwester", "altenpfleger", "physiotherapeut",
        "arzt", "ärztin", "doctor", "nurse", "physician",
        # Trades unrelated to auto
        "barista", "kellner", "koch", "chef de cuisine", "verkäufer",
        # Architecture / construction (TGA, BIM, etc. = building services, not auto)
        "bim koord",   # BIM Koordinator/Koordination
        "bim koordinator",
        "bim manager",
        "tga",         # Technische Gebäudeausrüstung
        "architekt",   # standalone Architekt only — "Software Architect" is different
    ]
    title_clean = title.strip()
    company_lower = (job.get("company") or "").lower()
    for bad in OBVIOUS_NON_AUTO_TITLES:
        # Substring match — "bim koord" matches "bim koordinator"
        # and "marketing manager" matches "junior marketing manager"
        if bad in title_clean:
            # Exception: if at a clearly automotive company, still send to AI
            # (e.g. "Marketing Manager" at BMW — auto-adjacent, AI may say "no" anyway)
            auto_company_signals = [
                "bmw", "mercedes", "daimler", "audi", "porsche", "volkswagen", "vw",
                "bosch", "continental", "zf", "valeo", "schaeffler", "magna",
                "wayve", "mobileye", "cariad",
            ]
            if any(c in company_lower for c in auto_company_signals):
                break  # let it through to AI
            return 0, f"Title contains out-of-domain term '{bad}'"

    # ── HARD FILTER 1: Exclude keywords ────────────────────────────────────────
    for excl in profile.get("exclude_keywords", []):
        if excl.lower() in text:
            return 0, f"Excluded — contains '{excl}'"

    # ── HARD FILTER 2: Language preference ────────────────────────────────────
    lang_pref = profile.get("language_preference", "any")
    if lang_pref == "english_only":
        if _is_german(desc):
            return 0, "Skipped — job description is in German"
    elif lang_pref == "no_german_required":
        # Only reject if German fluency is explicitly required
        fluency_required = [
            "verhandlungssicheres deutsch",
            "deutsch c1", "deutsch c2",
            "fließend deutsch", "fliessend deutsch",
            "muttersprache deutsch",
            "sehr gute deutschkenntnisse",
            "fluent german required",
            "native german speaker",
        ]
        if any(p in desc for p in fluency_required):
            return 0, "Skipped — fluent German required"

    score = 0
    reasons = []

    # ── 1. Title match against target_titles (up to 40 points) ────────────────
    # Single-word targets like "Werkstudent" match every working-student
    # posting (marketing, HR, ...) — cap their contribution at 25 so they
    # survive the pre-filter for AI judgment but can't reach a tier alone.
    best_title_points = 0
    best_title = None
    title_words = set(_tokenize(title))
    for tt in profile.get("target_titles", []):
        tt_words = set(_tokenize(tt))
        if not tt_words:
            continue
        overlap = len(tt_words & title_words) / len(tt_words)
        max_points = 25 if len(tt_words) == 1 else 40
        points = int(overlap * max_points)
        if points > best_title_points and overlap >= 0.4:
            best_title = tt
        best_title_points = max(best_title_points, points)
    score += best_title_points
    if best_title:
        reasons.append(f"title fits '{best_title}'")

    # ── 2. Skill overlap (up to 30 points) ────────────────────────────────────
    skills = profile.get("skills", [])
    matched_skills = [s for s in skills if s.lower() in text]
    skill_score = min(30, len(matched_skills) * 5)
    score += skill_score
    if matched_skills:
        shown = matched_skills[:3]
        more = f" (+{len(matched_skills)-3})" if len(matched_skills) > 3 else ""
        reasons.append(f"skills: {', '.join(shown)}{more}")

    # ── 3. Must-have keywords (only a soft penalty, not a cap) ────────────────
    # Note: the domain classifier (next stage) handles real domain checks.
    # We just give a small bonus when present, no penalty when absent.
    must_have = profile.get("must_have_keywords", [])
    if must_have:
        present = [kw for kw in must_have if kw.lower() in text]
        if present:
            score += min(10, len(present) * 2)
            reasons.append(f"keyword bonus: {len(present)}")

    # ── 4. Preferred location bonus (up to 10 points) ─────────────────────────
    pref_locs = profile.get("preferred_locations", [])
    if any(loc.lower() in location for loc in pref_locs):
        score += 10
        reasons.append("preferred location")

    # ── 5. Career-level penalty ───────────────────────────────────────────────
    if profile.get("career_level") == "student":
        senior_signals = [
            "senior", "lead", "principal", "staff engineer",
            "5+ years", "7+ years", "10+ years",
            "extensive experience", "head of", "director",
        ]
        if any(s in text for s in senior_signals):
            score = max(0, score - 30)
            reasons.append("(seniority warning)")

    # ── 6. Bonus for core strength keywords ───────────────────────────────────
    bonus_terms = [
        "lidar", "radar", "perception", "sensor fusion",
        "adas", "autonomous", "self-driving", "grafana", "influxdb",
    ]
    bonus_hits = sum(1 for b in bonus_terms if b in text)
    if bonus_hits:
        score += min(15, bonus_hits * 3)
        reasons.append(f"+{bonus_hits} core-strength terms")

    score = max(0, min(100, score))
    reason = "; ".join(reasons) if reasons else "basic keyword match"
    return score, reason


# ── Helpers ────────────────────────────────────────────────────────────────
def _tokenize(text: str) -> list:
    """Lowercase and split on non-alphanumeric chars."""
    return [w for w in re.split(r"[^a-zA-Z0-9+]+", text.lower()) if w]


# Common German stopwords – if many appear, the description is likely in German
_GERMAN_MARKERS = {
    "und", "der", "die", "das", "mit", "für", "fuer", "ist", "wir",
    "sie", "ein", "eine", "auf", "von", "zu", "im", "den", "dem",
    "werden", "haben", "sein", "nicht", "auch", "über", "ueber",
    "unser", "unsere", "bei", "als", "sich", "dich", "uns", "ihnen",
    "kenntnisse", "erfahrung", "stelle", "aufgaben", "anforderungen",
}


def _is_german(text: str) -> bool:
    if not text or len(text) < 100:
        return False
    words = set(_tokenize(text)[:200])  # Sample first 200 words
    matches = len(words & _GERMAN_MARKERS)
    return matches >= 5  # 5+ German stopwords ⇒ German posting
