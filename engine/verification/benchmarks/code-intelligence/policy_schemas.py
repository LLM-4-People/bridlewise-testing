#!/usr/bin/env python3
"""Generate closed structural schemas for the four code-intelligence policy documents."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


DOCUMENTS = {
    "candidate-catalog.schema.json": "docs/research/code-intelligence/candidates.v1.json",
    "qualification-protocol.schema.json": "docs/research/code-intelligence/protocol.v2.json",
    "query-oracle.schema.json": "docs/research/code-intelligence/query-oracle.v1.json",
    "scenario-catalog.schema.json": "docs/research/code-intelligence/scenarios.v1.json",
}

DOCUMENT_IDS = {
    "candidate-catalog.schema.json": ("candidate-catalog", "catalogVersion"),
    "qualification-protocol.schema.json": ("qualification-protocol", "protocolVersion"),
    "query-oracle.schema.json": ("query-oracle", "oracleVersion"),
    "scenario-catalog.schema.json": ("scenario-catalog", "catalogVersion"),
}
LOCK_PATH = "docs/research/code-intelligence/policy-bundle-lock.v2.json"


def _shape(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        raise ValueError("policy identity documents cannot contain floats")
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        if not value:
            return {"type": "array", "maxItems": 0}
        variants: dict[str, dict[str, Any]] = {}
        for item in value:
            schema = _shape(item)
            variants[json.dumps(schema, sort_keys=True, separators=(",", ":"))] = schema
        item_schema = next(iter(variants.values())) if len(variants) == 1 else {"oneOf": list(variants.values())}
        return {"type": "array", "items": item_schema}
    if isinstance(value, dict):
        return {
            "type": "object",
            "additionalProperties": False,
            "required": sorted(value),
            "properties": {key: _shape(value[key]) for key in sorted(value)},
        }
    raise TypeError(type(value).__name__)


def expected_schema(document: dict[str, Any], filename: str) -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://bridlewise.local/schemas/code-intelligence/{filename}",
        "title": f"Closed structural schema for {document.get('schemaVersion', filename)}",
        **_shape(document),
    }


def encoded(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def semantic_version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError(f"invalid semantic version: {value}")
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def expected_lock_documents(root: Path) -> list[dict[str, Any]]:
    values = []
    for schema_name, document_path in DOCUMENTS.items():
        document_bytes = (root / document_path).read_bytes()
        document = json.loads(document_bytes.decode("utf-8"), parse_float=lambda token: (_ for _ in ()).throw(ValueError(f"float forbidden: {token}")))
        schema_path = f"verification/benchmarks/code-intelligence/schemas/{schema_name}"
        schema_bytes = (root / schema_path).read_bytes()
        document_id, semantic_version_field = DOCUMENT_IDS[schema_name]
        values.append({
            "id": document_id,
            "path": document_path,
            "schemaPath": schema_path,
            "documentVersion": document["schemaVersion"],
            "semanticVersion": document[semantic_version_field],
            "semanticEpoch": document["semanticEpoch"],
            "byteSha256": sha256(document_bytes),
            "canonicalSha256": sha256(canonical_bytes(document)),
            "schemaSha256": sha256(schema_bytes),
        })
    return values


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--root", type=Path, default=Path.cwd())
    mode = parser.add_mutually_exclusive_group(required=True); mode.add_argument("--write", action="store_true"); mode.add_argument("--check", action="store_true"); mode.add_argument("--relock", action="store_true")
    args = parser.parse_args(); root = args.root.resolve(); schema_root = root / "verification/benchmarks/code-intelligence/schemas"
    lock_path = root / LOCK_PATH
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if args.relock:
        prior = {item["id"]: item for item in lock["documents"]}
        for schema_name, document_path in DOCUMENTS.items():
            document = json.loads((root / document_path).read_text(encoding="utf-8"))
            document_id, semantic_version_field = DOCUMENT_IDS[schema_name]
            previous = prior[document_id]
            changed = sha256(canonical_bytes(document)) != previous["canonicalSha256"]
            if changed and (
                document["semanticEpoch"] <= previous["semanticEpoch"]
                or semantic_version(document[semantic_version_field]) <= semantic_version(previous["semanticVersion"])
            ):
                raise SystemExit(f"refusing semantic relock without monotonic document version/epoch: {document_id}")
        if lock["semanticEpoch"] < max(json.loads((root / path).read_text(encoding="utf-8"))["semanticEpoch"] for path in DOCUMENTS.values()):
            raise SystemExit("refusing relock whose bundle epoch is below a document epoch")
    failures = []
    for filename, document_path in DOCUMENTS.items():
        document = json.loads((root / document_path).read_text(encoding="utf-8"), parse_float=lambda token: (_ for _ in ()).throw(ValueError(f"float forbidden: {token}")))
        payload = encoded(expected_schema(document, filename)); target = schema_root / filename
        if args.write or args.relock:
            target.write_bytes(payload)
        elif not target.is_file() or target.read_bytes() != payload:
            failures.append(str(target.relative_to(root)))
    if not failures:
        expected_documents = expected_lock_documents(root)
        if args.relock:
            if lock.get("trustStatus") != "integrity-only-untrusted-no-qualified-signer" or lock.get("qualificationPermitted") is not False or lock.get("signature") is not None:
                raise SystemExit("refusing to relock a policy bundle that overstates trust")
            lock["documents"] = expected_documents
            lock_path.write_bytes(encoded(lock))
        elif args.check and lock.get("documents") != expected_documents:
            failures.append(str(lock_path.relative_to(root)))
    if failures:
        print(json.dumps({"status": "drift", "files": failures}, indent=2)); return 2
    status = "relocked-untrusted" if args.relock else ("written" if args.write else "valid")
    print(json.dumps({"status": status, "schemas": len(DOCUMENTS), "qualificationPermitted": False})); return 0


if __name__ == "__main__":
    raise SystemExit(main())
