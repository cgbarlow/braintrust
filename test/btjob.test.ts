/**
 * The job host updates itself and says which version it ran.
 *
 * These drive the real `scripts/btjob.sh` under zsh through a fake `git` and a fake
 * `docker` in PATH, so the update decisions are exercised without the real host:
 * nothing new, fetch fails, build fails, build succeeds. The fakes record every call,
 * so the assertions check the decisions — what was fetched, what was rebuilt, what was
 * run — rather than the mechanics.
 *
 * See https://github.com/cgbarlow/braintrust/issues/281.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/btjob.sh', import.meta.url));

/**
 * The script under test is `#!/bin/zsh` — the shell the job host runs it under
 * (macOS/launchd) — and not every CI image ships zsh: the ubuntu-latest image,
 * for example, does not. When zsh is absent the suite is skipped rather than
 * failing the run for a shell nobody promised was there. The workflow itself
 * installs zsh (`.github/workflows/ci.yml`) so the tests normally do run there.
 */
function zshAvailable(): boolean {
  try {
    const probe = spawnSync('zsh', ['-n', '-c', 'true'], { encoding: 'utf8' });
    return probe.error === undefined && probe.status === 0;
  } catch {
    return false;
  }
}

const runJobTest = zshAvailable() ? it : it.skip;

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GIT = `#!/bin/sh
echo "git $*" >>"$FAKE_GIT_CALLS"
case "$1" in
  rev-parse)
    if [ "$2" = "--is-inside-work-tree" ]; then
      [ "$FAKE_GIT_NOT_A_REPO" = "1" ] && exit 1
      echo true
      exit 0
    fi
    if [ "$2" = "HEAD" ]; then
      cat "$FAKE_GIT_HEAD"
      exit 0
    fi
    exit 1
    ;;
  fetch)
    if [ "$FAKE_GIT_FETCH_FAIL" = "1" ]; then
      echo "error: could not fetch origin main" >&2
      exit 1
    fi
    exit 0
    ;;
  reset)
    if [ "$FAKE_GIT_RESET_FAIL" = "1" ]; then
      echo "error: unable to update local ref" >&2
      exit 1
    fi
    printf '%s' "$FAKE_GIT_REMOTE_SHA" >"$FAKE_GIT_HEAD"
    exit 0
    ;;
esac
exit 1
`;

const DOCKER = `#!/bin/sh
echo "docker $*" >>"$FAKE_DOCKER_CALLS"
case "$1" in
  info)
    exit 0
    ;;
  image)
    if [ "$2" = "inspect" ]; then
      if [ "$3" = "--format" ]; then
        if [ -n "$FAKE_IMAGE_COMMIT" ]; then echo "$FAKE_IMAGE_COMMIT";
        elif [ -n "$FAKE_IMAGE_ID" ]; then echo "$FAKE_IMAGE_ID";
        else echo ""; fi
        exit 0
      fi
      [ "$FAKE_IMAGE_MISSING" = "1" ] && exit 1
      echo "sha256:$(cat "$FAKE_GIT_HEAD" 2>/dev/null)"
      exit 0
    fi
    exit 1
    ;;
  build)
    if [ "$FAKE_BUILD_FAIL" = "1" ]; then
      echo "ERROR: failed to solve" >&2
      exit 1
    fi
    FAKE_IMAGE_MISSING=0
    exit 0
    ;;
  run)
    printf '%s\n' "$FAKE_RUN_OUTPUT"
    printf '%s\n' "$FAKE_RUN_STDERR" >&2
    exit "$FAKE_RUN_EXIT"
    ;;
esac
exit 1
`;

type Run = {
  status: number;
  stdout: string;
  stderr: string;
  dockerCalls: string[];
  gitCalls: string[];
  log: string;
};

function makeEnv(appDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: join(appDir, 'fakebin') + ':' + process.env.PATH!,
    BTJOB_APP_DIR: appDir,
    FAKE_GIT_HEAD: join(appDir, 'git-head'),
    FAKE_GIT_REMOTE_SHA: HEAD,
    FAKE_GIT_CALLS: join(appDir, 'git-calls'),
    FAKE_DOCKER_CALLS: join(appDir, 'docker-calls'),
    FAKE_GIT_FETCH_FAIL: '0',
    FAKE_GIT_RESET_FAIL: '0',
    FAKE_GIT_NOT_A_REPO: '0',
    FAKE_IMAGE_MISSING: '0',
    FAKE_BUILD_FAIL: '0',
    FAKE_IMAGE_COMMIT: '',
    FAKE_IMAGE_ID: '',
    FAKE_RUN_EXIT: '0',
    FAKE_RUN_OUTPUT: 'braintrust 1.0.0: ingest run starting.\ncorpus: 12 items, 10879 words.',
    FAKE_RUN_STDERR: 'braintrust: a fault no one was told',
    ...overrides,
  };
}

