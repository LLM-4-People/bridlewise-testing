#!/usr/bin/env python3
"""Independent verifier for the language-neutral code-intelligence protocol.

This file is benchmark/oracle infrastructure, not the harness runtime bootstrap
compiler. It deliberately fails closed when its declared Python/jsonschema
dependencies or any bound evidence are unavailable.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import sys
import tempfile
from typing import Any, Iterable
import urllib.error
import urllib.request
import unicodedata

try:
    import jsonschema
    from referencing import Registry, Resource
except ImportError as error:  # pragma: no cover - import itself is the gate
    raise SystemExit("BLOCKED: jsonschema and referencing are required; install the versions declared in runtime-requirements.json") from error


SCRIPT_VERSION = "code-intelligence-independent-verifier/v3"
EVIDENCE_SUFFIX = Path("traceability/evidence/research/code-intelligence")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
STABLE_TAG_RE = re.compile(r"^v?([0-9]+\.[0-9]+\.[0-9]+)$")
ASCII_KEY_RE = re.compile(r"^[\x20-\x7e]+$")
MAX_SAFE_INTEGER = 2**53 - 1
REQUIRED_CANDIDATES = {
    "codegraph-colbymchenry", "codegraph-suatkocar", "codegraph-sdsrss",
    "gitnexus", "probe", "serena", "codebase-memory-mcp", "jcodemunch",
    "grepai", "codegraphcontext", "sourcegraph-mcp", "sourcebot",
}
REQUIRED_QUERY_CLASSES = {
    "structure", "dependency", "public-api", "callers-callees",
    "execution-flow", "reuse-adapt-create", "change-impact", "freshness",
    "project-isolation", "unsupported-and-unknown",
}
REQUIRED_FATAL_INVARIANTS = {
    "correct-repository", "complete-eligible-inventory", "current-index-generation",
    "no-cross-project-contamination", "no-silent-empty", "no-unqualified-fallback",
    "no-partial-index-publication", "no-unsupported-required-language",
    "no-concurrent-snapshot-drift", "exact-tool-schema", "deterministic-bootstrap",
    "complete-content-addressed-evidence",
}

RUNTIME_POINTER_PATH = "verification/benchmarks/code-intelligence/runtime-requirements.json"
RUNTIME_POLICY_PATH = "verification/benchmarks/code-intelligence/runtime-policy.json"
RUNTIME_HOST_RECEIPT_PATH = "verification/benchmarks/code-intelligence/runtime-host-receipt.json"
POLICY_BUNDLE_LOCK_PATH = "docs/research/code-intelligence/policy-bundle-lock.v2.json"
CANONICAL_POLICY_DOCUMENT_PATHS = {
    "candidate-catalog": "docs/research/code-intelligence/candidates.v1.json",
    "qualification-protocol": "docs/research/code-intelligence/protocol.v2.json",
    "query-oracle": "docs/research/code-intelligence/query-oracle.v1.json",
    "scenario-catalog": "docs/research/code-intelligence/scenarios.v1.json",
}
OPERATIVE_SOURCE_PATHS = (
    "verification/benchmarks/code-intelligence/qualification.py",
    "verification/benchmarks/code-intelligence/policy_schemas.py",
    "verification/benchmarks/code-intelligence/canonicalize.mjs",
)
OPERATIVE_SCHEMA_PATHS = (
    "verification/benchmarks/code-intelligence/schemas/admission-record.schema.json",
    "verification/benchmarks/code-intelligence/schemas/bootstrap-output.schema.json",
    "verification/benchmarks/code-intelligence/schemas/candidate-catalog.schema.json",
    "verification/benchmarks/code-intelligence/schemas/candidate-resolution.schema.json",
    "verification/benchmarks/code-intelligence/schemas/evidence-manifest.schema.json",
    "verification/benchmarks/code-intelligence/schemas/policy-bundle-lock.schema.json",
    "verification/benchmarks/code-intelligence/schemas/qualification-protocol.schema.json",
    "verification/benchmarks/code-intelligence/schemas/query-oracle.schema.json",
    "verification/benchmarks/code-intelligence/schemas/repository-snapshot.schema.json",
    "verification/benchmarks/code-intelligence/schemas/reviewer-registry.schema.json",
    "verification/benchmarks/code-intelligence/schemas/review-receipt.schema.json",
    "verification/benchmarks/code-intelligence/schemas/run-record.schema.json",
    "verification/benchmarks/code-intelligence/schemas/scenario-catalog.schema.json",
)
OPERATIVE_POLICY_PATHS = (
    *CANONICAL_POLICY_DOCUMENT_PATHS.values(),
    POLICY_BUNDLE_LOCK_PATH,
    RUNTIME_POINTER_PATH,
    RUNTIME_POLICY_PATH,
    RUNTIME_HOST_RECEIPT_PATH,
)
REPOSITORY_BASELINE_POLICY_PATHS = (
    *CANONICAL_POLICY_DOCUMENT_PATHS.values(),
    POLICY_BUNDLE_LOCK_PATH,
)
DISTRIBUTION_PACKAGE_ROOTS = {
    "attrs": ("attr", "attrs"),
    "idna": ("idna",),
    "jsonschema": ("jsonschema",),
    "jsonschema-specifications": ("jsonschema_specifications",),
    "referencing": ("referencing",),
    "rpds-py": ("rpds",),
}
EXPECTED_DISTRIBUTIONS = tuple(DISTRIBUTION_PACKAGE_ROOTS)


class QualificationError(ValueError):
    """One or more fail-closed qualification checks failed."""


def _normalized_root(root: Path) -> Path:
    try:
        normalized = root.resolve(strict=True)
    except OSError as error:
        raise QualificationError(f"repository root is unavailable: {root}") from error
    if not normalized.is_dir():
        raise QualificationError(f"repository root is not a directory: {root}")
    return normalized


def _normalized_relative_path(value: str, *, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise QualificationError(f"{label} is not a normalized repository-relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(part in {"", ".", ".."} for part in path.parts):
        raise QualificationError(f"{label} is not a normalized repository-relative POSIX path")
    return path


def _safe_repository_path(root: Path, relative: str, *, must_exist: bool) -> Path:
    normalized_root = _normalized_root(root)
    normalized_relative = _normalized_relative_path(relative, label="governed path")
    candidate = normalized_root.joinpath(*normalized_relative.parts)
    current = normalized_root
    for part in normalized_relative.parts:
        current = current / part
        if current.exists() or current.is_symlink():
            if current.is_symlink():
                raise QualificationError(f"governed path traverses a symlink: {relative}")
    try:
        resolved = candidate.resolve(strict=must_exist)
    except OSError as error:
        raise QualificationError(f"governed path is unavailable: {relative}") from error
    if not resolved.is_relative_to(normalized_root):
        raise QualificationError(f"governed path escapes the repository root: {relative}")
    if must_exist and not resolved.is_file():
        raise QualificationError(f"governed path is not a regular file: {relative}")
    return resolved


def _evidence_root(root: Path) -> Path:
    normalized_root = _normalized_root(root)
    expected = normalized_root / EVIDENCE_SUFFIX
    try:
        resolved = expected.resolve(strict=True)
    except OSError as error:
        raise QualificationError("canonical evidence root is unavailable") from error
    if resolved != expected or not resolved.is_dir():
        raise QualificationError("canonical evidence root is symlinked or not repository-root-bound")
    return resolved


def _validate_set_id(evidence_set_id: str) -> None:
    if not isinstance(evidence_set_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,80}", evidence_set_id):
        raise QualificationError("invalid evidence set ID")


def _cas_relative_path(evidence_set_id: str, digest: str, extension: str) -> str:
    _validate_set_id(evidence_set_id)
    if not SHA256_RE.fullmatch(digest) or extension not in {"json", "txt", "bin"}:
        raise QualificationError("invalid content-addressed object identity")
    return (EVIDENCE_SUFFIX / "sets" / evidence_set_id / "objects" / "sha256" / digest[:2] / f"{digest}.{extension}").as_posix()


def _parse_cas_binding(binding: dict[str, str], *, extension: str | None = None) -> tuple[str, str]:
    if not isinstance(binding, dict) or set(binding) != {"path", "sha256"} or not SHA256_RE.fullmatch(str(binding.get("sha256", ""))):
        raise QualificationError("governed object binding is not exact")
    relative = _normalized_relative_path(binding["path"], label="governed object binding")
    prefix = (*EVIDENCE_SUFFIX.parts, "sets")
    parts = relative.parts
    if len(parts) != len(prefix) + 5 or tuple(parts[: len(prefix)]) != prefix:
        raise QualificationError(f"bound object is not at an exact governed CAS path: {binding['path']}")
    set_id, objects, sha_dir, prefix_dir, filename = parts[-5:]
    _validate_set_id(set_id)
    if objects != "objects" or sha_dir != "sha256" or prefix_dir != binding["sha256"][:2]:
        raise QualificationError(f"bound object is not at an exact governed CAS path: {binding['path']}")
    observed_suffix = PurePosixPath(filename).suffix.removeprefix(".")
    if filename != f"{binding['sha256']}.{observed_suffix}" or observed_suffix not in {"json", "txt", "bin"} or (extension and observed_suffix != extension):
        raise QualificationError(f"bound object is not at an exact governed CAS path: {binding['path']}")
    return set_id, observed_suffix


def _parse_manifest_binding(binding: dict[str, str]) -> str:
    if not isinstance(binding, dict) or set(binding) != {"path", "sha256"} or not SHA256_RE.fullmatch(str(binding.get("sha256", ""))):
        raise QualificationError("evidence manifest binding is not exact")
    relative = _normalized_relative_path(binding["path"], label="evidence manifest binding")
    prefix = (*EVIDENCE_SUFFIX.parts, "sets")
    if len(relative.parts) != len(prefix) + 2 or tuple(relative.parts[: len(prefix)]) != prefix or relative.parts[-1] != "manifest.json":
        raise QualificationError(f"bound evidence manifest is not at its exact governed path: {binding['path']}")
    _validate_set_id(relative.parts[-2])
    return relative.parts[-2]


def runtime_provenance() -> dict[str, str]:
    executable = Path(sys.executable).absolute()
    return {
        "verifier": SCRIPT_VERSION,
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "executablePath": str(executable),
        "executableRealPath": str(executable.resolve(strict=True)),
        "executableSha256": sha256_file(executable),
        "jsonschema": importlib.metadata.version("jsonschema"),
        "referencing": importlib.metadata.version("referencing"),
        "platform": platform.platform(),
    }


def _version_tuple(value: str, *, label: str) -> tuple[int, ...]:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", value):
        raise QualificationError(f"invalid {label} version policy: {value}")
    return tuple(int(part) for part in value.split("."))


def _major(value: str, *, label: str) -> int:
    try:
        return int(value.split(".", 1)[0])
    except ValueError as error:
        raise QualificationError(f"invalid {label} version: {value}") from error


def _file_records(root: Path, paths: Iterable[str]) -> list[dict[str, Any]]:
    records = []
    for relative in paths:
        path = _safe_repository_path(root, relative, must_exist=True)
        records.append({"path": relative, "sha256": sha256_file(path), "bytes": path.stat().st_size})
    return records


def _operative_repository_projection(root: Path, *, include_runtime_contracts: bool) -> dict[str, Any]:
    schema_root = _safe_repository_path(
        root, "verification/benchmarks/code-intelligence/schemas", must_exist=False
    )
    if not schema_root.is_dir() or schema_root.is_symlink():
        raise QualificationError("operative schema directory is unavailable or symlinked")
    observed_schema_paths = set()
    for path in schema_root.iterdir():
        if path.is_symlink() or not path.is_file():
            raise QualificationError("operative schema directory contains an unsupported entry")
        observed_schema_paths.add(path.relative_to(_normalized_root(root)).as_posix())
    if observed_schema_paths != set(OPERATIVE_SCHEMA_PATHS):
        raise QualificationError("operative schema inventory is incomplete or contains an unbound schema")
    policy_paths = OPERATIVE_POLICY_PATHS if include_runtime_contracts else REPOSITORY_BASELINE_POLICY_PATHS
    return {
        "sources": _file_records(root, OPERATIVE_SOURCE_PATHS),
        "schemas": _file_records(root, OPERATIVE_SCHEMA_PATHS),
        "policies": _file_records(root, policy_paths),
    }


def _distribution_record_hash(package_file: Any, path: Path) -> None:
    declared = package_file.hash
    if declared is None or declared.mode != "sha256":
        raise QualificationError(f"installed distribution file lacks a trustworthy SHA-256 RECORD identity: {path}")
    padding = "=" * (-len(declared.value) % 4)
    try:
        expected = base64.urlsafe_b64decode(declared.value + padding).hex()
    except (ValueError, TypeError) as error:
        raise QualificationError(f"installed distribution RECORD hash is invalid: {path}") from error
    if sha256_file(path) != expected or path.stat().st_size != package_file.size:
        raise QualificationError(f"installed distribution content differs from its RECORD metadata: {path}")


def _distribution_content_identity(name: str, contract: dict[str, Any]) -> dict[str, Any]:
    expected_keys = {
        "name", "version", "root", "packageRoots", "metadataPath", "recordPath",
        "fileCount", "totalBytes", "contentSetSha256", "metadataSha256", "recordSha256", "contentScope",
    }
    if not isinstance(contract, dict) or set(contract) != expected_keys:
        raise QualificationError(f"installed distribution host-receipt shape drift: {name}")
    try:
        distribution = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError as error:
        raise QualificationError(f"required installed distribution is unavailable: {name}") from error
    root = Path(distribution.locate_file("")).resolve(strict=True)
    expected_root = Path(contract["root"])
    if not expected_root.is_absolute() or expected_root.resolve(strict=True) != root or str(expected_root) != str(root):
        raise QualificationError(f"installed distribution root identity drift: {name}")
    if distribution.version != contract["version"] or contract["name"] != name:
        raise QualificationError(f"installed distribution version/name drift: {name}")
    package_roots = contract["packageRoots"]
    expected_package_roots = list(DISTRIBUTION_PACKAGE_ROOTS[name])
    if package_roots != expected_package_roots:
        raise QualificationError(f"installed distribution package-root contract drift: {name}")
    distribution_files = tuple(distribution.files or ())
    metadata_candidates = []
    record_candidates = []
    for package_file in distribution_files:
        raw = str(package_file).replace(os.sep, "/")
        candidate = PurePosixPath(raw)
        if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
            continue
        if len(candidate.parts) == 2 and candidate.parent.name.endswith(".dist-info"):
            if candidate.name == "METADATA":
                metadata_candidates.append(candidate)
            elif candidate.name == "RECORD":
                record_candidates.append(candidate)
    if len(metadata_candidates) != 1 or len(record_candidates) != 1 or metadata_candidates[0].parent != record_candidates[0].parent:
        raise QualificationError(f"installed distribution metadata inventory is ambiguous or incomplete: {name}")
    metadata_relative = _normalized_relative_path(contract["metadataPath"], label="distribution metadata path")
    record_relative = _normalized_relative_path(contract["recordPath"], label="distribution RECORD path")
    if metadata_relative != metadata_candidates[0] or record_relative != record_candidates[0]:
        raise QualificationError(f"installed distribution metadata paths drift: {name}")
    allowed_roots = [*_normalized_distribution_roots(package_roots), metadata_relative.parent.as_posix()]
    declared_files: dict[str, Any] = {}
    for package_file in distribution_files:
        raw = str(package_file).replace(os.sep, "/")
        candidate = PurePosixPath(raw)
        if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
            continue
        relative = candidate.as_posix()
        if not any(relative == prefix or relative.startswith(f"{prefix}/") for prefix in allowed_roots):
            continue
        if "__pycache__" in candidate.parts or candidate.suffix == ".pyc":
            continue
        if relative in declared_files:
            raise QualificationError(f"installed distribution metadata repeats a file: {name}:{relative}")
        declared_files[relative] = package_file
    observed_files: dict[str, Path] = {}
    for relative_root in allowed_roots:
        absolute_root = root.joinpath(*PurePosixPath(relative_root).parts)
        if not absolute_root.is_dir() or absolute_root.is_symlink() or not absolute_root.resolve(strict=True).is_relative_to(root):
            raise QualificationError(f"installed distribution content root is unavailable or escapes containment: {name}:{relative_root}")
        for current, directories, filenames in os.walk(absolute_root, followlinks=False):
            current_path = Path(current)
            for directory in tuple(directories):
                child = current_path / directory
                if child.is_symlink():
                    raise QualificationError(f"installed distribution contains a symlinked directory: {name}:{child}")
                if directory == "__pycache__":
                    directories.remove(directory)
            for filename in filenames:
                path = current_path / filename
                if filename.endswith(".pyc") or "__pycache__" in path.parts:
                    continue
                if path.is_symlink() or not path.is_file():
                    raise QualificationError(f"installed distribution contains a non-regular file: {name}:{path}")
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(root):
                    raise QualificationError(f"installed distribution file escapes its root: {name}:{path}")
                relative = resolved.relative_to(root).as_posix()
                if relative in observed_files:
                    raise QualificationError(f"installed distribution file inventory repeats a path: {name}:{relative}")
                observed_files[relative] = resolved
    if set(observed_files) != set(declared_files):
        raise QualificationError(f"installed distribution filesystem and RECORD inventories differ: {name}")
    for import_root in expected_package_roots:
        module = sys.modules.get(import_root)
        module_file = None if module is None else getattr(module, "__file__", None)
        if not isinstance(module_file, str):
            raise QualificationError(f"required distribution import root was not loaded from governed content: {name}:{import_root}")
        resolved_module = Path(module_file).resolve(strict=True)
        expected_import_root = (root / import_root).resolve(strict=True)
        if not resolved_module.is_relative_to(expected_import_root) or resolved_module.relative_to(root).as_posix() not in observed_files:
            raise QualificationError(f"required distribution import root escapes governed content: {name}:{import_root}")
        for module_name, loaded_module in tuple(sys.modules.items()):
            if module_name != import_root and not module_name.startswith(f"{import_root}."):
                continue
            loaded_file = getattr(loaded_module, "__file__", None)
            if not isinstance(loaded_file, str):
                raise QualificationError(f"loaded distribution module lacks a governed file identity: {name}:{module_name}")
            loaded_path = Path(loaded_file).resolve(strict=True)
            if loaded_path.suffix == ".pyc":
                loaded_path = Path(importlib.util.source_from_cache(str(loaded_path))).resolve(strict=True)
            if not loaded_path.is_relative_to(expected_import_root) or loaded_path.relative_to(root).as_posix() not in observed_files:
                raise QualificationError(f"loaded distribution module escapes governed content: {name}:{module_name}")
    records = []
    for relative in sorted(observed_files):
        path = observed_files[relative]
        if relative != record_relative.as_posix():
            _distribution_record_hash(declared_files[relative], path)
        records.append({"path": relative, "sha256": sha256_file(path), "bytes": path.stat().st_size})
    metadata_path = observed_files.get(metadata_relative.as_posix())
    record_path = observed_files.get(record_relative.as_posix())
    if metadata_path is None or record_path is None:
        raise QualificationError(f"installed distribution lacks governed METADATA/RECORD bytes: {name}")
    identity = {
        "name": name,
        "version": distribution.version,
        "root": str(root),
        "packageRoots": package_roots,
        "metadataPath": metadata_relative.as_posix(),
        "recordPath": record_relative.as_posix(),
        "fileCount": len(records),
        "totalBytes": sum(record["bytes"] for record in records),
        "contentSetSha256": sha256_json(records),
        "metadataSha256": sha256_file(metadata_path),
        "recordSha256": sha256_file(record_path),
        "contentScope": "all-recorded-import-package-and-dist-info-files-excluding-bytecode-cache",
    }
    if identity != contract:
        raise QualificationError(f"installed distribution content identity drift: {name}")
    return identity


def _normalized_distribution_roots(values: list[Any]) -> list[str]:
    normalized = []
    for value in values:
        path = _normalized_relative_path(value, label="distribution package root")
        if len(path.parts) != 1:
            raise QualificationError("distribution package roots must be single repository-independent names")
        normalized.append(path.as_posix())
    return normalized


def _executable_identity(name: str, contract: dict[str, Any]) -> dict[str, str]:
    path = Path(contract["path"])
    if not path.is_absolute() or not path.is_file():
        raise QualificationError(f"qualified {name} executable is unavailable")
    real_path = path.resolve(strict=True)
    observed = {
        "path": str(path),
        "realPath": str(real_path),
        "sha256": sha256_file(path),
    }
    if observed["realPath"] != contract["realPath"] or observed["sha256"] != contract["executableSha256"]:
        raise QualificationError(f"qualified {name} executable identity drift")
    return observed


def _runtime_contract_documents(root: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    pointer_path = _safe_repository_path(root, RUNTIME_POINTER_PATH, must_exist=True)
    pointer = load_json(pointer_path)
    expected_pointer_keys = {
        "schemaVersion", "scope", "compatibilityPolicy", "compatibilityPolicySha256",
        "hostReceipt", "hostReceiptSha256",
    }
    if (
        set(pointer) != expected_pointer_keys
        or pointer.get("schemaVersion") != "code-intelligence-independent-verifier-runtime-pointer/v3"
        or pointer.get("compatibilityPolicy") != RUNTIME_POLICY_PATH
        or pointer.get("hostReceipt") != RUNTIME_HOST_RECEIPT_PATH
    ):
        raise QualificationError("runtime pointer is not the exact canonical closed contract")
    policy_path = _safe_repository_path(root, RUNTIME_POLICY_PATH, must_exist=True)
    host_path = _safe_repository_path(root, RUNTIME_HOST_RECEIPT_PATH, must_exist=True)
    if sha256_file(policy_path) != pointer["compatibilityPolicySha256"] or sha256_file(host_path) != pointer["hostReceiptSha256"]:
        raise QualificationError("runtime pointer target byte identity mismatch")
    policy = load_json(policy_path)
    host = load_json(host_path)
    expected_policy_keys = {"schemaVersion", "scope", "python", "node", "openssl", "canonicalIdentitySubset", "missingBehavior"}
    expected_host_keys = {
        "schemaVersion", "observedAt", "python", "node", "openssl", "distributions",
        "repositoryContent", "qualificationEffect",
    }
    if set(policy) != expected_policy_keys or set(host) != expected_host_keys:
        raise QualificationError("runtime policy or host receipt is not an exact closed contract")
    if set(policy["python"]) != {"implementation", "minimum", "jsonschemaMajor", "referencingMajor"}:
        raise QualificationError("runtime Python compatibility policy shape drift")
    if set(policy["node"]) != {"minimum", "maximumExclusive", "purpose"} or set(policy["openssl"]) != {"minimumMajor", "purpose"}:
        raise QualificationError("runtime Node/OpenSSL compatibility policy shape drift")
    if set(policy["canonicalIdentitySubset"]) != {"objectKeys", "stringValues", "numbers", "other", "floats", "normalization", "broaderRfc8785"}:
        raise QualificationError("restricted canonical identity policy shape drift")
    if set(host["python"]) != {"version", "path", "realPath", "executableSha256"}:
        raise QualificationError("runtime Python host receipt shape drift")
    if set(host["node"]) != {"version", "path", "realPath", "executableSha256"} or set(host["openssl"]) != {"versionPrefix", "path", "realPath", "executableSha256"}:
        raise QualificationError("runtime Node/OpenSSL host receipt shape drift")
    if set(host["distributions"]) != set(EXPECTED_DISTRIBUTIONS):
        raise QualificationError("runtime distribution host receipt inventory drift")
    if set(host["repositoryContent"]) != {"projectionSha256", "sourceCount", "schemaCount", "policyCount"}:
        raise QualificationError("runtime governed repository-content receipt shape drift")
    if policy["schemaVersion"] != "code-intelligence-independent-verifier-runtime-policy/v1" or host["schemaVersion"] != "code-intelligence-independent-verifier-host-receipt/v2":
        raise QualificationError("unsupported runtime policy or host-receipt version")
    return pointer, policy, host


def validate_runtime_contract(root: Path) -> dict[str, str]:
    receipt = runtime_provenance()
    pointer, policy, host = _runtime_contract_documents(root)
    governed_verifier = _safe_repository_path(root, OPERATIVE_SOURCE_PATHS[0], must_exist=True)
    executing_verifier = Path(__file__).resolve(strict=True)
    if executing_verifier != governed_verifier or sha256_file(executing_verifier) != sha256_file(governed_verifier):
        raise QualificationError("executing verifier real path/bytes do not equal the governed qualification.py")
    baseline = _operative_repository_projection(root, include_runtime_contracts=False)
    expected_baseline = {
        "projectionSha256": sha256_json(baseline),
        "sourceCount": len(baseline["sources"]),
        "schemaCount": len(baseline["schemas"]),
        "policyCount": len(baseline["policies"]),
    }
    if host["repositoryContent"] != expected_baseline:
        raise QualificationError("governed verifier/generator/canonicalizer/schema/policy content identity drift")
    interpreter = host["python"]
    if receipt["implementation"] != policy["python"]["implementation"]:
        raise QualificationError("independent verifier interpreter implementation drift")
    if _version_tuple(receipt["python"], label="Python") < _version_tuple(policy["python"]["minimum"], label="minimum Python"):
        raise QualificationError("independent verifier Python is below the central runtime-policy minimum")
    python_executable = _executable_identity("Python", interpreter)
    if (
        receipt["python"] != interpreter["version"]
        or receipt["executablePath"] != interpreter["path"]
        or receipt["executableRealPath"] != interpreter["realPath"]
        or receipt["executableSha256"] != interpreter["executableSha256"]
    ):
        raise QualificationError("independent verifier interpreter identity drift; refresh qualification deliberately")
    distribution_identities = {
        name: _distribution_content_identity(name, host["distributions"][name])
        for name in EXPECTED_DISTRIBUTIONS
    }
    for name in ("jsonschema", "referencing"):
        observed = distribution_identities[name]["version"]
        required_major = policy["python"][f"{name}Major"]
        if _major(observed, label=name) != required_major:
            raise QualificationError(f"independent verifier dependency drift: {name}")
    node_contract = host["node"]
    node = Path(node_contract["path"])
    node_executable = _executable_identity("Node", node_contract)
    import subprocess
    version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if version.removeprefix("v") != node_contract["version"]:
        raise QualificationError("qualified Node cross-runtime version drift")
    observed_node = _version_tuple(node_contract["version"], label="Node")
    if not (_version_tuple(policy["node"]["minimum"], label="minimum Node") <= observed_node < _version_tuple(policy["node"]["maximumExclusive"], label="maximum Node")):
        raise QualificationError("qualified Node is outside the central runtime-policy range")
    openssl_contract = host["openssl"]
    openssl = Path(openssl_contract["path"])
    openssl_executable = _executable_identity("OpenSSL", openssl_contract)
    openssl_version = subprocess.run([openssl, "version"], check=True, capture_output=True, text=True).stdout.strip()
    if not openssl_version.startswith(openssl_contract["versionPrefix"]):
        raise QualificationError("qualified OpenSSL version drift")
    openssl_match = re.match(r"^OpenSSL ([0-9]+)\.", openssl_version)
    if not openssl_match or int(openssl_match.group(1)) < policy["openssl"]["minimumMajor"]:
        raise QualificationError("qualified OpenSSL is below the central runtime-policy minimum")
    toolchain_projection: dict[str, Any] = {
        "schemaVersion": "code-intelligence-independent-verifier-toolchain-projection/v1",
        "scriptVersion": SCRIPT_VERSION,
        "governedRepository": _operative_repository_projection(root, include_runtime_contracts=True),
        "executables": {
            "python": python_executable,
            "node": node_executable,
            "openssl": openssl_executable,
        },
        "distributions": [distribution_identities[name] for name in EXPECTED_DISTRIBUTIONS],
    }
    return {
        **receipt, "node": version, "nodeExecutableSha256": node_contract["executableSha256"],
        "openssl": openssl_version, "opensslExecutableSha256": openssl_contract["executableSha256"],
        "runtimePolicySha256": sha256_json(policy),
        "hostReceiptSha256": sha256_json(host),
        "toolchainSha256": sha256_json(toolchain_projection),
    }


def validate_canonical_subset(value: Any, path: str = "$") -> None:
    """Reject values outside the cross-runtime identity subset.

    This is intentionally narrower than RFC 8785: ASCII object keys, already-NFC
    strings, safe integers, booleans, null, arrays, and objects. Floats are never
    normalized or formatted by this verifier.
    """
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise QualificationError(f"unsafe integer at {path}")
        return
    if isinstance(value, float):
        raise QualificationError(f"floating-point number forbidden at {path}")
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise QualificationError(f"non-NFC string forbidden at {path}")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise QualificationError(f"invalid Unicode string at {path}") from error
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            validate_canonical_subset(item, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not ASCII_KEY_RE.fullmatch(key):
                raise QualificationError(f"non-ASCII or invalid object key at {path}")
            validate_canonical_subset(item, f"{path}.{key}")
        return
    raise QualificationError(f"unsupported identity value type at {path}: {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    """Canonical bytes for the deliberately restricted cross-runtime subset."""
    validate_canonical_subset(value)
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    def reject_float(token: str) -> Any:
        raise QualificationError(f"floating-point JSON number forbidden in {path}: {token}")
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise QualificationError(f"duplicate JSON object key forbidden in {path}: {key}")
            value[key] = item
        return value
    try:
        value = json.loads(
            path.read_bytes().decode("utf-8", errors="strict"),
            parse_float=reject_float,
            object_pairs_hook=reject_duplicate_keys,
        )
        validate_canonical_subset(value)
        return value
    except (OSError, json.JSONDecodeError, UnicodeError) as error:
        raise QualificationError(f"cannot load {path}: {error}") from error


def _load_repository_json(root: Path, relative: str) -> Any:
    return load_json(_safe_repository_path(root, relative, must_exist=True))


def _load_cli_repository_json(root: Path, path: Path) -> Any:
    normalized_root = _normalized_root(root)
    candidate = path if path.is_absolute() else normalized_root / path
    try:
        relative = candidate.absolute().relative_to(normalized_root).as_posix()
    except ValueError as error:
        raise QualificationError(f"CLI input path escapes the repository root: {path}") from error
    return _load_repository_json(normalized_root, relative)


def _schema_dir(root: Path) -> Path:
    return root / "verification/benchmarks/code-intelligence/schemas"


def validate_schema(root: Path, schema_name: str, instance: Any) -> None:
    if not re.fullmatch(r"[a-z0-9-]+\.schema\.json", schema_name):
        raise QualificationError(f"invalid schema name: {schema_name}")
    schema_path = _safe_repository_path(root, f"verification/benchmarks/code-intelligence/schemas/{schema_name}", must_exist=True)
    schema = load_json(schema_path)
    snapshot_schema = load_json(_safe_repository_path(root, "verification/benchmarks/code-intelligence/schemas/repository-snapshot.schema.json", must_exist=True))
    registry = Registry().with_resource(
        snapshot_schema["$id"], Resource.from_contents(snapshot_schema)
    )
    validator_class = jsonschema.validators.validator_for(schema)
    validator_class.check_schema(schema)
    validator = validator_class(schema, registry=registry, format_checker=jsonschema.FormatChecker())
    errors = sorted(validator.iter_errors(instance), key=lambda item: list(item.absolute_path))
    if errors:
        detail = "; ".join(f"/{'/'.join(map(str, error.absolute_path))}: {error.message}" for error in errors[:12])
        raise QualificationError(f"{schema_name} rejected instance: {detail}")


def _schema_property_const(root: Path, schema_name: str, property_name: str) -> str:
    schema = load_json(_safe_repository_path(root, f"verification/benchmarks/code-intelligence/schemas/{schema_name}", must_exist=True))
    value = schema.get("properties", {}).get(property_name, {}).get("const")
    if not isinstance(value, str) or not value:
        raise QualificationError(f"{schema_name} lacks authoritative {property_name} const")
    return value


def _exact_ids(observed: Iterable[str], expected: set[str], label: str) -> None:
    values = list(observed)
    if len(values) != len(set(values)):
        raise QualificationError(f"{label} contains duplicate IDs")
    if set(values) != expected:
        raise QualificationError(
            f"{label} mismatch; missing={sorted(expected - set(values))}, extra={sorted(set(values) - expected)}"
        )


def _validate_trust_registry(
    entries: Any, *, id_field: str, required_fields: Any, expected_fields: set[str], label: str,
) -> dict[str, dict[str, Any]]:
    if not isinstance(required_fields, list) or len(required_fields) != len(set(required_fields)) or set(required_fields) != expected_fields:
        raise QualificationError(f"{label} required-field contract drift")
    if not isinstance(entries, list):
        raise QualificationError(f"{label} registry must be an array")
    by_id: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != expected_fields:
            raise QualificationError(f"{label} registry entry shape drift")
        identity = entry.get(id_field)
        if not isinstance(identity, str) or not identity or identity in by_id:
            raise QualificationError(f"{label} registry contains an invalid or duplicate identity")
        if not SHA256_RE.fullmatch(str(entry.get("toolchainSha256", ""))):
            raise QualificationError(f"{label} registry lacks an exact toolchain identity")
        by_id[identity] = entry
    return by_id


def validate_protocol_bundle(root: Path) -> dict[str, str]:
    catalog = load_json(_safe_repository_path(root, "docs/research/code-intelligence/candidates.v1.json", must_exist=True))
    protocol = load_json(_safe_repository_path(root, "docs/research/code-intelligence/protocol.v2.json", must_exist=True))
    oracle = load_json(_safe_repository_path(root, "docs/research/code-intelligence/query-oracle.v1.json", must_exist=True))
    scenarios = load_json(_safe_repository_path(root, "docs/research/code-intelligence/scenarios.v1.json", must_exist=True))
    lock = load_json(_safe_repository_path(root, POLICY_BUNDLE_LOCK_PATH, must_exist=True))
    validate_schema(root, "policy-bundle-lock.schema.json", lock)
    supported_versions = {
        "candidate-catalog": ("code-intelligence-candidate-catalog/v1", "catalogVersion", "2.0.0", 2),
        "qualification-protocol": ("code-intelligence-qualification-protocol/v2", "protocolVersion", "3.0.0", 3),
        "query-oracle": ("code-intelligence-query-oracle/v1", "oracleVersion", "2.0.0", 2),
        "scenario-catalog": ("code-intelligence-scenario-catalog/v1", "catalogVersion", "2.0.0", 2),
    }
    documents = {item["id"]: item for item in lock["documents"]}
    if set(documents) != set(supported_versions) or lock["bundleVersion"] != "3.0.0" or lock["semanticEpoch"] != 3:
        raise QualificationError("unsupported policy bundle version or document set")
    values = {"candidate-catalog": catalog, "qualification-protocol": protocol, "query-oracle": oracle, "scenario-catalog": scenarios}
    schema_names = {"candidate-catalog": "candidate-catalog.schema.json", "qualification-protocol": "qualification-protocol.schema.json", "query-oracle": "query-oracle.schema.json", "scenario-catalog": "scenario-catalog.schema.json"}
    document_paths = CANONICAL_POLICY_DOCUMENT_PATHS
    # The generated closed schemas are checked byte-for-byte before use.
    import importlib.util
    generator_path = _safe_repository_path(root, "verification/benchmarks/code-intelligence/policy_schemas.py", must_exist=True)
    generator_spec = importlib.util.spec_from_file_location("code_intelligence_policy_schemas", generator_path)
    if generator_spec is None or generator_spec.loader is None:
        raise QualificationError("policy schema generator unavailable")
    generator = importlib.util.module_from_spec(generator_spec); generator_spec.loader.exec_module(generator)
    for document_id, value in values.items():
        lock_item = documents[document_id]
        expected_schema_path = f"verification/benchmarks/code-intelligence/schemas/{schema_names[document_id]}"
        if lock_item["path"] != document_paths[document_id] or lock_item["schemaPath"] != expected_schema_path:
            raise QualificationError(f"policy lock redirects a canonical path: {document_id}")
        expected_version, version_field, expected_semantic_version, expected_epoch = supported_versions[document_id]
        if value.get("schemaVersion") != expected_version or value.get(version_field) != expected_semantic_version or value.get("semanticEpoch") != expected_epoch:
            raise QualificationError(f"unsupported {document_id} semantic version/epoch")
        path = _safe_repository_path(root, lock_item["path"], must_exist=True)
        schema_path = _safe_repository_path(root, lock_item["schemaPath"], must_exist=True)
        expected_schema = generator.encoded(generator.expected_schema(value, schema_names[document_id]))
        if schema_path.read_bytes() != expected_schema:
            raise QualificationError(f"closed policy schema drift: {document_id}")
        validate_schema(root, schema_names[document_id], value)
        if (
            sha256_file(path) != lock_item["byteSha256"]
            or sha256_json(value) != lock_item["canonicalSha256"]
            or sha256_file(schema_path) != lock_item["schemaSha256"]
            or lock_item["documentVersion"] != expected_version
            or lock_item["semanticVersion"] != expected_semantic_version
            or lock_item["semanticEpoch"] != expected_epoch
        ):
            raise QualificationError(f"policy lock identity mismatch: {document_id}")
    transition = lock["transition"]
    if transition["fromSemanticEpoch"] >= transition["toSemanticEpoch"] or transition["toSemanticEpoch"] != lock["semanticEpoch"]:
        raise QualificationError("policy semantic change lacks a monotonic version transition")
    if lock["trustStatus"] != "integrity-only-untrusted-no-qualified-signer" or lock["signature"] is not None or lock["qualificationPermitted"]:
        raise QualificationError("foundation policy lock trust status is overstated")
    _exact_ids((item["id"] for item in catalog["candidates"]), REQUIRED_CANDIDATES, "candidate catalog")
    _exact_ids((item["id"] for item in oracle["classes"]), REQUIRED_QUERY_CLASSES, "oracle classes")
    if protocol["resolution"]["selector"] != "latest-stable-at-run":
        raise QualificationError("protocol must resolve latest stable at run time")
    forbidden = ("silentFallback", "closestVersionFallback", "alternateEngineFallback")
    if any(protocol["resolution"].get(key) != "forbidden" for key in forbidden):
        raise QualificationError("every resolution fallback must be forbidden")
    matrix = protocol["executionMatrix"]
    if matrix["repetitionsPerScenario"] != 3 or matrix["minimumMateriallyDistinctScenarios"] < 3:
        raise QualificationError("protocol must require x3 repetitions and at least three distinct scenarios")
    scenario_ids = [item["id"] for item in scenarios["scenarios"]]
    if set(matrix["requiredScenarioIds"]) - set(scenario_ids):
        raise QualificationError("protocol references missing scenario IDs")
    if scenarios["repetitionsPerCandidateScenario"] != 3:
        raise QualificationError("scenario catalog must require exactly three repetitions")
    observed_classes = {item["class"] for item in scenarios["scenarios"]}
    if not set(matrix["minimumFixtureClasses"]).issubset(observed_classes):
        raise QualificationError("scenario catalog lacks required fixture classes")
    observed_languages = {language for item in scenarios["scenarios"] for language in item["languages"]}
    if not set(matrix["minimumLanguagesAcrossMatrix"]).issubset(observed_languages):
        raise QualificationError("scenario catalog lacks required language coverage")
    if set(protocol["fatalInvariants"]) != REQUIRED_FATAL_INVARIANTS:
        raise QualificationError("fatal invariant set drifted")
    if protocol["claimBoundary"]["rankingPermitted"] or protocol["claimBoundary"]["candidatesQualified"]:
        raise QualificationError("foundation protocol cannot claim a ranking or qualification")
    critical_true = [
        ("resolution", "freezeBeforeFixtureAccess"), ("resolution", "rejectDraft"),
        ("resolution", "rejectPrereleaseMetadata"), ("resolution", "rejectSemverPrereleaseTag"),
        ("resolution", "recordEveryExaminedRelease"), ("resolution", "requireImmutableTagCommit"),
        ("resolution", "requireSourceArchiveSha256"), ("resolution", "requireInstalledExecutableSha256"),
        ("resolution", "requireDependencyLockOrImageDigests"), ("resolution", "requireToolSchemaSha256"),
        ("resolution", "requireGovernedRawOfficialReleasePages"), ("resolution", "requireGovernedRawOfficialLicenseBytes"),
        ("resolution", "onlineVerifierIdentityAndToolchainSha256Required"),
        ("authorization", "snapshotAllowlistRequired"), ("authorization", "credentialReferenceOnly"),
        ("authorization", "rawSecretsForbidden"), ("authorization", "purposeBound"),
        ("authorization", "authorityIdentityAndToolchainSha256Required"),
        ("repositorySnapshot", "descriptorRequired"), ("repositorySnapshot", "absoluteCanonicalRootRequired"),
        ("queryQualification", "oracleMustPreexistCandidateRun"), ("queryQualification", "candidateOutputCannotDefineTruth"),
        ("queryQualification", "exactSourceEvidenceRequired"), ("queryQualification", "modelSelfGradingForbidden"),
        ("evidence", "rawAndDerivedContentAddressed"), ("evidence", "temporaryOnlyEvidenceForbidden"),
        ("evidence", "manifestBindsEveryObject"), ("bootstrap", "sameInputsMustProduceSameBytes"),
        ("bootstrap", "everyFactSourceLinked"), ("bootstrap", "admittedRunOnly"),
        ("admission", "candidateRunnerCannotAdmit"), ("admission", "independentOracleReconcilerRequired"),
        ("admission", "independentEvidenceReviewerRequired"), ("admission", "reviewMustRecomputeAllContentDigests"),
        ("admission", "reviewerIdentityAndToolchainSha256Required"),
        ("admission", "reviewMustReconcileEveryEligiblePath"), ("admission", "allFatalInvariantsPass"),
        ("admission", "preAdmissionProjectionRequiredToAvoidCircularAdmissionIdentity"),
    ]
    if any(protocol[section].get(key) is not True for section, key in critical_true):
        raise QualificationError("critical protocol safety/admission invariant was downgraded")
    if protocol["authorization"]["externalEgressDefault"] != "deny" or protocol["resolution"]["unresolvedOutcome"] != "candidate-arm-blocked":
        raise QualificationError("critical fail-closed outcome was downgraded")
    _validate_trust_registry(
        protocol["resolution"]["trustedOnlineVerifiers"], id_field="verifierId",
        required_fields=protocol["resolution"]["trustedOnlineVerifierEntryRequiredFields"],
        expected_fields={"verifierId", "toolchainSha256"}, label="online verifier",
    )
    _validate_trust_registry(
        protocol["authorization"]["trustedAuthorizationAuthorities"], id_field="authorityId",
        required_fields=protocol["authorization"]["trustedAuthorizationAuthorityEntryRequiredFields"],
        expected_fields={"authorityId", "toolchainSha256"}, label="snapshot authorizer",
    )
    _validate_trust_registry(
        protocol["admission"]["trustedReviewers"], id_field="reviewerId",
        required_fields=protocol["admission"]["trustedReviewerEntryRequiredFields"],
        expected_fields={"reviewerId", "role", "publicKeySha256", "toolchainSha256"}, label="admission reviewer",
    )
    bootstrap_schema = load_json(_safe_repository_path(root, "verification/benchmarks/code-intelligence/schemas/bootstrap-output.schema.json", must_exist=True))
    if bootstrap_schema["properties"]["builderVersion"].get("const") != protocol["bootstrap"]["builderVersion"]:
        raise QualificationError("bootstrap builder version is not sourced from the protocol")
    identity_required = set(bootstrap_schema["properties"]["projection"]["properties"]["identity"]["required"])
    if not set(protocol["bootstrap"]["requiredInputs"]).issubset(identity_required):
        raise QualificationError("bootstrap output schema omits a protocol-required input identity")
    for candidate in catalog["candidates"]:
        urls = [candidate.get("license", {}).get("source", "")]
        resolver = candidate.get("resolver", {})
        if resolver.get("repository"):
            urls.append(f"https://github.com/{resolver['repository']}")
        if any("example.invalid" in url or not url.startswith("https://") for url in urls):
            raise QualificationError(f"candidate {candidate['id']} uses a non-official or invalid source URL")
    if any(not item["question"].strip() or not item["metrics"] for item in oracle["classes"]):
        raise QualificationError("oracle contains an empty question or metric contract")
    if scenarios["executable"] is not False or not scenarios["executionBlockers"]:
        raise QualificationError("scenario catalog overstates executable fixture evidence")
    return {
        "catalogSha256": sha256_json(catalog), "protocolSha256": sha256_json(protocol),
        "oracleSha256": sha256_json(oracle), "scenariosSha256": sha256_json(scenarios),
        "policyBundleSha256": sha256_json(lock), "policyTrusted": "false",
    }


def validate_resolution(root: Path, resolution: dict[str, Any]) -> bool:
    validate_schema(root, "candidate-resolution.schema.json", resolution)
    validate_protocol_bundle(root)
    catalog = _load_repository_json(root, "docs/research/code-intelligence/candidates.v1.json")
    candidate = next((item for item in catalog["candidates"] if item["id"] == resolution["candidateId"]), None)
    if candidate is None:
        raise QualificationError("resolution candidate is not cataloged")
    selected = resolution.get("selected")
    accepted = [item for item in resolution["examinedReleases"] if item["accepted"]]
    if resolution["resolutionClass"] == "synthetic-untrusted":
        if accepted or selected is not None or resolution["status"] != "blocked" or resolution["trustedForQualification"]:
            raise QualificationError("synthetic resolution cannot select or trust a candidate")
        return False
    if resolution["status"] == "resolved":
        if len(accepted) != 1 or accepted[0]["releaseId"] != selected["releaseId"]:
            raise QualificationError("resolved receipt must identify exactly one accepted examined release")
        match = STABLE_TAG_RE.fullmatch(selected["tag"])
        if not match or selected["version"] != match.group(1):
            raise QualificationError("selected release is not an exact stable semantic version")
        if resolution["licenseDisposition"] != "approved-for-benchmark-purpose":
            raise QualificationError("resolved candidate lacks purpose-specific license approval")
    elif accepted:
        raise QualificationError("blocked resolution cannot accept a release")
    resolver_config = candidate["resolver"]
    if resolver_config["type"] != "github-releases":
        raise QualificationError("service resolution needs a separate authorized service verifier")
    repository = resolver_config["repository"]
    evidence = load_bound_json_object(root, resolution["resolverEvidence"])
    license_evidence = load_bound_json_object(root, resolution["licenseEvidence"])
    manifest = load_bound_manifest(root, resolution["evidenceManifest"])
    validate_evidence_manifest(root, manifest)
    if evidence.get("schemaVersion") != "code-intelligence-official-resolver-evidence/v1" or evidence.get("repository") != repository:
        raise QualificationError("official resolver evidence repository mismatch")
    resolution_policy = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")["resolution"]
    trusted_verifiers = _validate_trust_registry(
        resolution_policy.get("trustedOnlineVerifiers"), id_field="verifierId",
        required_fields=resolution_policy.get("trustedOnlineVerifierEntryRequiredFields"),
        expected_fields={"verifierId", "toolchainSha256"}, label="online verifier",
    )
    verifier = trusted_verifiers.get(evidence.get("onlineVerifierId"))
    if verifier is None:
        raise QualificationError("official resolution lacks a trusted independent online verifier")
    if evidence.get("onlineVerifierToolchainSha256") != verifier["toolchainSha256"] or resolution.get("resolverToolchainSha256") != verifier["toolchainSha256"]:
        raise QualificationError("official resolution verifier toolchain identity mismatch")
    pages = evidence.get("pages")
    if not isinstance(pages, list) or not pages or pages[-1].get("terminal") is not True:
        raise QualificationError("official release enumeration is not complete")
    flattened: list[dict[str, Any]] = []
    for index, page in enumerate(pages, start=1):
        expected_url = f"https://api.github.com/repos/{repository}/releases?per_page=100&page={index}"
        if page.get("page") != index or page.get("url") != expected_url or page.get("terminal") != (index == len(pages)):
            raise QualificationError("official release pagination is not ordered and terminal")
        raw_bytes = load_bound_bytes(root, page["rawResponse"])
        try:
            raw = json.loads(raw_bytes)
        except json.JSONDecodeError as error:
            raise QualificationError("official release raw response is not JSON") from error
        if not isinstance(raw, list) or raw != page.get("releases"):
            raise QualificationError("official release page does not match its governed raw response")
        flattened.extend(raw)
    if len({item.get("id") for item in flattened}) != len(flattened):
        raise QualificationError("official release enumeration contains duplicate release IDs")
    projected = [
        {"releaseId": item["id"], "tag": item["tag_name"], "draft": bool(item["draft"]), "prerelease": bool(item["prerelease"])}
        for item in flattened
    ]
    examined_projection = [{key: item[key] for key in ("releaseId", "tag", "draft", "prerelease")} for item in resolution["examinedReleases"]]
    if projected != examined_projection:
        raise QualificationError("resolution does not enumerate every governed official release exactly")
    stable = next((item for item in flattened if not item["draft"] and not item["prerelease"] and STABLE_TAG_RE.fullmatch(item["tag_name"])), None)
    if stable is None or stable["id"] != selected["releaseId"] or stable["tag_name"] != selected["tag"]:
        raise QualificationError("selected release is not the latest actual stable in official enumeration")
    expected_release_url = f"https://github.com/{repository}/releases/tag/{selected['tag']}"
    if selected["releaseUrl"] != expected_release_url or not selected["sourceArchiveUri"].startswith(f"https://api.github.com/repos/{repository}/tarball/"):
        raise QualificationError("selected release/source URL is not the exact official repository identity")
    if (
        license_evidence.get("schemaVersion") != "code-intelligence-official-license-evidence/v1"
        or license_evidence.get("repository") != repository
        or license_evidence.get("sourceUrl") != candidate["license"]["source"]
        or not isinstance(license_evidence.get("rawLicenseObject"), dict)
        or license_evidence.get("disposition") != resolution["licenseDisposition"]
    ):
        raise QualificationError("governed official license evidence is missing or mismatched")
    manifest_hashes = {item["sha256"] for item in manifest["objects"]}
    required_hashes = {resolution["resolverEvidence"]["sha256"], resolution["licenseEvidence"]["sha256"]}
    required_hashes.update(page["rawResponse"]["sha256"] for page in pages)
    raw_license = load_bound_bytes(root, license_evidence["rawLicenseObject"])
    if sha256_bytes(raw_license) != license_evidence["rawLicenseObject"]["sha256"]:
        raise QualificationError("official license raw-byte digest mismatch")
    required_hashes.add(license_evidence["rawLicenseObject"]["sha256"])
    if not required_hashes.issubset(manifest_hashes):
        raise QualificationError("resolution evidence manifest omits governed resolver/license objects")
    return True


def load_bound_json_object(root: Path, binding: dict[str, str]) -> dict[str, Any]:
    _parse_cas_binding(binding, extension="json")
    path = _safe_repository_path(root, binding["path"], must_exist=True)
    payload = path.read_bytes()
    if sha256_bytes(payload) != binding["sha256"]:
        raise QualificationError(f"bound governed object digest mismatch: {binding['path']}")
    value = load_json(path)
    if canonical_bytes(value) != payload:
        raise QualificationError(f"bound object is not canonical: {binding['path']}")
    return value


def load_bound_bytes(root: Path, binding: dict[str, str]) -> bytes:
    _parse_cas_binding(binding)
    path = _safe_repository_path(root, binding["path"], must_exist=True)
    if sha256_file(path) != binding["sha256"]:
        raise QualificationError(f"bound governed byte object missing or mismatched: {binding['path']}")
    return path.read_bytes()


def load_bound_manifest(root: Path, binding: dict[str, str]) -> dict[str, Any]:
    _parse_manifest_binding(binding)
    path = _safe_repository_path(root, binding["path"], must_exist=True)
    payload = path.read_bytes()
    if sha256_bytes(payload) != binding["sha256"]:
        raise QualificationError(f"bound evidence manifest digest mismatch: {binding['path']}")
    return load_json(path)


def validate_snapshot(root: Path, snapshot: dict[str, Any]) -> bool:
    validate_schema(root, "repository-snapshot.schema.json", snapshot)
    validate_protocol_bundle(root)
    paths = [item["path"] for item in snapshot["files"]]
    if len(paths) != len(set(paths)):
        raise QualificationError("snapshot file manifest contains duplicate paths")
    eligible: set[tuple[str, str]] = set()
    for item in snapshot["files"]:
        if item["disposition"] == "eligible":
            content_hash = item.get("contentSha256")
            if not content_hash or not SHA256_RE.fullmatch(content_hash):
                raise QualificationError(f"eligible file lacks content hash: {item['path']}")
            eligible.add((item["path"], content_hash))
        elif not item["reason"].strip():
            raise QualificationError(f"non-eligible file lacks reason: {item['path']}")
    indexed_items = [(item["path"], item["contentSha256"]) for item in snapshot["indexInventory"]]
    if len(indexed_items) != len(set(indexed_items)):
        raise QualificationError("index inventory contains duplicates")
    indexed = set(indexed_items)
    if eligible != indexed:
        raise QualificationError(
            f"eligible/index reconciliation failed; missing={sorted(eligible-indexed)}, extra_or_wrong={sorted(indexed-eligible)}"
        )
    freshness = snapshot["freshness"]
    if not freshness["reconciled"] or freshness["concurrentChangeDetected"]:
        raise QualificationError("snapshot is stale, unreconciled, or concurrently changed")
    if freshness["captureGeneration"] != freshness["indexGeneration"]:
        raise QualificationError("snapshot and index generation differ")
    if snapshot["snapshotClass"] == "synthetic-untrusted":
        if snapshot["trustedForQualification"]:
            raise QualificationError("synthetic snapshot cannot be trusted for qualification")
        return False
    protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")
    authorization = load_bound_json_object(root, snapshot["authorizationReceipt"])
    discovery = load_bound_json_object(root, snapshot["eligibleDiscoveryReceipt"])
    required_authorization = {
        "schemaVersion": "code-intelligence-snapshot-authorization/v1",
        "authorityId": authorization.get("authorityId"),
        "canonicalRoot": snapshot["root"]["canonicalPath"],
        "descriptorSha256": snapshot["root"]["descriptorSha256"],
        "repositoryIdentitySha256": snapshot["root"]["repositoryIdentitySha256"],
        "candidateResolutionSha256": snapshot["candidateResolutionSha256"],
        "purpose": snapshot["purpose"],
    }
    if any(authorization.get(key) != value for key, value in required_authorization.items()):
        raise QualificationError("snapshot authorization receipt binding mismatch")
    authorization_policy = protocol["authorization"]
    trusted_authorities = _validate_trust_registry(
        authorization_policy["trustedAuthorizationAuthorities"], id_field="authorityId",
        required_fields=authorization_policy["trustedAuthorizationAuthorityEntryRequiredFields"],
        expected_fields={"authorityId", "toolchainSha256"}, label="snapshot authorizer",
    )
    authority = trusted_authorities.get(authorization.get("authorityId"))
    if authority is None:
        raise QualificationError("snapshot authorization authority is not trusted by the policy bundle")
    if authorization.get("authorizerToolchainSha256") != authority["toolchainSha256"]:
        raise QualificationError("snapshot authorization toolchain identity mismatch")
    expected_discovery_files = sorted(
        ({"path": item["path"], "disposition": item["disposition"], "contentSha256": item.get("contentSha256"), "reason": item["reason"]} for item in snapshot["files"]),
        key=lambda item: item["path"],
    )
    if (
        discovery.get("schemaVersion") != "code-intelligence-eligible-discovery/v1"
        or discovery.get("canonicalRoot") != snapshot["root"]["canonicalPath"]
        or discovery.get("descriptorSha256") != snapshot["root"]["descriptorSha256"]
        or discovery.get("repositoryIdentitySha256") != snapshot["root"]["repositoryIdentitySha256"]
        or discovery.get("candidateResolutionSha256") != snapshot["candidateResolutionSha256"]
        or discovery.get("complete") is not True
        or discovery.get("concurrentChangeDetected") is not False
        or discovery.get("files") != expected_discovery_files
        or not SHA256_RE.fullmatch(str(discovery.get("discoveryToolSha256", "")))
    ):
        raise QualificationError("eligible-file discovery receipt binding or completeness mismatch")
    return True


def _object_descriptor(kind: str, binding: dict[str, str], root: Path, raw: bool = False, source_sha256: str | None = None) -> dict[str, Any]:
    _parse_cas_binding(binding)
    path = _safe_repository_path(root, binding["path"], must_exist=True)
    return {"kind": kind, "path": binding["path"], "sha256": binding["sha256"], "bytes": path.stat().st_size, "mediaType": "application/json", "raw": raw, "sourceSha256": source_sha256}


def validate_run(root: Path, run: dict[str, Any]) -> bool:
    validate_schema(root, "run-record.schema.json", run)
    policy_trusted = validate_protocol_bundle(root)["policyTrusted"] == "true"
    protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")
    oracle = _load_repository_json(root, "docs/research/code-intelligence/query-oracle.v1.json")
    scenarios = _load_repository_json(root, "docs/research/code-intelligence/scenarios.v1.json")
    policy_lock = _load_repository_json(root, POLICY_BUNDLE_LOCK_PATH)
    if run["protocolSha256"] != sha256_json(protocol) or run["policyBundleSha256"] != sha256_json(policy_lock):
        raise QualificationError("run protocol/policy bundle identity mismatch")
    if run["oracleSha256"] != sha256_json(oracle) or run["scenarioCatalogSha256"] != sha256_json(scenarios):
        raise QualificationError("run oracle/scenario catalog identity mismatch")
    catalog_scenarios = {item["id"] for item in scenarios["scenarios"]}
    if run["scenarioId"] not in catalog_scenarios:
        raise QualificationError("run scenario is not in the exact catalog")
    resolution = load_bound_json_object(root, run["candidateResolutionObject"])
    if sha256_json(resolution) != run["candidateResolutionSha256"] or resolution["candidateId"] != run["candidateId"]:
        raise QualificationError("run candidate/resolution object binding mismatch")
    resolution_trusted = validate_resolution(root, resolution)
    snapshot_object = load_bound_json_object(root, run["snapshotObject"])
    if snapshot_object != run["snapshot"]:
        raise QualificationError("embedded snapshot differs from its governed object")
    if run["snapshot"]["candidateResolutionSha256"] != run["candidateResolutionSha256"]:
        raise QualificationError("snapshot candidate resolution binding mismatch")
    snapshot_trusted = validate_snapshot(root, run["snapshot"])
    if run["index"]["generation"] != run["snapshot"]["freshness"]["indexGeneration"]:
        raise QualificationError("run index generation is not the reconciled snapshot generation")
    inventory = sorted(
        ([item["path"], item["contentSha256"]] for item in run["snapshot"]["indexInventory"]),
        key=lambda item: item[0],
    )
    if run["index"]["inventorySha256"] != sha256_json(inventory):
        raise QualificationError("run index inventory digest mismatch")
    sequences = [call["sequence"] for call in run["toolCalls"]]
    if sequences != list(range(1, len(sequences) + 1)):
        raise QualificationError("tool-call sequence must be ordered and gap-free")
    fatal = {item["id"]: item["verdict"] for item in run["fatalInvariantResults"]}
    if set(fatal) != REQUIRED_FATAL_INVARIANTS:
        raise QualificationError("run fatal invariant result set is incomplete")
    oracle_classes = [item["class"] for item in run["oracleResults"]]
    if len(oracle_classes) != len(set(oracle_classes)) or set(oracle_classes) != REQUIRED_QUERY_CLASSES:
        raise QualificationError("run oracle class coverage must equal the exact protocol set")
    if any(item["oracleSha256"] != run["oracleSha256"] for item in run["oracleResults"]):
        raise QualificationError("run oracle result uses a substituted oracle identity")
    required_injections = set(protocol["requiredFailureInjections"])
    injection_ids = [item["id"] for item in run["failureInjections"]]
    if len(injection_ids) != len(set(injection_ids)) or set(injection_ids) != required_injections:
        raise QualificationError("run failure injections must equal the exact protocol set")
    manifest = load_bound_manifest(root, run["evidenceManifest"])
    expected_objects = [*run["rawEvidence"], _object_descriptor("candidate-resolution", run["candidateResolutionObject"], root), _object_descriptor("repository-snapshot", run["snapshotObject"], root)]
    validate_evidence_manifest(root, manifest, expected_objects)
    scenario_executable = scenarios.get("executable") is True and protocol["executionMatrix"].get("scenarioDefinitionsExecutable") is True
    derived_eligible = all([
        policy_trusted, resolution_trusted, snapshot_trusted, scenario_executable,
        run["process"]["exitCode"] == 0,
        all(value == "pass" for value in fatal.values()),
        all(item["verdict"] == "pass" for item in run["oracleResults"]),
        all(item["verdict"] == "pass" for item in run["failureInjections"]),
        not run.get("blockers"),
    ])
    if run["qualificationEligible"] != derived_eligible:
        raise QualificationError(f"run eligibility claim differs from independently derived value {derived_eligible}")
    return derived_eligible


def _verify_ed25519(root: Path, public_key_pem: str, payload: dict[str, Any], signature_base64: str) -> None:
    host = _load_repository_json(root, RUNTIME_HOST_RECEIPT_PATH)
    openssl = Path(host["openssl"]["path"])
    try:
        signature = base64.b64decode(signature_base64, validate=True)
    except ValueError as error:
        raise QualificationError("review signature is not valid base64") from error
    import subprocess
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        key_path = directory / "reviewer-public.pem"
        message_path = directory / "payload.json"
        signature_path = directory / "signature.bin"
        key_path.write_text(public_key_pem, encoding="ascii")
        message_path.write_bytes(canonical_bytes(payload))
        signature_path.write_bytes(signature)
        result = subprocess.run(
            [openssl, "pkeyutl", "-verify", "-pubin", "-inkey", key_path, "-rawin", "-in", message_path, "-sigfile", signature_path],
            capture_output=True, text=True,
        )
    if result.returncode != 0:
        raise QualificationError("review Ed25519 signature verification failed")


def _validate_reviewer_separation(reviewers: list[dict[str, Any]], runner_identities: list[str]) -> None:
    if {item["role"] for item in reviewers} != {"oracle", "evidence"}:
        raise QualificationError("reviewer registry lacks exact oracle/evidence role separation")
    if len({item["publicKeySha256"] for item in reviewers}) != len(reviewers):
        raise QualificationError("reviewer registry reuses a cryptographic identity")
    if any(item["reviewerId"] in runner_identities for item in reviewers):
        raise QualificationError("candidate runner cannot be a trusted reviewer")


def validate_reviewer_registry(
    root: Path, protocol: dict[str, Any], registry: dict[str, Any], runner_identities: list[str]
) -> dict[str, dict[str, Any]]:
    if protocol != load_json(_safe_repository_path(root, "docs/research/code-intelligence/protocol.v2.json", must_exist=True)):
        raise QualificationError("reviewer validation received a substituted protocol")
    validate_protocol_bundle(root)
    validate_schema(root, "reviewer-registry.schema.json", registry)
    if registry["protocolSha256"] != sha256_json(protocol):
        raise QualificationError("reviewer registry protocol mismatch")
    admission_policy = protocol["admission"]
    trusted_reviewers = admission_policy["trustedReviewers"]
    _validate_trust_registry(
        trusted_reviewers, id_field="reviewerId",
        required_fields=admission_policy["trustedReviewerEntryRequiredFields"],
        expected_fields={"reviewerId", "role", "publicKeySha256", "toolchainSha256"},
        label="admission reviewer",
    )
    registry_projection = sorted(
        ({key: reviewer[key] for key in ("reviewerId", "role", "publicKeySha256", "toolchainSha256")} for reviewer in registry["reviewers"]),
        key=lambda item: (item["role"], item["reviewerId"]),
    )
    if registry_projection != sorted(trusted_reviewers, key=lambda item: (item["role"], item["reviewerId"])):
        raise QualificationError("reviewer registry is not the exact trusted policy registry")
    if not trusted_reviewers:
        raise QualificationError("no trusted reviewers are configured; admission is blocked")
    _validate_reviewer_separation(registry["reviewers"], runner_identities)
    return {item["reviewerId"]: item for item in registry["reviewers"]}


def validate_admission(root: Path, admission: dict[str, Any]) -> bool:
    validate_schema(root, "admission-record.schema.json", admission)
    verifier_toolchain = validate_runtime_contract(root)["toolchainSha256"]
    if admission["admissionVerifierToolchainSha256"] != verifier_toolchain:
        raise QualificationError("admission verifier toolchain identity mismatch")
    policy_trusted = validate_protocol_bundle(root)["policyTrusted"] == "true"
    protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")
    scenarios = _load_repository_json(root, "docs/research/code-intelligence/scenarios.v1.json")
    policy_lock = _load_repository_json(root, POLICY_BUNDLE_LOCK_PATH)
    if admission["protocolSha256"] != sha256_json(protocol) or admission["policyBundleSha256"] != sha256_json(policy_lock):
        raise QualificationError("admission protocol/policy identity mismatch")
    resolution = load_bound_json_object(root, admission["candidateResolutionObject"])
    if sha256_json(resolution) != admission["candidateResolutionSha256"] or resolution["candidateId"] != admission["candidateId"]:
        raise QualificationError("admission candidate resolution binding mismatch")
    resolution_trusted = validate_resolution(root, resolution)
    loaded_runs: list[tuple[dict[str, Any], str]] = []
    for binding in admission["runObjects"]:
        run = load_bound_json_object(root, binding)
        loaded_runs.append((run, binding["sha256"]))
    ordered_runs = sorted(loaded_runs, key=lambda item: (item[0]["scenarioId"], item[0]["repetition"]))
    run_hashes = [item[1] for item in ordered_runs]
    if admission["scenarioRunSha256"] != run_hashes:
        raise QualificationError("admission run hashes do not equal the nine governed run objects")
    combos = [(run["scenarioId"], run["repetition"]) for run, _ in ordered_runs]
    expected_combos = [(scenario["id"], repetition) for scenario in scenarios["scenarios"] for repetition in (1, 2, 3)]
    if combos != sorted(expected_combos):
        raise QualificationError("admission does not contain exactly three repetitions of each catalog scenario")
    run_eligibility = [validate_run(root, run) for run, _ in ordered_runs]
    if any(run["candidateResolutionSha256"] != admission["candidateResolutionSha256"] or run["candidateId"] != admission["candidateId"] for run, _ in ordered_runs):
        raise QualificationError("admission run candidate/resolution substitution detected")
    derived_runners = sorted({run["runnerIdentity"] for run, _ in ordered_runs})
    if admission["runnerIdentities"] != derived_runners:
        raise QualificationError("admission runner identities differ from governed runs")
    coverage = admission["coverage"]
    derived_repetitions = {scenario["id"]: sum(1 for run, _ in ordered_runs if run["scenarioId"] == scenario["id"]) for scenario in scenarios["scenarios"]}
    if coverage["scenarioRepetitions"] != derived_repetitions:
        raise QualificationError("admission scenario coverage is asserted rather than derived")
    if set(coverage["queryClasses"]) != {item["class"] for run, _ in ordered_runs for item in run["oracleResults"]} or set(coverage["queryClasses"]) != REQUIRED_QUERY_CLASSES:
        raise QualificationError("admission query coverage differs from governed runs")
    if set(coverage["failureInjections"]) != {item["id"] for run, _ in ordered_runs for item in run["failureInjections"]} or set(coverage["failureInjections"]) != set(protocol["requiredFailureInjections"]):
        raise QualificationError("admission failure-injection coverage differs from governed runs")
    derived_fixture_classes = sorted({scenario["class"] for scenario in scenarios["scenarios"]})
    if sorted(coverage["fixtureClasses"]) != derived_fixture_classes:
        raise QualificationError("admission fixture classes differ from governed scenario catalog")
    registry = load_bound_json_object(root, admission["reviewerRegistryObject"])
    reviewers_by_id = validate_reviewer_registry(root, protocol, registry, derived_runners)
    reviews = [load_bound_json_object(root, admission["oracleReviewObject"]), load_bound_json_object(root, admission["evidenceReviewObject"])]
    manifest = load_bound_manifest(root, admission["evidenceManifest"])
    base_objects = [
        *[_object_descriptor("run-record", binding, root) for binding in admission["runObjects"]],
        _object_descriptor("candidate-resolution", admission["candidateResolutionObject"], root),
        _object_descriptor("reviewer-registry", admission["reviewerRegistryObject"], root),
        *admission["supportingEvidence"],
    ]
    reviewed_object_set_sha = sha256_json(_manifest_object_projection(base_objects))
    expected_objects = [
        *base_objects,
        _object_descriptor("oracle-review", admission["oracleReviewObject"], root),
        _object_descriptor("evidence-review", admission["evidenceReviewObject"], root),
    ]
    validate_evidence_manifest(root, manifest, expected_objects)
    seen_roles: set[str] = set()
    seen_keys: set[str] = set()
    for review in reviews:
        validate_schema(root, "review-receipt.schema.json", review)
        payload = review["payload"]
        reviewer = reviewers_by_id.get(payload["reviewerId"])
        if reviewer is None or reviewer["role"] != payload["role"]:
            raise QualificationError("review receipt reviewer/role is not registered")
        if reviewer["reviewerId"] in derived_runners:
            raise QualificationError("candidate runner cannot review its own evidence")
        if sha256_bytes(reviewer["publicKeyPem"].encode("ascii")) != reviewer["publicKeySha256"]:
            raise QualificationError("reviewer public-key digest mismatch")
        expected_payload = {
            "reviewId": payload["reviewId"], "reviewerId": reviewer["reviewerId"], "role": reviewer["role"],
            "reviewerToolchainSha256": reviewer["toolchainSha256"],
            "admissionVerifierToolchainSha256": verifier_toolchain,
            "protocolSha256": admission["protocolSha256"], "policyBundleSha256": admission["policyBundleSha256"],
            "candidateResolutionSha256": admission["candidateResolutionSha256"], "runSha256": run_hashes,
            "runnerIdentities": derived_runners, "reviewedObjectSetSha256": reviewed_object_set_sha,
            "preAdmissionProjectionSha256": admission["preAdmissionProjectionSha256"], "decision": "admitted",
        }
        if payload != expected_payload:
            raise QualificationError("signed review payload does not exactly bind derived evidence")
        _verify_ed25519(root, reviewer["publicKeyPem"], payload, review["signature"]["signatureBase64"])
        seen_roles.add(reviewer["role"]); seen_keys.add(reviewer["publicKeySha256"])
    if seen_roles != {"oracle", "evidence"} or len(seen_keys) != 2:
        raise QualificationError("admission lacks two cryptographically distinct review roles")
    if admission["preAdmissionReproductions"] != [admission["preAdmissionProjectionSha256"]] * 3:
        raise QualificationError("admission pre-admission projection reproduction hashes are not exact and byte-identical")
    derived_admitted = policy_trusted and resolution_trusted and all(run_eligibility) and scenarios.get("executable") is True
    if admission["decision"] == "admitted" and not derived_admitted:
        raise QualificationError("admission decision claims admitted without derived trusted evidence")
    return admission["decision"] == "admitted" and derived_admitted


def _manifest_object_projection(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        ({key: item[key] for key in ("kind", "sha256", "bytes", "path", "mediaType", "raw", "sourceSha256")} for item in objects),
        key=lambda item: (item["path"], item["kind"]),
    )


def validate_evidence_manifest(
    root: Path, manifest: dict[str, Any], expected_objects: list[dict[str, Any]] | None = None
) -> None:
    validate_schema(root, "evidence-manifest.schema.json", manifest)
    expected_root = _evidence_root(root)
    protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")
    if manifest["protocolSha256"] != sha256_json(protocol):
        raise QualificationError("evidence manifest protocol identity mismatch")
    policy_lock = _load_repository_json(root, POLICY_BUNDLE_LOCK_PATH)
    if manifest["policyBundleSha256"] != sha256_json(policy_lock):
        raise QualificationError("evidence manifest policy-bundle identity mismatch")
    if manifest["objectSetSha256"] != sha256_json(_manifest_object_projection(manifest["objects"])):
        raise QualificationError("evidence manifest object-set digest mismatch")
    if len({item["path"] for item in manifest["objects"]}) != len(manifest["objects"]):
        raise QualificationError("evidence manifest contains duplicate object paths")
    if len({item["sha256"] for item in manifest["objects"]}) != len(manifest["objects"]):
        raise QualificationError("evidence manifest contains duplicate object hashes")
    if expected_objects is not None:
        expected_projection = _manifest_object_projection(expected_objects)
        if _manifest_object_projection(manifest["objects"]) != expected_projection:
            raise QualificationError("evidence manifest does not exactly match derived object bindings")
    declared_paths = {item["path"] for item in manifest["objects"]}
    _validate_set_id(manifest["evidenceSetId"])
    set_root = expected_root / "sets" / manifest["evidenceSetId"] / "objects/sha256"
    if set_root.exists() and (set_root.is_symlink() or set_root.resolve() != set_root):
        raise QualificationError("evidence object set traverses a symlink")
    actual_paths = {
        str(path.relative_to(root)) for path in set_root.glob("*/*") if path.is_file()
    } if set_root.is_dir() else set()
    if actual_paths != declared_paths:
        raise QualificationError(
            f"evidence set reconciliation failed; omitted={sorted(actual_paths-declared_paths)}, missing={sorted(declared_paths-actual_paths)}"
        )
    sanitizer_seen = False
    for item in manifest["objects"]:
        extension = {"application/json": "json", "text/plain": "txt", "application/octet-stream": "bin"}[item["mediaType"]]
        binding = {"path": item["path"], "sha256": item["sha256"]}
        observed_set_id, observed_extension = _parse_cas_binding(binding, extension=extension)
        if observed_set_id != manifest["evidenceSetId"] or observed_extension != extension:
            raise QualificationError(f"evidence object belongs to a different evidence set: {item['path']}")
        path = _safe_repository_path(root, item["path"], must_exist=True)
        expected = evidence_object_path(expected_root, manifest["evidenceSetId"], item["sha256"], extension)
        if path != expected:
            raise QualificationError(f"evidence object path/hash layout mismatch: {item['path']}")
        payload = path.read_bytes()
        if len(payload) != item["bytes"] or sha256_bytes(payload) != item["sha256"]:
            raise QualificationError(f"evidence object byte/hash mismatch: {item['path']}")
        if item["mediaType"] == "application/json":
            try:
                parsed = json.loads(payload, parse_float=lambda token: (_ for _ in ()).throw(QualificationError(f"float forbidden: {token}")))
            except json.JSONDecodeError as error:
                raise QualificationError(f"evidence object is not JSON: {item['path']}") from error
            if canonical_bytes(parsed) != payload:
                raise QualificationError(f"evidence object is not canonical JSON: {item['path']}")
            if item["sha256"] == manifest["sanitizationReceiptSha256"]:
                if item["kind"] != "sanitization-receipt" or parsed.get("schemaVersion") != "code-intelligence-sanitization-receipt/v1":
                    raise QualificationError("manifest sanitization identity is not a sanitization receipt")
                sanitizer_seen = True
    if not sanitizer_seen:
        raise QualificationError("evidence manifest omits its bound sanitization receipt")


def _ordered_facts(facts: list[dict[str, Any]], source_ids: set[str], generation: int) -> list[dict[str, Any]]:
    for fact in facts:
        if not fact.get("sourceEvidenceIds") or not set(fact["sourceEvidenceIds"]).issubset(source_ids):
            raise QualificationError(f"fact {fact.get('id')} lacks valid source evidence")
        if fact.get("generation") != generation:
            raise QualificationError(f"fact {fact.get('id')} has stale generation")
    return sorted(facts, key=lambda item: item["id"])


def _finalize_bootstrap_projection(
    protocol: dict[str, Any], pre_admission_projection: dict[str, Any], admission: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    admission_sha = sha256_json(admission)
    projection = {
        **pre_admission_projection,
        "identity": {**pre_admission_projection["identity"], "admissionSha256": admission_sha},
    }
    missing_protocol_inputs = set(protocol["bootstrap"]["requiredInputs"]) - set(projection["identity"])
    if missing_protocol_inputs:
        raise QualificationError(f"bootstrap projection omitted protocol-required inputs: {sorted(missing_protocol_inputs)}")
    return projection, admission_sha


def build_bootstrap(
    root: Path,
    protocol: dict[str, Any], resolution: dict[str, Any], run: dict[str, Any],
    oracle: dict[str, Any], admission: dict[str, Any], facts: dict[str, Any],
) -> dict[str, Any]:
    actual_protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json")
    actual_oracle = _load_repository_json(root, "docs/research/code-intelligence/query-oracle.v1.json")
    policy_lock = _load_repository_json(root, POLICY_BUNDLE_LOCK_PATH)
    if protocol != actual_protocol or oracle != actual_oracle:
        raise QualificationError("bootstrap received a substituted protocol or oracle")
    run_hash = sha256_json(run)
    if run_hash not in admission["scenarioRunSha256"]:
        raise QualificationError("admission does not bind the selected run")
    if run["candidateResolutionSha256"] != sha256_json(resolution):
        raise QualificationError("run does not bind the supplied candidate resolution")
    governed_resolution = load_bound_json_object(root, admission["candidateResolutionObject"])
    if governed_resolution != resolution or admission["candidateResolutionSha256"] != sha256_json(resolution) or admission["candidateId"] != resolution["candidateId"]:
        raise QualificationError("bootstrap candidate/resolution was substituted from admission")
    if run["protocolSha256"] != sha256_json(protocol) or admission["protocolSha256"] != sha256_json(protocol) or run["policyBundleSha256"] != sha256_json(policy_lock) or admission["policyBundleSha256"] != sha256_json(policy_lock):
        raise QualificationError("run/admission protocol or policy binding mismatch")
    snapshot = run["snapshot"]
    generation = snapshot["freshness"]["indexGeneration"]
    required_fact_sections = ("structure", "dependencies", "publicApis", "calls", "reuseEvidence")
    if any(not isinstance(facts.get(section), list) or not facts[section] for section in required_fact_sections):
        raise QualificationError("bootstrap requires nonempty facts in every mandatory section")
    if not isinstance(facts.get("sourceEvidence"), list) or not facts["sourceEvidence"]:
        raise QualificationError("bootstrap requires nonempty source evidence")
    if not facts.get("knownUnknowns") or not facts.get("omissions"):
        raise QualificationError("bootstrap requires explicit nonempty unknowns and omissions")
    source_evidence = sorted(facts["sourceEvidence"], key=lambda item: item["id"])
    if len({item["id"] for item in source_evidence}) != len(source_evidence):
        raise QualificationError("bootstrap source evidence IDs are not unique")
    eligible_by_path = {item["path"]: item["contentSha256"] for item in snapshot["files"] if item["disposition"] == "eligible"}
    if any(item["path"] not in eligible_by_path or eligible_by_path[item["path"]] != item["contentSha256"] for item in source_evidence):
        raise QualificationError("bootstrap source evidence is not bound to eligible snapshot bytes")
    source_ids = {item["id"] for item in source_evidence}
    selected = resolution.get("selected")
    if selected is None:
        raise QualificationError("bootstrap candidate resolution is unresolved")
    eligible_files = sorted(
        ({"path": item["path"], "contentSha256": item["contentSha256"], "language": item.get("language")}
         for item in snapshot["files"] if item["disposition"] == "eligible"),
        key=lambda item: item["path"],
    )
    pre_admission_projection = {
        "identity": {
            "protocolSha256": sha256_json(protocol), "candidateResolutionSha256": sha256_json(resolution),
            "policyBundleSha256": sha256_json(policy_lock), "candidateId": resolution["candidateId"],
            "repositorySnapshotSha256": sha256_json(snapshot), "eligibleManifestSha256": sha256_json(snapshot["files"]),
            "indexInventorySha256": sha256_json(sorted(([i["path"], i["contentSha256"]] for i in snapshot["indexInventory"]), key=lambda item: item[0])),
            "toolSchemaSha256": selected["toolSchemaSha256"], "oracleSha256": sha256_json(oracle),
            "runSha256": run_hash,
            "repositoryIdentitySha256": snapshot["root"]["repositoryIdentitySha256"], "indexGeneration": generation,
        },
        "inventory": eligible_files,
        "structure": _ordered_facts(facts.get("structure", []), source_ids, generation),
        "dependencies": _ordered_facts(facts.get("dependencies", []), source_ids, generation),
        "publicApis": _ordered_facts(facts.get("publicApis", []), source_ids, generation),
        "calls": _ordered_facts(facts.get("calls", []), source_ids, generation),
        "reuseEvidence": _ordered_facts(facts.get("reuseEvidence", []), source_ids, generation),
        "knownUnknowns": sorted(set(facts.get("knownUnknowns", []))),
        "omissions": sorted(facts.get("omissions", []), key=lambda item: (item["class"], item["reason"])),
        "sourceEvidence": source_evidence,
    }
    all_fact_ids = [item["id"] for section in required_fact_sections for item in pre_admission_projection[section]]
    if len(all_fact_ids) != len(set(all_fact_ids)):
        raise QualificationError("bootstrap fact IDs must be globally unique")
    pre_admission_sha = sha256_json(pre_admission_projection)
    if admission.get("preAdmissionProjectionSha256") != pre_admission_sha or admission.get("preAdmissionReproductions") != [pre_admission_sha] * 3:
        raise QualificationError("admission reproduction hashes do not equal the actual pre-admission projection")
    resolution_trusted = validate_resolution(root, resolution)
    run_trusted = validate_run(root, run)
    admission_trusted = validate_admission(root, admission)
    if not resolution_trusted or not run_trusted or not admission_trusted:
        raise QualificationError("bootstrap requires independently trusted resolution, run, and admission")
    projection, admission_sha = _finalize_bootstrap_projection(protocol, pre_admission_projection, admission)
    projection_sha = sha256_json(projection)
    output = {
        "schemaVersion": _schema_property_const(root, "bootstrap-output.schema.json", "schemaVersion"),
        "builderVersion": protocol["bootstrap"]["builderVersion"],
        "projection": projection,
        "projectionSha256": projection_sha,
        "admission": {"admissionId": admission["admissionId"], "admissionSha256": admission_sha, "preAdmissionReproductions": admission["preAdmissionReproductions"]},
    }
    validate_schema(root, "bootstrap-output.schema.json", output)
    return output


def evidence_object_path(evidence_root: Path, evidence_set_id: str, digest: str, extension: str = "json") -> Path:
    _validate_set_id(evidence_set_id)
    if not SHA256_RE.fullmatch(digest) or extension not in {"json", "txt", "bin"}:
        raise QualificationError("invalid content-addressed object identity")
    return evidence_root / "sets" / evidence_set_id / "objects/sha256" / digest[:2] / f"{digest}.{extension}"


def _repository_root_from_evidence_root(evidence_root: Path) -> Path:
    absolute = evidence_root.absolute()
    if tuple(absolute.parts[-len(EVIDENCE_SUFFIX.parts):]) != EVIDENCE_SUFFIX.parts:
        raise QualificationError(f"evidence root must be the repository-bound {EVIDENCE_SUFFIX}")
    root = Path(*absolute.parts[:-len(EVIDENCE_SUFFIX.parts)])
    expected = _evidence_root(root)
    if absolute != expected:
        raise QualificationError("evidence root is not the exact non-symlinked repository evidence root")
    return _normalized_root(root)


def persist_content_addressed(evidence_root: Path, evidence_set_id: str, value: Any) -> tuple[Path, str]:
    repository_root = _repository_root_from_evidence_root(evidence_root)
    normalized = _evidence_root(repository_root)
    payload = canonical_bytes(value)
    digest = sha256_bytes(payload)
    _validate_set_id(evidence_set_id)
    target = evidence_object_path(normalized, evidence_set_id, digest)
    relative = target.relative_to(repository_root).as_posix()
    _safe_repository_path(repository_root, relative, must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    _safe_repository_path(repository_root, target.parent.relative_to(repository_root).as_posix(), must_exist=False)
    if target.exists():
        if target.read_bytes() != payload:
            raise QualificationError("content-addressed target exists with different bytes")
        return target, digest
    descriptor, temporary_name = tempfile.mkstemp(prefix=".candidate-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, digest


def persist_blob(evidence_root: Path, evidence_set_id: str, payload: bytes, extension: str = "bin") -> tuple[Path, str]:
    repository_root = _repository_root_from_evidence_root(evidence_root); normalized = _evidence_root(repository_root)
    _validate_set_id(evidence_set_id)
    if extension not in {"bin", "txt"}:
        raise QualificationError("invalid evidence set ID or blob extension")
    digest = sha256_bytes(payload); target = evidence_object_path(normalized, evidence_set_id, digest, extension)
    _safe_repository_path(repository_root, target.relative_to(repository_root).as_posix(), must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    _safe_repository_path(repository_root, target.parent.relative_to(repository_root).as_posix(), must_exist=False)
    if target.exists():
        if target.read_bytes() != payload:
            raise QualificationError("content-addressed blob collision")
        return target, digest
    descriptor, temporary_name = tempfile.mkstemp(prefix=".candidate-", dir=target.parent); temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, digest


def _github_json(url: str) -> tuple[bytes, Any]:
    request = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "User-Agent": SCRIPT_VERSION}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except (urllib.error.URLError, TimeoutError) as error:
        raise QualificationError(f"official release resolution unavailable: {error}") from error
    return raw, json.loads(raw)


def discover_github_releases_untrusted(root: Path, candidate_id: str, evidence_root: Path, evidence_set_id: str) -> dict[str, Any]:
    """Retain official raw discovery bytes without producing a trusted resolution."""
    if _repository_root_from_evidence_root(evidence_root) != _normalized_root(root):
        raise QualificationError("release-discovery evidence root belongs to a different repository root")
    catalog = _load_repository_json(root, "docs/research/code-intelligence/candidates.v1.json")
    candidate = next((item for item in catalog["candidates"] if item["id"] == candidate_id), None)
    if candidate is None:
        raise QualificationError("unknown candidate")
    resolver = candidate["resolver"]
    if resolver["type"] != "github-releases":
        raise QualificationError("service candidates require an authorized service-instance resolver")
    repository = resolver["repository"]
    pages = []
    releases: list[dict[str, Any]] = []
    raw_descriptors: list[dict[str, Any]] = []
    for page_number in range(1, 101):
        url = f"https://api.github.com/repos/{repository}/releases?per_page=100&page={page_number}"
        raw, page_releases = _github_json(url)
        raw_path, raw_hash = persist_blob(evidence_root, evidence_set_id, raw)
        binding = {"path": str(raw_path.relative_to(root)), "sha256": raw_hash}
        terminal = len(page_releases) < 100
        pages.append({"page": page_number, "url": url, "rawResponse": binding, "releaseCount": len(page_releases), "terminal": terminal})
        raw_descriptors.append({"kind": "official-github-release-page", "path": binding["path"], "sha256": raw_hash, "bytes": len(raw), "mediaType": "application/octet-stream", "raw": True, "sourceSha256": None})
        releases.extend(page_releases)
        if terminal:
            break
    if not pages[-1]["terminal"]:
        raise QualificationError("official release enumeration exceeded bounded pagination and is incomplete")
    latest_stable = next((release for release in releases if not release.get("draft") and not release.get("prerelease") and STABLE_TAG_RE.fullmatch(release.get("tag_name", ""))), None)
    license_url = candidate["license"]["source"]
    prefix = f"https://github.com/{repository}/blob/"
    if not license_url.startswith(prefix):
        raise QualificationError("official raw license URL cannot be derived for this candidate")
    raw_license_url = f"https://raw.githubusercontent.com/{repository}/" + license_url[len(prefix):]
    license_request = urllib.request.Request(raw_license_url, headers={"User-Agent": SCRIPT_VERSION})
    try:
        with urllib.request.urlopen(license_request, timeout=30) as response:
            raw_license = response.read()
    except (urllib.error.URLError, TimeoutError) as error:
        raise QualificationError(f"official raw license retrieval unavailable: {error}") from error
    license_path, license_hash = persist_blob(evidence_root, evidence_set_id, raw_license, "txt")
    license_binding = {"path": str(license_path.relative_to(root)), "sha256": license_hash}
    raw_descriptors.append({"kind": "official-license-bytes", "path": license_binding["path"], "sha256": license_hash, "bytes": len(raw_license), "mediaType": "text/plain", "raw": True, "sourceSha256": None})
    sanitizer_value = {"schemaVersion": "code-intelligence-sanitization-receipt/v1", "scope": evidence_set_id, "reviewOutcome": "public-official-metadata-no-credentials", "qualificationEffect": "none"}
    sanitizer_path, sanitizer_hash = persist_content_addressed(evidence_root, evidence_set_id, sanitizer_value)
    sanitizer_binding = {"path": str(sanitizer_path.relative_to(root)), "sha256": sanitizer_hash}
    raw_descriptors.append({"kind": "sanitization-receipt", "path": sanitizer_binding["path"], "sha256": sanitizer_hash, "bytes": sanitizer_path.stat().st_size, "mediaType": "application/json", "raw": False, "sourceSha256": None})
    discovery = {
        "schemaVersion": "code-intelligence-untrusted-release-discovery/v1", "candidateId": candidate_id,
        "repository": repository, "observedAt": _utc_now(), "pages": pages,
        "releaseCount": len(releases), "latestStableObservation": None if latest_stable is None else {"releaseId": latest_stable["id"], "tag": latest_stable["tag_name"], "publishedAt": latest_stable.get("published_at")},
        "rawLicenseUrl": raw_license_url, "rawLicenseObject": license_binding,
        "trustStatus": "untrusted-discovery-only", "qualificationPermitted": False,
        "blockers": ["no-trusted-online-verifier", "source-archive-not-retained", "executable-not-retained", "tool-schema-not-retained", "license-disposition-not-reviewed"],
    }
    discovery_path, discovery_hash = persist_content_addressed(evidence_root, evidence_set_id, discovery)
    discovery_binding = {"path": str(discovery_path.relative_to(root)), "sha256": discovery_hash}
    raw_descriptors.append({"kind": "untrusted-release-discovery", "path": discovery_binding["path"], "sha256": discovery_hash, "bytes": discovery_path.stat().st_size, "mediaType": "application/json", "raw": False, "sourceSha256": None})
    protocol = _load_repository_json(root, "docs/research/code-intelligence/protocol.v2.json"); lock = _load_repository_json(root, POLICY_BUNDLE_LOCK_PATH)
    manifest = {"schemaVersion": "code-intelligence-evidence-manifest/v2", "evidenceSetId": evidence_set_id, "scope": "resolution", "protocolSha256": sha256_json(protocol), "policyBundleSha256": sha256_json(lock), "createdAt": _utc_now(), "objects": raw_descriptors, "objectSetSha256": sha256_json(_manifest_object_projection(raw_descriptors)), "sanitizationReceiptSha256": sanitizer_hash, "complete": True}
    manifest_path = evidence_root / "sets" / evidence_set_id / "manifest.json"
    _safe_repository_path(root, manifest_path.relative_to(root).as_posix(), must_exist=False)
    manifest_path.write_bytes(canonical_bytes(manifest))
    validate_evidence_manifest(root, manifest)
    return {"status": "untrusted-discovery-retained", "discoveryObject": discovery_binding, "evidenceManifest": {"path": str(manifest_path.relative_to(root)), "sha256": sha256_file(manifest_path)}, "qualificationPermitted": False}


def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check-runtime")
    subparsers.add_parser("validate-suite")
    for name in ("validate-resolution", "validate-snapshot", "validate-run", "validate-admission", "validate-evidence-manifest"):
        item = subparsers.add_parser(name); item.add_argument("path", type=Path)
    resolver = subparsers.add_parser("discover-releases-untrusted"); resolver.add_argument("candidate_id"); resolver.add_argument("--evidence-root", type=Path, required=True); resolver.add_argument("--evidence-set-id", required=True)
    bootstrap = subparsers.add_parser("build-bootstrap")
    for flag in ("protocol", "resolution", "run", "oracle", "admission", "facts"):
        bootstrap.add_argument(f"--{flag}", type=Path, required=True)
    bootstrap.add_argument("--evidence-root", type=Path, required=True)
    bootstrap.add_argument("--evidence-set-id", required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    provenance = validate_runtime_contract(root)
    if args.command == "check-runtime": result = provenance
    elif args.command == "validate-suite": result = {**validate_protocol_bundle(root), "runtime": provenance}
    elif args.command == "validate-resolution": validate_resolution(root, _load_cli_repository_json(root, args.path)); result = {"status": "valid"}
    elif args.command == "validate-snapshot": validate_snapshot(root, _load_cli_repository_json(root, args.path)); result = {"status": "valid"}
    elif args.command == "validate-run": validate_run(root, _load_cli_repository_json(root, args.path)); result = {"status": "valid"}
    elif args.command == "validate-admission": validate_admission(root, _load_cli_repository_json(root, args.path)); result = {"status": "valid"}
    elif args.command == "validate-evidence-manifest": validate_evidence_manifest(root, _load_cli_repository_json(root, args.path)); result = {"status": "valid"}
    elif args.command == "discover-releases-untrusted": result = discover_github_releases_untrusted(root, args.candidate_id, args.evidence_root.absolute(), args.evidence_set_id)
    else:
        values = {name: _load_cli_repository_json(root, getattr(args, name)) for name in ("protocol", "resolution", "run", "oracle", "admission", "facts")}
        output = build_bootstrap(root, **values)
        evidence_root = args.evidence_root.absolute()
        if _repository_root_from_evidence_root(evidence_root) != root:
            raise QualificationError("bootstrap evidence root belongs to a different repository root")
        path, digest = persist_content_addressed(evidence_root, args.evidence_set_id, output)
        result = {"status": "written", "sha256": digest, "path": str(path.relative_to(root))}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except QualificationError as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        raise SystemExit(2)
