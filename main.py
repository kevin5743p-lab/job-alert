"""
Job Alert System — single-run orchestrator.
=============================================

Pipeline (one invocation = one run; GitHub Actions cron provides the cadence):

  FETCH → DEDUP → RULE PRE-FILTER → CLASSIFY (rules→AI) →
  AI SCORE (Groq, budgeted) → TIER → TELEGRAM → ARCHIVE → SAVE STATE

Usage:
  python main.py                       # full run (what CI executes)
  python main.py --dry-run             # fetch + score, print only; no Telegram, no state writes
  python main.py --source arbeitnow    # smoke-test one fetcher (implies --dry-run, no AI)
  python main.py --force               # ignore quiet hours (or env FORCE_RUN=true)
  python main.py --no-ai               # rules-only scoring path
  python main.py --test-telegram       # send one test message and exit

Secrets come from environment variables only:
  GROQ_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  ADZUNA_APP_ID, ADZUNA_APP_KEY, LINKEDIN_LI_AT
"""
import argparse
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List

import yaml

import archive
import fetchers
import history
import personalize
import quiet_hours
from matchers import ai as ai_scorer
from matchers import domain_classifier, groq_client, memory_stub, rules
from matchers import tier as tier_router
from notifiers import telegram

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("main")

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.yaml"
PROFILE_PATH = ROOT / "profile.yaml"
CV_PATH = ROOT / "cv.md"
STATE_DIR = ROOT / "state"

# Matches Groq / Google / OpenAI-style key prefixes — config.yaml must never
# contain credentials (they live in env vars / GitHub Secrets).
SECRET_PATTERN = re.compile(r"(gsk_|AIza[0-9A-Za-z_\-]{10}|sk-[A-Za-z0-9]{20})")


def load_yaml(path: Path) -> Dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_cv() -> str:
    if not CV_PATH.exists():
        return ""
    text = CV_PATH.read_text(encoding="utf-8")
    if "[e.g. M.Sc." in text or "[Your University," in text:
        logger.warning("CV file still has placeholder text — please edit cv.md")
        return ""
    return text


def check_no_secrets_in_config() -> None:
    raw = CONFIG_PATH.read_text(encoding="utf-8")
    if SECRET_PATTERN.search(raw):
        logger.error("🚨 config.yaml appears to contain an API key! Secrets must "
                     "live in environment variables / GitHub Secrets, never in "
                     "the repo. Remove it and rotate the key before pushing.")
        sys.exit(2)


