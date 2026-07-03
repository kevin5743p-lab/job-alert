"""
Minimal Groq client — one POST to the OpenAI-compatible endpoint, no SDK.

Owning the HTTP call gives us direct access to 429 response bodies, which is
how we tell "slow down for a minute" apart from "daily token quota exhausted"
(the old SDK-based code had to string-match exception text).
"""
import json
import logging
import threading
import time
from typing import Dict, Optional

import requests

logger = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# ── Rate limiter ─────────────────────────────────────────────────────────────
# Groq's free tier has a per-minute rate limit (~30 req/min on 70B models).
# Without pacing, we burn through the per-minute quota in seconds, then every
# subsequent call hits 429 and waits (with exponential backoff). That turns a
# 30-second run into a 4-minute run.
# By adding a small delay BEFORE each call, we stay under the limit naturally
# and never trigger the backoff dance.
_MIN_INTERVAL_SECONDS = 2.2     # 60s / 27 = ~2.22s → safely under 30 req/min
_last_call_time = 0.0
_lock = threading.Lock()


def _wait_for_rate_limit():
    """Pause if needed so we don't hit Groq's per-minute limit."""
    global _last_call_time
    with _lock:
        elapsed = time.time() - _last_call_time
        if elapsed < _MIN_INTERVAL_SECONDS:
            time.sleep(_MIN_INTERVAL_SECONDS - elapsed)
        _last_call_time = time.time()


class DailyQuotaExhausted(Exception):
    """Groq's daily token quota is used up — no point retrying until tomorrow."""


def _is_daily_quota_429(body_text: str) -> bool:
    t = body_text.lower()
    return "tokens per day" in t or "tpd" in t


def chat_json(prompt: str, api_key: str,
              model: str = "llama-3.3-70b-versatile",
              max_tokens: int = 300,
              temperature: float = 0.2) -> Optional[Dict]:
    """
    Send one user message, ask for a JSON object back, return it parsed.

    Returns None on transient failure (network error, malformed JSON, repeated
    429) — callers fall back to rule-based scoring for that job.
    Raises DailyQuotaExhausted when the free tier's daily quota is used up —
    callers should stop making AI calls for the rest of the run.
    """
    if not api_key:
        return None

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    for attempt in (1, 2):
        _wait_for_rate_limit()
        try:
            resp = requests.post(GROQ_URL, json=payload, headers=headers, timeout=45)
        except requests.RequestException as e:
            logger.warning(f"Groq request failed: {e}")
            return None

        if resp.status_code == 429:
            if _is_daily_quota_429(resp.text):
                logger.warning("⏳ Groq daily token quota reached — AI scoring "
                               "disabled for the rest of this run. Resets in ~24h.")
                raise DailyQuotaExhausted(resp.text[:200])
            if attempt == 1:
                wait = _retry_after_seconds(resp)
                logger.info(f"Groq per-minute limit hit — waiting {wait:.0f}s and retrying.")
                time.sleep(wait)
                continue
            logger.warning("Groq still rate-limited after retry — giving up on this call.")
            return None

        if resp.status_code != 200:
            logger.warning(f"Groq HTTP {resp.status_code}: {resp.text[:200]}")
            return None

        try:
            text = resp.json()["choices"][0]["message"]["content"].strip()
            return json.loads(text)
        except (KeyError, IndexError, ValueError) as e:
            logger.warning(f"Could not parse Groq response: {e}")
            return None

    return None


def _retry_after_seconds(resp) -> float:
    try:
        return min(60.0, max(1.0, float(resp.headers.get("retry-after", 10))))
    except (TypeError, ValueError):
        return 10.0
