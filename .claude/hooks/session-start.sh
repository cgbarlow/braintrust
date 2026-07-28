#!/bin/bash
# Makes Matt Pocock's skills plugin available in Claude Code on the web.
#
# Remote sessions start from a fresh container that has an empty plugin cache
# and does not resolve the project-scoped marketplace in .claude/settings.json
# on its own, so the skills never load. Fetching the marketplace and installing
# the plugin here puts them in place; the container image is cached afterwards,
# so later sessions start with them already installed.
set -euo pipefail

# On a developer's own machine Claude Code resolves .claude/settings.json
# through the normal trust prompt, so leave their config alone.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$PWD}"

# Keep in sync with extraKnownMarketplaces / enabledPlugins in .claude/settings.json
MARKETPLACE="mattpocock/skills"
PLUGIN="mattpocock-skills@mattpocock"

if ! command -v claude >/dev/null 2>&1; then
  echo "session-start: claude CLI not on PATH, skipping plugin install" >&2
  exit 0
fi

# Both commands are idempotent — they exit 0 and no-op when the marketplace or
# plugin is already present. A network failure should warn, not block startup.
if ! claude plugin marketplace add "$MARKETPLACE"; then
  echo "session-start: could not add marketplace $MARKETPLACE" >&2
  exit 0
fi

if ! claude plugin install "$PLUGIN" --scope project; then
  echo "session-start: could not install plugin $PLUGIN" >&2
  exit 0
fi
