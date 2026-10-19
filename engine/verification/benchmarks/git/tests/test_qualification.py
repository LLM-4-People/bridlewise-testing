from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


TOOL_ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("git_qualification", TOOL_ROOT / "qualification.py")
assert SPEC and SPEC.loader
q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(q)


class QualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = q.load_json(q.CATALOG_PATH)

    def test_catalog_is_complete_and_x3(self) -> None:
        summary = q.validate_catalog(self.catalog)
        self.assertEqual(summary["scenarioCount"], 47)
        self.assertEqual(summary["coverageCount"], 45)
        for scenario in self.catalog["scenarios"]:
            self.assertGreaterEqual(scenario["repetitions"]["minimum"], 3)
            self.assertGreaterEqual(len(set(scenario["repetitions"]["variants"])), 3)
            self.assertTrue(scenario["oracle"]["objectGraphRequired"])
            self.assertFalse(scenario["execution"]["networkMutation"])

    def test_sources_and_schemas_are_parseable_and_bound(self) -> None:
        result = q.validate_suite(verify_manifest_too=q.MANIFEST_PATH.exists())
        self.assertEqual(result["sources"]["localSourcesChecked"], 7)
        self.assertEqual(len(result["schemas"]), 3)

    def test_same_fixture_repetition_has_same_graph_in_different_roots(self) -> None:
        scenario = q.find_scenario(self.catalog, "GIT-REMOTE-001")
        with tempfile.TemporaryDirectory() as left_text, tempfile.TemporaryDirectory() as right_text:
            left = Path(left_text)
            right = Path(right_text)
            q.generate_fixture(left, scenario, 1)
            q.generate_fixture(right, scenario, 1)
            self.assertEqual(q.inspect_fixture(left)["graphSha256"], q.inspect_fixture(right)["graphSha256"])

    def test_oracle_detects_independent_graph_mutation(self) -> None:
        scenario = q.find_scenario(self.catalog, "GIT-STATE-001")
        with tempfile.TemporaryDirectory() as root_text:
            root = Path(root_text)
            q.generate_fixture(root, scenario, 1)
            before = q.inspect_fixture(root)
            repository = root / "workspace"
            q.commit_changes(root, repository, 1, 99, "oracle-mutation", {"mutation.txt": "changed\n"})
            after = q.inspect_fixture(root)
            self.assertNotEqual(before["graphSha256"], after["graphSha256"])
            self.assertNotEqual(before["filesystemSha256"], after["filesystemSha256"])

    def test_self_test_rejects_fewer_than_three_repetitions(self) -> None:
        with self.assertRaises(q.QualificationError):
            q.run_self_test(2, "GIT-ONBOARD-001")

    def test_fault_transport_is_case_bound_and_secret_free(self) -> None:
        with tempfile.TemporaryDirectory() as root_text:
            root = Path(root_text)
            remote = root / "remote.git"
            q.init_repository(root, remote, "main", bare=True)
            env = q.isolated_environment(root)
            completed = subprocess.run(
                [sys.executable, str(q.FAULT_TRANSPORT), "--service", "upload-pack", "--mode", "fail-before", "--repo", str(remote)],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(completed.returncode, 75)
            transcript = (completed.stdout + completed.stderr).decode("utf-8", "replace").lower()
            self.assertNotIn("password", transcript)
            self.assertNotIn("bearer", transcript)

    def test_receive_then_fail_is_a_real_ambiguous_push(self) -> None:
        scenario = q.find_scenario(self.catalog, "GIT-TX-004")
        with tempfile.TemporaryDirectory() as root_text:
            root = Path(root_text)
            fixture_builder = q.FixtureBuilder(root, scenario, 1)
            remote, workspace = fixture_builder.remote_and_clone("destination", commits=2)
            q.commit_changes(root, workspace, 1, 20, "ambiguous", {"ambiguous.txt": "yes\n"})
            before = q.git_text(root, remote, ["rev-parse", "refs/heads/main"])
            receive_pack = shlex.join([
                sys.executable, str(q.FAULT_TRANSPORT), "--service", "receive-pack",
                "--mode", "service-then-fail",
            ])
            completed = q.git(
                root,
                workspace,
                ["push", f"--receive-pack={receive_pack}", "origin", "HEAD:refs/heads/main"],
                check=False,
            )
            after = q.git_text(root, remote, ["rev-parse", "refs/heads/main"])
            self.assertNotEqual(completed.returncode, 0)
            self.assertNotEqual(before, after, "remote must advance while client observes failure")

    def test_dependency_activation_fixture_binds_graph_and_leases(self) -> None:
        scenario = q.find_scenario(self.catalog, "GIT-EVOL-004")
        with tempfile.TemporaryDirectory() as root_text:
            root = Path(root_text)
            fixture = q.generate_fixture(root, scenario, 2)
            dependency = json.loads((root / "control/dependency-graph.json").read_text(encoding="utf-8"))
            self.assertEqual(dependency["activeLeases"], 2)
            self.assertTrue(dependency["contractEvidenceRequired"])
            self.assertTrue((root / "install/current").is_symlink())
            self.assertTrue(fixture["blockers"])

    def test_preflight_never_claims_readiness(self) -> None:
        result = q.probe_preflight()
        self.assertFalse(result["readinessClaim"])
        encoded = json.dumps(result).lower()
        self.assertNotIn("authorization: bearer", encoded)


if __name__ == "__main__":
    unittest.main()
