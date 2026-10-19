#!/usr/bin/env python3
"""Deterministically expand context/memory scenario templates.

This is fixture tooling, not a runtime memory integration. It emits invented
events only and has no provider, MCP, repository, credential, or model access.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = (
    REPO_ROOT
    / "verification"
    / "benchmarks"
    / "context"
    / "fixtures"
    / "scenario-templates.json"
)


def canonical_json(value: Any) -> str:
    """Return the suite's stable JSON representation for generated fixtures."""

    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_hex(*parts: object) -> str:
    material = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def load_catalog(path: Path = DEFAULT_CATALOG) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        catalog = json.load(handle)
    if catalog.get("generator_contract", {}).get("id_algorithm") != "sha256_v1":
        raise ValueError("unsupported generator id algorithm")
    if catalog.get("generator_contract", {}).get("directive_id_algorithm") != "sha256_v1":
        raise ValueError("unsupported directive id algorithm")
    return catalog


def _reserve_positions(
    records: list[dict[str, Any]], horizon: int
) -> dict[int, tuple[int, dict[str, Any]]]:
    occupied: dict[int, tuple[int, dict[str, Any]]] = {}
    ordered = sorted(enumerate(records), key=lambda item: (item[1]["at"], item[0]))
    previous = -1
    for declaration_index, record in ordered:
        target = round(float(record["at"]) * (horizon - 1))
        position = max(target, previous + 1)
        while position in occupied:
            position += 1
        if position >= horizon:
            raise ValueError(
                f"fixed events do not fit horizon {horizon}; last symbol={record['symbol']}"
            )
        occupied[position] = (declaration_index, record)
        previous = position
    return occupied


def _event_id(
    template_id: str, seed: int, horizon: int, agent_count: int, symbolic_id: str
) -> str:
    digest = stable_hex(
        "event", template_id, seed, horizon, agent_count, symbolic_id
    )
    return f"evt_{digest[:32]}"


def _timestamp(sequence: int) -> str:
    # A logical UTC clock is sufficient for fixtures and remains version-stable.
    hours, remainder = divmod(sequence, 3600)
    minutes, seconds = divmod(remainder, 60)
    days, hours = divmod(hours, 24)
    return f"2026-01-{days + 1:02d}T{hours:02d}:{minutes:02d}:{seconds:02d}Z"


def _map_agent_id(event: dict[str, Any], agent_count: int) -> str | None:
    slot = event.get("agent_slot")
    if slot is None or agent_count == 0:
        return None
    return f"agent_{int(slot) % agent_count}"


def _expand_fact(
    fact: dict[str, Any], symbolic_to_event: dict[str, str]
) -> dict[str, Any]:
    expanded = copy.deepcopy(fact)
    supersedes = expanded.pop("supersedes_symbols", [])
    expanded["supersedes_event_ids"] = [symbolic_to_event[item] for item in supersedes]
    return expanded


def _expand_directive_set(source: dict[str, Any]) -> dict[str, Any]:
    expanded = copy.deepcopy(source)
    for directive in expanded["directives"]:
        directive["directive_id"] = "dir_" + stable_hex(
            "directive",
            expanded["source_message_id"],
            expanded["source_message_sha256"],
            directive["ordinal"],
            directive["kind"],
            canonical_json(directive["source_spans"]),
            canonical_json(directive["target"]),
            canonical_json(directive["arguments"]),
        )[:32]
    return expanded


