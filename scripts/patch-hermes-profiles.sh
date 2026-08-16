#!/usr/bin/env bash
# Put every Hermes persona profile back into the state braintrust designs for:
# the current SOUL.md, and braintrust's tools in reach and nothing else.
#
# SOUL.md is copied into a profile, not linked, so a profile keeps whatever the
# template said on the day it was created. When the template changes, existing
# profiles keep the old text until something re-renders them. This is that
# something, for a host with no repo checkout: it pulls the template straight
# from origin.
#
# It also scopes each profile's CLI toolset to its own MCP servers, so a
# persona is not carrying a browser, a terminal and a filesystem it must never
# call — see issue #298, finding 4.
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
# Every file it overwrites is backed up alongside itself first, as SOUL.md.bak
# and config.yaml.bak. To undo the whole run:
#
#   for f in ~/.hermes/profiles/bt-*/*.bak; do mv "$f" "${f%.bak}"; done
#
# Restart any running session afterwards — both files are read at session start.

set -uo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# A persona profile should have braintrust's tools in reach and nothing else.
# Left unscoped it inherits the global `hermes-cli` set — browser, terminal,
# filesystem, image generation — none of which a persona answering from a
# compiled corpus has any business calling, and all of which cost it context
# it spends on the answer instead. See issue #298, finding 4.
#
# The key is `platform_toolsets.<platform>`, NOT a top-level `toolsets:` list.
# A profile-level `toolsets:` key is read by nothing on the CLI path and
# silently does nothing — measured, not assumed: with it set, a persona still
# had browser, terminal and filesystem in reach.
#
# Which MCP servers to keep is read from the profile rather than hardcoded: a
# profile that named its server something other than `braintrust` would
# otherwise be scoped down to no tools at all, and a persona with no tools
# cannot load a persona.
scope_toolset() {
  local profile="$1" name="$2" cfg="$1/config.yaml"

  [ -f "$cfg" ] || { echo "  toolset  $name — no config.yaml, left alone" >&2; return; }

  DRY_RUN="$DRY_RUN" python3 - "$cfg" "$name" <<'PY'
import os, shutil, sys
try:
    import yaml
except ImportError:
    print("  toolset  %s — PyYAML not available, left alone" % sys.argv[2], file=sys.stderr)
    sys.exit(0)

cfg_path, name = sys.argv[1], sys.argv[2]
dry = bool(os.environ.get("DRY_RUN"))

with open(cfg_path) as fh:
    cfg = yaml.safe_load(fh) or {}

servers = sorted((cfg.get("mcp_servers") or {}).keys())
if not servers:
    print("  toolset  %s — no mcp_servers block, left alone" % name, file=sys.stderr)
    sys.exit(0)

platforms = cfg.get("platform_toolsets") or {}
current = platforms.get("cli")
if current == servers:
    print("  toolset  %s — already scoped to %s" % (name, ", ".join(servers)))
    sys.exit(0)
if isinstance(current, list):
    # Somebody scoped this deliberately, through `hermes tools` or by hand.
    # Say so and change nothing — an overwrite here is how a considered
    # choice disappears without anyone noticing.
    print("  toolset  %s — already has its own cli scope (%s), left alone"
          % (name, ", ".join(str(t) for t in current)), file=sys.stderr)
    sys.exit(0)

if dry:
    print("  toolset  %s — would scope cli to %s" % (name, ", ".join(servers)))
    sys.exit(0)

shutil.copyfile(cfg_path, cfg_path + ".bak")
platforms["cli"] = servers
cfg["platform_toolsets"] = platforms
with open(cfg_path, "w") as fh:
    yaml.safe_dump(cfg, fh, default_flow_style=False, sort_keys=False)
print("  toolset  %s — scoped cli to %s" % (name, ", ".join(servers)))
PY
}

patched=0
skipped=0

for profile in "${profiles[@]}"; do
  soul="$profile/SOUL.md"
  name=$(basename "$profile")

  # Both the display name and the braintrust slug come off the existing file,
  # never off the directory name. None of the three are reliably the same word
  # — "bt-stuart-wt" is the profile, "stuart-winter-tear" is the slug and
  # "Stuart Winter-Tear" is the person — and deriving one from another renames
  # the person in their own profile, which is the failure this loop exists to
  # avoid. A profile whose SOUL.md cannot answer for itself is skipped, not
  # guessed at.
  display=$(sed -n '1s/^# braintrust model of //p' "$soul" 2>/dev/null)
  person=$(sed -n 's/.*`person: "\([^"]*\)"`.*/\1/p' "$soul" 2>/dev/null | head -1)

  if [ -z "$display" ]; then
    echo "skip  $name — no '# braintrust model of …' first line to read the name from"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -z "$person" ]; then
    echo "skip  $name — no 'person: \"…\"' line to read the braintrust slug from" >&2
    skipped=$((skipped + 1))
    continue
  fi

  if [ -n "$DRY_RUN" ]; then
    echo "would patch  $name  ($display / $person)"
    scope_toolset "$profile" "$name"
    patched=$((patched + 1))
    continue
  fi

  cp "$soul" "$soul.bak" || { echo "skip  $name — could not back up" >&2; skipped=$((skipped+1)); continue; }
  sed -e "s/{{DISPLAY_NAME}}/$display/g" -e "s/{{PERSON}}/$person/g" "$template" > "$soul"
  echo "patched  $name  ($display / $person)"
  scope_toolset "$profile" "$name"
  patched=$((patched + 1))
done

echo "${DRY_RUN:+would patch }$patched profile(s)${skipped:+, $skipped skipped}"
