"""
tailor.py — the "Tailor" stage of the copilot.

Given ONE job posting + the candidate's CV (cv.md), produce a tailored
application packet:

  - fit_summary        : one honest line on how well the candidate fits
  - tailored_summary   : a 3-4 sentence professional summary tuned to the role
  - relevant_experience: the candidate's most relevant points, reordered and
                         rephrased to the job — each carries `from_cv`, the
                         source line it was derived from, so any invention is
                         visible at a glance
  - matched_keywords   : job requirements the candidate genuinely meets
  - missing_keywords   : job requirements the CV does NOT support (honest gaps)
  - suggestions        : how to position honestly, and how to mitigate gaps
  - cover_letter       : a tailored cover letter grounded only in CV facts

HARD RULE — NO FABRICATION. The engine may reorder, rephrase, and emphasize,
but must never invent employers, job titles, dates, degrees, skills, tools, or
achievements the CV does not contain. Gaps are reported, not papered over.
The `from_cv` field on every experience bullet is the guardrail: it forces each
claim to trace back to a real CV line.

All LLM traffic goes through matchers.groq_client (shared rate-limiting +
daily-quota handling). This module is deliberately UI-agnostic: the browser
extension, a CLI, or the Telegram bot can all call `tailor()` and render the
same structured result.

Usage:
  python tailor.py --demo                      # tailor cv.md against a sample JD
  python tailor.py --job-file job.txt          # tailor cv.md against a JD file
  python tailor.py --job-file job.txt --lang de --json
"""
import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

from matchers import groq_client

logger = logging.getLogger(__name__)

ROOT = Path(__file__).parent
CV_PATH = ROOT / "cv.md"

# Tailoring is low-volume and high-value, so it uses a stronger writing model
# than the per-job scorer (which runs on the cheap 8B model for budget reasons).
DEFAULT_MODEL = "llama-3.3-70b-versatile"

# Enough room for the summary + several bullets + a full cover letter in one call.
MAX_TOKENS = 2200

# Cap inputs so a huge CV or JD can't blow the context / token budget.
# 4000 was under the length of a real two-page CV (a live one measured 4233),
# so the tail — languages, availability, "what I'm looking for" — never reached
# the model, and the closing paragraphs of the letter were written without the
# facts they were asked to quote. Mirrors CV_LIMIT in tailor_core.js.
_CV_LIMIT = 12000
_JD_LIMIT = 3000

_LANG_NAME = {"en": "English", "de": "German"}


class NoCV(Exception):
    """cv.md is missing or empty — nothing to tailor from."""


def load_cv(path: Path = CV_PATH) -> str:
    """Read cv.md, refusing the factory placeholder so we never tailor a stub."""
    if not path.exists():
        raise NoCV(f"{path} does not exist")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise NoCV(f"{path} is empty")
    if "[e.g. M.Sc." in text or "[Your University," in text:
        raise NoCV(f"{path} still has placeholder text — fill in a real CV first")
    return text


