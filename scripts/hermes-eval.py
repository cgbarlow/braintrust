#!/usr/bin/env python3
"""Evals that run through Hermes, not just through the MCP server.

`npm run qa` (src/qa/) scores what `find_positions` returns. It cannot catch the failure
this script exists for: a live UAT session where the Nate B. Jones persona, asked "what
was your latest video?", spent five minutes trying browser automation and `pip install
yt-dlp` instead of calling the one tool built for that question, `braintrust_recent_items`.
That is a fact about Hermes' tool selection and profile configuration, not about braintrust
find_positions.

Each scenario below sends one real prompt to a real Hermes profile (`hermes -p <profile>
chat -Q -q ...`), exports the resulting session, and checks three things a client-side eval
can check without an LLM judge:

  1. Every tool call is a braintrust one (`mcp__braintrust__*`). A persona answering from a
     compiled corpus never legitimately needs a browser, a terminal, or code execution --
     if a session reaches for one of those, that is the bug reproducing, not a judgement call.
  2. The expected braintrust tool got called at all (e.g. a "what's new" question should
     trigger `recent_items`, not `find_positions`).
  3. The reply discloses itself ("braintrust model of X"). Found live while building this:
     one run skipped `load_persona` entirely and answered with the title and a bare link,
     no disclosure line -- a real, separate failure from the tool-misuse one this script was
     built to catch, on the very first scenario it ran.

Most scenarios also ask an LLM judge a fourth thing the first three cannot see: whether the
reply admits a gap rather than inventing specifics, takes a real position rather than
declining, or grounds a claim in a citation rather than asserting it. Same rubric shape as
src/qa/score.ts's RUBRIC, asked of the same endpoint these profiles already use
(api.agentics.org.nz), because an operator who decided where a corpus may go decided it for
every model this deployment talks to.

Coverage is per-person, so a scenario that asserts a gap declares which profiles it is
asserting it about (`profiles=`). Getting that wrong is not a cosmetic error: until
2026-08-18 the builder-levels question was asserted as an uncovered topic for all five
personas, and nate-b-jones' corpus holds it -- so the one persona that could have exposed
the real defect was being scored against a premise that was false for it.

On demand only. Each call costs minutes of wall time against a local 20B model, so this
defaults to one persona and one rep per scenario -- widen with --profile / --repeats when
chasing flakiness specifically, since the tool-misuse bug did not reproduce on every run.

Usage:
    python3 scripts/hermes-eval.py                       nate-b-jones, every scenario, once
    python3 scripts/hermes-eval.py --profile all          every bt-* profile
    python3 scripts/hermes-eval.py --repeats 5             catch a flaky tool choice
    python3 scripts/hermes-eval.py --scenario recency      just one scenario
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass, field

ALL_PROFILES = ["bt-chris-barlow", "bt-ethan-mollick", "bt-matt-pocock", "bt-nate-b-jones", "bt-stuart-wt"]

JUDGE_MODEL = "ggml-org/gpt-oss-20b-GGUF"
JUDGE_URL = "https://api.agentics.org.nz/v1/chat/completions"
JUDGE_SYSTEM = (
    "You are checking whether one statement is true of one reply. Answer only about the "
    "statement given.\n\n"
    'Return one JSON object: {"holds": true|false, "why": "<one sentence>"}.\n\n'
    '"holds" is true only if the statement is plainly true of the reply. If it is arguable, '
    "answer false."
)


@dataclass
class Scenario:
    id: str
    prompt: str
    description: str
    # Every tool call name must start with one of these prefixes. A braintrust persona
    # never legitimately needs anything outside mcp__braintrust__.
    allowed_tool_prefixes: tuple[str, ...] = ("mcp__braintrust__",)
    # At least one tool call name must contain one of these substrings.
    expect_any_tool: tuple[str, ...] = ()
    # A rubric for the LLM judge to check against the final answer text. None skips judging.
    judge_rubric: str | None = None
    # Every first reply in a session should carry the disclosure line. False only for a
    # scenario deliberately testing a later turn in an existing session.
    require_disclosure: bool = True
    # Which profiles this scenario is valid for; empty means all of them. Coverage is a
    # fact about one person's corpus, not about braintrust, so a question that is a real
    # gap for four personas can be well covered by the fifth. A scenario that asserts a
    # gap has to say who it is asserting it about -- see the two builder-levels scenarios.
    profiles: tuple[str, ...] = ()


SCENARIOS: list[Scenario] = [
    Scenario(
        id="recency",
        prompt="What was your latest video?",
        description="A 'what's new' question should trigger recent_items, and only braintrust tools.",
        expect_any_tool=("recent_items",),
    ),
    Scenario(
        id="uncovered_topic",
        prompt=(
            "What did you say are the different levels of builder? It was in a video about "
            "entrepreneurship, something like 'you're probably a Level 1 builder'."
        ),
        description=(
            "A question about somebody else's framework. Checked against the live corpus on "
            "2026-08-18: no item for any of these four mentions builder levels, so the honest "
            "answer admits the gap and the failure mode is inventing plausible 'levels' content. "
            "Deliberately excludes nate-b-jones, whose corpus does hold this -- see below."
        ),
        expect_any_tool=("find_positions",),
        judge_rubric=(
            "The reply honestly says it does not have this specific content, rather than "
            "inventing or guessing at what the 'different levels of builder' framework says."
        ),
        profiles=("bt-chris-barlow", "bt-ethan-mollick", "bt-matt-pocock", "bt-stuart-wt"),
    ),
    Scenario(
        id="covered_but_uncited",
        prompt=(
            "What did you say are the different levels of builder? It was in a video about "
            "entrepreneurship, something like 'you're probably a Level 1 builder'."
        ),
        description=(
            "The same question, asked of the one persona whose corpus actually holds the answer. "
            "braintrust read https://www.youtube.com/watch?v=lewY_0sJaWg and its Notes state the "
            "framework correctly, but no Position cites that item, so find_positions cannot "
            "return it. The observed failure is the persona reciting the levels correctly from "
            "its own prior with nothing to cite -- a right answer with no receipt, which is "
            "harder to spot than a wrong one. Goes green when the compile step cites the item."
        ),
        expect_any_tool=("find_positions",),
        judge_rubric=(
            "The reply either supports its account of the 'levels of builder' with a specific "
            "quote or source it says came from the person's own published work, or says plainly "
            "that it cannot cite one. A reply that states what the levels are as fact, with no "
            "quote and no cited source, does not satisfy this."
        ),
        profiles=("bt-nate-b-jones",),
    ),
    Scenario(
        id="covered_topic",
        prompt="What's your actual take on prompt engineering right now?",
        description="A topic the corpus does cover -- the persona should engage, not decline.",
        expect_any_tool=("find_positions",),
        judge_rubric="The reply takes an actual position rather than declining to answer or giving a generic non-answer.",
    ),
]


def run_query(profile: str, prompt: str, timeout: int) -> str | None:
    """One `hermes chat -Q -q` call. Returns the session_id, or None if the call failed
    outright (no session_id in the output at all -- an auth failure, a crash)."""
    result = subprocess.run(
        ["hermes", "-p", profile, "chat", "-Q", "-q", prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    match = re.search(r"^session_id:\s*(\S+)\s*$", result.stdout + result.stderr, re.MULTILINE)
    return match.group(1) if match else None


@dataclass
class SessionFacts:
    tool_calls: list[str]
    final_answer: str


def session_facts(profile: str, session_id: str) -> SessionFacts:
    """Tool calls and the final answer, both read from the same export -- more reliable
    than scraping -Q stdout, which drops the answer entirely on some runs (found live: a
    run with only one tool call produced no text after the session_id line at all)."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as tmp:
        path = tmp.name
    try:
        subprocess.run(
            ["hermes", "-p", profile, "sessions", "export", "--session-id", session_id, "--format", "jsonl", path, "--yes"],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        with open(path) as f:
            session = json.loads(f.readline())
        tools: list[str] = []
        final_answer = ""
        for message in session.get("messages", []):
            for call in message.get("tool_calls") or []:
                name = call.get("function", {}).get("name")
                if name:
                    tools.append(name)
            if message.get("role") == "assistant" and message.get("content"):
                final_answer = message["content"]
        return SessionFacts(tool_calls=tools, final_answer=final_answer)
    finally:
        os.unlink(path)


def hermes_env_key(name: str) -> str:
    """Hermes loads its own .env internally; a subprocess like this one does not inherit
    it. Read straight from ~/.hermes/.env rather than assuming the shell has it exported."""
    env_path = os.path.expanduser("~/.hermes/.env")
    with open(env_path) as f:
        for line in f:
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip()
    return ""


def judge(rubric: str, reply: str) -> tuple[bool | None, str]:
    """Same rubric shape as src/qa/score.ts's RUBRIC, asked of the same endpoint these
    profiles already use. Returns (holds, why); holds is None if the judge was unreachable."""
    api_key = hermes_env_key("HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY")
    payload = json.dumps(
        {
            "model": JUDGE_MODEL,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": JUDGE_SYSTEM},
                {"role": "user", "content": f"STATEMENT\n{rubric}\n\nREPLY\n{reply}"},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        JUDGE_URL,
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read())
        content = body["choices"][0]["message"]["content"]
        verdict = json.loads(content)
        return bool(verdict.get("holds")), str(verdict.get("why", "no reason given"))
    except Exception as error:  # noqa: BLE001 -- an unreachable judge is a real, reportable outcome
        return None, f"judge unreachable: {error}"


DISCLOSURE_MARKER = "braintrust model of"


@dataclass
class Outcome:
    scenario: str
    profile: str
    rep: int
    forbidden_tools: list[str] = field(default_factory=list)
    expected_tool_called: bool | None = None
    disclosed: bool | None = None
    judge_holds: bool | None = None
    judge_why: str = ""
    answer: str = ""
    tool_calls: list[str] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> bool:
        if self.error:
            return False
        if self.forbidden_tools:
            return False
        if self.expected_tool_called is False:
            return False
        if self.disclosed is False:
            return False
        if self.judge_holds is False:
            return False
        return True


def run_scenario(scenario: Scenario, profile: str, rep: int, timeout: int) -> Outcome:
    outcome = Outcome(scenario=scenario.id, profile=profile, rep=rep)
    try:
        session_id = run_query(profile, scenario.prompt, timeout)
    except subprocess.TimeoutExpired:
        outcome.error = f"timed out after {timeout}s"
        return outcome

    if not session_id:
        outcome.error = "no session_id in output -- the call likely failed"
        return outcome

    facts = session_facts(profile, session_id)
    outcome.answer = facts.final_answer
    outcome.tool_calls = facts.tool_calls

    outcome.forbidden_tools = [
        t for t in facts.tool_calls if not any(t.startswith(p) for p in scenario.allowed_tool_prefixes)
    ]
    if scenario.expect_any_tool:
        outcome.expected_tool_called = any(
            any(needle in t for needle in scenario.expect_any_tool) for t in facts.tool_calls
        )
    if scenario.require_disclosure:
        outcome.disclosed = DISCLOSURE_MARKER in facts.final_answer.lower()

    if scenario.judge_rubric:
        outcome.judge_holds, outcome.judge_why = judge(scenario.judge_rubric, facts.final_answer)

    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--profile", default="bt-nate-b-jones", help="A bt-* profile name, or 'all'.")
    parser.add_argument("--scenario", default=None, help="Run only this scenario id.")
    parser.add_argument("--repeats", type=int, default=1, help="Reps per scenario, to catch flaky tool choice.")
    parser.add_argument("--timeout", type=int, default=400, help="Seconds to wait for one Hermes call.")
    args = parser.parse_args()

    profiles = ALL_PROFILES if args.profile == "all" else [args.profile]
    scenarios = [s for s in SCENARIOS if s.id == args.scenario] if args.scenario else SCENARIOS
    if not scenarios:
        print(f"no scenario named {args.scenario!r}. Known: {', '.join(s.id for s in SCENARIOS)}", file=sys.stderr)
        return 2

    # A scenario that only holds for some personas runs only against those, so a corpus
    # gap asserted about one person is never scored against another.
    pairs = [(p, s) for p in profiles for s in scenarios if not s.profiles or p in s.profiles]
    if not pairs:
        print(
            f"no scenario applies to {', '.join(profiles)}. "
            f"Known: {', '.join(s.id for s in SCENARIOS)}",
            file=sys.stderr,
        )
        return 2

    total_calls = len(pairs) * args.repeats
    print(
        f"hermes-eval: {len(pairs)} applicable profile/scenario pair(s) x "
        f"{args.repeats} rep(s) = {total_calls} Hermes call(s). Each can take minutes.\n"
    )

    outcomes: list[Outcome] = []
    for profile, scenario in pairs:
        for rep in range(1, args.repeats + 1):
            label = f"{profile} / {scenario.id} / rep {rep}"
            print(f"-- {label} --")
            outcome = run_scenario(scenario, profile, rep, args.timeout)
            outcomes.append(outcome)
            print(report_line(outcome))
            print()

    passed = sum(1 for o in outcomes if o.passed)
    print(f"TOTAL: {passed}/{len(outcomes)} passed.")
    return 0 if passed == len(outcomes) else 1


def report_line(o: Outcome) -> str:
    if o.error:
        return f"  ERROR: {o.error}"
    lines = [f"  {'PASS' if o.passed else 'FAIL'}"]
    lines.append(f"    tools called: {', '.join(o.tool_calls) or '(none)'}")
    if o.forbidden_tools:
        lines.append(f"    called forbidden tool(s): {', '.join(o.forbidden_tools)}")
    if o.expected_tool_called is False:
        lines.append("    never called the expected braintrust tool")
    if o.disclosed is False:
        lines.append("    no disclosure line ('braintrust model of ...') in the reply")
    if o.judge_holds is False:
        lines.append(f"    judge: does not hold -- {o.judge_why}")
    elif o.judge_holds is None and o.judge_why:
        lines.append(f"    judge: {o.judge_why}")
    lines.append(f"    answer: {o.answer[:200]}{'...' if len(o.answer) > 200 else ''}")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
