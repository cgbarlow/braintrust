#!/usr/bin/env bash
# Re-render every Hermes persona profile's SOUL.md from the current template.
#
# SOUL.md is copied into a profile, not linked, so a profile keeps whatever the
# template said on the day it was created. When the template changes, existing
# profiles keep the old text until something re-renders them. This is that
# something, for a host with no repo checkout: it pulls the template straight
# from origin.
#
# Usage:
#   ./scripts/patch-hermes-profiles.sh            # re-render every bt-* profile
#   DRY_RUN=1 ./scripts/patch-hermes-profiles.sh  # print what would change, write nothing
#   ./scripts/patch-hermes-profiles.sh --help     # this text
#
# Environment:
#   TEMPLATE_URL   where to fetch the template (default: hermes/SOUL.md.template on main)
#   PROFILES_DIR   Hermes profiles directory (default: ~/.hermes/profiles)
#
# Each profile's SOUL.md is backed up to SOUL.md.bak before it is overwritten.
# To undo the whole run:
#
#   for f in ~/.hermes/profiles/bt-*/SOUL.md.bak; do mv "$f" "${f%.bak}"; done
#
# Restart any running session afterwards — SOUL.md is read at session start.

set -uo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

TEMPLATE_URL="${TEMPLATE_URL:-https://raw.githubusercontent.com/cgbarlow/braintrust/main/hermes/SOUL.md.template}"
PROFILES_DIR="${PROFILES_DIR:-$HOME/.hermes/profiles}"
DRY_RUN="${DRY_RUN:-}"

template=$(mktemp) || exit 1
trap 'rm -f "$template"' EXIT

if ! curl -fsSL "$TEMPLATE_URL" -o "$template"; then
  echo "could not fetch the template from $TEMPLATE_URL" >&2
  exit 1
fi

# A template that still names braintrust's tools literally is the fault this
# script exists to clear, not something to spread. Hermes registers MCP tools
# prefixed (mcp__braintrust__…), so a literal name in a profile is a name that
# does not exist wherever it runs, and the persona never loads. Refuse rather
# than overwrite good profiles with it — see issue #225.
if grep -q 'braintrust_[a-z]' "$template"; then
  echo "refusing to apply: the template still names braintrust's tools literally." >&2
  echo "the fix is not on main yet — see issue #225." >&2
  exit 1
fi

shopt -s nullglob
profiles=("$PROFILES_DIR"/bt-*)
if [ ${#profiles[@]} -eq 0 ]; then
  echo "no bt-* profiles under $PROFILES_DIR" >&2
  exit 1
fi

patched=0
skipped=0

for profile in "${profiles[@]}"; do
  soul="$profile/SOUL.md"
  name=$(basename "$profile")
  person="${name#bt-}"

  # The display name comes off the existing file rather than the slug: the two
  # are not always the same word ("stuart-wt" is Stuart Winter-Tear), and
  # guessing one from the other renames the person in their own profile.
  display=$(sed -n '1s/^# braintrust model of //p' "$soul" 2>/dev/null)

  if [ -z "$display" ]; then
    echo "skip  $name — no '# braintrust model of …' first line to read the name from"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -n "$DRY_RUN" ]; then
    echo "would patch  $name  ($display)"
    patched=$((patched + 1))
    continue
  fi

  cp "$soul" "$soul.bak" || { echo "skip  $name — could not back up" >&2; skipped=$((skipped+1)); continue; }
  sed -e "s/{{DISPLAY_NAME}}/$display/g" -e "s/{{PERSON}}/$person/g" "$template" > "$soul"
  echo "patched  $name  ($display)"
  patched=$((patched + 1))
done

echo "${DRY_RUN:+would patch }$patched profile(s)${skipped:+, $skipped skipped}"
