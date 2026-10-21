/**
 * THE EXTERNAL-COMMAND INVENTORY — the blocked Python/shell commands the
 * architecture manifest declares, and the exact source bytes each one was
 * qualified against.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────
 *
 * The values belong to `ArchitectureManifest.externalCommands` (this module is
 * imported by `architecture-manifest.ts` and read through it by the verifier
 * and the effect inventory). They live HERE because the hash-binding registry
 * must derive one source binding per published command, and it is reachable
 * from the measured surface: a frontend test reaches
 * `tree-identity -> hash-binding-registry`, so a static import of the 500 KB
 * generated manifest module blew the frontend-closure bound (round 5). This
 * module is the same one owner — no list is duplicated, the registry reads the
 * command ids/paths/digests from here and the manifest spreads the same array.
 *
 * The type import below is TYPE-ONLY (erased at runtime): the manifest imports
 * this module's value, so a value import back would be a runtime cycle.
 */
import type { ArchitectureExternalCommand } from "../architecture-manifest.ts";

import { deepFreeze } from "./integrity.ts";

type ExternalCommandInput = Omit<ArchitectureExternalCommand, "disposition" | "exposure" | "language" | "publication">;

function blockedPythonCommand(input: ExternalCommandInput): ArchitectureExternalCommand {
  return {
    ...input,
    disposition: "blocked-unqualified",
    exposure: "verification-internal",
    language: "python",
    publication: "published",
  };
}

/**
 * A declared external command whose source the PUBLIC SNAPSHOT deliberately
 * does not carry. The architecture verifier still refuses it (named
 * `architecture-external-command-source-not-published`) and refuses it again
 * if the source appears; this is a boundary declaration, not a skip.
 */
function blockedNotPublishedPythonCommand(input: ExternalCommandInput): ArchitectureExternalCommand {
  return {
    ...input,
    disposition: "blocked-unqualified",
    exposure: "verification-internal",
    language: "python",
    publication: "not-published",
  };
}

function blockedResearchShellCommand(input: ExternalCommandInput): ArchitectureExternalCommand {
  return {
    ...input,
    disposition: "blocked-unqualified",
    exposure: "research-only-non-model-facing",
    language: "shell",
    publication: "published",
  };
}

