#!/usr/bin/env python3
"""Minimal stdio MCP client used only by the isolated benchmark."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


def _reader(stream: Any, output: queue.Queue[str]) -> None:
    for line in iter(stream.readline, ""):
        output.put(line.rstrip("\n"))


def _request(
    process: subprocess.Popen[str],
    stdout_lines: queue.Queue[str],
    request_id: int,
    method: str,
    params: dict[str, Any],
    timeout: float,
) -> tuple[dict[str, Any], float, list[str]]:
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }
    started = time.perf_counter()
    assert process.stdin is not None
    process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
    process.stdin.flush()
    non_json: list[str] = []
    deadline = started + timeout
    while time.perf_counter() < deadline:
        remaining = max(0.01, deadline - time.perf_counter())
        try:
            line = stdout_lines.get(timeout=remaining)
        except queue.Empty:
            break
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            non_json.append(line)
            continue
        if response.get("id") == request_id:
            return response, (time.perf_counter() - started) * 1000, non_json
    raise TimeoutError(f"timed out waiting for MCP response to {method}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument(
        "--calls",
        type=Path,
        help="Optional JSON array of {label, tool, arguments} calls to run after tools/list",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("a server command is required after --")

    env = os.environ.copy()
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=args.cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None and process.stderr is not None
    stdout_lines: queue.Queue[str] = queue.Queue()
    stderr_lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=_reader, args=(process.stdout, stdout_lines), daemon=True).start()
    threading.Thread(target=_reader, args=(process.stderr, stderr_lines), daemon=True).start()

    result: dict[str, Any] = {
        "candidate": args.name,
        "command": command,
        "cwd": str(args.cwd),
        "started_at_epoch": time.time(),
    }
    try:
        initialize, init_ms, init_noise = _request(
            process,
            stdout_lines,
            1,
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {"roots": {"listChanged": False}},
                "clientInfo": {"name": "isolated-code-intelligence-benchmark", "version": "1.0.0"},
                "rootUri": args.cwd.as_uri(),
                "workspaceFolders": [{"uri": args.cwd.as_uri(), "name": args.cwd.name}],
            },
            args.timeout,
        )
        result["initialize"] = initialize
        result["initialize_ms"] = round(init_ms, 3)
        result["initialize_stdout_noise"] = init_noise

        assert process.stdin is not None
        process.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n')
        process.stdin.flush()

        tools_response, tools_ms, tools_noise = _request(
            process, stdout_lines, 2, "tools/list", {}, args.timeout
        )
        result["tools_list"] = tools_response
        result["tools_list_ms"] = round(tools_ms, 3)
        result["tools_stdout_noise"] = tools_noise
        result["calls"] = []
        if args.calls:
            calls = json.loads(args.calls.read_text(encoding="utf-8"))
            for offset, call in enumerate(calls, start=3):
                response, elapsed_ms, noise = _request(
                    process,
                    stdout_lines,
                    offset,
                    "tools/call",
                    {
                        "name": call["tool"],
                        "arguments": call.get("arguments", {}),
                    },
                    args.timeout,
                )
                encoded = json.dumps(response, separators=(",", ":"))
                result["calls"].append(
                    {
                        "label": call.get("label", call["tool"]),
                        "tool": call["tool"],
                        "arguments": call.get("arguments", {}),
                        "elapsed_ms": round(elapsed_ms, 3),
                        "response_bytes": len(encoded.encode("utf-8")),
                        "estimated_tokens": (len(encoded) + 3) // 4,
                        "stdout_noise": noise,
                        "response": response,
                    }
                )
        result["startup_total_ms"] = round((time.perf_counter() - started) * 1000, 3)
        result["status"] = "ok"
    except Exception as error:  # benchmark captures failures as evidence
        result["status"] = "error"
        result["error"] = f"{type(error).__name__}: {error}"
        result["startup_total_ms"] = round((time.perf_counter() - started) * 1000, 3)
    finally:
        try:
            process.terminate()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        stderr: list[str] = []
        while not stderr_lines.empty():
            stderr.append(stderr_lines.get_nowait())
        result["stderr"] = stderr
        result["exit_code"] = process.returncode

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "candidate": args.name,
        "status": result["status"],
        "startup_total_ms": result["startup_total_ms"],
        "tools": len(result.get("tools_list", {}).get("result", {}).get("tools", [])),
        "error": result.get("error"),
    }))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