def _fixed_event(
    *,
    template: dict[str, Any],
    source: dict[str, Any],
    sequence: int,
    seed: int,
    horizon: int,
    agent_count: int,
    symbolic_to_event: dict[str, str],
    symbolic_to_directives: dict[str, dict[int, str]],
) -> dict[str, Any]:
    symbolic_id = source["symbol"]
    event: dict[str, Any] = {
        "event_id": symbolic_to_event[symbolic_id],
        "symbolic_id": symbolic_id,
        "sequence": sequence,
        "event_time": _timestamp(sequence),
        "observed_time": _timestamp(sequence),
        "valid_time": _timestamp(sequence),
        "type": source["type"],
        "actor": source["actor"],
        "agent_id": _map_agent_id(source, agent_count),
        "repository_state_id": source["repository_state_id"],
        "capability_epoch_id": source.get("payload", {}).get(
            "capability_epoch", "cap_epoch_fixture_default"
        ),
        "causal_parent_ids": [
            symbolic_to_event[item]
            for item in source.get("causal_parent_symbols", [])
        ],
        "payload": copy.deepcopy(source["payload"]),
        "fixture_role": "oracle_source",
    }
    if "fact" in source:
        event["fact"] = _expand_fact(source["fact"], symbolic_to_event)
    if "directive_set" in source:
        event["directive_set"] = _expand_directive_set(source["directive_set"])
    if "focus_disposition" in source:
        disposition = copy.deepcopy(source["focus_disposition"])
        disposition["source_event_id"] = symbolic_to_event[
            disposition.pop("source_event_symbol")
        ]
        event["focus_disposition"] = disposition
    if "continuity_transition" in source:
        transition = copy.deepcopy(source["continuity_transition"])
        transition["source_directive_ids"] = [
            symbolic_to_directives[item["directive_set_symbol"]][item["ordinal"]]
            for item in transition.pop("source_directive_refs")
        ]
        event["continuity_transition"] = transition
    if "observer_output" in source:
        observer_output = copy.deepcopy(source["observer_output"])
        observer_output["source_event_ids"] = [
            symbolic_to_event[item]
            for item in observer_output.pop("source_event_symbols")
        ]
        event["observer_output"] = observer_output
    return event


def _distractor_event(
    *,
    template: dict[str, Any],
    distractors: list[dict[str, Any]],
    sequence: int,
    seed: int,
    horizon: int,
    agent_count: int,
) -> dict[str, Any]:
    selector = int(
        stable_hex("distractor", template["id"], seed, horizon, agent_count, sequence),
        16,
    )
    source = distractors[selector % len(distractors)]
    variant = selector % 997
    symbolic_id = f"distractor_{sequence:06d}"
    return {
        "event_id": _event_id(
            template["id"], seed, horizon, agent_count, symbolic_id
        ),
        "symbolic_id": symbolic_id,
        "sequence": sequence,
        "event_time": _timestamp(sequence),
        "observed_time": _timestamp(sequence),
        "valid_time": _timestamp(sequence),
        "type": source["type"],
        "actor": "untrusted_content"
        if source["type"] == "untrusted.content"
        else "scheduler",
        "agent_id": None,
        "repository_state_id": template["events"][0]["repository_state_id"],
        "capability_epoch_id": "cap_epoch_fixture_default",
        "causal_parent_ids": [],
        "payload": {
            "distractor_id": source["id"],
            "text": source["text"],
            "similarity_keys": source.get("similarity_keys", []),
            "variant": variant,
        },
        "fixture_role": "distractor",
    }


def _expand_faults(
    template: dict[str, Any], seed: int, horizon: int, agent_count: int
) -> list[dict[str, Any]]:
    faults: list[dict[str, Any]] = []
    for declaration_index, fault in enumerate(template["faults"]):
        fault_id = f"fault_{stable_hex('fault', template['id'], seed, horizon, agent_count, fault['id'])[:32]}"
        faults.append(
            {
                "fault_id": fault_id,
                "symbolic_id": fault["id"],
                "at_sequence": round(float(fault["at"]) * (horizon - 1)),
                "declaration_order": declaration_index,
                "type": fault["type"],
                "payload": copy.deepcopy(fault["payload"]),
            }
        )
    return sorted(faults, key=lambda item: (item["at_sequence"], item["declaration_order"]))


def _expand_queries(
    template: dict[str, Any], horizon: int, symbolic_to_event: dict[str, str]
) -> list[dict[str, Any]]:
    queries: list[dict[str, Any]] = []
    for query in template["queries"]:
        oracle = copy.deepcopy(query["oracle"])
        oracle["must_use_event_ids"] = [
            symbolic_to_event[item] for item in oracle.pop("must_use_symbols")
        ]
        oracle["must_not_rely_on_event_ids"] = [
            symbolic_to_event[item] for item in oracle.pop("must_not_use_symbols")
        ]
        queries.append(
            {
                "query_id": query["id"],
                "at_sequence": round(float(query["at"]) * (horizon - 1)),
                "action": query["action"],
                "oracle": oracle,
                "metrics": list(query["metrics"]),
            }
        )
    return queries


