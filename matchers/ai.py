"""
AI scorer — Stage 2 of the matching pipeline.
Uses CV + user's past decisions (memory) + already-computed domain class.

All Groq traffic goes through matchers.groq_client. DailyQuotaExhausted
propagates to the caller (main.py switches to rules-only for the rest of the
run); any other AI failure returns None so the caller can fall back to the
rule score for that one job.
"""
import logging
from typing import Dict, Optional, Tuple

from matchers import groq_client
from matchers.domain_classifier import get_domain

logger = logging.getLogger(__name__)

VALID_CLASSES = {"core_field", "adjacent_in_company", "skill_adjacent",
                 "broader_field", "out_of_domain"}

DEFAULT_PERSONA = ("a master's student in International Automotive Engineering "
                   "(sensor data specialty: LiDAR/Radar/Camera, Python, "
                   "Grafana/InfluxDB)")


def _persona(profile: Dict) -> str:
    """One-line description of the candidate, configurable in profile.yaml."""
    return profile.get("persona", DEFAULT_PERSONA)


def score(job: Dict, profile: Dict, domain_class: str, api_key: str,
          cv_text: str = "", recent_decisions=None,
          model: str = "llama-3.3-70b-versatile") -> Tuple[Optional[int], str]:
    """
    Score a job whose domain class is already known (1 AI call).
    Returns (score 0-100, reason), or (None, reason) if the AI call failed.
    Raises groq_client.DailyQuotaExhausted when the daily quota is gone.
    """
    memory = {"decisions": recent_decisions or [], "patterns": {}}

    cv_section = ""
    if cv_text and cv_text.strip():
        cv_section = f"\n\nCANDIDATE CV:\n{cv_text[:3000]}"

    memory_section = _build_memory_context(memory)

    prompt = f"""You are a strict but fair job-matching assistant. The candidate
is {_persona(profile)}.

DOMAIN CLASSIFICATION (already done): {domain_class}

JOB POSTING:
- Title: {job.get("title", "N/A")}
- Company: {job.get("company", "N/A")}
- Location: {job.get("location", "N/A")}
- Description: {(job.get("description", "") or "")[:1500]}

CANDIDATE PROFILE:
- Career level: {profile.get("career_level", "student")}
- Years of experience: {profile.get("years_of_experience", 0)}
- Skills: {", ".join(profile.get("skills", []))}
- Target titles: {", ".join(profile.get("target_titles", []))}
- Preferred locations: {", ".join(profile.get("preferred_locations", []))}
- Language preference: {profile.get("language_preference", "no_german_required")}{cv_section}
{memory_section}

SCORING:
1. Score 0-100. Be strict — only outstanding fits score 80+.
2. HARD ZEROS:
   - role requires 3+ years of professional experience
   - role requires fluent/business German ("verhandlungssicheres Deutsch",
     "Deutsch C1/C2", "Muttersprache Deutsch", "fließend Deutsch").
     Casual phrasing like "Grundkenntnisse", "B1/B2", "Deutsch von Vorteil" is FINE.
3. CV-BASED MATCHING when CV provided:
   - Look for ACTUAL experience overlap, not just keyword matches.
4. MEMORY GUIDANCE: weight in line with the user's past decisions.
5. Reason: 1-2 specific sentences citing matches and gaps.

Respond with a JSON object in exactly this format:
{{"score": <int 0-100>, "reason": "<short reason>"}}"""

    result = groq_client.chat_json(prompt, api_key, model=model,
                                   max_tokens=300, temperature=0.2)
    if result is None:
        return None, "AI scoring unavailable"
    try:
        score_val = max(0, min(100, int(result.get("score", 0))))
    except (TypeError, ValueError):
        return None, "AI returned a malformed score"
    return score_val, result.get("reason", "No reason provided.")


