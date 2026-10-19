#!/usr/bin/env python3
"""Validate the context/memory qualification research and fixture tooling."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


sys.dont_write_bytecode = True


REPO_ROOT = Path(__file__).resolve().parents[3]
DOC_ROOT = REPO_ROOT / "docs" / "research" / "context" / "qualification"
BENCH_ROOT = REPO_ROOT / "verification" / "benchmarks" / "context"
PLAN = DOC_ROOT / "qualification-plan.json"
PLAN_SCHEMA = BENCH_ROOT / "schemas" / "qualification-plan.schema.json"
CATALOG = BENCH_ROOT / "fixtures" / "scenario-templates.json"
CATALOG_SCHEMA = BENCH_ROOT / "schemas" / "scenario-template.schema.json"
RUN_SCHEMA = BENCH_ROOT / "schemas" / "run-record.schema.json"
CANDIDATES = DOC_ROOT / "candidate-snapshot.json"
MANIFEST = DOC_ROOT / "manifest.json"
GENERATOR = BENCH_ROOT / "generate-scenarios.py"

DIRECTIVE_KINDS = {
    "replace",
    "augment",
    "reprioritize",
    "correct",
    "question",
    "pause",
    "cancel",
    "resume",
}
FOCUS_DISPOSITIONS = {
    "active",
    "suspended",
    "blocked",
    "completed",
    "superseded",
    "cancelled",
    "abandoned",
}
TRANSITION_KINDS = {
    "replan",
    "change_priority",
    "interrupt",
    "resume",
    "supersede",
    "cancel",
    "alert",
}
OBSERVER_PROPOSAL_KINDS = {
    "directive_set_concern",
    "continuation_concern",
    "abandonment_staleness_concern",
    "alignment_concern",
}
OBSERVER_OUTPUT_INVARIANTS = {
    "source_linked",
    "advisory_only",
    "no_effect_authority",
    "no_mutation_authority",
    "no_private_memory_authority",
    "no_direct_peer_channel",
    "no_task_state_change",
}
TERMINAL_FOCUS_DISPOSITIONS = {"completed", "superseded", "cancelled", "abandoned"}
DIRECTIVE_TO_TRANSITION_KINDS = {
    "replan": {"augment", "correct"},
    "change_priority": {"reprioritize"},
    "interrupt": {"pause", "question"},
    "resume": {"pause", "question", "resume"},
    "supersede": {"replace"},
    "cancel": {"cancel"},
    "alert": set(DIRECTIVE_KINDS),
}
TRANSITION_PHASES = {
    "requested",
    "quiescing",
    "reconciling",
    "applied",
    "blocked_unknown_effect",
    "failed",
}
CONTINUITY_STRATEGIES = {
    "no_monitor_negative_control",
    "deterministic_supervisor_only",
    "isolated_model_only_simulator",
    "hybrid_rules_and_small_model_proposal",
}


class ValidationFailure(Exception):
    pass


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationFailure(f"cannot load {path.relative_to(REPO_ROOT)}: {error}") from error


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def schema_validate(instance: Any, schema: dict[str, Any], label: str) -> None:
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(instance), key=lambda item: list(item.path))
    if errors:
        details = []
        for error in errors[:20]:
            location = "/".join(str(item) for item in error.absolute_path) or "<root>"
            details.append(f"{location}: {error.message}")
        raise ValidationFailure(f"{label} schema errors: " + "; ".join(details))


def require_unique(records: list[dict[str, Any]], key: str, label: str) -> None:
    values = [record[key] for record in records]
    if len(values) != len(set(values)):
        raise ValidationFailure(f"duplicate {label} {key}")


def validate_governing_inputs(plan: dict[str, Any]) -> int:
    for item in plan["governing_inputs"]:
        path = REPO_ROOT / item["path"]
        if not path.is_file():
            raise ValidationFailure(f"missing governing input: {item['path']}")
        observed = sha256_file(path)
        if observed != item["sha256"]:
            raise ValidationFailure(
                f"stale governing input hash for {item['path']}: "
                f"declared={item['sha256']} observed={observed}"
            )
    return len(plan["governing_inputs"])


def validate_plan_semantics(plan: dict[str, Any]) -> dict[str, int]:
    strategies = plan["strategies"]
    metrics = plan["metrics"]
    phases = plan["phases"]
    gates = plan["gates"]
    require_unique(strategies, "id", "strategy")
    require_unique(metrics, "id", "metric")
    require_unique(phases, "id", "phase")
    require_unique(gates, "id", "gate")
    orders = sorted(phase["order"] for phase in phases)
    if orders != list(range(1, len(phases) + 1)):
        raise ValidationFailure("phase order is not contiguous")
    gate_orders = sorted(gate["order"] for gate in gates)
    if gate_orders != list(range(1, len(gates) + 1)):
        raise ValidationFailure("gate order is not contiguous")
    if plan["factors"]["agent_counts"] != [0, 1, 2, 3, 4, 5]:
        raise ValidationFailure("agent counts must cover zero through five exactly")
    seeds = plan["repetitions"]["exploratory_seeds"]
    if len(seeds) < 3 or len(set(seeds)) < 3:
        raise ValidationFailure("at least three distinct exploratory seeds are required")
    unsafe = {"s00_full_exact_truncate", "s01_recent_window", "s02_rolling_summary"}
    observed_unsafe = {item["id"] for item in strategies if item.get("negative_control")}
    if not unsafe.issubset(observed_unsafe):
        raise ValidationFailure("required negative controls are not marked")
    incident = plan["incident_learning_contract"]
    if not incident["material_incident_capture_required"]:
        raise ValidationFailure("material incident capture must be required")
    if incident["minimum_distinct_incident_classes"] < 3:
        raise ValidationFailure("incident learning must cover at least three distinct classes")
    required_closure_stages = {
        "deduplicate_and_link",
        "owned_root_cause",
        "permanent_design_correction",
        "deterministic_regression_or_nonreproduction_evidence",
        "independent_recheck",
        "supersession_or_closure_record",
    }
    if set(incident["closure_stages"]) != required_closure_stages:
        raise ValidationFailure("incident learning closure stages are incomplete")
    if incident["author_only_closure_allowed"] or not incident["recurrence_blocks_capability"]:
        raise ValidationFailure("author-only closure or non-blocking recurrence is forbidden")
    memory = plan["automatic_memory_contract"]
    required_hooks = {
        "task_create",
        "task_resume",
        "agent_spawn",
        "agent_handoff",
        "planning",
        "replanning",
        "before_edit",
        "before_retry",
        "before_commit",
        "before_external_effect",
        "after_failure",
        "after_conflict",
        "after_test",
        "after_commit",
        "after_config_change",
        "after_capability_change",
        "context_pressure_change",
    }
    if set(memory["lifecycle_hooks"]) != required_hooks:
        raise ValidationFailure("automatic memory lifecycle-hook contract is incomplete")
    if memory["capture_bypass_allowed"] or not memory["memory_agent_optional"]:
        raise ValidationFailure("capture must be unavoidable while a memory agent remains optional")
    if memory["memory_agent_mutation_authority"]:
        raise ValidationFailure("memory agents cannot have mutation authority")
    if set(memory["proposal_contract"]["admission_checks"]) != {
        "schema",
        "source_support",
        "contradiction",
        "policy",
    }:
        raise ValidationFailure("memory proposal admission checks are incomplete")
    if set(memory["retrieval_modes"]) != {"proactive", "on_demand", "hybrid"}:
        raise ValidationFailure("retrieval-mode comparison is incomplete")
    if set(memory["agent_topologies"]) != {
        "no_memory_agent_direct_query",
        "one_shared_readonly_memory_agent",
        "per_agent_readonly_memory_agents",
    }:
        raise ValidationFailure("memory-agent topology comparison is incomplete")
    if set(memory["sourced_views"]) != {"present", "short", "long"}:
        raise ValidationFailure("present/short/long sourced views are required")
    concurrency = plan["concurrency_contract"]
    if concurrency["broker_count"] != 1:
        raise ValidationFailure("exactly one concurrency broker is required")
    if set(concurrency["resource_set_dimensions"]) != {"physical", "semantic"}:
        raise ValidationFailure("physical and semantic resource sets are required")
    if set(concurrency["parallelism_allowed"]) != {
        "concurrent_reads",
        "proven_disjoint_writes",
    }:
        raise ValidationFailure("safe parallelism contract is incomplete")
    if concurrency["isolated_worktree_bypass_allowed"]:
        raise ValidationFailure("isolated worktrees cannot bypass shared resource fencing")
    steering = plan["steering_continuity_contract"]
    if set(steering["directive_kinds"]) != DIRECTIVE_KINDS:
        raise ValidationFailure("canonical eight-kind steering directive contract is incomplete")
    if set(steering["destructive_directives_require_explicit_authority"]) != {
        "replace",
        "cancel",
    }:
        raise ValidationFailure("replace and cancel must require explicit authority")
    directive_contract = steering["directive_contract"]
    if (
        directive_contract["source_span_unit"] != "utf8_bytes_half_open"
        or directive_contract["interrupt_role"] != "derived_transition_never_directive"
        or directive_contract["replace_role"]
        != "semantic_directive_with_explicit_target_scope"
        or directive_contract["target_binding"]
        != "exactly_one_resolved_typed_target_with_prior_resolution_event"
        or directive_contract["span_partition"]
        != "admitted_and_unresolved_utf8_spans_are_pairwise_disjoint"
        or directive_contract["causal_binding"]
        != "transition_steps_reference_individual_directive_ids_and_prior_causal_events"
    ):
        raise ValidationFailure("directive source binding or semantic separation is incomplete")
    if set(steering["focus_dispositions"]) != FOCUS_DISPOSITIONS:
        raise ValidationFailure("focus disposition contract is incomplete")
    if set(steering["transition_kinds"]) != TRANSITION_KINDS:
        raise ValidationFailure("continuity transition-kind contract is incomplete")
    if set(steering["transition_phases"]) != TRANSITION_PHASES:
        raise ValidationFailure("continuity transition-phase contract is incomplete")
    if steering["transition_operation"] != (
        "one_operation_id_monotonic_phase_ordinals_and_centrally_legal_paths"
    ):
        raise ValidationFailure("continuity operation identity/path contract is incomplete")
    if steering["focus_disposition_cas"] != (
        "prior_causal_event_operation_and_revision_bound_no_terminal_resurrection"
    ):
        raise ValidationFailure("focus disposition causal/CAS contract is incomplete")
    if steering["foreground_focus_count"] != 1:
        raise ValidationFailure("exactly one foreground focus is required")
    required_suspended_fields = {
        "task_id",
        "subtask_id",
        "attempt_id",
        "focus_id",
        "priority",
        "suspension_sequence",
        "checkpoint_event_id",
        "progress",
        "next_safe_action",
        "constraint_revision",
        "requirements_hash",
        "plan_hash",
        "config_hash",
        "policy_hash",
        "architecture_hash",
        "test_method_hash",
        "test_inventory_hash",
        "repository_base",
        "lease_disposition",
        "resource_set_revision",
        "completed_effect_receipts",
        "dependency_revision",
        "capability_epoch",
        "suspension_cause",
        "validity",
        "terminal_disposition",
        "disposition_revision",
    }
    if set(steering["suspended_work_fields"]) != required_suspended_fields:
        raise ValidationFailure("suspended-work checkpoint fields are incomplete")
    supervisor = steering["continuity_supervisor"]
    if not supervisor["core_projector"] or supervisor["duplicate_authorities_allowed"]:
        raise ValidationFailure("continuity must be one deterministic core projector")
    if supervisor["source"] != "canonical_event_ledger":
        raise ValidationFailure("continuity supervisor must consume the canonical ledger")
    observers = steering["observer_profiles"]
    if not observers["optional"] or not observers["read_only"] or observers["effect_authority"]:
        raise ValidationFailure("continuity observers must be optional read-only and effect-free")
    if set(observers["allowed_inputs"]) != {
        "sanitized_user_message",
        "sanitized_agent_message",
        "task_status",
        "subtask_status",
        "agent_status",
        "bounded_tool_summary",
    }:
        raise ValidationFailure("observer sanitized-input allowlist is incomplete")
    if set(observers["forbidden_inputs"]) != {
        "chain_of_thought",
        "raw_secret",
        "unrestricted_transcript",
        "raw_tool_payload",
        "ambient_repository",
        "broker_handle",
        "effect_port",
    }:
        raise ValidationFailure("observer forbidden-input set is incomplete")
    if set(observers["strategies"]) != CONTINUITY_STRATEGIES:
        raise ValidationFailure("continuity strategy comparison is incomplete")
    if observers["strategy_enforcement_eligibility"] != {
        "no_monitor_negative_control": False,
        "deterministic_supervisor_only": True,
        "isolated_model_only_simulator": False,
        "hybrid_rules_and_small_model_proposal": True,
    }:
        raise ValidationFailure("continuity strategy enforcement eligibility is unsafe")
    if set(observers["proposal_kinds"]) != OBSERVER_PROPOSAL_KINDS:
        raise ValidationFailure("observer proposal-kind contract is incomplete")
    if set(observers["output_invariants"]) != OBSERVER_OUTPUT_INVARIANTS:
        raise ValidationFailure("observer output-authority invariants are incomplete")
    required_delivery = {
        "privacy_filter_before_delivery",
        "bounded_backpressure",
        "stable_event_id_deduplication",
        "durable_replay_offset",
        "crash_recovery",
        "false_alert_accounting",
        "no_silent_steering_drop",
    }
    if set(observers["delivery_controls"]) != required_delivery:
        raise ValidationFailure("observer delivery/replay controls are incomplete")
    language = plan["runtime_language_contract"]
    if (
        language["product_core_language"] != "typescript"
        or language["product_core_runtime"] != "node"
        or language["production_and_canonical_runner"] != "node_only"
        or language["node_lts_major"] != 24
    ):
        raise ValidationFailure("TypeScript/Node 24 must be the sole core and canonical runner")
    if language["python_product_core_dependency_allowed"]:
        raise ValidationFailure("Python cannot be a product/core dependency")
    oracle = language["independent_python_oracle"]
    if not (
        oracle["optional"]
        and oracle["read_only"]
        and oracle["test_only"]
        and oracle["independently_implemented"]
    ):
        raise ValidationFailure("independent Python oracle boundary is incomplete")
    if oracle["may_import_call_or_share_production_predicate"]:
        raise ValidationFailure("independent oracle cannot share the production predicate")
    if oracle["disagreement"] != "fail_closed":
        raise ValidationFailure("oracle disagreement must fail closed")
    if language["rewrite_existing_python_now"]:
        raise ValidationFailure("existing Python research evidence must not be rewritten now")
    runtime_inputs = {
        item["path"]
        for item in plan["governing_inputs"]
        if item["relationship"] == "runtime_language_policy_input"
    }
    if runtime_inputs != {"src/root-policy.ts", "package.json"}:
        raise ValidationFailure("root policy and package engine must both be bound")
    coord_input = [
        item
        for item in plan["governing_inputs"]
        if item["relationship"] == "incident_regression_input"
    ]
    if len(coord_input) != 1 or coord_input[0]["path"] != (
        "traceability/findings/COORD-001-concurrent-research-layout-move.md"
    ):
        raise ValidationFailure("COORD-001 must be bound as the incident regression input")
    return {
        "governing_inputs": validate_governing_inputs(plan),
        "strategies": len(strategies),
        "metrics": len(metrics),
        "phases": len(phases),
        "gates": len(gates),
        "automatic_memory_hooks": len(memory["lifecycle_hooks"]),
        "memory_agent_topologies": len(memory["agent_topologies"]),
        "broker_resource_dimensions": len(concurrency["resource_set_dimensions"]),
        "incident_classes_minimum": incident["minimum_distinct_incident_classes"],
        "steering_directive_kinds": len(steering["directive_kinds"]),
        "focus_dispositions": len(steering["focus_dispositions"]),
        "continuity_transition_kinds": len(steering["transition_kinds"]),
        "continuity_transition_phases": len(steering["transition_phases"]),
        "continuity_strategies": len(observers["strategies"]),
        "observer_allowed_inputs": len(observers["allowed_inputs"]),
        "runtime_language_inputs": len(runtime_inputs),
    }


def validate_source_span(
    span: dict[str, Any], message_bytes: bytes, label: str
) -> tuple[int, int]:
    start = span["start_byte"]
    end = span["end_byte"]
    if start >= end or end > len(message_bytes):
        raise ValidationFailure(f"invalid UTF-8 source span bounds: {label}")
    try:
        selected = message_bytes[start:end]
        selected.decode("utf-8")
        message_bytes[:start].decode("utf-8")
        message_bytes[:end].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValidationFailure(f"source span splits a UTF-8 code point: {label}") from error
    if hashlib.sha256(selected).hexdigest() != span["span_sha256"]:
        raise ValidationFailure(f"source span digest mismatch: {label}")
    return start, end


def validate_directive_set(
    directive_set: dict[str, Any], label: str
) -> tuple[set[str], bool]:
    message_bytes = directive_set["source_message_utf8"].encode("utf-8")
    if len(message_bytes) != directive_set["source_message_utf8_bytes"]:
        raise ValidationFailure(f"source message byte length mismatch: {label}")
    if hashlib.sha256(message_bytes).hexdigest() != directive_set["source_message_sha256"]:
        raise ValidationFailure(f"source message digest mismatch: {label}")
    directives = directive_set["directives"]
    if [item["ordinal"] for item in directives] != list(range(len(directives))):
        raise ValidationFailure(f"directive ordinals are not contiguous and ordered: {label}")
    observed: set[str] = set()
    prior_directive_end = -1
    occupied_spans: list[tuple[int, int, str]] = []
    for directive in directives:
        kind = directive["kind"]
        if kind not in DIRECTIVE_KINDS:
            raise ValidationFailure(f"unknown directive kind: {label}/{kind}")
        observed.add(kind)
        spans = [
            validate_source_span(
                span,
                message_bytes,
                f"{label}/directive-{directive['ordinal']}",
            )
            for span in directive["source_spans"]
        ]
        if spans != sorted(spans) or any(
            current[0] < previous[1] for previous, current in zip(spans, spans[1:])
        ):
            raise ValidationFailure(f"directive spans overlap or are unordered: {label}")
        if spans[0][0] < prior_directive_end:
            raise ValidationFailure(f"directives are not ordered by source span: {label}")
        prior_directive_end = spans[-1][1]
        occupied_spans.extend(
            (start, end, f"directive-{directive['ordinal']}")
            for start, end in spans
        )
    unresolved = [
        validate_source_span(span, message_bytes, f"{label}/unresolved")
        for span in directive_set["unresolved_spans"]
    ]
    if unresolved != sorted(unresolved) or any(
        current[0] < previous[1]
        for previous, current in zip(unresolved, unresolved[1:])
    ):
        raise ValidationFailure(f"unresolved source spans overlap or are unordered: {label}")
    occupied_spans.extend(
        (start, end, "unresolved") for start, end in unresolved
    )
    ordered_occupied = sorted(occupied_spans)
    if any(
        current[0] < previous[1]
        for previous, current in zip(ordered_occupied, ordered_occupied[1:])
    ):
        raise ValidationFailure(
            f"admitted and unresolved source spans overlap: {label}"
        )
    return observed, len(directives) > 1


def expected_generated_directive_id(
    directive_set: dict[str, Any], directive: dict[str, Any]
) -> str:
    parts = (
        "directive",
        directive_set["source_message_id"],
        directive_set["source_message_sha256"],
        directive["ordinal"],
        directive["kind"],
        json.dumps(
            directive["source_spans"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        json.dumps(
            directive["target"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        json.dumps(
            directive.get("arguments", {}),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
    )
    digest = hashlib.sha256("\x1f".join(str(item) for item in parts).encode("utf-8")).hexdigest()
    return f"dir_{digest[:32]}"


def is_causal_ancestor(
    candidate: str,
    descendant: str,
    parent_map: dict[str, tuple[str, ...]],
) -> bool:
    pending = list(parent_map.get(descendant, ()))
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current == candidate:
            return True
        if current in visited:
            continue
        visited.add(current)
        pending.extend(parent_map.get(current, ()))
    return False


def validate_resolved_target(
    target: dict[str, Any],
    *,
    event_symbol: str,
    event_index: int,
    event_by_symbol: dict[str, dict[str, Any]],
    event_index_by_symbol: dict[str, int],
    parent_map: dict[str, tuple[str, ...]],
    label: str,
) -> None:
    resolution = target["resolution_event_symbol"]
    if resolution not in event_by_symbol or event_index_by_symbol[resolution] >= event_index:
        raise ValidationFailure(f"target resolution is missing or not prior: {label}")
    if not is_causal_ancestor(resolution, event_symbol, parent_map):
        raise ValidationFailure(f"target resolution is not a causal ancestor: {label}")
    source = event_by_symbol[resolution]
    if target["scope_kind"] == "focus":
        if source["type"] != "focus.created" or source["payload"].get("focus_id") != target["scope_id"]:
            raise ValidationFailure(f"focus target resolution is not a matching create event: {label}")
    elif (
        source["payload"].get("resolved_scope_kind") != target["scope_kind"]
        or source["payload"].get("resolved_scope_id") != target["scope_id"]
    ):
        raise ValidationFailure(f"non-focus target resolution does not match: {label}")


def legal_operation_phases(kind: str, requires_quiescence: bool) -> set[tuple[str, ...]]:
    if kind == "alert":
        return {("applied",)} if not requires_quiescence else set()
    if kind in {"replan", "change_priority"}:
        if requires_quiescence:
            return set()
        return {("requested", "applied"), ("requested", "failed")}
    if kind == "resume":
        if requires_quiescence:
            return set()
        return {
            ("requested", "reconciling", "applied"),
            ("requested", "reconciling", "blocked_unknown_effect"),
            ("requested", "reconciling", "failed"),
            ("requested", "failed"),
        }
    if kind in {"interrupt", "supersede", "cancel"}:
        if requires_quiescence:
            return {
                ("requested", "quiescing", "reconciling", "applied"),
                ("requested", "quiescing", "reconciling", "blocked_unknown_effect"),
                ("requested", "quiescing", "reconciling", "failed"),
            }
        return {("requested", "applied"), ("requested", "failed")}
    return set()


def validate_template_relations(
    template: dict[str, Any],
) -> tuple[set[str], set[str], set[str], set[str], int]:
    events = template["events"]
    symbols = [event["symbol"] for event in events]
    event_by_symbol = {event["symbol"]: event for event in events}
    event_index_by_symbol = {symbol: index for index, symbol in enumerate(symbols)}
    parent_map = {
        event["symbol"]: tuple(event.get("causal_parent_symbols", []))
        for event in events
    }
    if [event["at"] for event in events] != sorted(event["at"] for event in events):
        raise ValidationFailure(f"event declarations are not in logical-time order: {template['id']}")
    directive_by_reference: dict[tuple[str, int], dict[str, Any]] = {}
    observed_directive_kinds: set[str] = set()
    observed_dispositions: set[str] = set()
    observed_transition_kinds: set[str] = set()
    observed_transition_phases: set[str] = set()
    blocked_unknown_effects = 0

    for event_index, event in enumerate(events):
        symbol = event["symbol"]
        for parent in parent_map[symbol]:
            if parent not in event_by_symbol:
                raise ValidationFailure(f"unknown causal parent {parent} in {template['id']}")
            if event_index_by_symbol[parent] >= event_index:
                raise ValidationFailure(f"causal parent is not earlier: {template['id']}:{parent}")
        if event["type"] != "steering.directives_admitted":
            continue
        directive_set = event["directive_set"]
        for directive in directive_set["directives"]:
            reference = (symbol, directive["ordinal"])
            directive_by_reference[reference] = directive
            observed_directive_kinds.add(directive["kind"])
            validate_resolved_target(
                directive["target"],
                event_symbol=symbol,
                event_index=event_index,
                event_by_symbol=event_by_symbol,
                event_index_by_symbol=event_index_by_symbol,
                parent_map=parent_map,
                label=f"{template['id']}:{symbol}:directive-{directive['ordinal']}",
            )
            if directive["kind"] not in {"replace", "cancel"}:
                continue
            authorization = directive["arguments"]["authorization_event_symbol"]
            if authorization not in event_by_symbol or event_index_by_symbol[authorization] >= event_index:
                raise ValidationFailure(f"destructive authorization is missing or not prior: {template['id']}:{symbol}")
            authorization_event = event_by_symbol[authorization]
            if (
                authorization_event["type"] != "steering.authorization_granted"
                or authorization_event["actor"] != "policy"
                or authorization_event["payload"].get("directive_kind") != directive["kind"]
                or authorization_event["payload"].get("target") != directive["target"]
                or not is_causal_ancestor(authorization, symbol, parent_map)
            ):
                raise ValidationFailure(f"destructive authorization evidence does not bind directive: {template['id']}:{symbol}")

    operations: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    transition_event_by_symbol: dict[str, dict[str, Any]] = {}
    for event_index, event in enumerate(events):
        if event["type"] != "continuity.transition":
            continue
        transition = event["continuity_transition"]
        operation_id = transition["operation_id"]
        operations.setdefault(operation_id, []).append((event_index, event))
        transition_event_by_symbol[event["symbol"]] = transition
        observed_transition_kinds.add(transition["kind"])
        observed_transition_phases.add(transition["phase"])
        validate_resolved_target(
            transition["target"],
            event_symbol=event["symbol"],
            event_index=event_index,
            event_by_symbol=event_by_symbol,
            event_index_by_symbol=event_index_by_symbol,
            parent_map=parent_map,
            label=f"{template['id']}:{event['symbol']}:transition-target",
        )
        resolved_kinds: set[str] = set()
        for reference in transition["source_directive_refs"]:
            key = (reference["directive_set_symbol"], reference["ordinal"])
            directive = directive_by_reference.get(key)
            if directive is None:
                raise ValidationFailure(f"transition directive reference does not resolve: {template['id']}:{event['symbol']}")
            source_symbol = reference["directive_set_symbol"]
            if event_index_by_symbol[source_symbol] >= event_index or not is_causal_ancestor(
                source_symbol, event["symbol"], parent_map
            ):
                raise ValidationFailure(f"transition directive source is not prior causal evidence: {template['id']}:{event['symbol']}")
            if directive["target"] != transition["target"]:
                raise ValidationFailure(f"transition target does not match its directive cause: {template['id']}:{event['symbol']}")
            resolved_kinds.add(directive["kind"])
        if transition["kind"] != "alert" and not resolved_kinds:
            raise ValidationFailure(f"non-alert transition has no individual directive cause: {template['id']}:{event['symbol']}")
        if not resolved_kinds.issubset(DIRECTIVE_TO_TRANSITION_KINDS[transition["kind"]]):
            raise ValidationFailure(f"directive kind cannot cause transition kind: {template['id']}:{event['symbol']}")
        if transition["phase"] == "blocked_unknown_effect":
            if not transition["unknown_effect"]:
                raise ValidationFailure(f"blocked unknown effect lacks evidence: {template['id']}:{event['symbol']}")
            blocked_unknown_effects += 1
        if transition["phase"] == "applied" and transition["unknown_effect"]:
            raise ValidationFailure(f"applied transition cannot retain an unknown effect: {template['id']}:{event['symbol']}")
        if transition["unknown_effect"] and transition["phase"] not in {
            "reconciling", "blocked_unknown_effect", "failed"
        }:
            raise ValidationFailure(f"unknown effect appears in an illegal phase: {template['id']}:{event['symbol']}")

    for operation_id, records in operations.items():
        transitions = [event["continuity_transition"] for _, event in records]
        first = transitions[0]
        invariant_fields = ("kind", "target", "requires_quiescence", "source_directive_refs")
        for transition in transitions[1:]:
            if any(transition[field] != first[field] for field in invariant_fields):
                raise ValidationFailure(f"operation identity changed across phases: {template['id']}:{operation_id}")
        if [item["phase_ordinal"] for item in transitions] != list(range(len(transitions))):
            raise ValidationFailure(f"operation phase ordinals are not contiguous: {template['id']}:{operation_id}")
        phases = tuple(item["phase"] for item in transitions)
        if phases not in legal_operation_phases(first["kind"], first["requires_quiescence"]):
            raise ValidationFailure(f"illegal continuity operation phase path: {template['id']}:{operation_id}:{phases}")
        for (_, previous_event), (_, current_event) in zip(records, records[1:]):
            if previous_event["symbol"] not in current_event.get("causal_parent_symbols", []):
                raise ValidationFailure(f"operation phase does not causally follow prior phase: {template['id']}:{operation_id}")

    created_focus_symbols: dict[str, str] = {}
    focus_revisions: dict[str, int] = {}
    terminal_focuses: set[str] = set()
    for event_index, event in enumerate(events):
        if event["type"] == "focus.created":
            focus_id = event["payload"].get("focus_id")
            if not isinstance(focus_id, str) or focus_id in created_focus_symbols:
                raise ValidationFailure(f"focus creation is missing or duplicated: {template['id']}:{event['symbol']}")
            created_focus_symbols[focus_id] = event["symbol"]
        if event["type"] != "focus.disposition_recorded":
            continue
        disposition = event["focus_disposition"]
        focus_id = disposition["focus_id"]
        if focus_id not in created_focus_symbols or event_index_by_symbol[created_focus_symbols[focus_id]] >= event_index:
            raise ValidationFailure(f"focus disposition lacks a prior create event: {template['id']}:{event['symbol']}")
        source_symbol = disposition["source_event_symbol"]
        if source_symbol not in event_by_symbol or event_index_by_symbol[source_symbol] >= event_index:
            raise ValidationFailure(f"focus disposition source is missing or future: {template['id']}:{event['symbol']}")
        if not is_causal_ancestor(source_symbol, event["symbol"], parent_map):
            raise ValidationFailure(f"focus disposition source is not causal: {template['id']}:{event['symbol']}")
        prior_revision = focus_revisions.get(focus_id, 0)
        if disposition["expected_prior_revision"] != prior_revision or disposition["revision"] != prior_revision + 1:
            raise ValidationFailure(f"focus disposition CAS revision is invalid: {template['id']}:{event['symbol']}")
        if focus_id in terminal_focuses:
            raise ValidationFailure(f"terminal focus was resurrected: {template['id']}:{event['symbol']}")
        source_event = event_by_symbol[source_symbol]
        source_transition = transition_event_by_symbol.get(source_symbol)
        causal_operation_id = disposition["causal_operation_id"]
        state = disposition["disposition"]
        if source_transition is not None:
            if causal_operation_id != source_transition["operation_id"]:
                raise ValidationFailure(f"focus disposition operation linkage is invalid: {template['id']}:{event['symbol']}")
            if source_transition["target"] != {
                "scope_kind": "focus",
                "scope_id": focus_id,
                "resolution_event_symbol": created_focus_symbols[focus_id],
            }:
                raise ValidationFailure(f"focus disposition transition targets another focus: {template['id']}:{event['symbol']}")
            allowed_transition_causes = {
                "active": ("resume", "applied"),
                "suspended": ("interrupt", "applied"),
                "blocked": (source_transition["kind"], "blocked_unknown_effect"),
                "superseded": ("supersede", "applied"),
                "cancelled": ("cancel", "applied"),
            }
            if state not in allowed_transition_causes or (
                source_transition["kind"], source_transition["phase"]
            ) != allowed_transition_causes[state]:
                raise ValidationFailure(f"focus disposition is premature or incompatible: {template['id']}:{event['symbol']}")
        else:
            if causal_operation_id is not None:
                raise ValidationFailure(f"non-transition disposition has an operation ID: {template['id']}:{event['symbol']}")
            allowed_nontransition = (
                state == "active"
                and source_event["type"] == "focus.created"
                and source_event["payload"].get("focus_id") == focus_id
                and prior_revision == 0
            ) or (
                state == "completed"
                and source_event["type"] == "focus.disposition_recorded"
                and source_event["focus_disposition"]["focus_id"] == focus_id
                and source_event["focus_disposition"]["disposition"] == "active"
            ) or (
                state == "abandoned"
                and source_event["type"] == "focus.abandonment_authorized"
                and source_event["actor"] == "policy"
                and source_event["payload"].get("focus_id") == focus_id
            )
            if not allowed_nontransition:
                raise ValidationFailure(f"focus disposition has an illegal non-transition cause: {template['id']}:{event['symbol']}")
        focus_revisions[focus_id] = disposition["revision"]
        observed_dispositions.add(state)
        if state in TERMINAL_FOCUS_DISPOSITIONS:
            terminal_focuses.add(focus_id)

    observer_output_ids: set[str] = set()
    for event_index, event in enumerate(events):
        if event["type"] not in {"observer.proposal", "observer.alert_batch"}:
            continue
        output = event["observer_output"]
        if output["output_id"] in observer_output_ids:
            raise ValidationFailure(f"duplicate observer output ID: {template['id']}:{output['output_id']}")
        observer_output_ids.add(output["output_id"])
        if output["kind"] not in OBSERVER_PROPOSAL_KINDS:
            raise ValidationFailure(f"unknown observer output kind: {template['id']}:{event['symbol']}")
        if output["profile_id"] not in {
            "isolated_model_only_simulator",
            "hybrid_rules_and_small_model_proposal",
        }:
            raise ValidationFailure(f"observer output uses an ineligible profile: {template['id']}:{event['symbol']}")
        if event["type"] == "observer.alert_batch" and "alert_count" not in output:
            raise ValidationFailure(f"observer alert batch lacks a count: {template['id']}:{event['symbol']}")
        if event["type"] == "observer.proposal" and "alert_count" in output:
            raise ValidationFailure(f"observer proposal carries an alert count: {template['id']}:{event['symbol']}")
        for source_symbol in output["source_event_symbols"]:
            if source_symbol not in event_by_symbol or event_index_by_symbol[source_symbol] >= event_index:
                raise ValidationFailure(f"observer output source is missing or future: {template['id']}:{event['symbol']}")
            if not is_causal_ancestor(source_symbol, event["symbol"], parent_map):
                raise ValidationFailure(f"observer output source is not causal: {template['id']}:{event['symbol']}")
    return (
        observed_directive_kinds,
        observed_dispositions,
        observed_transition_kinds,
        observed_transition_phases,
        blocked_unknown_effects,
    )


def validate_catalog_semantics(
    catalog: dict[str, Any], metric_ids: set[str]
) -> dict[str, int]:
    templates = catalog["templates"]
    require_unique(templates, "id", "template")
    required_tags = {
        "protected_requirement",
        "contradiction",
        "supersession",
        "negation",
        "context_pressure",
        "sudden_budget_reduction",
        "failed_attempt",
        "repository_change",
        "stale_code",
        "multi_hop",
        "agent_conflict",
        "write_conflict",
        "delayed_event",
        "duplicate_event",
        "crash",
        "recovery",
        "summary_drift",
        "malicious_memory",
        "authority_spoof",
        "lexical_dense",
        "index_corruption",
        "rebuild",
        "missing_runtime",
        "low_complexity",
        "capability_epoch",
        "activation_rollback",
        "evidence_lineage",
        "declared_omission",
        "automatic_capture",
        "capture_hook",
        "change_trigger",
        "risk_trigger",
        "novelty_trigger",
        "proactive_injection",
        "on_demand_retrieval",
        "hybrid_retrieval",
        "memory_agent_topology",
        "memory_agent_proposal",
        "present_view",
        "short_view",
        "long_view",
        "past_conversation_query",
        "git_query",
        "action_query",
        "attempt_query",
        "privacy",
        "restart",
        "physical_resource_set",
        "semantic_resource_set",
        "concurrent_read",
        "disjoint_write",
        "lease_ttl",
        "heartbeat",
        "fencing",
        "deadlock",
        "orphan_recovery",
        "cas_drift",
        "isolated_worktree",
        "out_of_band_change",
        "coord001_regression",
        "incident_learning",
        "permanent_regression",
        "finding_deduplication",
        "steering",
        "replace",
        "augment",
        "reprioritize",
        "correct",
        "question",
        "pause",
        "cancel",
        "resume",
        "compound_directive",
        "source_span",
        "focus_disposition",
        "transition_phase",
        "interrupt_transition",
        "quiescing",
        "unknown_effect",
        "focus_stack",
        "automatic_resume",
        "abandonment",
        "nested_interrupt_transition",
        "causal_constraint_merge",
        "continuity_supervisor",
        "observer_absent",
        "observer_wrong",
        "observer_noisy",
        "observer_sanitization",
        "observer_subscription",
        "observer_backpressure",
        "observer_replay",
        "agent_interleaving",
        "compaction_continuity",
        "node_runtime",
        "python_boundary",
        "independent_oracle",
        "engine_drift",
    }
    observed_tags: set[str] = set()
    observed_agent_counts: set[int] = set()
    observed_directive_kinds: set[str] = set()
    observed_focus_dispositions: set[str] = set()
    observed_transition_kinds: set[str] = set()
    observed_transition_phases: set[str] = set()
    observed_source_message_ids: set[str] = set()
    compound_directive_sets = 0
    blocked_unknown_effect_transitions = 0
    contract_horizons = set(catalog["generator_contract"]["horizons"])
    query_count = 0
    for template in templates:
        observed_tags.update(template["tags"])
        observed_agent_counts.update(template["allowed_agent_counts"])
        if template["default_agent_count"] not in template["allowed_agent_counts"]:
            raise ValidationFailure(f"default agent count not allowed: {template['id']}")
        if not set(template["required_horizons"]).issubset(contract_horizons):
            raise ValidationFailure(f"unknown required horizon: {template['id']}")
        symbols = [event["symbol"] for event in template["events"]]
        if len(symbols) != len(set(symbols)):
            raise ValidationFailure(f"duplicate event symbol: {template['id']}")
        symbol_set = set(symbols)
        max_agents = max(template["allowed_agent_counts"])
        (
            relational_directive_kinds,
            relational_dispositions,
            relational_transition_kinds,
            relational_transition_phases,
            relational_blocked_unknown_effects,
        ) = validate_template_relations(template)
        observed_directive_kinds.update(relational_directive_kinds)
        observed_focus_dispositions.update(relational_dispositions)
        observed_transition_kinds.update(relational_transition_kinds)
        observed_transition_phases.update(relational_transition_phases)
        blocked_unknown_effect_transitions += relational_blocked_unknown_effects
        for event_index, event in enumerate(template["events"]):
            slot = event["agent_slot"]
            if slot is not None and max_agents > 0 and slot >= max_agents:
                raise ValidationFailure(
                    f"agent slot {slot} is impossible for {template['id']}"
                )
            if event["type"] == "steering.directives_admitted":
                source_message_id = event["directive_set"]["source_message_id"]
                if source_message_id in observed_source_message_ids:
                    raise ValidationFailure(
                        f"duplicate directive source message ID: {source_message_id}"
                    )
                observed_source_message_ids.add(source_message_id)
                kinds, compound = validate_directive_set(
                    event["directive_set"], f"{template['id']}:{event['symbol']}"
                )
                observed_directive_kinds.update(kinds)
                compound_directive_sets += int(compound)
            for superseded in event.get("fact", {}).get("supersedes_symbols", []):
                if superseded not in symbol_set:
                    raise ValidationFailure(
                        f"unknown superseded symbol {superseded} in {template['id']}"
                    )
        query_ids = [query["id"] for query in template["queries"]]
        if len(query_ids) != len(set(query_ids)):
            raise ValidationFailure(f"duplicate query id in {template['id']}")
        query_count += len(query_ids)
        for query in template["queries"]:
            unknown_metrics = set(query["metrics"]) - metric_ids
            if unknown_metrics:
                raise ValidationFailure(
                    f"unknown metrics in {template['id']}:{query['id']}: "
                    f"{sorted(unknown_metrics)}"
                )
            refs = set(query["oracle"]["must_use_symbols"]) | set(
                query["oracle"]["must_not_use_symbols"]
            )
            unknown = refs - symbol_set
            if unknown:
                raise ValidationFailure(
                    f"unknown oracle symbols in {template['id']}:{query['id']}: {sorted(unknown)}"
                )
    missing_tags = required_tags - observed_tags
    if missing_tags:
        raise ValidationFailure(f"missing adversarial tag coverage: {sorted(missing_tags)}")
    if observed_agent_counts != set(range(6)):
        raise ValidationFailure(
            f"fixture agent-count coverage is {sorted(observed_agent_counts)}, expected 0..5"
        )
    if observed_directive_kinds != DIRECTIVE_KINDS:
        raise ValidationFailure(
            f"fixture directive-kind coverage is incomplete: {sorted(DIRECTIVE_KINDS - observed_directive_kinds)}"
        )
    if compound_directive_sets < 1:
        raise ValidationFailure("fixture catalog lacks a compound ordered directive set")
    if observed_focus_dispositions != FOCUS_DISPOSITIONS:
        raise ValidationFailure(
            f"fixture focus-disposition coverage is incomplete: {sorted(FOCUS_DISPOSITIONS - observed_focus_dispositions)}"
        )
    if observed_transition_kinds != TRANSITION_KINDS:
        raise ValidationFailure(
            f"fixture continuity transition-kind coverage is incomplete: {sorted(TRANSITION_KINDS - observed_transition_kinds)}"
        )
    if observed_transition_phases != TRANSITION_PHASES:
        raise ValidationFailure("fixture continuity transition-phase coverage is incomplete")
    if blocked_unknown_effect_transitions < 1:
        raise ValidationFailure("fixture catalog lacks blocked-unknown-effect continuity evidence")
    extension = next(
        item for item in templates if item["id"] == "extension_manifest_activation_rollback"
    )
    behaviors = set(extension["queries"][0]["oracle"]["required_behaviors"])
    needed = {
        "deny_stale_capability_handle",
        "invalidate_capability_projection",
        "invalidate_context_projection",
        "replay_old_run_with_original_epoch",
    }
    if not needed.issubset(behaviors):
        raise ValidationFailure("extension evolution fixture lacks stale-handle/projection/replay checks")
    required_usr047_templates = {
        "automatic_capture_lifecycle_hooks",
        "memory_history_views_and_queries",
        "proactive_on_demand_hybrid_triggering",
        "memory_agent_topology_readonly_proposal",
        "privacy_scope_memory_denial",
        "context_pressure_restart_view_rebuild",
        "broker_physical_parallelism",
        "broker_semantic_conflict_different_files",
        "lease_ttl_heartbeat_fencing",
        "deadlock_and_orphan_recovery",
        "cas_drift_worktree_out_of_band",
        "coord001_descendant_move_regression",
        "incident_learning_three_class_loop",
    }
    template_ids = {item["id"] for item in templates}
    missing_usr047 = required_usr047_templates - template_ids
    if missing_usr047:
        raise ValidationFailure(f"missing USR-047 fixtures: {sorted(missing_usr047)}")
    capture = next(item for item in templates if item["id"] == "automatic_capture_lifecycle_hooks")
    capture_behaviors = set(capture["queries"][0]["oracle"]["required_behaviors"])
    if not {
        "capture_all_registered_hooks",
        "emit_immutable_events",
        "produce_byte_deterministic_capture",
        "deny_capture_bypass",
    }.issubset(capture_behaviors):
        raise ValidationFailure("automatic capture fixture lacks deterministic immutable checks")
    topology = next(
        item for item in templates if item["id"] == "memory_agent_topology_readonly_proposal"
    )
    topology_behaviors = set(topology["queries"][0]["oracle"]["required_behaviors"])
    if not {
        "produce_canonical_topology_equivalence",
        "keep_proposals_unverified_until_checks",
        "deny_memory_agent_mutation",
    }.issubset(topology_behaviors):
        raise ValidationFailure("memory-agent topology fixture lacks read-only proposal checks")
    coord001 = next(
        item for item in templates if item["id"] == "coord001_descendant_move_regression"
    )
    coord_oracle = coord001["queries"][0]["oracle"]
    if coord_oracle["expected_state"] != {
        "move_allowed": False,
        "regression_id": "agent-write-set-descendant-lease-and-stale-signal-mutation-x3",
        "minimum_repeats": 3,
    }:
        raise ValidationFailure("COORD-001 regression identity or x3 requirement changed")
    if not {
        "normalize_descendant_write_set",
        "deny_overlapping_layout_move",
        "ignore_stale_conversational_safety_signal",
        "deny_direct_tool_bypass",
        "run_regression_three_repeats",
    }.issubset(set(coord_oracle["required_behaviors"])):
        raise ValidationFailure("COORD-001 fixture lacks required broker regression checks")
    incident_loop = next(
        item for item in templates if item["id"] == "incident_learning_three_class_loop"
    )
    incident_behaviors = set(incident_loop["queries"][0]["oracle"]["required_behaviors"])
    if not {
        "capture_three_incident_classes",
        "deduplicate_and_link_finding",
        "require_owned_root_cause",
        "retain_permanent_regressions",
        "deny_author_only_closure",
        "require_independent_recheck",
    }.issubset(incident_behaviors):
        raise ValidationFailure("incident learning fixture lacks DER-031 closure checks")
    recurrence = incident_loop["queries"][1]["oracle"]
    if recurrence["expected_state"] != {
        "closure_state": "recurred_blocking",
        "capability_blocked": True,
    }:
        raise ValidationFailure("incident recurrence must reopen and block")
    required_usr048_templates = {
        "displaced_task_missing_resume_alert",
        "steering_eight_directives_source_spans",
        "nested_interrupts_agent_interleaving",
        "observer_absent_wrong_noisy",
        "observer_sanitized_subscription_backpressure",
        "focus_stack_compaction_rebuild",
        "continuity_supervisor_crash_restart",
        "quiesce_unknown_effect_blocks_resume",
        "node_python_runtime_boundary_drift",
    }
    missing_usr048 = required_usr048_templates - template_ids
    if missing_usr048:
        raise ValidationFailure(f"missing USR-048 fixtures: {sorted(missing_usr048)}")
    required_fixture_behaviors = {
        "displaced_task_missing_resume_alert": {
            "preserve_displaced_checkpoint",
            "detect_missing_resume",
            "emit_visible_abandonment_alert",
            "resume_or_leave_explicitly_blocked",
        },
        "steering_eight_directives_source_spans": {
            "admit_canonical_eight_directive_kinds",
            "preserve_compound_source_order",
            "verify_utf8_message_and_span_digests",
            "keep_directives_dispositions_transitions_and_phases_separate",
            "derive_interrupt_transition_from_pause",
            "make_replace_supersede_only_explicit_target",
            "make_cancel_terminal",
        },
        "nested_interrupts_agent_interleaving": {
            "deduplicate_nested_interrupt_transition",
            "preserve_ordered_source_spanned_directives",
            "preserve_all_checkpoints",
            "resume_highest_priority_valid_focus",
            "revalidate_before_each_resume",
            "restore_outer_next_safe_action",
        },
        "observer_absent_wrong_noisy": {
            "continue_without_optional_observer",
            "reject_wrong_observer_proposal",
            "keep_model_only_simulator_ineligible_for_enforcement",
            "keep_alignment_concern_advisory",
            "measure_false_alerts",
            "preserve_deterministic_task_state",
        },
        "observer_sanitized_subscription_backpressure": {
            "filter_privacy_before_delivery",
            "emit_typed_redaction_markers",
            "bound_queue_without_dropping_steering",
            "deduplicate_stable_event_ids",
            "resume_from_durable_offset",
        },
        "focus_stack_compaction_rebuild": {
            "rebuild_focus_from_canonical_events",
            "preserve_checkpoint_and_next_action",
            "revalidate_before_resume",
        },
        "continuity_supervisor_crash_restart": {
            "resume_from_last_durable_offset",
            "deduplicate_replayed_directive_and_transition",
            "keep_interrupt_as_transition",
            "rebuild_corrupt_projection",
            "preserve_causal_order",
        },
        "quiesce_unknown_effect_blocks_resume": {
            "preserve_requested_quiescing_and_reconciling_phases",
            "mark_blocked_unknown_effect",
            "keep_focus_blocked",
            "deny_resume_until_effect_reconciled",
            "retain_user_resume_directive_without_executing_it",
        },
        "node_python_runtime_boundary_drift": {
            "enforce_root_policy_node24_authority",
            "reject_package_engine_drift",
            "reject_hidden_python_core_dependency",
            "start_node_core_without_python",
            "keep_python_oracle_independent",
            "fail_closed_on_oracle_disagreement",
            "preserve_python_evidence_without_rewrite",
        },
    }
    template_by_id = {item["id"]: item for item in templates}
    for fixture_id, required_behaviors in required_fixture_behaviors.items():
        observed_behaviors = set(
            template_by_id[fixture_id]["queries"][0]["oracle"]["required_behaviors"]
        )
        if not required_behaviors.issubset(observed_behaviors):
            raise ValidationFailure(
                f"USR-048 fixture lacks required behaviors: {fixture_id}"
            )
    runtime_state = template_by_id["node_python_runtime_boundary_drift"]["queries"][0][
        "oracle"
    ]["expected_state"]
    if runtime_state != {
        "canonical_runner": "node_only",
        "python_core_dependency": False,
        "oracle_disagreement": "fail_closed",
        "node_equivalent_qualification": "not_run",
        "migration_decision": "pending",
    }:
        raise ValidationFailure("runtime-language fixture weakened its fail-closed boundary")
    return {
        "templates": len(templates),
        "queries": query_count,
        "tags": len(observed_tags),
        "agent_counts": len(observed_agent_counts),
        "directive_kinds": len(observed_directive_kinds),
        "focus_dispositions": len(observed_focus_dispositions),
        "transition_kinds": len(observed_transition_kinds),
        "transition_phases": len(observed_transition_phases),
        "compound_directive_sets": compound_directive_sets,
        "blocked_unknown_effect_transitions": blocked_unknown_effect_transitions,
        "directive_source_messages": len(observed_source_message_ids),
    }


def load_generator_module() -> Any:
    spec = importlib.util.spec_from_file_location("context_fixture_generator", GENERATOR)
    if spec is None or spec.loader is None:
        raise ValidationFailure("cannot load fixture generator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_generator(catalog: dict[str, Any], seeds: list[int]) -> dict[str, Any]:
    module = load_generator_module()
    hashes: dict[str, str] = {}
    coord001_hashes: dict[str, str] = {}
    continuity_hashes: dict[str, str] = {}
    compound_directive_hashes: dict[str, str] = {}
    unknown_effect_hashes: dict[str, str] = {}
    runtime_language_hashes: dict[str, str] = {}
    for seed in seeds:
        first = module.render_jsonl(
            module.generate_catalog(catalog, seed=seed, horizon=100)
        )
        second = module.render_jsonl(
            module.generate_catalog(catalog, seed=seed, horizon=100)
        )
        if first != second:
            raise ValidationFailure(f"generator is nondeterministic for seed {seed}")
        parsed = [json.loads(line) for line in first.splitlines()]
        if len(parsed) != len(catalog["templates"]):
            raise ValidationFailure("generator did not emit one default scenario per template")
        for scenario in parsed:
            if len(scenario["events"]) != 100:
                raise ValidationFailure(
                    f"wrong event horizon in {scenario['scenario_id']}"
                )
            event_ids = [event["event_id"] for event in scenario["events"]]
            if len(event_ids) != len(set(event_ids)):
                raise ValidationFailure(
                    f"duplicate generated event id in {scenario['scenario_id']}"
                )
            all_ids = set(event_ids)
            generated_directive_ids: list[str] = []
            for event in scenario["events"]:
                directive_set = event.get("directive_set")
                if directive_set is not None:
                    for directive in directive_set["directives"]:
                        expected_id = expected_generated_directive_id(
                            directive_set, directive
                        )
                        if directive.get("directive_id") != expected_id:
                            raise ValidationFailure(
                                f"generated directive id mismatch in {scenario['scenario_id']}"
                            )
                        if directive["kind"] == "interrupt":
                            raise ValidationFailure(
                                f"interrupt leaked into generated directive semantics: {scenario['scenario_id']}"
                            )
                        generated_directive_ids.append(directive["directive_id"])
            generated_directive_id_set = set(generated_directive_ids)
            for event in scenario["events"]:
                transition = event.get("continuity_transition")
                if transition is not None and not set(
                    transition["source_directive_ids"]
                ).issubset(generated_directive_id_set):
                    raise ValidationFailure(
                        f"generated transition has unresolved directive evidence: {scenario['scenario_id']}"
                    )
                observer_output = event.get("observer_output")
                if observer_output is not None and not set(
                    observer_output["source_event_ids"]
                ).issubset(all_ids):
                    raise ValidationFailure(
                        f"generated observer output has unresolved source evidence: {scenario['scenario_id']}"
                    )
            if len(generated_directive_ids) != len(set(generated_directive_ids)):
                raise ValidationFailure(
                    f"duplicate generated directive id in {scenario['scenario_id']}"
                )
            for query in scenario["queries"]:
                required = set(query["oracle"]["must_use_event_ids"])
                forbidden = set(query["oracle"]["must_not_rely_on_event_ids"])
                if not required.issubset(all_ids) or not forbidden.issubset(all_ids):
                    raise ValidationFailure(
                        f"generated query has unresolved evidence IDs: {scenario['scenario_id']}"
                    )
        hashes[str(seed)] = hashlib.sha256(first.encode("utf-8")).hexdigest()
        coord001 = module.render_jsonl(
            module.generate_catalog(
                catalog,
                seed=seed,
                horizon=100,
                scenario_id="coord001_descendant_move_regression",
                agent_count=3,
            )
        )
        coord001_hashes[str(seed)] = hashlib.sha256(coord001.encode("utf-8")).hexdigest()
        continuity = module.render_jsonl(
            module.generate_catalog(
                catalog,
                seed=seed,
                horizon=100,
                scenario_id="nested_interrupts_agent_interleaving",
                agent_count=4,
            )
        )
        continuity_hashes[str(seed)] = hashlib.sha256(
            continuity.encode("utf-8")
        ).hexdigest()
        compound = module.render_jsonl(
            module.generate_catalog(
                catalog,
                seed=seed,
                horizon=100,
                scenario_id="steering_eight_directives_source_spans",
                agent_count=1,
            )
        )
        compound_directive_hashes[str(seed)] = hashlib.sha256(
            compound.encode("utf-8")
        ).hexdigest()
        unknown_effect = module.render_jsonl(
            module.generate_catalog(
                catalog,
                seed=seed,
                horizon=100,
                scenario_id="quiesce_unknown_effect_blocks_resume",
                agent_count=2,
            )
        )
        unknown_effect_hashes[str(seed)] = hashlib.sha256(
            unknown_effect.encode("utf-8")
        ).hexdigest()
        runtime_language = module.render_jsonl(
            module.generate_catalog(
                catalog,
                seed=seed,
                horizon=100,
                scenario_id="node_python_runtime_boundary_drift",
                agent_count=0,
            )
        )
        runtime_language_hashes[str(seed)] = hashlib.sha256(
            runtime_language.encode("utf-8")
        ).hexdigest()
    large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="extension_manifest_activation_rollback",
        agent_count=3,
    )[0]
    if len(large["events"]) != 2000:
        raise ValidationFailure("2,000-event expansion failed")
    coord001_large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="coord001_descendant_move_regression",
        agent_count=3,
    )[0]
    if len(coord001_large["events"]) != 2000:
        raise ValidationFailure("COORD-001 2,000-event expansion failed")
    continuity_large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="nested_interrupts_agent_interleaving",
        agent_count=4,
    )[0]
    if len(continuity_large["events"]) != 2000:
        raise ValidationFailure("nested steering 2,000-event expansion failed")
    compound_large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="steering_eight_directives_source_spans",
        agent_count=1,
    )[0]
    if len(compound_large["events"]) != 2000:
        raise ValidationFailure("compound steering 2,000-event expansion failed")
    unknown_effect_large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="quiesce_unknown_effect_blocks_resume",
        agent_count=2,
    )[0]
    if len(unknown_effect_large["events"]) != 2000:
        raise ValidationFailure("unknown-effect steering 2,000-event expansion failed")
    runtime_language_large = module.generate_catalog(
        catalog,
        seed=seeds[0],
        horizon=2000,
        scenario_id="node_python_runtime_boundary_drift",
        agent_count=0,
    )[0]
    if len(runtime_language_large["events"]) != 2000:
        raise ValidationFailure("runtime-language 2,000-event expansion failed")
    return {
        "seed_100_event_jsonl_sha256": hashes,
        "coord001_seed_100_event_sha256": coord001_hashes,
        "continuity_seed_100_event_sha256": continuity_hashes,
        "compound_directive_seed_100_event_sha256": compound_directive_hashes,
        "unknown_effect_seed_100_event_sha256": unknown_effect_hashes,
        "runtime_language_seed_100_event_sha256": runtime_language_hashes,
        "large_horizon_events": 2000,
        "large_horizon_scenarios": 6,
    }


def event_in_template(
    catalog: dict[str, Any], template_id: str, event_symbol: str
) -> dict[str, Any]:
    template = next(item for item in catalog["templates"] if item["id"] == template_id)
    return next(item for item in template["events"] if item["symbol"] == event_symbol)


def validate_mutation_guards(
    catalog: dict[str, Any],
    catalog_schema: dict[str, Any],
    run_schema: dict[str, Any],
    metric_ids: set[str],
) -> dict[str, Any]:
    rejected_catalog_mutants: list[str] = []

    def require_catalog_rejection(
        mutant_id: str, mutate: Any
    ) -> None:
        mutant = copy.deepcopy(catalog)
        mutate(mutant)
        try:
            schema_validate(mutant, catalog_schema, f"catalog mutant {mutant_id}")
            validate_catalog_semantics(mutant, metric_ids)
        except (ValidationFailure, KeyError, TypeError, ValueError):
            rejected_catalog_mutants.append(mutant_id)
            return
        raise ValidationFailure(f"mutation guard false green: {mutant_id}")

    require_catalog_rejection(
        "transition_ref_to_non_directive_event",
        lambda mutant: event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "transition_replan_requested",
        )["continuity_transition"]["source_directive_refs"][0].update(
            {"directive_set_symbol": "focus_seed_created", "ordinal": 0}
        ),
    )

    def remove_target(mutant: dict[str, Any]) -> None:
        directive = event_in_template(
            mutant,
            "observer_absent_wrong_noisy",
            "deterministic_augment_directive",
        )["directive_set"]["directives"][0]
        del directive["target"]

    require_catalog_rejection("directive_without_resolved_target", remove_target)

    def future_destructive_authorization(mutant: dict[str, Any]) -> None:
        directive = event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "compound_all_directives",
        )["directive_set"]["directives"][0]
        directive["arguments"]["authorization_event_symbol"] = "focus_new_completed"

    require_catalog_rejection(
        "destructive_directive_uses_future_authorization",
        future_destructive_authorization,
    )

    def overlap_unresolved_span(mutant: dict[str, Any]) -> None:
        directive_set = event_in_template(
            mutant,
            "displaced_task_missing_resume_alert",
            "steering_directives_primary",
        )["directive_set"]
        directive_set["unresolved_spans"].append(
            copy.deepcopy(directive_set["directives"][0]["source_spans"][0])
        )

    require_catalog_rejection(
        "unresolved_span_overlaps_admitted_span", overlap_unresolved_span
    )

    def future_disposition_source(mutant: dict[str, Any]) -> None:
        disposition_event = event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "focus_new_suspended",
        )
        disposition_event["focus_disposition"]["source_event_symbol"] = (
            "focus_new_completed"
        )
        disposition_event["causal_parent_symbols"] = ["transition_interrupt_applied"]

    require_catalog_rejection(
        "focus_disposition_uses_future_source", future_disposition_source
    )

    def illegal_operation_path(mutant: dict[str, Any]) -> None:
        event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "transition_replan_applied",
        )["continuity_transition"]["phase"] = "quiescing"

    require_catalog_rejection("illegal_operation_phase_path", illegal_operation_path)

    def premature_disposition(mutant: dict[str, Any]) -> None:
        disposition_event = event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "focus_new_suspended",
        )
        disposition_event["focus_disposition"]["source_event_symbol"] = (
            "transition_reconciling"
        )
        disposition_event["causal_parent_symbols"] = ["transition_interrupt_applied"]

    require_catalog_rejection(
        "focus_disposition_before_operation_applied", premature_disposition
    )

    def invalid_disposition_cas(mutant: dict[str, Any]) -> None:
        event_in_template(
            mutant,
            "steering_eight_directives_source_spans",
            "focus_new_active_resumed",
        )["focus_disposition"]["expected_prior_revision"] = 1

    require_catalog_rejection(
        "focus_disposition_stale_cas_revision", invalid_disposition_cas
    )

    def resurrect_terminal_focus(mutant: dict[str, Any]) -> None:
        template = next(
            item
            for item in mutant["templates"]
            if item["id"] == "steering_eight_directives_source_spans"
        )
        insertion = next(
            index
            for index, event in enumerate(template["events"])
            if event["symbol"] == "focus_abandonment_authorized"
        )
        template["events"].insert(
            insertion,
            {
                "symbol": "focus_new_illegal_resurrection",
                "at": 0.77,
                "type": "focus.disposition_recorded",
                "actor": "continuity_supervisor",
                "agent_slot": None,
                "repository_state_id": "repo_ag0",
                "payload": {},
                "focus_disposition": {
                    "focus_id": "focus_new",
                    "disposition": "active",
                    "source_event_symbol": "transition_resume_applied",
                    "causal_operation_id": "op_resume_new",
                    "expected_prior_revision": 4,
                    "revision": 5,
                    "reason": "illegal_resurrection",
                },
                "causal_parent_symbols": [
                    "focus_new_completed",
                    "transition_resume_applied",
                ],
            },
        )

    require_catalog_rejection(
        "terminal_focus_resurrection", resurrect_terminal_focus
    )

    def observer_effect_authority(mutant: dict[str, Any]) -> None:
        event_in_template(
            mutant,
            "observer_absent_wrong_noisy",
            "observer_wrong_replace_proposal",
        )["observer_output"]["effect_authority"] = True

    require_catalog_rejection(
        "observer_output_with_effect_authority", observer_effect_authority
    )

    def transition_target_drift(mutant: dict[str, Any]) -> None:
        wrong_target = {
            "scope_kind": "focus",
            "scope_id": "focus_old",
            "resolution_event_symbol": "focus_old_created",
        }
        for symbol in ("transition_replan_requested", "transition_replan_applied"):
            event_in_template(
                mutant, "steering_eight_directives_source_spans", symbol
            )["continuity_transition"]["target"] = copy.deepcopy(wrong_target)

    require_catalog_rejection(
        "transition_target_does_not_match_directive", transition_target_drift
    )

    steering_schema = copy.deepcopy(run_schema["properties"]["steering_continuity"])
    steering_schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    steering_schema["$defs"] = copy.deepcopy(run_schema["$defs"])
    artifact = {
        "id": "artifact_guard",
        "path_or_uri": "synthetic/guard.json",
        "sha256": "0" * 64,
        "media_type": "application/json",
        "size_bytes": 1,
        "classification": "sanitized",
    }
    base_record = {
        "strategy": "deterministic_supervisor_only",
        "steering_directive_sets_artifact": artifact,
        "focus_dispositions_artifact": artifact,
        "continuity_transitions_artifact": artifact,
        "focus_stack_artifact": artifact,
        "constraint_merge_artifact": artifact,
        "supervisor_offset_artifact": artifact,
        "observer_subscription_artifact": None,
        "observer_proposals_artifact": None,
        "observer_delivery_replay_artifact": None,
        "strategy_enforcement_eligible": True,
        "sanitized_inputs_only": True,
        "chain_of_thought_visible": False,
        "observer_effect_authority": False,
        "observer_mutation_authority": False,
        "observer_private_memory_authority": False,
        "observer_direct_peer_channel": False,
        "observer_independent_state_authority": False,
    }
    schema_validate(base_record, steering_schema, "valid steering continuity run slice")
    rejected_run_mutants: list[str] = []

    def require_run_rejection(
        mutant_id: str, mutate: Any
    ) -> None:
        mutant = copy.deepcopy(base_record)
        mutate(mutant)
        try:
            schema_validate(mutant, steering_schema, f"run mutant {mutant_id}")
        except ValidationFailure:
            rejected_run_mutants.append(mutant_id)
            return
        raise ValidationFailure(f"run invariant mutation guard false green: {mutant_id}")

    run_field_mutants = {
        "unsanitized_observer_input": ("sanitized_inputs_only", False),
        "chain_of_thought_exposed": ("chain_of_thought_visible", True),
        "observer_effect_authority": ("observer_effect_authority", True),
        "observer_mutation_authority": ("observer_mutation_authority", True),
        "observer_private_memory_authority": (
            "observer_private_memory_authority",
            True,
        ),
        "observer_direct_peer_channel": ("observer_direct_peer_channel", True),
        "observer_independent_state_authority": (
            "observer_independent_state_authority",
            True,
        ),
    }
    for mutant_id, (field, value) in run_field_mutants.items():
        require_run_rejection(
            mutant_id,
            lambda mutant, field=field, value=value: mutant.update({field: value}),
        )

    require_run_rejection(
        "deterministic_strategy_with_observer_artifact",
        lambda mutant: mutant.update({"observer_proposals_artifact": artifact}),
    )

    def hybrid_without_observer_artifacts(mutant: dict[str, Any]) -> None:
        mutant["strategy"] = "hybrid_rules_and_small_model_proposal"

    require_run_rejection(
        "hybrid_strategy_without_observer_artifacts",
        hybrid_without_observer_artifacts,
    )

    def isolated_model_with_enforcement(mutant: dict[str, Any]) -> None:
        mutant.update(
            {
                "strategy": "isolated_model_only_simulator",
                "strategy_enforcement_eligible": True,
                "observer_subscription_artifact": artifact,
                "observer_proposals_artifact": artifact,
                "observer_delivery_replay_artifact": artifact,
            }
        )

    require_run_rejection(
        "isolated_model_strategy_with_enforcement", isolated_model_with_enforcement
    )
    require_run_rejection(
        "negative_control_with_enforcement",
        lambda mutant: mutant.update(
            {
                "strategy": "no_monitor_negative_control",
                "strategy_enforcement_eligible": True,
            }
        ),
    )
    return {
        "catalog_mutants_rejected": len(rejected_catalog_mutants),
        "catalog_mutant_ids": rejected_catalog_mutants,
        "run_mutants_rejected": len(rejected_run_mutants),
        "run_mutant_ids": rejected_run_mutants,
        "false_greens": 0,
    }


def validate_candidates(snapshot: dict[str, Any]) -> dict[str, int]:
    groups = ["embedding_models", "rerankers", "runtimes", "mandatory_mcps"]
    counts: dict[str, int] = {}
    for group in groups:
        records = snapshot[group]
        require_unique(records, "id", group)
        for record in records:
            if record["qualification_status"] != "not_run":
                raise ValidationFailure(
                    f"candidate snapshot must not claim qualification: {group}/{record['id']}"
                )
        counts[group] = len(records)
    if snapshot["acquisition"]["fallback_mcp_used"]:
        raise ValidationFailure("MCP fallback must remain false for this acquisition snapshot")
    return counts


def validate_manifest(
    require_manifest: bool, governing_inputs: list[dict[str, Any]]
) -> dict[str, int]:
    if not MANIFEST.exists():
        if require_manifest:
            raise ValidationFailure("manifest.json is required but missing")
        return {"manifest_entries": 0}
    manifest = load_json(MANIFEST)
    if manifest.get("governing_inputs") != governing_inputs:
        raise ValidationFailure(
            "manifest governing inputs differ from the qualification plan"
        )
    if manifest.get("qualification_claim") != "none":
        raise ValidationFailure("manifest must not claim qualification")
    if manifest.get("credentials_or_personal_data_retained"):
        raise ValidationFailure("manifest cannot retain credentials or personal data")
    entries = manifest.get("artifacts", [])
    require_unique(entries, "path", "manifest artifact")
    for entry in entries:
        path = REPO_ROOT / entry["path"]
        if not path.is_file():
            raise ValidationFailure(f"manifest artifact missing: {entry['path']}")
        observed = sha256_file(path)
        if observed != entry["sha256"]:
            raise ValidationFailure(
                f"manifest hash mismatch for {entry['path']}: "
                f"declared={entry['sha256']} observed={observed}"
            )
    return {"manifest_entries": len(entries)}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-manifest", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        plan_schema = load_json(PLAN_SCHEMA)
        catalog_schema = load_json(CATALOG_SCHEMA)
        run_schema = load_json(RUN_SCHEMA)
        plan = load_json(PLAN)
        catalog = load_json(CATALOG)
        candidates = load_json(CANDIDATES)
        schema_validate(plan, plan_schema, "qualification plan")
        schema_validate(catalog, catalog_schema, "scenario catalog")
        Draft202012Validator.check_schema(run_schema)
        summary = {
            "status": "pass",
            "scope": "design_and_fixture_validation_only",
            "qualification_claim": "none",
            "plan": validate_plan_semantics(plan),
            "catalog": validate_catalog_semantics(
                catalog, {item["id"] for item in plan["metrics"]}
            ),
            "generator": validate_generator(
                catalog, plan["repetitions"]["exploratory_seeds"]
            ),
            "mutation_guards": validate_mutation_guards(
                catalog,
                catalog_schema,
                run_schema,
                {item["id"] for item in plan["metrics"]},
            ),
            "candidates": validate_candidates(candidates),
            "manifest": validate_manifest(
                args.require_manifest, plan["governing_inputs"]
            ),
            "schemas_checked": 3,
        }
    except (ValidationFailure, ValueError, KeyError, TypeError) as error:
        print(
            json.dumps(
                {
                    "status": "fail",
                    "scope": "design_and_fixture_validation_only",
                    "qualification_claim": "none",
                    "error": str(error),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