def _build_prompt(job: Dict, cv_text: str, language: str) -> str:
    lang_name = _LANG_NAME.get(language, "English")
    return f"""You are an expert career coach and CV writer. Tailor the \
candidate's application to ONE specific job.

=== JOB POSTING ===
Title: {job.get("title", "N/A")}
Company: {job.get("company", "N/A")}
Location: {job.get("location", "N/A")}
Description:
{(job.get("description", "") or "")[:_JD_LIMIT]}

=== CANDIDATE CV (the ONLY source of truth about the candidate) ===
{cv_text[:_CV_LIMIT]}

=== YOUR TASK ===
Produce a tailored application packet, written in {lang_name}.

ABSOLUTE RULE — NO FABRICATION:
- Use ONLY facts present in the CV. Never invent employers, job titles, dates,
  degrees, tools, skills, certifications, or achievements.
- You MAY reorder, rephrase, quantify differently, and emphasize the parts of
  the CV most relevant to this job.
- If the job wants something the CV does not show, do NOT pretend the candidate
  has it. Put it in "missing_keywords" and, if useful, suggest an honest way to
  address it in "suggestions".
- Every item in "relevant_experience" MUST include "from_cv": a short quote or
  close paraphrase of the exact CV line it is based on. If you cannot ground a
  point in the CV, do not include it.

Return a JSON object in EXACTLY this shape:
{{
  "fit_score": <int 0-100: how well this candidate fits THIS role — 85+ outstanding,
                70-84 strong, 50-69 worth a look, below 50 poor. Be strict, and
                score 0 if it is a different profession, needs years of experience
                the CV lacks, or demands fluent German the CV doesn't show>,
  "fit_summary": "<one honest sentence on overall fit, strengths and gaps>",
  "tailored_summary": "<3-4 sentence professional summary tuned to THIS role, grounded in the CV>",
  "relevant_experience": [
    {{"from_cv": "<the CV line/fact this is based on>", "bullet": "<the same fact rephrased to emphasize this job's needs>"}}
  ],
  "matched_keywords": ["<job requirement the CV genuinely supports>", "..."],
  "missing_keywords": ["<job requirement the CV does NOT support>", "..."],
  "suggestions": ["<honest positioning tip or gap-mitigation>", "..."],
  "cover_letter": "<the BODY of the cover letter — see rules below>"
}}

COVER LETTER — this is the part candidates are judged on, so make it specific:
- Write the BODY ONLY: no letterhead, no date, no subject line, no "Dear ...",
  no sign-off and no name. Those are added around it by the letter template.
- 5 or 6 paragraphs separated by blank lines, and BETWEEN 340 AND 450 WORDS.
  Count them before you answer. Letters written to this prompt come back at
  260-320 words far more often than not, which is a page half-filled: it reads
  as though the candidate had little to say. If your draft is under 340 words,
  the fix is more specifics from the CV — a named tool, a number, an outcome —
  not more adjectives.
- Follow this arc:
  1. Who the candidate is right now (course/role and institution/employer) and
     what they are applying for.
  2. What specifically draws them to THIS role and company — tie it to the
     posting's actual responsibilities, not generic praise.
  3. One or two concrete projects or achievements from the CV, naming the real
     tools, methods and outcomes.
  4. Current or most recent experience and what it taught them.
  5. Working style plus language levels exactly as the CV states them.
  6. Practical close: availability/start date if the CV says, and an invitation
     to talk.
- Name real tools, methods and numbers from the CV. Specifics are what make it
  credible; adjectives are not.
- Never invent anything. No flattery ("your esteemed company"), no clichés
  ("I am a hard worker"), no repeating the job ad back.
- NOTHING IN "missing_keywords" MAY BE CLAIMED HERE, in any tense. You have
  just listed those as things the CV does not show, and the letter is the same
  document set — writing that the candidate is doing, pursuing, studying for,
  holding or about to obtain one of them contradicts your own analysis and puts
  a false claim in their name. A live letter did exactly this: it listed a
  licence under missing_keywords, then wrote "I am also pursuing" it. Saying
  they are willing to learn something is fine. Saying they have started is not.
- Do NOT turn "suggestions" into sentences. Those are advice for the candidate
  about what they could do next; the letter reports only what is already true.
- Availability, notice period and start date: state them ONLY if the CV states
  them. If it does not, say nothing about when they can start — do not write
  "available immediately", and do not infer a date from anything.
- Language levels: exactly as the CV writes them. If the CV says B1, do not
  write "working proficiency"; if the CV is silent on a language, omit it.
- First person, warm but professional, plain language.

Aim for 4-7 items in "relevant_experience". Respond with ONLY the JSON object."""


# Every key the caller can rely on being present in a successful result.
_RESULT_KEYS = ("fit_score", "fit_summary", "tailored_summary", "relevant_experience",
                "matched_keywords", "missing_keywords", "suggestions",
                "cover_letter")


def tailor(job: Dict, cv_text: str, api_key: str,
           model: str = DEFAULT_MODEL, language: str = "en"
           ) -> Optional[Dict]:
    """
    Tailor the candidate's application (from cv_text) to `job`.

    `job` needs at least a "title"; "company", "location", "description" make
    the output much better. Returns the structured packet (see module docstring)
    or None if the LLM call failed (network / malformed JSON / rate limit).
    Raises groq_client.DailyQuotaExhausted when the daily quota is gone.
    """
    if not (cv_text and cv_text.strip()):
        raise NoCV("empty CV text passed to tailor()")

    prompt = _build_prompt(job, cv_text, language)
    result = groq_client.chat_json(prompt, api_key, model=model,
                                   max_tokens=MAX_TOKENS, temperature=0.4)
    if result is None:
        return None
    return _normalize(result)


def _normalize(result: Dict) -> Dict:
    """Coerce the LLM output into the stable shape callers expect.

    The model occasionally returns a bare string where a list is expected, or
    omits an optional key. We fill every key so downstream renderers never
    KeyError, and coerce experience entries into {from_cv, bullet} dicts.
    """
    out: Dict = {}
    for key in ("fit_summary", "tailored_summary", "cover_letter"):
        val = result.get(key, "")
        out[key] = val.strip() if isinstance(val, str) else str(val or "")

    for key in ("matched_keywords", "missing_keywords", "suggestions"):
        out[key] = _as_str_list(result.get(key))

    exp: List[Dict] = []
    for item in result.get("relevant_experience") or []:
        if isinstance(item, dict):
            bullet = str(item.get("bullet", "")).strip()
            if bullet:
                exp.append({"from_cv": str(item.get("from_cv", "")).strip(),
                            "bullet": bullet})
        elif isinstance(item, str) and item.strip():
            exp.append({"from_cv": "", "bullet": item.strip()})
    out["relevant_experience"] = exp
    return out


