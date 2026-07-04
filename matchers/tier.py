"""
Tier router — decides which bucket a job goes into based on domain class + score.

Tiers:
  - strong      : 75+   → Telegram alert immediately
  - worth_look  : 50–74 → Telegram alert, lower urgency
  - rejected    : <50   → archived; counted in the daily summary

Thresholds are configurable via profile.yaml `tier_thresholds`.
"""
from typing import Dict, Optional

DOMAIN_SCORE_CAP = {
    "core_field":          100,
    "adjacent_in_company": 100,   # trust AI's judgment
    "skill_adjacent":      100,   # trust AI's judgment
    "broader_field":       100,   # trust AI's judgment
    "out_of_domain":         0,   # only this is hard-rejected
}

THRESHOLDS = {
    "strong":     75,
    "worth_look": 50,
}


def assign_tier(score: int, domain_class: str,
                thresholds: Optional[Dict[str, int]] = None) -> str:
    t = thresholds or THRESHOLDS
    capped = min(score, DOMAIN_SCORE_CAP.get(domain_class, 0))
    if capped >= t.get("strong", 75):
        return "strong"
    if capped >= t.get("worth_look", 50):
        return "worth_look"
    return "rejected"


def apply_domain_cap(score: int, domain_class: str) -> int:
    return min(score, DOMAIN_SCORE_CAP.get(domain_class, 0))


def tier_label(tier: str) -> str:
    return {
        "strong":     "🟢 Strong match",
        "worth_look": "🟡 Worth a look",
        "rejected":   "🔴 Auto-rejected",
    }.get(tier, tier)


def route(job, domain_class, domain_reason, ai_score, ai_reason,
          profile, pattern_hit=None):
    """
    Combines domain class + AI score into (tier_name, final_score, reason).
    """
    if pattern_hit:
        return ("rejected", 0, f"Memory pattern: {pattern_hit}")
    if domain_class == "out_of_domain":
        return ("rejected", 0, f"Out of domain: {domain_reason}")
    final_score = apply_domain_cap(ai_score, domain_class)
    tier = assign_tier(ai_score, domain_class,
                       profile.get("tier_thresholds"))
    reason = ai_reason or domain_reason
    return (tier, final_score, reason)


def summarize_rejection(domain_class, reason, pattern_hit=None) -> str:
    """Human-readable category code for the daily summary."""
    if pattern_hit:
        return "memory_pattern"
    if domain_class == "out_of_domain":
        return "out_of_domain"
    if domain_class == "broader_field":
        return "broader_field"
    r = (reason or "").lower()
    if "german" in r or "deutsch" in r:
        return "fluent_german"
    if "senior" in r or "years" in r or "experience" in r:
        return "too_senior"
    return "low_score"
