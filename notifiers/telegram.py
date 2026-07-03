"""
Telegram notifier.

Sends tiered job digests via the Bot API. Every job field is html.escape()d
(titles contain & and < constantly — unescaped HTML is the #1 sendMessage
failure mode). Job blocks are greedily packed into messages under Telegram's
4096-char limit, never split mid-block.
"""
import html
import logging
import time
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

import requests

logger = logging.getLogger(__name__)

API_URL = "https://api.telegram.org/bot{token}/sendMessage"
MAX_MESSAGE_CHARS = 3800   # headroom under Telegram's 4096 hard limit
PAUSE_BETWEEN_SENDS = 0.5


def send_message(text: str, token: str, chat_id: str) -> bool:
    """Send one message. On 429, honor retry_after once."""
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    for attempt in (1, 2):
        try:
            resp = requests.post(API_URL.format(token=token), json=payload, timeout=20)
        except requests.RequestException as e:
            logger.error(f"Telegram request failed: {e}")
            return False
        if resp.status_code == 200:
            return True
        if resp.status_code == 429 and attempt == 1:
            try:
                wait = resp.json().get("parameters", {}).get("retry_after", 5)
            except ValueError:
                wait = 5
            logger.info(f"Telegram rate limit — waiting {wait}s.")
            time.sleep(min(60, wait))
            continue
        logger.error(f"Telegram sendMessage failed (HTTP {resp.status_code}): "
                     f"{resp.text[:200]}")
        return False
    return False


def send_messages(messages: List[str], token: str, chat_id: str) -> bool:
    ok = True
    for i, msg in enumerate(messages):
        if i:
            time.sleep(PAUSE_BETWEEN_SENDS)
        ok = send_message(msg, token, chat_id) and ok
    return ok


# ──────────────────────────────────────────────────────────────────────────────
#  Digest formatting
# ──────────────────────────────────────────────────────────────────────────────
def _job_block(index: int, item: Dict) -> str:
    job = item.get("job", {})
    title = html.escape(job.get("title", "?"))
    company = html.escape(job.get("company", "?"))
    location = html.escape(job.get("location", "?"))
    source = html.escape(job.get("source", "?"))
    url = html.escape(job.get("url", ""), quote=True)
    reason = html.escape(item.get("reason", "") or "")

    unscored = " ⏳ <i>unscored (AI quota)</i>" if item.get("unscored") else ""
    lines = [
        f"{index}. <b>{title}</b>{unscored}",
        f"   🏢 {company} — 📍 {location}",
        f"   ⭐ {item.get('score', 0)}/100 · {source}",
    ]
    if reason:
        lines.append(f"   <i>{reason}</i>")
    if url:
        lines.append(f"   👉 <a href=\"{url}\">Open posting</a>")
    return "\n".join(lines)


def _pack(header: str, blocks: List[str]) -> List[str]:
    """Greedily pack blocks into messages under the size cap."""
    messages = []
    current = header
    for block in blocks:
        candidate = f"{current}\n\n{block}" if current else block
        if len(candidate) > MAX_MESSAGE_CHARS and current != header:
            messages.append(current)
            current = block
        else:
            current = candidate
    if current.strip():
        messages.append(current)
    return messages


def build_digest_messages(strong: List[Dict], worth_look: List[Dict],
                          source_stats: Dict[str, Dict],
                          counts: Dict[str, int],
                          tz: str = "Europe/Berlin") -> List[str]:
    """
    Build the per-run digest. Returns [] when there is nothing to alert
    (silence = nothing found).
    """
    if not (strong or worth_look):
        return []

    now = datetime.now(ZoneInfo(tz)).strftime("%a %d %b, %H:%M")
    header = f"🚗 <b>Job Alert</b> — {now} ({tz.split('/')[-1]})"

    blocks = []
    idx = 1
    if strong:
        blocks.append(f"🟢 <b>STRONG MATCHES ({len(strong)})</b>")
        for item in strong:
            blocks.append(_job_block(idx, item))
            idx += 1
    if worth_look:
        blocks.append(f"🟡 <b>WORTH A LOOK ({len(worth_look)})</b>")
        for item in worth_look:
            blocks.append(_job_block(idx, item))
            idx += 1

    blocks.append(_footer(source_stats, counts))
    return _pack(header, blocks)


def _footer(source_stats: Dict[str, Dict], counts: Dict[str, int]) -> str:
    parts = []
    for name, s in source_stats.items():
        if s.get("error"):
            parts.append(f"{name} ⚠")
        else:
            parts.append(f"{name} {s.get('count', 0)}")
    fetched = sum(s.get("count", 0) for s in source_stats.values())
    line1 = f"📊 Fetched {fetched} ({', '.join(parts)})" if parts else "📊 No sources ran"
    line2 = (f"🆕 {counts.get('new', 0)} new · "
             f"✅ {counts.get('strong', 0)} strong · "
             f"🟡 {counts.get('worth_look', 0)} worth a look · "
             f"🔴 {counts.get('rejected', 0)} rejected (archived)")
    return f"—\n{line1}\n{line2}"


# ──────────────────────────────────────────────────────────────────────────────
#  Daily rejected-jobs summary
# ──────────────────────────────────────────────────────────────────────────────
def build_daily_summary(today_data: Dict, tz: str = "Europe/Berlin") -> Optional[str]:
    """
    One compact evening message: how many jobs were rejected today and why,
    plus how many alerts went out. Returns None if there was no activity.
    """
    runs = today_data.get("runs", [])
    if not runs:
        return None

    strong_n = sum(len(r.get("strong", [])) for r in runs)
    worth_n = sum(len(r.get("worth_look", [])) for r in runs)
    rejected = [item for r in runs for item in r.get("rejected", [])]

    reason_counts: Dict[str, int] = {}
    for item in rejected:
        cat = item.get("category", "low_score")
        reason_counts[cat] = reason_counts.get(cat, 0) + 1
    top_reasons = sorted(reason_counts.items(), key=lambda kv: -kv[1])[:4]

    date_str = today_data.get("date", datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d"))
    lines = [
        f"🌙 <b>Daily summary</b> — {html.escape(date_str)}",
        f"✅ {strong_n} strong · 🟡 {worth_n} worth a look · "
        f"🔴 {len(rejected)} rejected today",
    ]
    if top_reasons:
        pretty = {
            "out_of_domain": "out of domain",
            "fluent_german": "fluent German required",
            "too_senior": "too senior",
            "low_score": "low fit score",
            "engineering_general": "general engineering",
            "memory_pattern": "learned rejection",
            "prefilter": "rule pre-filter",
        }
        reason_bits = [f"{pretty.get(cat, cat)}: {n}" for cat, n in top_reasons]
        lines.append(f"📉 Top rejection reasons — {html.escape('; '.join(reason_bits))}")
    lines.append("🗂 Full details are in state/archive/ in the repo.")
    return "\n".join(lines)


def send_test(token: str, chat_id: str) -> bool:
    ok = send_message(
        "✅ <b>Job Alert test</b> — your Telegram bot is wired up correctly.\n"
        "Alerts will look like this, with job title, score and link.",
        token, chat_id,
    )
    return ok