def _as_str_list(value) -> List[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        # tolerate a comma/newline separated string
        parts = [p.strip() for p in value.replace("\n", ",").split(",")]
        return [p for p in parts if p]
    return []


# ──────────────────────────────────────────────────────────────────────────
# Grounding check — flags experience bullets whose `from_cv` can't be found in
# the CV. Not a hard block (paraphrase won't match verbatim), but a cheap smoke
# signal that the model may have invented something. Word-overlap based.
# ──────────────────────────────────────────────────────────────────────────
def grounding_warnings(result: Dict, cv_text: str,
                       min_overlap: float = 0.5) -> List[str]:
    cv_words = _word_set(cv_text)
    warnings = []
    for item in result.get("relevant_experience", []):
        src = item.get("from_cv", "")
        src_words = _word_set(src)
        if not src_words:
            warnings.append(f"no CV source cited for: {item['bullet'][:60]}")
            continue
        overlap = len(src_words & cv_words) / len(src_words)
        if overlap < min_overlap:
            warnings.append(
                f"weak CV grounding ({overlap:.0%}) for: {item['bullet'][:60]}")
    return warnings


def _word_set(text: str) -> set:
    import re
    return {w for w in re.findall(r"[a-zA-ZäöüÄÖÜß0-9]+", (text or "").lower())
            if len(w) > 2}


# ──────────────────────────────────────────────────────────────────────────
# CLI (for testing before the extension exists)
# ──────────────────────────────────────────────────────────────────────────
_DEMO_JOB = {
    "title": "Working Student — Corporate Finance / FP&A",
    "company": "Aurelia Capital Partners",
    "location": "Frankfurt, Germany (hybrid)",
    "description": (
        "We are looking for a working student to support our corporate finance "
        "team. Responsibilities: build and maintain valuation models (DCF and "
        "multiples), prepare financial analyses for mid-cap clients, and "
        "automate recurring reporting. Requirements: enrolled in a finance or "
        "business master's programme; strong Excel skills, ideally VBA; Python "
        "for data automation is a plus; solid grasp of three-statement modelling "
        "and financial statement analysis; German B2 and fluent English. "
        "Experience with Bloomberg or FactSet is a plus."
    ),
}


def _print_human(result: Dict, cv_text: str) -> None:
    line = "─" * 70
    print(f"\n{line}\nFIT: {result['fit_summary']}\n{line}")
    print(f"\nTAILORED SUMMARY\n{result['tailored_summary']}")
    print("\nRELEVANT EXPERIENCE (reordered & rephrased to the job)")
    for e in result["relevant_experience"]:
        print(f"  • {e['bullet']}")
        if e["from_cv"]:
            print(f"      ↳ from CV: {e['from_cv']}")
    print(f"\n✅ MATCHES: {', '.join(result['matched_keywords']) or '—'}")
    print(f"⚠️  GAPS:    {', '.join(result['missing_keywords']) or '—'}")
    if result["suggestions"]:
        print("\nSUGGESTIONS")
        for s in result["suggestions"]:
            print(f"  • {s}")
    print(f"\nCOVER LETTER\n{result['cover_letter']}")
    warns = grounding_warnings(result, cv_text)
    print(f"\n{line}\nGROUNDING CHECK: " +
          ("no issues ✅" if not warns else f"{len(warns)} flag(s) ⚠️"))
    for w in warns:
        print(f"  ⚠️  {w}")
    print(line)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Tailor an application to a job")
    parser.add_argument("--job-file", help="Path to a text file with the job description")
    parser.add_argument("--title", default="", help="Job title (with --job-file)")
    parser.add_argument("--company", default="", help="Company (with --job-file)")
    parser.add_argument("--demo", action="store_true",
                        help="Tailor cv.md against a built-in sample job")
    parser.add_argument("--lang", default="en", choices=["en", "de"])
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--json", action="store_true", help="Print raw JSON")
    args = parser.parse_args()

    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        print("Set GROQ_API_KEY first (export GROQ_API_KEY=...).", file=sys.stderr)
        return 1

    try:
        cv_text = load_cv()
    except NoCV as e:
        print(f"CV error: {e}", file=sys.stderr)
        return 1

    if args.demo:
        job = _DEMO_JOB
    elif args.job_file:
        desc = Path(args.job_file).read_text(encoding="utf-8")
        job = {"title": args.title or "the role",
               "company": args.company or "the company",
               "location": "", "description": desc}
    else:
        print("Pass --demo or --job-file. See --help.", file=sys.stderr)
        return 1

    try:
        result = tailor(job, cv_text, api_key, model=args.model, language=args.lang)
    except groq_client.DailyQuotaExhausted:
        print("Groq daily quota exhausted — try again tomorrow.", file=sys.stderr)
        return 1

    if result is None:
        print("Tailoring failed (LLM call returned nothing).", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        _print_human(result, cv_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