# ──────────────────────────────────────────────────────────────────────────────
#  The pipeline
# ──────────────────────────────────────────────────────────────────────────────
def run_check(dry_run: bool = False, no_ai: bool = False,
              only_source: str = "") -> Dict:
    logger.info("=" * 60)
    logger.info(f"Run at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                + (" [DRY RUN]" if dry_run else ""))
    logger.info("=" * 60)

    config = load_yaml(CONFIG_PATH)
    profile = load_yaml(PROFILE_PATH)
    cv_text = load_cv()
    memory = memory_stub.load_memory(STATE_DIR)

    api_key = os.environ.get("GROQ_API_KEY", "")
    ai_cfg = config.get("ai", {})
    model = ai_cfg.get("model", "llama-3.3-70b-versatile")
    max_ai_calls = ai_cfg.get("max_ai_calls_per_run", 60)

    # One-file onboarding: while profile.yaml is still the factory template,
    # a real run derives the whole profile (skills, titles, domain block,
    # search queries) from cv.md.
    if personalize.profile_is_template(profile):
        if dry_run:
            logger.warning("profile.yaml is still the factory template — a real "
                           "run (or `python main.py --personalize`) generates "
                           "it from cv.md.")
        else:
            profile = personalize.ensure_profile(cv_text, api_key, model,
                                                 PROFILE_PATH)

    # Generated profiles carry their own job-board queries
    if profile.get("search_queries"):
        config.setdefault("search", {})["queries"] = profile["search_queries"]

    ai_enabled = bool(api_key) and not no_ai
    if not ai_enabled:
        logger.warning("AI scoring disabled (%s) — falling back to rule-based scores.",
                       "--no-ai" if no_ai else "GROQ_API_KEY not set")

    sched = config.get("scheduler", {})
    lookback = sched.get("lookback_minutes", 240)

    if cv_text:
        logger.info(f"CV loaded ({len(cv_text)} chars).")

    # ── 1. Fetch ─────────────────────────────────────────────────────────────
    seen = history.load_seen(STATE_DIR)
    all_jobs, source_stats = fetchers.fetch_all(config, lookback,
                                                seen_jobs=seen,
                                                only_source=only_source)
    for name, s in source_stats.items():
        status = f"⚠ {s['error']}" if s.get("error") else f"{s['count']} jobs"
        logger.info(f"   {name}: {status}")
    logger.info(f"📥 Fetched {len(all_jobs)} jobs across all sources.")
    if not all_jobs:
        return _finish(dry_run, config, source_stats,
                       strong=[], worth_look=[], rejected=[], new_count=0)

    # ── 2. Dedup against history (and against same title+company) ────────────
    dedup_seen_ids, dedup_seen_titles = set(), set()
    unique = []
    for j in all_jobs:
        if j["id"] in seen or j["id"] in dedup_seen_ids:
            continue
        # Also dedup on (lowercase title, lowercase company): LinkedIn often
        # returns the same posting multiple times with different URL params.
        title_key = (j.get("title", "").strip().lower(),
                     j.get("company", "").strip().lower())
        if title_key in dedup_seen_titles:
            continue
        dedup_seen_ids.add(j["id"])
        dedup_seen_titles.add(title_key)
        unique.append(j)
    logger.info(f"🆕 {len(unique)} new jobs after dedup.")
    if not unique:
        return _finish(dry_run, config, source_stats,
                       strong=[], worth_look=[], rejected=[], new_count=0)

    # ── 3. Pre-filter with rules ─────────────────────────────────────────────
    threshold = profile.get("prefilter_min_score", 15)
    survivors, rejected = [], []
    for j in unique:
        s, reason = rules.score_job(j, profile)
        if s >= threshold:
            survivors.append((j, s, reason))
        else:
            rejected.append({"score": s, "reason": reason, "job": j,
                             "category": "prefilter"})
    logger.info(f"🔍 {len(survivors)} survived rule pre-filter "
                f"(threshold={threshold}); {len(rejected)} filtered out.")

    # AI budget goes to the most promising jobs first
    survivors.sort(key=lambda t: -t[1])

    # ── 4-6. Classify → score → tier ─────────────────────────────────────────
    strong, worth_look = [], []
    ai_calls = 0

    for i, (job, rule_score, rule_reason) in enumerate(survivors, 1):
        pattern_hit = memory_stub.has_been_rejected_pattern(memory, job)
        if pattern_hit:
            tier_name, score, reason = tier_router.route(
                job, "core_field", "", 0, "", profile, pattern_hit)
            item = {"score": score, "reason": reason, "job": job,
                    "category": "memory_pattern"}
            rejected.append(item)
            logger.info(f"  [{i}/{len(survivors)}] REJECTED   (  0) "
                        f"{job['title'][:50]} (memory pattern)")
            continue

        klass, klass_reason = domain_classifier.classify_with_rules(
            job, domain_classifier.get_domain(profile))
        ai_score, ai_reason = None, ""
        unscored = False
        source = "rules"

        if klass == "out_of_domain":
            # Rules confidently rejected — no AI needed
            tier_name, score, reason = tier_router.route(
                job, klass, klass_reason, 0, "", profile, None)
        else:
            budget_left = ai_enabled and ai_calls < max_ai_calls
            if budget_left:
                try:
                    if klass is not None:
                        ai_calls += 1
                        ai_score, ai_reason = ai_scorer.score(
                            job, profile, klass, api_key, cv_text,
                            memory["decisions"][-20:], model)
                    else:
                        ai_calls += 1
                        combined = ai_scorer.classify_and_score(
                            job, profile, cv_text, memory, api_key, model)
                        if combined is not None:
                            klass, klass_reason, ai_score, ai_reason = combined
                        source = "ai-combined"
                except groq_client.DailyQuotaExhausted:
                    ai_enabled = False
                    unscored = True
            elif ai_enabled and ai_calls >= max_ai_calls:
                logger.info(f"AI budget of {max_ai_calls} calls reached — "
                            "remaining jobs use rule scores.")
                ai_enabled = False

            if unscored:
                # Groq quota gone mid-run: don't bury a potentially good job —
                # surface it in worth_look, flagged, with its rule score.
                tier_name, score, reason = (
                    "worth_look", rule_score,
                    f"{rule_reason} (rule-based; AI quota exhausted)")
            elif ai_score is not None:
                tier_name, score, reason = tier_router.route(
                    job, klass, klass_reason, ai_score, ai_reason, profile, None)
            else:
                # AI unavailable / failed / unclassifiable → rule score decides
                score = (tier_router.apply_domain_cap(rule_score, klass)
                         if klass is not None else rule_score)
                tier_name = tier_router.assign_tier(
                    score, klass or "core_field", profile.get("tier_thresholds"))
                reason = f"{rule_reason} (rule-based)"
                source = "rules-only"

        logger.info(f"  [{i}/{len(survivors)}] {tier_name.upper():10} "
                    f"({score:3d}) {job['title'][:50]} @ {job['company'][:25]} "
                    f"({klass or 'unclassified'}, {source})")

        item = {
            "score": score, "reason": reason, "job": job,
            "domain_class": klass or "unclassified",
            "ai_score": ai_score, "ai_reason": ai_reason,
            "unscored": unscored,
        }
        if tier_name == "strong":
            strong.append(item)
        elif tier_name == "worth_look":
            worth_look.append(item)
        else:
            item["category"] = tier_router.summarize_rejection(klass, reason)
            rejected.append(item)

    strong.sort(key=lambda x: -x["score"])
    worth_look.sort(key=lambda x: -x["score"])

    logger.info(f"✅ Tiers: {len(strong)} strong, {len(worth_look)} worth-look, "
                f"{len(rejected)} rejected")

    stats = _finish(dry_run, config, source_stats, strong, worth_look,
                    rejected, new_count=len(unique))

    if not dry_run:
        history.save_seen(STATE_DIR, {j["id"] for j in unique})
    return stats


def _finish(dry_run: bool, config: Dict, source_stats: Dict,
            strong: List, worth_look: List, rejected: List,
            new_count: int) -> Dict:
    """Notify + archive + daily summary. Shared by empty and full runs."""
    counts = {"new": new_count, "strong": len(strong),
              "worth_look": len(worth_look), "rejected": len(rejected)}
    sched = config.get("scheduler", {})
    tz = (sched.get("quiet_hours") or {}).get("tz", "Europe/Berlin")

    messages = telegram.build_digest_messages(strong, worth_look,
                                              source_stats, counts, tz)
    if not messages and config.get("telegram", {}).get("always_send_summary"):
        messages = [f"🤖 Job Alert ran — nothing new worth flagging.\n"
                    + telegram._footer(source_stats, counts)]

    if dry_run:
        _print_preview(strong, worth_look, rejected)
        return counts

    # Archive first so the daily summary includes this run
    if strong or worth_look or rejected:
        today_dir = archive.append_run(STATE_DIR, strong, worth_look, rejected)
        logger.info(f"📁 Archived to {today_dir.relative_to(ROOT)}/")

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not (token and chat_id):
        if messages:
            logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — "
                         "cannot send alerts (jobs are still archived).")
        return counts

    if messages:
        ok = telegram.send_messages(messages, token, chat_id)
        logger.info("📨 Telegram alert sent." if ok else "❌ Telegram send failed.")

    _maybe_send_daily_summary(sched, tz, token, chat_id)
    return counts


