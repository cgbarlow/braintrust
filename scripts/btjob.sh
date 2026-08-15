#!/bin/zsh
#
# btjob — run the braintrust ingest job in a container.
#
# The job host updates itself before every run, because a merged fix that never
# reaches the host that executes the job is a fix that never happened. It fetches
# origin/main and, whenever the working tree moved, rebuilds the image from it.
# Nothing new is a no-op that says so. A fetch or build that fails is reported
# loudly and the previous working image runs instead, so the night's ingest never
# waits on the update and a half-built tree is never run.
#
# Every run names the commit the running image was built from: the commit is
# baked into the image as a label at build time, read back before the run, and
# the run's own output carries it (as BRAINTRUST_COMMIT, which the job prints).
#
# Usage:
#   ./btjob.sh              run the job, log to logs/job-<timestamp>.log
#   ./btjob.sh --quiet      no terminal output (for launchd)
#   ./btjob.sh --build      rebuild the image first, then run
#   ./btjob.sh --config     validate .env and exit without running
#
# Called with --quiet by the launchd agent defined in the plist beside this
# script. The exit status is the container run's exit status, so launchd — and
# whatever reports run health — sees a failure instead of a green run.
#
# BTJOB_APP_DIR overrides the checkout; the launchd definition and the docs use
# the default below.

set -u

APP_DIR="${BTJOB_APP_DIR:-/Users/chris/repos/bt-probe}"
IMAGE="braintrust:local"
COMMIT_LABEL="com.braintrust.commit"
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

mkdir -p "$LOG_DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LOG="$LOG_DIR/job-$STAMP.log"

print -r -- "=== btjob start $(date '+%Y-%m-%d %H:%M:%S %Z') ===" >"$LOG"

# Something spoken when nobody is watching still has to reach a reader, so it
# goes to stderr (which launchd captures) and into the run's own log file.
note() { print -r -- "btjob: $*" >&2; print -r -- "btjob: $*" >>"$LOG" 2>/dev/null; }

# --- config check ------------------------------------------------------------
#
# The container run refuses to start on a missing required variable; this is
# the same check a person or CI can run without running the job. It also says,
# up front, whether a fault found tonight could be filed anywhere at all.

if [[ $CONFIG_ONLY -eq 1 ]]; then
  exec "$DOCKER" run --rm --env-file .env "$IMAGE" \
    node -e "
      import('./dist/config.js').then(({ loadConfig }) => {
        const config = loadConfig();
        const repo = (process.env.BRAINTRUST_ISSUES_REPO || '').trim();
        const token = (process.env.BRAINTRUST_ISSUES_TOKEN || '').trim();
        console.log('config OK, port ' + config.port + (repo && token
          ? ', faults to ' + repo
          : ' — BRAINTRUST_ISSUES_REPO and BRAINTRUST_ISSUES_TOKEN are not set, so nothing found tonight can be filed anywhere'));
      });
    "
fi

# --- image state -------------------------------------------------------------

HAD_IMAGE=0
"$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 && HAD_IMAGE=1
if [[ $HAD_IMAGE -eq 0 ]]; then
  say "btjob: image $IMAGE not found, building it"
  BUILD=1
fi

# --- update ------------------------------------------------------------------
#
# The whole point of this step: a merged fix reaches the job host on its own.
# Nothing new is a no-op that says so; a fetch or reset that fails leaves the
# host where it is and the night's run proceeds with the image already there.

COMMIT=""
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BEFORE="$(git rev-parse HEAD 2>/dev/null)"
  if git fetch origin main >/dev/null 2>&1; then
    if git reset --hard origin/main >/dev/null 2>&1; then
      COMMIT="$(git rev-parse HEAD 2>/dev/null)"
      if [[ -n "$BEFORE" && "$COMMIT" != "$BEFORE" ]]; then
        note "fetched origin/main: HEAD moved ($BEFORE -> $COMMIT), rebuilding"
        BUILD=1
      else
        note "already at origin/main ($COMMIT) — nothing new, no rebuild"
      fi
    else
      note "fetched origin/main but could not move the working tree — staying put, not rebuilding"
    fi
  else
    note "could not fetch origin/main — the host stays where it is; running the existing image"
  fi
else
  note "not a git checkout — nothing to update; running the image already present"
fi

# --- build -------------------------------------------------------------------

BUILD_FAILED=0
if [[ $BUILD -eq 1 ]]; then
  if [[ -z "$COMMIT" ]]; then
    note "building $IMAGE (no git commit to name — run the image only after the update step has a checkout)"
  else
    note "building $IMAGE from $COMMIT"
  fi
  if "$DOCKER" build --label "$COMMIT_LABEL=$COMMIT" -t "$IMAGE" .; then
    note "built $IMAGE from ${COMMIT:-unknown}"
  else
    note "build FAILED — keeping the previous image and running it"
    if [[ $HAD_IMAGE -eq 0 ]]; then
      fail "build failed and there is no previous image to run — nothing to run tonight"
    fi
    BUILD_FAILED=1
  fi
fi

# --- run ---------------------------------------------------------------------

# Which code is the container about to execute? The label the image was built
# with — that is where "which version ran" is actually answered, so inspect the
# image rather than the checkout. Fallbacks: a pre-existing image built before
# labels existed reads as its digest, and a static (non-git) host reads as
# "unknown".
RUNNING_COMMIT="$("$DOCKER" image inspect --format "{{ index .Config.Labels \"$COMMIT_LABEL\" }}" "$IMAGE" 2>/dev/null)"
if [[ -z "$RUNNING_COMMIT" ]]; then
  RUNNING_COMMIT="$("$DOCKER" image inspect --format '{{ .Id }}' "$IMAGE" 2>/dev/null)"
fi
[[ -n "$RUNNING_COMMIT" ]] || RUNNING_COMMIT="unknown"

note "running $IMAGE — built from $RUNNING_COMMIT"

if [[ $QUIET -eq 1 ]]; then
  # >> first, then 2>&1: the other order points stderr at the pre-existing stdout
  # and the container's stderr would never reach this run's log file.
  "$DOCKER" run --rm --env-file .env -e BRAINTRUST_COMMIT="$RUNNING_COMMIT" "$IMAGE" npm run job >>"$LOG" 2>&1
  RUN_EXIT=$?
else
  "$DOCKER" run --rm --env-file .env -e BRAINTRUST_COMMIT="$RUNNING_COMMIT" "$IMAGE" npm run job 2>&1 | tee -a "$LOG"
  RUN_EXIT=$pipestatus[1]
fi

{
  print -r -- "=== btjob exit $RUN_EXIT at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  if [[ $BUILD_FAILED -eq 1 ]]; then
    print -r -- "btjob: note — tonight's build failed; this run used the previous image"
  fi
} >>"$LOG"

# --- what actually happened --------------------------------------------------
#
# The line worth reading is the corpus summary. `no captions` is the number
# this whole migration exists to move; `sources due` being 0 means the job
# found nothing ripe and did no fetching at all.

say ""
say "log: $LOG"
grep -E "sources due|no captions|corpus:" "$LOG" | sed 's/^/  /' >&2 2>/dev/null || true

ln -sf "$LOG" "$LOG_DIR/latest.log"

# Keep the last 30 runs.
ls -1t "$LOG_DIR"/job-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null

# The run's exit status, not a script that always says 0. Whatever health is
# reported by (launchd, or a person running the script by hand) sees a failure.
exit "$RUN_EXIT"
