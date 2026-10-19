from __future__ import annotations

from copy import deepcopy
import hashlib
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[4]
MODULE_PATH = ROOT / "verification/benchmarks/code-intelligence/qualification.py"
SPEC = importlib.util.spec_from_file_location("code_intelligence_qualification", MODULE_PATH)
assert SPEC and SPEC.loader
q = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(q)
SHA1 = "b" * 40


def digest(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


class GovernedFixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        docs_target = self.root / "docs/research"
        docs_target.mkdir(parents=True)
        shutil.copytree(ROOT / "docs/research/code-intelligence", docs_target / "code-intelligence")
        verification_parent = self.root / "verification/benchmarks"
        verification_parent.mkdir(parents=True)
        shutil.copytree(ROOT / "verification/benchmarks/code-intelligence", verification_parent / "code-intelligence")
        verifier_path = verification_parent / "code-intelligence/qualification.py"
        verifier_spec = importlib.util.spec_from_file_location(f"fixture_qualification_{id(self)}", verifier_path)
        assert verifier_spec and verifier_spec.loader
        self.verifier = importlib.util.module_from_spec(verifier_spec)
        verifier_spec.loader.exec_module(self.verifier)
        self.evidence_root = self.root / q.EVIDENCE_SUFFIX
        self.evidence_root.mkdir(parents=True)

    def close(self) -> None:
        self.temporary.cleanup()

    def rebind_runtime_pointer(self) -> None:
        pointer_path = self.root / q.RUNTIME_POINTER_PATH
        pointer = q.load_json(pointer_path)
        pointer["compatibilityPolicySha256"] = q.sha256_file(self.root / q.RUNTIME_POLICY_PATH)
        pointer["hostReceiptSha256"] = q.sha256_file(self.root / q.RUNTIME_HOST_RECEIPT_PATH)
        pointer_path.write_bytes(q.canonical_bytes(pointer))

    def persist(self, set_id: str, value: dict) -> tuple[dict[str, str], dict]:
        path, sha = q.persist_content_addressed(self.evidence_root, set_id, value)
        binding = {"path": str(path.relative_to(self.root)), "sha256": sha}
        return binding, self.descriptor("fixture-object", binding)

    def descriptor(self, kind: str, binding: dict[str, str], *, raw: bool = False) -> dict:
        path = self.root / binding["path"]
        return {"kind": kind, "path": binding["path"], "sha256": binding["sha256"], "bytes": path.stat().st_size, "mediaType": "application/json", "raw": raw, "sourceSha256": None}

    def manifest(self, set_id: str, objects: list[dict]) -> dict[str, str]:
        protocol = q.load_json(self.root / "docs/research/code-intelligence/protocol.v2.json")
        lock = q.load_json(self.root / "docs/research/code-intelligence/policy-bundle-lock.v2.json")
        sanitizer = next(item for item in objects if item["kind"] == "sanitization-receipt")
        value = {
            "schemaVersion": "code-intelligence-evidence-manifest/v2", "evidenceSetId": set_id, "scope": "run",
            "protocolSha256": q.sha256_json(protocol), "policyBundleSha256": q.sha256_json(lock),
            "createdAt": "2026-07-12T21:00:00Z", "objects": objects,
            "objectSetSha256": q.sha256_json(q._manifest_object_projection(objects)),
            "sanitizationReceiptSha256": sanitizer["sha256"], "complete": True,
        }
        path = self.evidence_root / "sets" / set_id / "manifest.json"
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(q.canonical_bytes(value))
        return {"path": str(path.relative_to(self.root)), "sha256": q.sha256_file(path)}

    def synthetic_resolution(self) -> dict:
        return {
            "schemaVersion": "code-intelligence-candidate-resolution/v3", "candidateId": "codegraph-colbymchenry",
            "resolutionClass": "synthetic-untrusted", "trustedForQualification": False, "status": "blocked",
            "selector": "latest-stable-at-run", "resolvedAt": "2026-07-12T20:00:00Z", "resolverVersion": q.SCRIPT_VERSION,
            "examinedReleases": [{"releaseId": 1, "tag": "v1.2.3-rc1", "draft": False, "prerelease": True, "accepted": False, "reason": "prerelease-metadata"}],
            "selected": None, "resolverEvidence": None, "licenseEvidence": None, "evidenceManifest": None,
            "licenseDisposition": "blocked", "blockers": ["synthetic-untrusted"],
        }

    def snapshot(self, resolution_sha: str) -> dict:
        return {
            "schemaVersion": "code-intelligence-repository-snapshot/v2", "snapshotId": "synthetic-snapshot",
            "snapshotClass": "synthetic-untrusted", "trustedForQualification": False,
            "candidateResolutionSha256": resolution_sha, "authorizationReceipt": None, "eligibleDiscoveryReceipt": None,
            "purpose": "synthetic hostile validation", "capturedAt": "2026-07-12T20:01:00Z",
            "root": {"canonicalPath": str(self.root / "invented-project"), "descriptorSha256": digest("descriptor"), "device": 1, "inode": 2, "repositoryIdentitySha256": digest("repo")},
            "git": {"headSha": SHA1, "treeSha": SHA1, "indexSha256": digest("index"), "worktreeSha256": digest("worktree"), "branch": "main", "dirty": False, "staged": False, "untracked": False, "submodulesSha256": digest("submodules"), "lfsSha256": digest("lfs")},
            "files": [
                {"path": "src/a.ts", "kind": "regular", "disposition": "eligible", "reason": "synthetic included", "contentSha256": digest("a"), "language": "typescript"},
                {"path": "vendor/x.bin", "kind": "binary", "disposition": "binary", "reason": "binary excluded", "language": None},
            ],
            "indexInventory": [{"path": "src/a.ts", "contentSha256": digest("a"), "parser": "typescript@synthetic"}],
            "freshness": {"captureGeneration": 4, "indexGeneration": 4, "reconciled": True, "concurrentChangeDetected": False, "reconciledAt": "2026-07-12T20:01:01Z"},
        }

    def run(self, scenario: str = "S01-clean-polyglot", repetition: int = 1) -> tuple[dict, dict]:
        set_id = f"synthetic-{scenario[:3].lower()}-{repetition}"
        protocol = q.load_json(self.root / "docs/research/code-intelligence/protocol.v2.json")
        oracle = q.load_json(self.root / "docs/research/code-intelligence/query-oracle.v1.json")
        scenarios = q.load_json(self.root / "docs/research/code-intelligence/scenarios.v1.json")
        lock = q.load_json(self.root / "docs/research/code-intelligence/policy-bundle-lock.v2.json")
        resolution = self.synthetic_resolution(); resolution_binding, _ = self.persist(set_id, resolution)
        resolution_sha = q.sha256_json(resolution)
        snapshot = self.snapshot(resolution_sha); snapshot_binding, _ = self.persist(set_id, snapshot)
        sanitizer = {"schemaVersion": "code-intelligence-sanitization-receipt/v1", "scope": set_id, "reviewOutcome": "synthetic-no-secrets"}
        sanitizer_binding, _ = self.persist(set_id, sanitizer)
        telemetry = {"schemaVersion": "code-intelligence-synthetic-telemetry/v1", "events": ["start", "stop"]}
        telemetry_binding, _ = self.persist(set_id, telemetry)
        raw = [self.descriptor("sanitization-receipt", sanitizer_binding), self.descriptor("process-telemetry", telemetry_binding, raw=True)]
        objects = [*raw, self.descriptor("candidate-resolution", resolution_binding), self.descriptor("repository-snapshot", snapshot_binding)]
        manifest_binding = self.manifest(set_id, objects)
        inventory = [[item["path"], item["contentSha256"]] for item in snapshot["indexInventory"]]
        run = {
            "schemaVersion": "code-intelligence-run-record/v2", "runId": f"run-{scenario}-{repetition}", "runnerIdentity": "synthetic-runner",
            "protocolSha256": q.sha256_json(protocol), "policyBundleSha256": q.sha256_json(lock), "candidateId": resolution["candidateId"],
            "candidateResolutionSha256": resolution_sha, "candidateResolutionObject": resolution_binding,
            "snapshot": snapshot, "snapshotObject": snapshot_binding, "oracleSha256": q.sha256_json(oracle), "scenarioCatalogSha256": q.sha256_json(scenarios),
            "scenarioId": scenario, "repetition": repetition, "startedAt": "2026-07-12T20:02:00Z", "endedAt": "2026-07-12T20:03:00Z",
            "process": {"startupNs": 10, "exitCode": 0, "terminationReason": "normal", "peakRssBytes": 100, "cpuUserNs": 10, "cpuSystemNs": 5, "readBytes": 100, "writeBytes": 100},
            "index": {"startedAt": "2026-07-12T20:02:01Z", "durationNs": 10, "filesClaimed": 1, "bytesClaimed": 10, "nodesClaimed": 1, "edgesClaimed": 0, "storageBytes": 10, "generation": 4, "inventorySha256": q.sha256_json(inventory)},
            "toolCalls": [{"sequence": 1, "toolName": "structure", "toolSchemaSha256": digest("tools"), "inputSha256": digest("input"), "outputSha256": digest("output"), "startedAt": "2026-07-12T20:02:02Z", "durationNs": 2, "requestBytes": 10, "responseBytes": 20, "inputTokens": None, "outputTokens": None, "tokenCounterIdentity": "utf8-only/no-tokenizer", "success": True, "errorClass": None}],
            "oracleResults": [{"queryId": f"{name}-1", "class": name, "oracleSha256": q.sha256_json(oracle), "resultSha256": digest(f"result-{name}"), "verdict": "pass", "falsePositives": 0, "falseNegatives": 0} for name in sorted(q.REQUIRED_QUERY_CLASSES)],
            "failureInjections": [{"id": name, "expected": "blocked", "observed": "blocked", "verdict": "pass"} for name in protocol["requiredFailureInjections"]],
            "fatalInvariantResults": [{"id": name, "verdict": "pass", "evidenceSha256": digest(name)} for name in sorted(q.REQUIRED_FATAL_INVARIANTS)],
            "rawEvidence": raw, "evidenceManifest": manifest_binding, "qualificationEligible": False, "blockers": ["synthetic-untrusted", "scenario-unexecutable"],
        }
        return run, resolution


class QualificationRemediationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fx = GovernedFixture()

    def tearDown(self) -> None:
        self.fx.close()

    def test_legacy_01_admission_query_coverage(self):
        admission = self._nonexistent_admission(); admission["coverage"]["queryClasses"] = admission["coverage"]["queryClasses"][:-1]
        with self.assertRaises(q.QualificationError): q.validate_admission(self.fx.root, admission)

    def test_legacy_02_reviewer_separation(self):
        key = digest("same-key"); toolchain = digest("toolchain")
        reviewers = [{"reviewerId": "one", "role": "oracle", "publicKeyPem": "pem-one", "publicKeySha256": key, "toolchainSha256": toolchain}, {"reviewerId": "two", "role": "evidence", "publicKeyPem": "pem-two", "publicKeySha256": key, "toolchainSha256": toolchain}]
        with self.assertRaisesRegex(q.QualificationError, "reuses"): q._validate_reviewer_separation(reviewers, ["runner"])

    def test_legacy_03_bootstrap_determinism_blocked_without_trust(self):
        run, resolution = self.fx.run(); admission = self._bootstrap_admission(run, resolution)
        with self.assertRaises(q.QualificationError): q.build_bootstrap(self.fx.root, q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json"), resolution, run, q.load_json(self.fx.root / "docs/research/code-intelligence/query-oracle.v1.json"), admission, self._facts())

    def test_legacy_04_bootstrap_stale_fact(self):
        run, resolution = self.fx.run(); admission = self._bootstrap_admission(run, resolution); facts = self._facts(); facts["structure"][0]["generation"] = 3
        with self.assertRaises(q.QualificationError): q.build_bootstrap(self.fx.root, q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json"), resolution, run, q.load_json(self.fx.root / "docs/research/code-intelligence/query-oracle.v1.json"), admission, facts)

    def test_legacy_05_cas_idempotence(self):
        one = self.fx.persist("cas-control", {"b": 2, "a": 1})[0]; two = self.fx.persist("cas-control", {"a": 1, "b": 2})[0]; self.assertEqual(one, two)

    def test_legacy_06_governed_root(self):
        with self.assertRaises(q.QualificationError): q.persist_content_addressed(Path(self.fx.temporary.name), "bad-set", {"a": 1})

    def test_legacy_07_cross_runtime_canonical(self):
        value = {"z": [3, {"b": 2, "a": 1}], "a": "é"}; path = self.fx.root / "value.json"; path.write_text(json.dumps(value), encoding="utf-8")
        node = "/home/example/.nvm/versions/node/v24.18.0/bin/node"; observed = [json.loads(subprocess.run([node, ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], check=True, capture_output=True, text=True).stdout)["sha256"] for _ in range(3)]
        self.assertEqual(observed, [q.sha256_json(value)] * 3)

    def test_legacy_08_policy_bundle(self):
        self.assertEqual(q.validate_protocol_bundle(self.fx.root)["policyTrusted"], "false")

    def test_legacy_09_foundation_manifest(self):
        pointer = q.load_json(ROOT / "traceability/evidence/research/code-intelligence/foundation-evidence-manifest.json"); path = ROOT / pointer["manifestPath"]
        self.assertEqual(q.sha256_file(path), pointer["manifestSha256"]); q.validate_evidence_manifest(ROOT, q.load_json(path))

    def test_legacy_10_prerelease(self):
        self.assertFalse(q.validate_resolution(self.fx.root, self.fx.synthetic_resolution()))

    def test_legacy_11_runtime_provenance(self):
        receipt = q.validate_runtime_contract(ROOT); self.assertEqual(receipt["node"], "v24.18.0"); self.assertIn("OpenSSL 3.5.6", receipt["openssl"])

    def test_legacy_12_license_gate(self):
        resolution = self.fx.synthetic_resolution(); resolution["licenseDisposition"] = "pending-independent-review"
        self.assertFalse(q.validate_resolution(self.fx.root, resolution))

    def test_legacy_13_synthetic_run_control_is_untrusted(self):
        run, _ = self.fx.run(); self.assertFalse(q.validate_run(self.fx.root, run)); self.assertFalse(q.validate_snapshot(self.fx.root, run["snapshot"]))

    def test_legacy_14_crash_eligibility(self):
        run, _ = self.fx.run(); run["process"]["exitCode"] = 137; run["qualificationEligible"] = True
        with self.assertRaisesRegex(q.QualificationError, "derived value False"): q.validate_run(self.fx.root, run)

    def test_legacy_15_equal_count_wrong_hash(self):
        run, _ = self.fx.run(); snapshot = run["snapshot"]; snapshot["indexInventory"][0]["contentSha256"] = digest("wrong")
        with self.assertRaisesRegex(q.QualificationError, "reconciliation failed"): q.validate_snapshot(self.fx.root, snapshot)

    def test_legacy_16_failed_injection(self):
        run, _ = self.fx.run(); run["failureInjections"][0]["verdict"] = "fail"; run["qualificationEligible"] = True
        with self.assertRaisesRegex(q.QualificationError, "derived value False"): q.validate_run(self.fx.root, run)

    def test_legacy_17_partial_index(self):
        run, _ = self.fx.run(); run["snapshot"]["indexInventory"] = []
        with self.assertRaisesRegex(q.QualificationError, "reconciliation failed"): q.validate_snapshot(self.fx.root, run["snapshot"])

    def test_legacy_18_tool_sequence(self):
        run, _ = self.fx.run(); run["toolCalls"][0]["sequence"] = 2
        with self.assertRaisesRegex(q.QualificationError, "gap-free"): q.validate_run(self.fx.root, run)

    def test_legacy_19_concurrent_snapshot(self):
        run, _ = self.fx.run(); run["snapshot"]["freshness"]["concurrentChangeDetected"] = True
        with self.assertRaisesRegex(q.QualificationError, "concurrently changed"): q.validate_snapshot(self.fx.root, run["snapshot"])

    def test_legacy_20_wrong_repository(self):
        run, _ = self.fx.run(); run["snapshot"]["root"]["repositoryIdentitySha256"] = digest("invented-other")
        self.assertFalse(q.validate_snapshot(self.fx.root, run["snapshot"]))

    def test_review_01_incomplete_run_coverage(self):
        run, _ = self.fx.run(); run["oracleResults"] = run["oracleResults"][:1]; run["failureInjections"] = run["failureInjections"][:1]; run["qualificationEligible"] = True
        with self.assertRaises(q.QualificationError): q.validate_run(self.fx.root, run)

    def test_review_02_unknown_scenario(self):
        run, _ = self.fx.run(); run["scenarioId"] = "S99-invented"; run["qualificationEligible"] = True
        with self.assertRaises(q.QualificationError): q.validate_run(self.fx.root, run)

    def test_review_03_asserted_admission_nonexistent_runs(self):
        run, _ = self.fx.run(); run["fatalInvariantResults"] = run["fatalInvariantResults"][:1]; run["qualificationEligible"] = True
        with self.assertRaises(q.QualificationError): q.validate_run(self.fx.root, run)
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "unavailable"): self.fx.verifier.validate_admission(self.fx.root, self._nonexistent_admission())

    def test_review_04_manifest_omission_zero_protocol_unbound_sanitizer(self):
        run, _ = self.fx.run(); manifest_path = self.fx.root / run["evidenceManifest"]["path"]; manifest = q.load_json(manifest_path); original = deepcopy(manifest)
        manifest["objects"] = manifest["objects"][:-1]; manifest["objectSetSha256"] = q.sha256_json(q._manifest_object_projection(manifest["objects"])); manifest_path.write_bytes(q.canonical_bytes(manifest)); run["evidenceManifest"]["sha256"] = q.sha256_file(manifest_path)
        with self.assertRaisesRegex(q.QualificationError, "exactly match|reconciliation failed"): q.validate_run(self.fx.root, run)
        manifest["protocolSha256"] = "0" * 64; manifest_path.write_bytes(q.canonical_bytes(manifest)); run["evidenceManifest"]["sha256"] = q.sha256_file(manifest_path)
        with self.assertRaises(q.QualificationError): q.validate_run(self.fx.root, run)
        manifest = deepcopy(original); manifest["sanitizationReceiptSha256"] = next(item["sha256"] for item in manifest["objects"] if item["kind"] == "process-telemetry"); manifest_path.write_bytes(q.canonical_bytes(manifest)); run["evidenceManifest"]["sha256"] = q.sha256_file(manifest_path)
        with self.assertRaisesRegex(q.QualificationError, "sanitization"): q.validate_run(self.fx.root, run)

    def test_review_05_empty_substituted_bootstrap_wrong_reproduction(self):
        run, resolution = self.fx.run(); admission = self._bootstrap_admission(run, resolution); protocol = q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json"); oracle = q.load_json(self.fx.root / "docs/research/code-intelligence/query-oracle.v1.json")
        with self.assertRaisesRegex(q.QualificationError, "nonempty facts"): q.build_bootstrap(self.fx.root, protocol, resolution, run, oracle, admission, {})
        substituted = deepcopy(resolution); substituted["candidateId"] = "probe"
        with self.assertRaisesRegex(q.QualificationError, "supplied candidate resolution"): q.build_bootstrap(self.fx.root, protocol, substituted, run, oracle, admission, self._facts())
        selected = deepcopy(resolution); selected.update({"resolutionClass": "official-online-verified", "trustedForQualification": True, "status": "resolved", "licenseDisposition": "approved-for-benchmark-purpose", "blockers": [], "resolverEvidence": {"path": "traceability/evidence/research/code-intelligence/sets/missing/objects/sha256/aa/" + "a" * 64 + ".json", "sha256": "a" * 64}, "licenseEvidence": {"path": "traceability/evidence/research/code-intelligence/sets/missing/objects/sha256/bb/" + "b" * 64 + ".json", "sha256": "b" * 64}, "evidenceManifest": {"path": "traceability/evidence/research/code-intelligence/sets/missing/manifest.json", "sha256": "c" * 64}})
        selected["examinedReleases"] = [{"releaseId": 1, "tag": "v1.2.3", "draft": False, "prerelease": False, "accepted": True, "reason": "latest-stable"}]
        selected["selected"] = {"version": "1.2.3", "tag": "v1.2.3", "releaseId": 1, "releaseUrl": "https://github.com/colbymchenry/codegraph/releases/tag/v1.2.3", "tagCommitSha": SHA1, "sourceArchiveUri": "https://api.github.com/repos/colbymchenry/codegraph/tarball/v1.2.3", "sourceArchiveSha256": digest("source"), "installedExecutableSha256": digest("exe"), "toolSchemaSha256": digest("tools"), "components": [{"name": "runtime", "identity": "runtime", "sha256": digest("runtime")} ]}
        binding, _ = self.fx.persist("synthetic-s01-1", selected); run["candidateResolutionObject"] = binding; run["candidateResolutionSha256"] = q.sha256_json(selected); run["snapshot"]["candidateResolutionSha256"] = run["candidateResolutionSha256"]
        admission = self._bootstrap_admission(run, selected); admission["candidateResolutionObject"] = binding; admission["preAdmissionReproductions"] = [digest("wrong")] * 3
        with self.assertRaisesRegex(q.QualificationError, "reproduction hashes"): q.build_bootstrap(self.fx.root, protocol, selected, run, oracle, admission, self._facts())

    def test_review_06_float_rejected_cross_runtime(self):
        with self.assertRaisesRegex(q.QualificationError, "floating-point"): q.canonical_bytes({"number": 1.0})
        path = self.fx.root / "float.json"; path.write_text('{"number":1.0}\n')
        result = subprocess.run(["/home/example/.nvm/versions/node/v24.18.0/bin/node", ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_review_07_unicode_keys_rejected_cross_runtime(self):
        value = {"\ue000": 1, "😀": 2}
        with self.assertRaisesRegex(q.QualificationError, "non-ASCII"): q.canonical_bytes(value)
        path = self.fx.root / "keys.json"; path.write_text(json.dumps(value, ensure_ascii=False))
        result = subprocess.run(["/home/example/.nvm/versions/node/v24.18.0/bin/node", ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_policy_01_resolution_downgrade(self):
        self._assert_policy_mutation_rejected(lambda value: value["resolution"].__setitem__("rejectDraft", False))

    def test_policy_02_admission_downgrade(self):
        self._assert_policy_mutation_rejected(lambda value: value["admission"].__setitem__("independentEvidenceReviewerRequired", False))

    def test_policy_03_source_url_downgrade(self):
        catalog_path = self.fx.root / "docs/research/code-intelligence/candidates.v1.json"; value = q.load_json(catalog_path); value["candidates"][0]["license"]["source"] = "https://example.invalid/LICENSE"; catalog_path.write_bytes(q.canonical_bytes(value))
        with self.assertRaises(q.QualificationError): q.validate_protocol_bundle(self.fx.root)

    def test_conformance_01_invalid_utf8_rejected_cross_runtime(self):
        path = self.fx.root / "invalid-utf8.json"; path.write_bytes(b'{"value":"\xff"}\n')
        with self.assertRaises(q.QualificationError): q.load_json(path)
        result = subprocess.run([self._node(), ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_conformance_02_lone_surrogates_rejected_cross_runtime(self):
        for name, payload in (("high", b'{"value":"\\ud800"}\n'), ("low", b'{"value":"\\udfff"}\n')):
            path = self.fx.root / f"lone-{name}.json"; path.write_bytes(payload)
            with self.assertRaisesRegex(q.QualificationError, "Unicode"): q.load_json(path)
            result = subprocess.run([self._node(), ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_conformance_03_non_nfc_rejected_cross_runtime(self):
        value = {"value": "e\u0301"}
        with self.assertRaisesRegex(q.QualificationError, "non-NFC"): q.canonical_bytes(value)
        path = self.fx.root / "non-nfc.json"; path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run([self._node(), ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_conformance_04_astral_and_duplicate_key_boundaries(self):
        value = {"emoji": "😀", "composed": "é"}; path = self.fx.root / "astral.json"; path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        observed = json.loads(subprocess.run([self._node(), ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", path], check=True, capture_output=True, text=True).stdout)
        self.assertEqual(observed["sha256"], q.sha256_json(value))
        duplicate = self.fx.root / "duplicate.json"; duplicate.write_text('{"a":1,"\\u0061":2}\n', encoding="utf-8")
        with self.assertRaisesRegex(q.QualificationError, "duplicate"): q.load_json(duplicate)
        result = subprocess.run([self._node(), ROOT / "verification/benchmarks/code-intelligence/canonicalize.mjs", duplicate], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_conformance_05_cas_traversal_and_absolute_paths_rejected(self):
        binding, _ = self.fx.persist("path-probe", {"safe": True})
        traversal = dict(binding); traversal["path"] = traversal["path"].replace("/objects/", "/../objects/")
        absolute = dict(binding); absolute["path"] = str((self.fx.root / binding["path"]).resolve())
        for hostile in (traversal, absolute):
            with self.assertRaises(q.QualificationError): q.load_bound_json_object(self.fx.root, hostile)

    def test_conformance_06_cas_symlink_rejected(self):
        binding, _ = self.fx.persist("symlink-probe", {"safe": True}); target = self.fx.root / binding["path"]
        outside = self.fx.root / "outside.json"; outside.write_bytes(target.read_bytes()); target.unlink(); os.symlink(outside, target)
        with self.assertRaisesRegex(q.QualificationError, "symlink"): q.load_bound_json_object(self.fx.root, binding)

    def test_conformance_07_manifest_cross_set_path_rejected(self):
        sanitizer_a, descriptor_a = self.fx.persist("manifest-a", {"schemaVersion": "code-intelligence-sanitization-receipt/v1", "scope": "a"})
        sanitizer_b, _ = self.fx.persist("manifest-b", {"schemaVersion": "code-intelligence-sanitization-receipt/v1", "scope": "a"})
        descriptor_a["kind"] = "sanitization-receipt"; descriptor_a["path"] = sanitizer_b["path"]
        manifest_binding = self.fx.manifest("manifest-a", [descriptor_a]); manifest = q.load_json(self.fx.root / manifest_binding["path"])
        with self.assertRaises(q.QualificationError): q.validate_evidence_manifest(self.fx.root, manifest)

    def test_conformance_08_runtime_policy_minimums_are_enforced(self):
        path = self.fx.root / "verification/benchmarks/code-intelligence/runtime-policy.json"; policy = q.load_json(path)
        policy["python"]["minimum"] = "99.0"; path.write_bytes(q.canonical_bytes(policy)); self.fx.rebind_runtime_pointer()
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "central runtime-policy minimum"): self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_conformance_09_node_and_openssl_policy_bounds_are_enforced(self):
        path = self.fx.root / "verification/benchmarks/code-intelligence/runtime-policy.json"; policy = q.load_json(path)
        policy["node"]["maximumExclusive"] = "24.0.0"; path.write_bytes(q.canonical_bytes(policy)); self.fx.rebind_runtime_pointer()
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "Node.*central runtime-policy"): self.fx.verifier.validate_runtime_contract(self.fx.root)
        policy = q.load_json(ROOT / q.RUNTIME_POLICY_PATH); policy["openssl"]["minimumMajor"] = 99; path.write_bytes(q.canonical_bytes(policy)); self.fx.rebind_runtime_pointer()
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "OpenSSL.*central runtime-policy"): self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_conformance_10_runtime_toolchain_identity_binds_implementation(self):
        self.fx.verifier.validate_runtime_contract(self.fx.root)
        path = self.fx.root / "verification/benchmarks/code-intelligence/canonicalize.mjs"; path.write_text(path.read_text() + "\n// drift\n")
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "governed verifier/generator/canonicalizer"): self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_conformance_11_bootstrap_version_and_required_inputs_share_policy(self):
        protocol = q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json")
        schema = q.load_json(self.fx.root / "verification/benchmarks/code-intelligence/schemas/bootstrap-output.schema.json")
        self.assertEqual(protocol["bootstrap"]["builderVersion"], schema["properties"]["builderVersion"]["const"])
        identity_required = set(schema["properties"]["projection"]["properties"]["identity"]["required"])
        self.assertIn("admissionSha256", identity_required)
        self.assertTrue(set(protocol["bootstrap"]["requiredInputs"]).issubset(identity_required))

    def test_conformance_12_toolchain_trust_registries_are_closed(self):
        with self.assertRaises(q.QualificationError): q._validate_trust_registry(
            [{"reviewerId": "r", "role": "oracle", "publicKeySha256": digest("key")}], id_field="reviewerId",
            required_fields=["reviewerId", "role", "publicKeySha256", "toolchainSha256"],
            expected_fields={"reviewerId", "role", "publicKeySha256", "toolchainSha256"}, label="reviewer",
        )
        self.assertEqual(q.validate_protocol_bundle(self.fx.root)["policyTrusted"], "false")

    def test_conformance_13_relock_never_promotes_trust(self):
        self._relock()
        observed = q.validate_protocol_bundle(self.fx.root)
        lock = q.load_json(self.fx.root / "docs/research/code-intelligence/policy-bundle-lock.v2.json")
        self.assertEqual(observed["policyTrusted"], "false"); self.assertFalse(lock["qualificationPermitted"]); self.assertIsNone(lock["signature"])
        protocol_path = self.fx.root / "docs/research/code-intelligence/protocol.v2.json"; protocol = q.load_json(protocol_path)
        protocol["claimBoundary"]["reason"] += " Integrity-only relock test."
        protocol_path.write_bytes(q.canonical_bytes(protocol))
        with self.assertRaises(subprocess.CalledProcessError): self._relock()
        with self.assertRaises(q.QualificationError): q.validate_protocol_bundle(self.fx.root)

    def test_conformance_14_policy_version_downgrade_and_path_redirect_rejected(self):
        protocol_path = self.fx.root / "docs/research/code-intelligence/protocol.v2.json"; protocol = q.load_json(protocol_path)
        protocol["protocolVersion"] = "1.9.9"; protocol_path.write_bytes(q.canonical_bytes(protocol))
        with self.assertRaises(subprocess.CalledProcessError): self._relock()
        with self.assertRaises(q.QualificationError): q.validate_protocol_bundle(self.fx.root)
        shutil.copy2(ROOT / "docs/research/code-intelligence/protocol.v2.json", protocol_path); self._relock()
        shutil.copytree(ROOT / "docs/research/code-intelligence", self.fx.root / "replacement-docs")
        lock_path = self.fx.root / "docs/research/code-intelligence/policy-bundle-lock.v2.json"; lock = q.load_json(lock_path)
        lock["documents"][0]["path"] = "replacement-docs/candidates.v1.json"; lock_path.write_bytes(q.canonical_bytes(lock))
        with self.assertRaises(q.QualificationError): q.validate_protocol_bundle(self.fx.root)

    def test_conformance_15_final_bootstrap_identity_changes_with_admission(self):
        protocol = q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json")
        identity = {name: digest(name) for name in protocol["bootstrap"]["requiredInputs"] if name != "admissionSha256"}
        pre = {"identity": identity, "inventory": []}; one = {"admissionId": "one"}; two = {"admissionId": "two"}
        projection_one, admission_one = q._finalize_bootstrap_projection(protocol, pre, one)
        projection_two, admission_two = q._finalize_bootstrap_projection(protocol, pre, two)
        self.assertEqual(projection_one["identity"]["admissionSha256"], admission_one)
        self.assertNotEqual(admission_one, admission_two); self.assertNotEqual(q.sha256_json(projection_one), q.sha256_json(projection_two))

    def test_conformance_16_runtime_pointer_substitution_is_rejected(self):
        alternate = self.fx.root / "verification/benchmarks/code-intelligence/alternate"
        alternate.mkdir()
        policy = alternate / "runtime-policy.json"; host = alternate / "runtime-host-receipt.json"
        shutil.copy2(self.fx.root / q.RUNTIME_POLICY_PATH, policy); shutil.copy2(self.fx.root / q.RUNTIME_HOST_RECEIPT_PATH, host)
        pointer_path = self.fx.root / q.RUNTIME_POINTER_PATH; pointer = q.load_json(pointer_path)
        pointer.update({
            "compatibilityPolicy": policy.relative_to(self.fx.root).as_posix(),
            "compatibilityPolicySha256": q.sha256_file(policy),
            "hostReceipt": host.relative_to(self.fx.root).as_posix(),
            "hostReceiptSha256": q.sha256_file(host),
        })
        pointer_path.write_bytes(q.canonical_bytes(pointer))
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "exact canonical"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)
        shutil.copy2(ROOT / q.RUNTIME_POINTER_PATH, pointer_path)
        pointer = q.load_json(pointer_path); pointer["hostReceiptSha256"] = "0" * 64
        pointer_path.write_bytes(q.canonical_bytes(pointer))
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "target byte identity"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_conformance_17_executing_verifier_must_equal_governed_file(self):
        canonical = subprocess.run(
            ["/usr/bin/python3", MODULE_PATH, "--root", self.fx.root, "check-runtime"],
            capture_output=True, text=True,
        )
        self.assertEqual(canonical.returncode, 2); self.assertIn("executing verifier real path/bytes", canonical.stderr)
        governed_path = self.fx.root / q.OPERATIVE_SOURCE_PATHS[0]
        governed = subprocess.run(
            ["/usr/bin/python3", governed_path, "--root", self.fx.root, "check-runtime"],
            capture_output=True, text=True,
        )
        self.assertEqual(governed.returncode, 0, governed.stderr)
        copied_path = governed_path.with_name("qualification-copy.py"); shutil.copy2(governed_path, copied_path)
        copied = subprocess.run(
            ["/usr/bin/python3", copied_path, "--root", self.fx.root, "check-runtime"],
            capture_output=True, text=True,
        )
        self.assertEqual(copied.returncode, 2); self.assertIn("executing verifier real path/bytes", copied.stderr)

    def test_conformance_18_generator_and_schema_bytes_are_governed(self):
        self.fx.verifier.validate_runtime_contract(self.fx.root)
        generator = self.fx.root / "verification/benchmarks/code-intelligence/policy_schemas.py"
        generator.write_text(generator.read_text() + "\n# hostile generator drift\n")
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "governed verifier/generator/canonicalizer"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)
        shutil.copy2(ROOT / "verification/benchmarks/code-intelligence/policy_schemas.py", generator)
        schema = self.fx.root / "verification/benchmarks/code-intelligence/schemas/run-record.schema.json"
        schema.write_text(schema.read_text() + "\n")
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "governed verifier/generator/canonicalizer"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_conformance_19_dependency_content_mismatch_is_rejected(self):
        host_path = self.fx.root / q.RUNTIME_HOST_RECEIPT_PATH; host = q.load_json(host_path)
        host["distributions"]["attrs"]["packageRoots"] = ["attrs"]
        host_path.write_bytes(q.canonical_bytes(host)); self.fx.rebind_runtime_pointer()
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "package-root contract drift"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)
        host = q.load_json(ROOT / q.RUNTIME_HOST_RECEIPT_PATH)
        host["distributions"]["jsonschema"]["contentSetSha256"] = "0" * 64
        host_path.write_bytes(q.canonical_bytes(host)); self.fx.rebind_runtime_pointer()
        with self.assertRaisesRegex(self.fx.verifier.QualificationError, "distribution content identity drift"):
            self.fx.verifier.validate_runtime_contract(self.fx.root)

    def test_test_family_catalog_boundary(self):
        catalog = q.load_json(ROOT / "verification/benchmarks/code-intelligence/test-family-catalog.v3.json")
        ids = [item["id"] for item in catalog["families"]]; successors = [item["successor"] for item in catalog["families"]]
        self.assertEqual(len(ids), 49); self.assertEqual(len(ids), len(set(ids))); self.assertEqual(len(successors), len(set(successors)))
        implemented = {name for name in dir(type(self)) if name.startswith(("test_legacy_", "test_review_", "test_policy_", "test_conformance_"))}
        self.assertEqual(set(successors), implemented)
        self.assertEqual(sum(item["origin"] == "epoch1-test" for item in catalog["families"]), 20)
        self.assertEqual(sum(item["origin"] == "independent-review" for item in catalog["families"]), 7)
        self.assertEqual(sum(item["origin"] == "policy-redteam" for item in catalog["families"]), 3)
        self.assertEqual(sum(item["origin"] == "epoch2-hardening" for item in catalog["families"]), 15)
        self.assertEqual(sum(item["origin"] == "epoch3-conformance" for item in catalog["families"]), 4)

    def test_additional_crypto_review_signature_is_verified(self):
        openssl = "/usr/bin/openssl"; private = self.fx.root / "private.pem"; public = self.fx.root / "public.pem"; message = self.fx.root / "message.json"; signature = self.fx.root / "signature.bin"
        subprocess.run([openssl, "genpkey", "-algorithm", "Ed25519", "-out", private], check=True, capture_output=True)
        subprocess.run([openssl, "pkey", "-in", private, "-pubout", "-out", public], check=True, capture_output=True)
        payload = {"review": "synthetic-signature-control", "version": 1}; message.write_bytes(q.canonical_bytes(payload))
        subprocess.run([openssl, "pkeyutl", "-sign", "-inkey", private, "-rawin", "-in", message, "-out", signature], check=True, capture_output=True)
        encoded = base64.b64encode(signature.read_bytes()).decode(); q._verify_ed25519(self.fx.root, public.read_text(), payload, encoded)
        corrupted = bytearray(signature.read_bytes()); corrupted[0] ^= 1
        with self.assertRaisesRegex(q.QualificationError, "signature verification failed"): q._verify_ed25519(self.fx.root, public.read_text(), payload, base64.b64encode(corrupted).decode())

    def test_additional_trusted_snapshot_without_receipts_is_rejected(self):
        run, _ = self.fx.run(); snapshot = run["snapshot"]; snapshot["snapshotClass"] = "authorized-real"; snapshot["trustedForQualification"] = True
        with self.assertRaises(q.QualificationError): q.validate_snapshot(self.fx.root, snapshot)

    def test_additional_fictional_official_resolution_is_rejected(self):
        value = self.fx.synthetic_resolution(); value.update({"resolutionClass": "official-online-verified", "trustedForQualification": True, "status": "resolved", "licenseDisposition": "approved-for-benchmark-purpose", "blockers": [], "resolverEvidence": {"path": "traceability/evidence/research/code-intelligence/sets/fake/objects/sha256/aa/" + "a" * 64 + ".json", "sha256": "a" * 64}, "licenseEvidence": {"path": "traceability/evidence/research/code-intelligence/sets/fake/objects/sha256/bb/" + "b" * 64 + ".json", "sha256": "b" * 64}, "evidenceManifest": {"path": "traceability/evidence/research/code-intelligence/sets/fake/manifest.json", "sha256": "c" * 64}})
        value["examinedReleases"] = [{"releaseId": 1, "tag": "v1.2.3", "draft": False, "prerelease": False, "accepted": True, "reason": "latest-stable"}]
        value["selected"] = {"version": "1.2.3", "tag": "v1.2.3", "releaseId": 1, "releaseUrl": "https://example.invalid/release", "tagCommitSha": SHA1, "sourceArchiveUri": "https://example.invalid/source", "sourceArchiveSha256": digest("source"), "installedExecutableSha256": digest("exe"), "toolSchemaSha256": digest("tools"), "components": [{"name": "runtime", "identity": "runtime", "sha256": digest("runtime")}]}
        with self.assertRaises(q.QualificationError): q.validate_resolution(self.fx.root, value)

    def _assert_policy_mutation_rejected(self, mutation) -> None:
        path = self.fx.root / "docs/research/code-intelligence/protocol.v2.json"; value = q.load_json(path); mutation(value); path.write_bytes(q.canonical_bytes(value))
        with self.assertRaises(q.QualificationError): q.validate_protocol_bundle(self.fx.root)

    def _relock(self) -> None:
        subprocess.run(["/usr/bin/python3", self.fx.root / "verification/benchmarks/code-intelligence/policy_schemas.py", "--root", self.fx.root, "--relock"], check=True, capture_output=True, text=True)

    def _node(self) -> str:
        return q.load_json(ROOT / "verification/benchmarks/code-intelligence/runtime-host-receipt.json")["node"]["path"]

    def _nonexistent_admission(self) -> dict:
        run, resolution = self.fx.run(); hashes = [digest(f"missing-{index}") for index in range(9)]; set_id = "admission-probe"
        resolution_binding, _ = self.fx.persist(set_id, resolution)
        fake = lambda label: {"path": f"traceability/evidence/research/code-intelligence/sets/{set_id}/objects/sha256/{digest(label)[:2]}/{digest(label)}.json", "sha256": digest(label)}
        return {
            "schemaVersion": "code-intelligence-admission-record/v3", "admissionId": "probe-admission", "candidateId": resolution["candidateId"],
            "candidateResolutionSha256": q.sha256_json(resolution), "candidateResolutionObject": resolution_binding,
            "protocolSha256": run["protocolSha256"], "policyBundleSha256": run["policyBundleSha256"], "runObjects": [fake(f"missing-{index}") for index in range(9)], "scenarioRunSha256": hashes,
            "coverage": {"scenarioRepetitions": {"S01-clean-polyglot": 3, "S02-monorepo-concurrency": 3, "S03-adversarial-recovery": 3}, "fixtureClasses": ["small-polyglot", "monorepo-multi-language", "adversarial-partially-broken"], "queryClasses": sorted(q.REQUIRED_QUERY_CLASSES), "failureInjections": q.load_json(self.fx.root / "docs/research/code-intelligence/protocol.v2.json")["requiredFailureInjections"]},
            "runnerIdentities": ["synthetic-runner"], "reviewerRegistryObject": fake("registry"), "oracleReviewObject": fake("oracle-review"), "evidenceReviewObject": fake("evidence-review"),
            "supportingEvidence": run["rawEvidence"], "evidenceManifest": {"path": f"traceability/evidence/research/code-intelligence/sets/{set_id}/manifest.json", "sha256": digest("manifest")},
            "admissionVerifierToolchainSha256": self.fx.verifier.validate_runtime_contract(self.fx.root)["toolchainSha256"],
            "preAdmissionProjectionSha256": digest("projection"), "preAdmissionReproductions": [digest("projection")] * 3,
            "licenseDisposition": "approved-for-benchmark-purpose", "decision": "admitted", "reasons": [],
        }

    def _bootstrap_admission(self, run: dict, resolution: dict) -> dict:
        return {"admissionId": "synthetic", "candidateId": resolution["candidateId"], "candidateResolutionSha256": q.sha256_json(resolution), "candidateResolutionObject": run["candidateResolutionObject"], "protocolSha256": run["protocolSha256"], "policyBundleSha256": run["policyBundleSha256"], "scenarioRunSha256": [q.sha256_json(run)], "preAdmissionProjectionSha256": digest("projection"), "preAdmissionReproductions": [digest("projection")] * 3, "decision": "blocked"}

    def _facts(self) -> dict:
        source = {"id": "source-1", "path": "src/a.ts", "contentSha256": digest("a")}
        names = ("structure", "dependencies", "publicApis", "calls", "reuseEvidence")
        value = {name: [{"id": f"{name}-1", "value": {"kind": name}, "sourceEvidenceIds": ["source-1"], "generation": 4}] for name in names}
        return {**value, "sourceEvidence": [source], "knownUnknowns": ["synthetic-untrusted"], "omissions": [{"class": "synthetic", "reason": "not real evidence"}]}


if __name__ == "__main__":
    unittest.main()