def _maybe_send_daily_summary(sched: Dict, tz: str,
                              token: str, chat_id: str) -> None:
    """First run at/after daily_summary_hour sends one recap message."""
    summary_hour = sched.get("daily_summary_hour", 21)
    if quiet_hours.local_hour(sched) < summary_hour:
        return
    marker = STATE_DIR / "daily_summary_sent.txt"
    today = datetime.now().strftime("%Y-%m-%d")
    if marker.exists() and marker.read_text().strip() == today:
        return

    summary = telegram.build_daily_summary(archive.load_today(STATE_DIR), tz)
    if summary and telegram.send_message(summary, token, chat_id):
        logger.info("🌙 Daily summary sent.")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(today)


def _print_preview(strong, worth_look, rejected):
    print("\n" + "=" * 60)
    print("DRY RUN — nothing sent, no state written")
    print("=" * 60)
    for label, items, icon in [("STRONG", strong, "🟢"),
                               ("WORTH A LOOK", worth_look, "🟡")]:
        if items:
            print(f"\n{icon} {label} ({len(items)})")
            print("-" * 60)
            for m in items:
                j = m["job"]
                print(f"  [{m['score']:3d}] {j.get('title','?')} @ {j.get('company','?')}")
                print(f"        {j.get('location','?')} · {j.get('source','')}")
                print(f"        {m.get('reason','')}")
                print(f"        {j.get('url','')}")
    if rejected:
        print(f"\n🔴 REJECTED ({len(rejected)}) — sample:")
        for m in rejected[:5]:
            j = m["job"]
            print(f"  [{m.get('category','?')}] {j.get('title','?')} @ {j.get('company','?')}")
        if len(rejected) > 5:
            print(f"  …and {len(rejected) - 5} more")
    print("=" * 60)