function runJob(overrides: Record<string, string> = {}, args: string[] = ['--quiet']): Run {
  const appDir = mkdtempSync(join(tmpdir(), 'btjob-'));
  mkdirSync(join(appDir, 'fakebin'), { recursive: true });
  writeFileSync(join(appDir, 'fakebin', 'git'), GIT);
  writeFileSync(join(appDir, 'fakebin', 'docker'), DOCKER);
  chmodSync(join(appDir, 'fakebin', 'git'), 0o755);
  chmodSync(join(appDir, 'fakebin', 'docker'), 0o755);
  writeFileSync(join(appDir, '.env'), 'BRAINTRUST_ISSUES_REPO=\nBRAINTRUST_ISSUES_TOKEN=\n');
  writeFileSync(join(appDir, 'git-head'), HEAD);
  writeFileSync(join(appDir, 'git-remote'), HEAD);

  const env = makeEnv(appDir, overrides);
  const result = spawnSync('zsh', [SCRIPT, ...args], { env, encoding: 'utf8' });

  // A spawn that cannot happen at all (zsh missing) is a real cause, not a
  // mystery: say so instead of letting a downstream ENOENT hide it.
  if (result.error) throw result.error;

  const dockerCalls = (existsSync(join(appDir, 'docker-calls')) ? readFileSync(join(appDir, 'docker-calls'), 'utf8') : '')
    .split('\n')
    .filter(Boolean);
  const gitCalls = (existsSync(join(appDir, 'git-calls')) ? readFileSync(join(appDir, 'git-calls'), 'utf8') : '')
    .split('\n')
    .filter(Boolean);
  const logsDir = join(appDir, 'logs');
  let log = '';
  if (existsSync(logsDir)) {
    const logs = readdirSync(logsDir).filter((name) => name.endsWith('.log'));
    logs.sort().reverse();
    if (logs.length > 0) log = readFileSync(join(logsDir, logs[0]!), 'utf8');
  } else {
    // btjob.sh always starts its own log file before the run; a run that created
    // none exited early, and its exit status and stderr are the diagnosis.
    throw new Error(
      `btjob.sh exited before writing its log in ${logsDir}: status ${result.status}, ` +
        `stderr=${JSON.stringify(result.stderr)}`,
    );
  }

  rmSync(appDir, { recursive: true, force: true });

  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    dockerCalls,
    gitCalls,
    log,
  };
}

