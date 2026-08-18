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
# Each patched profile reports the template version it landed on back to
# braintrust, using the braintrust key already in that profile's own
# config.yaml — no new secret. braintrust reads that report on the serving
# path (braintrust_load_persona checks it on every call) to tell current from
# stale from silent, and files a fault naming this exact command when a
# profile stays wrong for more than a day. A report that never arrives is the
# alarm, not one that arrives late, so a failure to report is logged and never
# stops the loop. See issue #326 and docs/design/map-300-spec.md §4.
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

# What braintrust means by "current": the exact hash it computes itself from its own
# checked-in copy of this file (src/heal.ts, currentTemplateVersion). sha256sum is not on
# every macOS by default; shasum -a 256 always is.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
template_version=$(sha256_of "$template" | cut -c1-12)

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

# Reports the version this profile just landed on back to braintrust, reading the URL and
# key straight out of the profile's own config.yaml — braintrust never gets a new secret
# for this, and a profile whose config.yaml this script cannot parse simply is not
# reported for, the same as it is left alone by scope_toolset above.
#
# Failing to report is not fatal to the run: the whole point of this ticket is that a
# report which never arrives is what raises the alarm, on braintrust's side, days later —
# not something this script needs to enforce on the spot.
report_heal() {
  local profile="$1" name="$2" person="$3" cfg="$1/config.yaml"

  [ -f "$cfg" ] || { echo "  report   $name — no config.yaml, could not report in" >&2; return; }

  DRY_RUN="$DRY_RUN" PROFILE_NAME="$name" PERSON="$person" TEMPLATE_VERSION="$template_version" \
    python3 - "$cfg" <<'PY'
import json, os, sys, urllib.error, urllib.parse, urllib.request
try:
    import yaml
except ImportError:
    print("  report   %s — PyYAML not available, could not report in" % os.environ["PROFILE_NAME"], file=sys.stderr)
    sys.exit(0)

cfg_path = sys.argv[1]
dry = bool(os.environ.get("DRY_RUN"))
name = os.environ["PROFILE_NAME"]
person = os.environ["PERSON"]
version = os.environ["TEMPLATE_VERSION"]

with open(cfg_path) as fh:
    cfg = yaml.safe_load(fh) or {}

url = ((cfg.get("mcp_servers") or {}).get("braintrust") or {}).get("url")
if not url:
    print("  report   %s — no mcp_servers.braintrust.url in config.yaml, could not report in" % name, file=sys.stderr)
    sys.exit(0)

parsed = urllib.parse.urlsplit(url)
key = (urllib.parse.parse_qs(parsed.query).get("key") or [None])[0]
heal_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/heal", "", ""))
if key:
    heal_url += "?key=" + urllib.parse.quote(key)

if dry:
    print("  report   %s — would report template %s to %s" % (name, version, heal_url))
    sys.exit(0)

body = json.dumps({"profile": name, "person": person, "template_version": version}).encode()
req = urllib.request.Request(
    heal_url, data=body, headers={"content-type": "application/json"}, method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status == 200:
            print("  report   %s — reported template %s" % (name, version))
        else:
            print("  report   %s — braintrust returned HTTP %s, not reported" % (name, resp.status), file=sys.stderr)
except (urllib.error.URLError, OSError) as e:
    print("  report   %s — could not reach braintrust to report in: %s" % (name, e), file=sys.stderr)
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
    report_heal "$profile" "$name" "$person"
    patched=$((patched + 1))
    continue
  fi

  cp "$soul" "$soul.bak" || { echo "skip  $name — could not back up" >&2; skipped=$((skipped+1)); continue; }
  sed -e "s/{{DISPLAY_NAME}}/$display/g" -e "s/{{PERSON}}/$person/g" "$template" > "$soul"
  echo "patched  $name  ($display / $person)"
  scope_toolset "$profile" "$name"
  report_heal "$profile" "$name" "$person"
  patched=$((patched + 1))
done

echo "${DRY_RUN:+would patch }$patched profile(s)${skipped:+, $skipped skipped}"