# ──────────────────────────────────────────────────────────────────────────────
#  Entry point
# ──────────────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description="Job Alert System")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and score, print results; no Telegram, no state writes")
    parser.add_argument("--source", default="",
                        help="Smoke-test a single fetcher (implies --dry-run and --no-ai)")
    parser.add_argument("--force", action="store_true",
                        help="Run even during quiet hours")
    parser.add_argument("--no-ai", action="store_true",
                        help="Skip Groq; rule-based scoring only")
    parser.add_argument("--test-telegram", action="store_true",
                        help="Send a test Telegram message and exit")
    parser.add_argument("--personalize", action="store_true",
                        help="(Re)generate profile.yaml from cv.md and exit")
    args = parser.parse_args()

    check_no_secrets_in_config()

    if args.personalize:
        config = load_yaml(CONFIG_PATH)
        model = config.get("ai", {}).get("model", "llama-3.3-70b-versatile")
        personalize.ensure_profile(load_cv(), os.environ.get("GROQ_API_KEY", ""),
                                   model, PROFILE_PATH)
        return 0

    if args.test_telegram:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
        if not (token and chat_id):
            print("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars first.")
            return 1
        ok = telegram.send_test(token, chat_id)
        print("✅ Test message sent — check Telegram." if ok else "❌ Send failed.")
        return 0 if ok else 1

    dry_run = args.dry_run or bool(args.source)
    no_ai = args.no_ai or bool(args.source)

    # A real run with no way to deliver alerts must not proceed: it would mark
    # every fetched job as seen while the user never hears about them.
    if not dry_run and not (os.environ.get("TELEGRAM_BOT_TOKEN")
                            and os.environ.get("TELEGRAM_CHAT_ID")):
        logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — refusing "
                     "to run. Add the secrets (repo Settings → Secrets and "
                     "variables → Actions) or use --dry-run for testing.")
        return 1

    force = args.force or os.environ.get("FORCE_RUN", "").lower() in ("1", "true", "yes")
    if not dry_run and not force:
        config = load_yaml(CONFIG_PATH)
        if quiet_hours.is_quiet_now(config.get("scheduler", {})):
            logger.info("😴 Quiet hours — skipping this run.")
            return 0

    run_check(dry_run=dry_run, no_ai=no_ai, only_source=args.source)
    return 0


if __name__ == "__main__":
    sys.exit(main())