def generate_scenario(
    catalog: dict[str, Any],
    template: dict[str, Any],
    *,
    seed: int,
    horizon: int,
    agent_count: int | None = None,
) -> dict[str, Any]:
    contract_horizons = catalog["generator_contract"]["horizons"]
    if horizon not in contract_horizons:
        raise ValueError(f"horizon must be one of {contract_horizons}")
    selected_agents = (
        template["default_agent_count"] if agent_count is None else agent_count
    )
    if selected_agents not in template["allowed_agent_counts"]:
        raise ValueError(
            f"scenario {template['id']} does not allow agent count {selected_agents}; "
            f"allowed={template['allowed_agent_counts']}"
        )
    positions = _reserve_positions(template["events"], horizon)
    symbolic_to_event = {
        event["symbol"]: _event_id(
            template["id"], seed, horizon, selected_agents, event["symbol"]
        )
        for event in template["events"]
    }
    symbolic_to_directives: dict[str, dict[int, str]] = {}
    for source in template["events"]:
        if "directive_set" not in source:
            continue
        expanded = _expand_directive_set(source["directive_set"])
        symbolic_to_directives[source["symbol"]] = {
            directive["ordinal"]: directive["directive_id"]
            for directive in expanded["directives"]
        }
    events: list[dict[str, Any]] = []
    for sequence in range(horizon):
        positioned = positions.get(sequence)
        if positioned is None:
            events.append(
                _distractor_event(
                    template=template,
                    distractors=catalog["distractor_pool"],
                    sequence=sequence,
                    seed=seed,
                    horizon=horizon,
                    agent_count=selected_agents,
                )
            )
            continue
        _, source = positioned
        events.append(
            _fixed_event(
                template=template,
                source=source,
                sequence=sequence,
                seed=seed,
                horizon=horizon,
                agent_count=selected_agents,
                symbolic_to_event=symbolic_to_event,
                symbolic_to_directives=symbolic_to_directives,
            )
        )

    catalog_digest = hashlib.sha256(canonical_json(catalog).encode("utf-8")).hexdigest()
    scenario: dict[str, Any] = {
        "schema_version": "2.0.0",
        "generator_id": "context-memory-fixture-sha256-v2",
        "catalog_sha256": catalog_digest,
        "scenario_id": f"{template['id']}.seed-{seed}.h-{horizon}.a-{selected_agents}",
        "template_id": template["id"],
        "title": template["title"],
        "tags": list(template["tags"]),
        "seed": seed,
        "horizon_events": horizon,
        "agent_count": selected_agents,
        "events": events,
        "fault_schedule": _expand_faults(
            template, seed, horizon, selected_agents
        ),
        "queries": _expand_queries(template, horizon, symbolic_to_event),
    }
    scenario["scenario_payload_sha256"] = hashlib.sha256(
        canonical_json(scenario).encode("utf-8")
    ).hexdigest()
    return scenario


def generate_catalog(
    catalog: dict[str, Any],
    *,
    seed: int,
    horizon: int,
    scenario_id: str | None = None,
    agent_count: int | None = None,
) -> list[dict[str, Any]]:
    templates = catalog["templates"]
    if scenario_id is not None:
        templates = [item for item in templates if item["id"] == scenario_id]
        if not templates:
            raise ValueError(f"unknown scenario: {scenario_id}")
    elif agent_count is not None:
        templates = [
            item for item in templates if agent_count in item["allowed_agent_counts"]
        ]
        if not templates:
            raise ValueError(f"no scenarios allow agent count {agent_count}")
    return [
        generate_scenario(
            catalog,
            template,
            seed=seed,
            horizon=horizon,
            agent_count=agent_count,
        )
        for template in templates
    ]


def render_jsonl(scenarios: Iterable[dict[str, Any]]) -> str:
    return "".join(f"{canonical_json(scenario)}\n" for scenario in scenarios)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--scenario")
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--horizon", type=int, required=True)
    parser.add_argument("--agent-count", type=int, choices=range(0, 6))
    parser.add_argument("--output", default="-", help="'-' for stdout")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        catalog = load_catalog(args.catalog)
        rendered = render_jsonl(
            generate_catalog(
                catalog,
                seed=args.seed,
                horizon=args.horizon,
                scenario_id=args.scenario,
                agent_count=args.agent_count,
            )
        )
        if args.output == "-":
            sys.stdout.write(rendered)
        else:
            Path(args.output).write_text(rendered, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"fixture generation failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
