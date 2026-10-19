#!/usr/bin/env python3
"""Read-only sanitized inspection of codebase-memory storage and OpenCode usage."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3


CONFIG = {
    "cache": Path("/home/example/.cache/codebase-memory-mcp"),
    "opencode_db": Path("/home/example/.local/share/opencode/opencode.db"),
    "output": Path("/tmp/code-intelligence-benchmark/raw/existing-baseline.json"),
}


def parse_json(value, fallback=None):
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def safe_output_signal(value: str) -> str:
    lowered = value.lower()
    rules = [
        ("project_not_found_or_not_indexed", r"project not found|not indexed"),
        ("database_locked", r"database is locked|locked database"),
        ("required_argument_missing", r"is required|required field|missing required"),
        ("no_results", r"no results|0 results|not found"),
        ("empty_graph", r'"nodes"\s*:\s*0|nodes:\s*0'),
        ("successful_json_response", r"^\s*\{"),
    ]
    for label, pattern in rules:
        if re.search(pattern, lowered):
            return label
    return "unclassified_completed_output"


def intent(text: str) -> str:
    lowered = text.lower()
    rules = [
        ("reuse_or_existing_owner", r"reuse|existing|already|canonical|shared|duplicate|owner"),
        ("architecture_or_dependencies", r"architecture|dependency|dependencies|consumer|call graph|reference"),
        ("code_search", r"find|search|locate|where|symbol|function|class"),
        ("change_impact", r"impact|affected|change|refactor|modify|edit"),
        ("general_implementation", r"implement|build|create|add|fix"),
    ]
    for label, pattern in rules:
        if re.search(pattern, lowered):
            return label
    return "other"


def iso(epoch_ms):
    if epoch_ms is None:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).isoformat(timespec="milliseconds")


cache_databases = []
for database_path in sorted(CONFIG["cache"].glob("*.db")):
    db = sqlite3.connect(f"file:{database_path}?mode=ro&immutable=1", uri=True)
    tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    table_counts = {}
    for table in tables:
        if not re.fullmatch(r"[A-Za-z0-9_]+", table):
            continue
        table_counts[table] = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
    columns = {}
    for table in tables:
        if not re.fullmatch(r"[A-Za-z0-9_]+", table):
            continue
        columns[table] = [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]
    db.close()
    stat = database_path.stat()
    cache_databases.append(
        {
            "name": database_path.name,
            "size_bytes": stat.st_size,
            "mtime_utc": iso(int(stat.st_mtime * 1000)),
            "table_counts": table_counts,
            "columns": columns,
        }
    )

db = sqlite3.connect(f"file:{CONFIG['opencode_db']}?mode=ro", uri=True)
db.row_factory = sqlite3.Row
tool_rows = []
for row in db.execute(
    """
    SELECT p.id,p.message_id,p.session_id,p.time_created,p.time_updated,p.data,
           m.data AS message_data
    FROM part p JOIN message m ON m.id=p.message_id
    WHERE json_extract(p.data,'$.type')='tool'
      AND json_extract(p.data,'$.tool') LIKE 'codebase-memory-mcp_%'
    ORDER BY p.time_created,p.id
    """
):
    part = parse_json(row["data"], {})
    state = part.get("state") if isinstance(part.get("state"), dict) else {}
    state_time = state.get("time") if isinstance(state.get("time"), dict) else {}
    tool_input = state.get("input") if isinstance(state.get("input"), dict) else {}
    output = str(state.get("output") or state.get("error") or "")
    tool_rows.append(
        {
            "part_id": row["id"],
            "message_id": row["message_id"],
            "session_id": row["session_id"],
            "timestamp_utc": iso(row["time_created"]),
            "tool": part.get("tool"),
            "status": state.get("status"),
            "input_keys": sorted(tool_input),
            "latency_ms": (
                state_time.get("end") - state_time.get("start")
                if isinstance(state_time.get("end"), int) and isinstance(state_time.get("start"), int)
                else None
            ),
            "output_signal": safe_output_signal(output),
            "raw_input_output_retained": False,
        }
    )

messages_by_session = defaultdict(list)
for row in db.execute("SELECT id,session_id,time_created,data FROM message ORDER BY session_id,time_created,id"):
    data = parse_json(row["data"], {})
    messages_by_session[row["session_id"]].append({**dict(row), "data": data})

parts_by_message = defaultdict(list)
for row in db.execute(
    """
    SELECT p.message_id,p.data
    FROM part p
    WHERE p.session_id IN (
      SELECT DISTINCT session_id FROM part
      WHERE json_extract(data,'$.tool') LIKE 'codebase-memory-mcp_%'
    )
    """
):
    parts_by_message[row["message_id"]].append(parse_json(row["data"], {}))
db.close()

call_context = []
for call in tool_rows:
    timeline = messages_by_session[call["session_id"]]
    message = next((item for item in timeline if item["id"] == call["message_id"]), None)
    parent_id = message["data"].get("parentID") if message else None
    user = next((item for item in timeline if item["id"] == parent_id), None)
    user_text = "\n".join(
        str(part.get("text"))
        for part in parts_by_message.get(parent_id, [])
        if part.get("type") == "text" and part.get("text") is not None
    )
    later_tools = []
    if message:
        for later_message in timeline:
            if (later_message["time_created"], later_message["id"]) < (message["time_created"], message["id"]):
                continue
            for part in parts_by_message.get(later_message["id"], []):
                if part.get("type") == "tool":
                    later_tools.append(str(part.get("tool") or "unknown"))
    call_context.append(
        {
            **call,
            "user_intent": intent(user_text),
            "fallback_file_tools_after_call": dict(
                Counter(tool for tool in later_tools if tool in {"read", "grep", "glob", "bash"})
            ),
            "raw_conversation_retained": False,
        }
    )

latencies = [row["latency_ms"] for row in call_context if row["latency_ms"] is not None]
result = {
    "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "cache_databases": cache_databases,
    "usage": {
        "calls": len(call_context),
        "sessions": len({row["session_id"] for row in call_context}),
        "by_tool": dict(Counter(row["tool"] for row in call_context)),
        "by_status": dict(Counter(str(row["status"]) for row in call_context)),
        "by_output_signal": dict(Counter(row["output_signal"] for row in call_context)),
        "by_user_intent": dict(Counter(row["user_intent"] for row in call_context)),
        "latency_ms": {
            "count": len(latencies),
            "min": min(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
            "mean": round(sum(latencies) / len(latencies), 3) if latencies else None,
        },
        "fallback_file_tool_totals": dict(
            Counter(
                tool
                for row in call_context
                for tool, count in row["fallback_file_tools_after_call"].items()
                for _ in range(count)
            )
        ),
    },
    "calls": call_context,
    "privacy": {"raw_tool_inputs_outputs_retained": False, "raw_conversations_retained": False},
}
CONFIG["output"].write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(result["usage"], indent=2, sort_keys=True))