export const ARCHITECTURE_EXTERNAL_COMMANDS: readonly ArchitectureExternalCommand[] = deepFreeze([
  blockedPythonCommand({
    id: "code-intelligence-inspect-existing-baseline",
    path: "verification/benchmarks/code-intelligence/inspect_existing_baseline.py",
    owner: "code-intelligence-qualification", effects: ["filesystem-read", "process-status"],
    sourceSha256: "478d81228488ade967f79d110b7b386af4f489b8f659919f72d86454b63f2279",
  }),
  blockedPythonCommand({
    id: "code-intelligence-mcp-probe", path: "verification/benchmarks/code-intelligence/mcp_probe.py",
    owner: "code-intelligence-qualification",
    effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
    sourceSha256: "d7c7f19210e049904cf24a089acfd5b1a2044a2c71bb42424a316d875a6cefa7",
  }),
  blockedPythonCommand({
    id: "code-intelligence-policy-schemas", path: "verification/benchmarks/code-intelligence/policy_schemas.py",
    owner: "code-intelligence-qualification",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "6ecba33199fb695b20855ec43f0a0ac895b2817cfa894368d339182499228552",
  }),
  blockedPythonCommand({
    id: "code-intelligence-qualification", path: "verification/benchmarks/code-intelligence/qualification.py",
    owner: "code-intelligence-qualification",
    effects: [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
      "process-status",
    ],
    sourceSha256: "7a1a6a82af9e38a4723b5258a45a41d7b567d207eedd8511da2156a2ce8a4560",
  }),
  blockedPythonCommand({
    id: "code-intelligence-qualification-tests",
    path: "verification/benchmarks/code-intelligence/tests/test_qualification.py",
    owner: "code-intelligence-qualification",
    effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "git"],
    sourceSha256: "191b4eb3d930bdce16028a03439248c804c63b6799fbeb38bea96c9f58d6f1c5",
  }),
  blockedPythonCommand({
    id: "context-generate-scenarios", path: "verification/benchmarks/context/generate-scenarios.py",
    owner: "context-qualification",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "e8e87c399c065268b041a5fbfef97a725fea44bbb891bec3b11a712d37399cae",
  }),
  blockedPythonCommand({
    id: "context-validate-suite", path: "verification/benchmarks/context/validate-suite.py",
    owner: "context-qualification", effects: ["cryptography", "filesystem-read", "process-status"],
    sourceSha256: "80989cd3e8dc19213c824bd2873061cd889352dabda1802feeb25ccbe4a14c56",
  }),
  blockedPythonCommand({
    id: "git-fault-transport", path: "verification/benchmarks/git/fault_transport.py",
    owner: "git-qualification",
    effects: ["child-process", "filesystem-read", "filesystem-write", "git", "process-status"],
    sourceSha256: "22346a118033f8e36cf68e4f9185b95fa347f53272a5538034d1e5f5de17a8b9",
  }),
  blockedPythonCommand({
    id: "git-qualification", path: "verification/benchmarks/git/qualification.py",
    owner: "git-qualification",
    effects: [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
      "process-status",
    ],
    sourceSha256: "a6ada0ea61477b9fe6e579aa0bcfd758ec234cce10d2b639cbbb0bd04140d350",
  }),
  blockedPythonCommand({
    id: "git-qualification-tests", path: "verification/benchmarks/git/tests/test_qualification.py",
    owner: "git-qualification",
    effects: ["child-process", "filesystem-read", "filesystem-write", "git"],
    sourceSha256: "be99b25c1455cb26c377e8b5b6e17676fd4a4519257894a155b39e29d6123cf5",
  }),
  // The not-published commands declare a boundary: their sources are
  // deliberately absent from the public snapshot, so no generator can
  // re-derive these literals. They are authored refusal pins (the same
  // declaration `blockedNotPublishedPythonCommand` makes), not values a
  // sync pass rewrites; the published pins above remain binding-owned.
  // BEGIN AUTHORED PINS
  blockedNotPublishedPythonCommand({
    id: "historical-conversation-build-manifest",
    path: "verification/benchmarks/historical-opencode/conversation-study/build_manifest.py",
    owner: "historical-conversation-study",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "230daf654a973ab310f07aeb5d7475b2b9b509dd7395329d0b4789f80ba69fba",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-conversation-build-work-units",
    path: "verification/benchmarks/historical-opencode/conversation-study/build_work_units.py",
    owner: "historical-conversation-study",
    effects: ["filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "056410719cf1772a89db678c21d0f73eb6e2fe0dd840f527d293f5d2d29f529d",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-conversation-review-digest",
    path: "verification/benchmarks/historical-opencode/conversation-study/review_digest.py",
    owner: "historical-conversation-study", effects: ["child-process", "process-status"],
    sourceSha256: "105d6881872d6b8a9b950549f58f2bdb4d43a587009daae2b79af01a40c71e92",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-conversation-validate-failures-agent-b",
    path: "verification/benchmarks/historical-opencode/conversation-study/validate_failures_agent_b.py",
    owner: "historical-conversation-study", effects: ["cryptography", "filesystem-read", "process-status"],
    sourceSha256: "b4543886622b27c1d5f5028e160d6e3e83dcb0d0b97b9651b58dd903d19a8d7d",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-editor-analyze-history",
    path: "verification/benchmarks/historical-opencode/editor-benchmark/analyze_history.py",
    owner: "historical-editor-benchmark",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "2efadd06b1c494aa6ca1f2761818526ba69ce2a6d966efe748b0f3f721f23ea4",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-editor-validate-artifacts",
    path: "verification/benchmarks/historical-opencode/editor-benchmark/validate_artifacts.py",
    owner: "historical-editor-benchmark", effects: ["filesystem-read", "process-status"],
    sourceSha256: "9f1fc90b0cdb4af4a6e5ea3a190531bb65b797e4f0d36f8380f42d47f6e5b4b0",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-production-integration-test-manifest",
    path: "verification/benchmarks/historical-opencode/production-methodology/v4.7.0/integration_test_manifest.py",
    owner: "historical-production-methodology", effects: ["filesystem-read", "process-status"],
    sourceSha256: "6463488a834820fbc2b3dbdbce9ae4920f7abf6632b10ec04f36d36ac8306fd1",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-read-only-generate-fixtures",
    path: "verification/benchmarks/historical-opencode/read-only-adapter/fixtures/generate_fixtures.py",
    owner: "historical-read-only-adapter",
    effects: ["filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "3534832ceade313ab7ac561d0e0ce893d06ecca07ea120ba37d1d4fecc0b1001",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-read-only-adapter-tests",
    path: "verification/benchmarks/historical-opencode/read-only-adapter/tests/test_adapter.py",
    owner: "historical-read-only-adapter", effects: ["cryptography", "filesystem-read", "filesystem-write"],
    sourceSha256: "5680c81960c3f34a09e8850996c042e11685884233c7e0132770eaea7cf832d5",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-analysis",
    path: "verification/benchmarks/historical-opencode/sanitizer/opencode_analysis.py",
    owner: "historical-sanitizer",
    effects: ["child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "process-status"],
    sourceSha256: "c6ce9bebf5ef52bc647b1e74ca7d6140224d47a626b07a4d58cbd6b3b105c33c",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-tests",
    path: "verification/benchmarks/historical-opencode/sanitizer/test_v46.py",
    owner: "historical-sanitizer",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "network"],
    sourceSha256: "7d1c789c0b7e794fd0d5f65216aeeaf7ad682d0b2f5e69744303654be40e7a19",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-acceptance-tests",
    path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_acceptance.py",
    owner: "historical-sanitizer",
    effects: [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
    ],
    sourceSha256: "61b8176f182ae3de95ca259307132ae747e2c4ca88de5dc01922a55c38cafdd4",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-lineage-tests",
    path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_lineage_v467.py",
    owner: "historical-sanitizer", effects: [],
    sourceSha256: "96483c0a8569543cca3b4e64228a58a7569ef872f5b6cb157c0e515fd41a18b0",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-property-tests",
    path: "verification/benchmarks/historical-opencode/sanitizer/test_v46_properties.py",
    owner: "historical-sanitizer", effects: [],
    sourceSha256: "4dec25d344e81323c083c968ab42dbeb9db83d65c7a080906a3f8960bf1ec92a",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-public-verify",
    path: "verification/benchmarks/historical-opencode/sanitizer/v46_public_verify.py",
    owner: "historical-sanitizer",
    effects: ["cryptography", "filesystem-read", "filesystem-write", "process-status"],
    sourceSha256: "f1ed4ffbc0c088bdb005fbccb9194e8ddef901fe8a70313c2603882f70e4354b",
  }),
  blockedNotPublishedPythonCommand({
    id: "historical-sanitizer-test-manifest",
    path: "verification/benchmarks/historical-opencode/sanitizer/v46_test_manifest.py",
    owner: "historical-sanitizer", effects: ["filesystem-read", "process-status"],
    sourceSha256: "2d6970558c9b294c56da4bc91dc92d81db1efbad4906136bde4cc6a6d9609af0",
  }),
  // END AUTHORED PINS
  blockedResearchShellCommand({
    id: "node-v24-linux-x64-runtime-provenance-verifier",
    path: "verification/benchmarks/runtime/verify-node-v24.18.0-linux-x64.sh",
    owner: "runtime-capability-qualification",
    effects: [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "network", "process-status",
    ],
    sourceSha256: "8d20dcf7a41dc4b936a0f256f8200b07d13700dfec779ca6bdc7b2a2b2c58924",
  }),
]);
