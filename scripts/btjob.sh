#!/bin/zsh
#
# btjob — run the braintrust ingest job in a container.
#
# Usage:
#   ./btjob.sh              run the job, log to logs/job-<timestamp>.log
#   ./btjob.sh --quiet      no terminal output (for launchd)
#   ./btjob.sh --build      rebuild the image first, then run
#   ./btjob.sh --config     validate .env and exit without running
#
# Called with no arguments by the launchd agent.

set -u

APP_DIR="/Users/chris/repos/bt-probe"
IMAGE="braintrust:local"
LOG_DIR="$APP_DIR/logs"
DOCKER="$(command -v docker || echo /usr/local/bin/docker)"

QUIET=0
BUILD=0
CONFIG_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --quiet)  QUIET=1 ;;
    --build)  BUILD=1 ;;
    --config) CONFIG_ONLY=1 ;;
    *) echo "btjob: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { [[ $QUIET -eq 1 ]] || print -r -- "$@"; }
fail() { print -r -- "btjob: $1" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------

cd "$APP_DIR" 2>/dev/null || fail "cannot cd to $APP_DIR"
[[ -x "$DOCKER" ]] || fail "docker not found (looked for $DOCKER)"
[[ -f .env ]]      || fail "no .env in $APP_DIR"

# Docker Desktop only runs inside a logged-in GUI session. If the Mac rebooted
# and nobody signed in, this is where it stops — loudly, in the log, rather
# than silently never ingesting.
"$DOCKER" info >/dev/null 2>&1 || fail "docker daemon not responding — is Docker Desktop running?"

"$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || {
  say "btjob: image $IMAGE not found, building it"
  BUILD=1
}

if [[ $BUILD -eq 1 ]]; then
  say "btjob: building $IMAGE"
  "$DOCKER" build -t "$IMAGE" . || fail "build failed"
fi

# --- config check ------------------------------------------------------------

if [[ $CONFIG_ONLY -eq 1 ]]; then
  exec "$DOCKER" run --rm --env-file .env "$IMAGE" \
    node -e "import('./dist/config.js').then(m => console.log('OK, port', m.loadConfig().port))"
fi

# --- run ---------------------------------------------------------------------

mkdir -p "$LOG_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG="$LOG_DIR/job-$STAMP.log"

{
  print -r -- "=== btjob start $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  "$DOCKER" run --rm --env-file .env "$IMAGE" npm run job 2>&1
  print -r -- "=== btjob exit $? at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} | if [[ $QUIET -eq 1 ]]; then cat >"$LOG"; else tee "$LOG"; fi

# --- what actually happened --------------------------------------------------
#
# The line worth reading is the corpus summary. `no captions` is the number
# this whole migration exists to move; `sources due` being 0 means the job
# found nothing ripe and did no fetching at all.

say ""
say "log: $LOG"
grep -E "sources due|no captions|corpus:" "$LOG" | sed 's/^/  /' >&2 2>/dev/null

ln -sf "$LOG" "$LOG_DIR/latest.log"

# Keep the last 30 runs.
ls -1t "$LOG_DIR"/job-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null

exit 0