def classify_and_score(job: Dict, profile: Dict, cv_text: str, memory: Dict,
                       api_key: str,
                       model: str = "llama-3.3-70b-versatile"
                       ) -> Optional[Tuple[str, str, int, str]]:
    """
    Single AI call that does BOTH classification AND scoring.
    Returns (domain_class, domain_reason, score, score_reason), or None if
    the AI call failed. Halves the token usage compared to two calls.
    Raises groq_client.DailyQuotaExhausted when the daily quota is gone.

    The rule layer should always try to classify first (free). Only call
    this function when the rules can't decide.
    """
    field = get_domain(profile).get("name", "the candidate's field")
    cv_section = ""
    if cv_text and cv_text.strip():
        cv_section = f"\n\nCANDIDATE CV:\n{cv_text[:3000]}"

    memory_section = _build_memory_context(memory)

    prompt = f"""You are a strict job-matching assistant. The candidate is
{_persona(profile)}.

JOB POSTING:
- Title: {job.get("title", "N/A")}
- Company: {job.get("company", "N/A")}
- Location: {job.get("location", "N/A")}
- Description: {(job.get("description", "") or "")[:1500]}

CANDIDATE PROFILE:
- Career level: {profile.get("career_level", "student")}
- Years of experience: {profile.get("years_of_experience", 0)}
- Skills: {", ".join(profile.get("skills", []))}
- Target titles: {", ".join(profile.get("target_titles", []))}
- Preferred locations: {", ".join(profile.get("preferred_locations", []))}
- Language preference: {profile.get("language_preference", "no_german_required")}{cv_section}
{memory_section}

DO TWO THINGS:

(A) CLASSIFY the job's domain relative to the candidate's field
    ({field}). Pick exactly ONE class:
    - core_field: directly in the candidate's field
    - adjacent_in_company: different kind of role, but at a company central
      to the field
    - skill_adjacent: different industry with strong overlap with the
      candidate's skills
    - broader_field: same broad profession, different specialty
    - out_of_domain: unrelated to the field and the candidate's skills

(B) SCORE the candidate fit (0-100):
    - 90-100: outstanding fit
    - 75-89:  excellent
    - 60-74:  good
    - 40-59:  partial
    - 0-39:   poor
    HARD ZEROS:
      - role requires 3+ years of professional experience
      - role requires fluent/business German ("verhandlungssicheres Deutsch",
        "Deutsch C1/C2", "Muttersprache Deutsch"). Phrases like
        "Grundkenntnisse", "B1/B2", "Deutsch von Vorteil" are fine.
      - class is "out_of_domain"

Respond with a JSON object in exactly this format:
{{"class": "<one of the 5>", "class_reason": "<one short sentence>", "score": <int 0-100>, "score_reason": "<one short sentence>"}}"""

    result = groq_client.chat_json(prompt, api_key, model=model,
                                   max_tokens=350, temperature=0.2)
    if result is None:
        return None
    klass = result.get("class", "out_of_domain")
    if klass not in VALID_CLASSES:
        klass = "out_of_domain"
    try:
        score_val = max(0, min(100, int(result.get("score", 0))))
    except (TypeError, ValueError):
        return None
    return (klass, result.get("class_reason", ""),
            score_val, result.get("score_reason", ""))


def _build_memory_context(memory: Dict) -> str:
    decisions = memory.get("decisions", [])
    if not decisions:
        return ""

    recent = decisions[-5:]
    lines = []
    for d in recent:
        verb = "ACCEPTED" if d.get("decision") == "accepted" else "REJECTED"
        line = f"  - {verb}: {d.get('title','?')} @ {d.get('company','?')}"
        if d.get("reason"):
            line += f" — \"{d['reason'][:80]}\""
        lines.append(line)

    patterns = memory.get("patterns", {})
    pattern_lines = []
    if patterns.get("rejected_companies"):
        pattern_lines.append(
            f"  - Rejected companies: {', '.join(patterns['rejected_companies'][:5])}")
    if patterns.get("rejected_terms"):
        pattern_lines.append(
            f"  - Rejected terms: {', '.join(patterns['rejected_terms'][:5])}")

    section = "\n\nUSER'S RECENT DECISIONS (use as guidance):\n" + "\n".join(lines)
    if pattern_lines:
        section += "\n\nLEARNED PATTERNS:\n" + "\n".join(pattern_lines)
    return section
