#!/usr/bin/env bash
#
# sync_to_template.sh — push CODE ONLY from this dev copy (Job_Alert_Claude)
# to the public template (Job_Alert_Template), never touching the template's
# personal / onboarding / secret / state files.
#
# The template is what other people adopt: they paste their own CV into cv.md
# and the system auto-generates their profile. So cv.md, profile.yaml and
# README.md in the template must stay generic and are NEVER overwritten here.
#
# Usage:  bash sync_to_template.sh
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$(cd "$SRC/../Job_Alert_Template" && pwd)"

# Explicit allow-list of code to sync. An include-list (not exclude-list)
# guarantees a newly added personal file can never leak into the template.
FILES=(
  main.py
  personalize.py
  archive.py
  history.py
  quiet_hours.py
  config.yaml
  requirements.txt
)
DIRS=(
  fetchers
  matchers
  notifiers
  .github
)

echo "Syncing code:  $SRC"
echo "         ->    $DST"
echo

for f in "${FILES[@]}"; do
  if [[ -f "$SRC/$f" ]]; then
    rsync -a "$SRC/$f" "$DST/$f"
    echo "  file  $f"
  else
    echo "  WARN  missing source file: $f (skipped)"
  fi
done

for d in "${DIRS[@]}"; do
  if [[ -d "$SRC/$d" ]]; then
    # --delete so files removed in the dev copy also disappear from template.
    rsync -a --delete --exclude='__pycache__/' --exclude='*.pyc' \
          "$SRC/$d/" "$DST/$d/"
    echo "  dir   $d/"
  else
    echo "  WARN  missing source dir: $d (skipped)"
  fi
done

echo
echo "Safety net — secret guard on the template's config.yaml:"
if grep -Eq '(gsk_|AIza[0-9A-Za-z_-]{10}|sk-[A-Za-z0-9]{20})' "$DST/config.yaml"; then
  echo "  🚨 config.yaml in the template looks like it contains an API key!"
  echo "     Remove it and rotate the key BEFORE committing/pushing."
  exit 2
fi
echo "  ok — no key-shaped strings in config.yaml"

echo
echo "Template changes (review before committing/pushing):"
git -C "$DST" status --short || true
echo
echo "Done. Next: cd \"$DST\" && git diff, then commit + push."