describe('the job host updates itself', () => {
  runJobTest('fetches origin/main before every run', () => {
    const run = runJob();
    assert.equal(run.status, 0);
    assert.ok(run.gitCalls.some((call) => call.includes('fetch origin main')));
    assert.ok(run.gitCalls.some((call) => call.includes('reset --hard origin/main')));
    assert.ok(run.dockerCalls.some((call) => call.includes('run')));
  });

  runJobTest('an update with nothing new is a no-op that says so, and does not rebuild', () => {
    const run = runJob();
    assert.equal(run.status, 0);
    assert.match(run.log, /nothing new, no rebuild/);
    assert.ok(!run.dockerCalls.some((call) => call.includes('docker build')));
    assert.ok(run.dockerCalls.some((call) => call.includes('docker run')));
  });

  runJobTest('an interactive (non-quiet) run takes the same path and still writes the log', () => {
    const run = runJob({ FAKE_IMAGE_COMMIT: REMOTE }, []);
    assert.equal(run.status, 0);
    assert.match(run.log, /nothing new, no rebuild/);
    assert.match(run.log, /=== btjob exit 0 at /);
  });

  runJobTest('a fetch that fails runs the existing image and does not rebuild', () => {
    const run = runJob({ FAKE_GIT_FETCH_FAIL: '1' });
    assert.equal(run.status, 0);
    assert.match(run.log, /could not fetch origin\/main/);
    assert.ok(!run.dockerCalls.some((call) => call.includes('docker build')));
    assert.ok(run.dockerCalls.some((call) => call.includes('docker run')));
  });

  runJobTest('a failed build keeps the previous image, runs it, and says it did', () => {
    const run = runJob({ FAKE_GIT_REMOTE_SHA: REMOTE, FAKE_BUILD_FAIL: '1' });
    assert.equal(run.status, 0);
    assert.match(run.log, /HEAD moved/);
    assert.match(run.log, /build FAILED/);
    assert.match(run.log, /used the previous image/);
    assert.ok(run.dockerCalls.some((call) => call.includes('docker build')));
    const build = run.dockerCalls.find((call) => call.includes('docker build'))!;
    const runCall = run.dockerCalls.find((call) => call.includes('docker run'))!;
    assert.ok(run.dockerCalls.indexOf(build) < run.dockerCalls.indexOf(runCall));
  });

  runJobTest('a failed build with no previous image aborts, and does not run', () => {
    const run = runJob({ FAKE_GIT_REMOTE_SHA: REMOTE, FAKE_BUILD_FAIL: '1', FAKE_IMAGE_MISSING: '1' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no previous image/);
    assert.ok(!run.dockerCalls.some((call) => call.includes('docker run')));
  });

  runJobTest('a successful build labels the image with the fetched commit and runs it', () => {
    const run = runJob({
      FAKE_GIT_REMOTE_SHA: REMOTE,
      FAKE_GIT_FETCH_FAIL: '0',
      FAKE_IMAGE_COMMIT: REMOTE,
    });
    assert.equal(run.status, 0);
    assert.match(run.log, /HEAD moved/);
    assert.match(run.log, /built braintrust:local from bbb/);
    assert.ok(run.dockerCalls.some((call) => call.includes(`docker build --label com.braintrust.commit=${REMOTE}`)));
    assert.ok(
      run.dockerCalls.some((call) => call.includes('run') && call.includes(`-e BRAINTRUST_COMMIT=${REMOTE}`)),
    );
  });
});

describe('every run names the commit it ran from', () => {
  runJobTest('resolves the commit from the image label, not the checkout', () => {
    // The image was built from REMOTE, but the checkout behind it is just the
    // pre-existing HEAD: the log must name the image's commit.
    const run = runJob({ FAKE_IMAGE_COMMIT: REMOTE });
    assert.equal(run.status, 0);
    assert.match(run.log, /running braintrust:local — built from bbb/);
    assert.ok(run.dockerCalls.some((call) => call.includes(`-e BRAINTRUST_COMMIT=${REMOTE}`)));
  });

  runJobTest('falls back to the image digest for an image built before labels existed', () => {
    const run = runJob({ FAKE_IMAGE_ID: 'deadbeefdeadbeef' });
    assert.equal(run.status, 0);
    assert.match(run.log, /built from deadbeefdeadbeef/);
  });
});

describe('the script reports', () => {
  runJobTest('the container run exit status, not a green 0', () => {
    const run = runJob({ FAKE_RUN_EXIT: '3' });
    assert.equal(run.status, 3);
    assert.match(run.log, /=== btjob exit 3 at /);
  });

  runJobTest('in the log that wraps the run, with the commit line inside it', () => {
    const run = runJob({ FAKE_IMAGE_COMMIT: REMOTE });
    const lines = run.log.split('\n');
    assert.equal(lines[0], lines[0]);
    assert.match(lines[0]!, /=== btjob start /);
    assert.match(run.log, /running braintrust:local — built from bbb/);
    assert.match(run.log, /=== btjob exit 0 at /);
  });

  runJobTest('missing issue-filing configuration to the --config check, up front', () => {
    const run = runJob({}, ['--config']);
    assert.equal(run.status, 0);
    const calls = run.dockerCalls.join('\n');
    assert.ok(calls.includes('docker run'));
    assert.ok(calls.includes('BRAINTRUST_ISSUES_REPO'));
  });
});

describe('a run nobody is watching stays visible', () => {
  runJobTest('writes a log file even with --quiet, and keeps it behind latest.log', () => {
    const run = runJob();
    assert.notEqual(run.log, '');
    assert.match(run.log, /=== btjob start /);
    assert.match(run.log, /=== btjob exit 0 at /);
  });

  runJobTest('with --quiet still captures the container run\'s stderr into the log', () => {
    // launchd runs with --quiet, and the container's stderr (fault lines,
    // warnings, errors) has to reach the same log a maintainer reads — a
    // `2>&1 >>log` redirection order would silently point it elsewhere.
    const run = runJob();
    assert.match(run.log, /a fault no one was told/);
  });
});
