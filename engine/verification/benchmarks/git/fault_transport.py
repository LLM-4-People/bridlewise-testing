#!/usr/bin/env python3
"""Deterministic local Git service fault injector.

This program is fixture tooling, not a transport adapter.  It accepts only a
repository below QUALIFICATION_CASE_ROOT and never opens a network connection.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


EXIT_FAULT = 75
SERVICES = {"upload-pack", "receive-pack"}
MODES = {
    "pass",
    "fail-before",
    "delay-before",
    "service-then-fail",
    "reset-before",
    "auth-absent",
    "auth-expired",
    "auth-wrong-scope",
    "atomic-unsupported",
}


def contained(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (FileNotFoundError, ValueError):
        return False
    return True


def service_command(service: str, repository: Path) -> list[str]:
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git executable unavailable")
    return [git, service, str(repository)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", required=True, choices=sorted(SERVICES))
    parser.add_argument("--mode", required=True, choices=sorted(MODES))
    parser.add_argument("--repo")
    parser.add_argument("--delay-ms", type=int, default=250)
    # Git appends the repository path when this program is supplied through
    # --upload-pack/--receive-pack. Direct fixture probes may use --repo.
    parser.add_argument("repository_argument", nargs="?")
    args = parser.parse_args(argv)

    root_text = os.environ.get("QUALIFICATION_CASE_ROOT")
    if not root_text:
        print("qualification transport fault: missing case-root binding", file=sys.stderr)
        return 77
    root = Path(root_text)
    repository_text = args.repo or args.repository_argument
    if not repository_text:
        print("qualification transport fault: missing repository", file=sys.stderr)
        return 77
    if args.repo and args.repository_argument and Path(args.repo) != Path(args.repository_argument):
        print("qualification transport fault: ambiguous repository binding", file=sys.stderr)
        return 77
    repository = Path(repository_text)
    if not contained(repository, root):
        print("qualification transport fault: repository outside case root", file=sys.stderr)
        return 77
    if args.delay_ms < 0 or args.delay_ms > 5_000:
        print("qualification transport fault: invalid bounded delay", file=sys.stderr)
        return 77

    if args.mode in {"fail-before", "reset-before", "atomic-unsupported"}:
        print(f"qualification transport fault: {args.mode}", file=sys.stderr)
        return EXIT_FAULT
    if args.mode.startswith("auth-"):
        # The class is synthetic.  No username, token, password, or helper
        # payload is accepted or emitted by this tool.
        print(f"qualification auth capability: {args.mode[5:]}", file=sys.stderr)
        return EXIT_FAULT
    if args.mode == "delay-before":
        time.sleep(args.delay_ms / 1000)
        print("qualification transport fault: bounded-delay-expired", file=sys.stderr)
        return EXIT_FAULT

    command = service_command(args.service, repository)
    if args.mode == "pass":
        os.execve(command[0], command, _service_environment())
        raise AssertionError("unreachable")

    completed = subprocess.run(command, env=_service_environment(), check=False)
    if completed.returncode != 0:
        return completed.returncode
    # The Git service completed, so refs or fetched data may already have
    # changed.  The client nevertheless receives failure and must read back.
    print("qualification transport fault: service-completed-ack-lost", file=sys.stderr)
    return EXIT_FAULT


def _service_environment() -> dict[str, str]:
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    # Local service negotiation still needs the case binding for child-side
    # diagnostics, but no other inherited qualification/candidate values.
    env["QUALIFICATION_CASE_ROOT"] = os.environ["QUALIFICATION_CASE_ROOT"]
    return env


if __name__ == "__main__":
    raise SystemExit(main())
