/**
 * THE DOOR'S VERDICT — one pure judgement of one completed CI run, from what
 * the door re-derived itself (github-only §5.3 step 3):
 *
 *   - IDENTITY: the plan names the tree GitHub says the run built — for a pull
 *     request, the test merge of the base and exactly the PR head GitHub named;
 *     for a merge group or any other event, the run's own head commit — and
 *     the run is this repository's (a fork's receipt is never trusted for
 *     reuse, and its run is judged cold);
 *   - THE RECEIPT, RE-SEALED: the door seals the downloaded results itself
 *     with the job outcomes GitHub reports (never the run's own `seal` job or
 *     its receipt file), so a run cannot certify itself;
 *   - THE ATTEMPT DISCIPLINE: if an earlier attempt of this run failed, the
 *     verdict is failure whatever a later attempt says — a re-run never
 *     launders a failure (UR-17, FLAKE-REPRO); only a new tree turns it green;
 *   - THE RATCHET, THE TREE JUDGE and the QUEUE INTEGRITY findings;
 *   - CPU-work budgets: judged once the per-file ledger exists (P3.4); until
 *     then the verdict says the budgets are `unmeasured`, never invented.
 *
 * The verdict renders as the `bridlewise/door` check run: a summary table, an
 * annotation per finding at its path, and the two buttons.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { renderReceipt, type GateReceipt } from "../gates/seal.ts";
import type { CheckAnnotation, CheckRunWrite } from "./door-github.ts";
import { DOOR_LIMITS } from "./door-config.ts";
import type { RatchetVerdict } from "./ratchet.ts";
import type { TreeFinding } from "./tree-judge.ts";

const DOOR_VERDICT_SCHEMA = schemaId("door-verdict", 1);

/** The two buttons of the check (`requested_action` identifiers, at most 20 characters). */
export const DOOR_ACTIONS = deepFreeze([
  { label: "Re-run cold", description: "Run every gate again, reusing nothing", identifier: "rerun-cold" },
  { label: "Explain", description: "Show each failure's full message", identifier: "explain" },
] as const);

export type IdentityFinding = Readonly<{ rule: "identity"; detail: string }>;
export type AttemptFinding = Readonly<{ rule: "attempt-laundering"; detail: string }>;
export type QueueFinding = Readonly<{ rule: "queue-integrity"; detail: string }>;

export type VerdictInputs = Readonly<{
  /** K (the key document's digest) the verdict is for. */
  key: string;
  receipt: GateReceipt;
  identity: readonly IdentityFinding[];
  attempts: readonly AttemptFinding[];
  ratchet: RatchetVerdict;
  tree: readonly TreeFinding[];
  queue: readonly QueueFinding[];
  /** The CI run the verdict judged (its URL, for the check's details). */
  runUrl: string;
  /** Failed test files from the cells' reports (path, first line of the failure), for annotations. */
  failedTests: readonly Readonly<{ path: string; message: string }>[];
}>;

export type DoorVerdict = Readonly<{
  schemaVersion: typeof DOOR_VERDICT_SCHEMA;
  key: string;
  treeId: string;
  headSha: string;
  conclusion: "success" | "failure";
  ciChanging: boolean;
  receiptVerdict: GateReceipt["verdict"];
  findings: readonly Readonly<{ rule: string; path?: string; commit?: string; gate?: string; detail: string }>[];
  budgets: "unmeasured";
  runUrl: string;
}>;

export function judgeRun(inputs: VerdictInputs): DoorVerdict {
  const findings = [...inputs.identity, ...inputs.attempts, ...inputs.queue, ...inputs.ratchet.findings, ...inputs.tree];
  const conclusion = findings.length === 0 && inputs.receipt.verdict === "passed" ? "success" : "failure";
  return deepFreeze({
    schemaVersion: DOOR_VERDICT_SCHEMA,
    key: inputs.key,
    treeId: inputs.receipt.treeId,
    headSha: inputs.receipt.headSha,
    conclusion,
    ciChanging: inputs.ratchet.ciChanging,
    receiptVerdict: inputs.receipt.verdict,
    findings: findings.map((finding) => ({ ...finding })),
    budgets: "unmeasured",
    runUrl: inputs.runUrl,
  });
}

/** Markdown inline code. */
function code(text: string): string {
  return ["`", text, "`"].join("");
}

/** GitHub's bounds on a check run's output (title 255, summary and text 65535 characters). */

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 40)}\n\n… (clipped at ${String(max)} characters)`;
}

/** The check run the verdict is shown as. */
export function verdictCheckRun(verdict: DoorVerdict, receipt: GateReceipt, failedTests: VerdictInputs["failedTests"]): CheckRunWrite {
  const failedGates = receipt.gates.filter((gate) => gate.role === "required" && gate.status === "failed").map((gate) => gate.id);
  const title = verdict.conclusion === "success"
    ? `Every required gate passed (${String(receipt.tests)} suite tests)`
    : `Refused: ${[...failedGates.map((id) => `${id} failed`), ...verdict.findings.map((finding) => finding.rule)].slice(0, DOOR_LIMITS.refusalsNamed).join(", ")}`;
  const lines = [
    `**Verdict:** ${verdict.conclusion}  ·  **K:** ${code(verdict.key)}  ·  [CI run](${verdict.runUrl})`,
    verdict.ciChanging ? "\n**This tree changes CI** (the gate catalogue or its generator): it is judged cold and is never reused." : "",
    "\n**CPU-work budgets:** unmeasured — the per-file ledger is seeded by the first cold runs on main (P3.4); no budget is invented before it.",
    "",
    renderReceipt(receipt),
  ];
  if (verdict.findings.length > 0) {
    lines.push("### The door's findings", "", ...verdict.findings.map((finding) => {
      const where = [
        finding.path === undefined ? "" : ` ${code(finding.path)}`,
        finding.commit === undefined ? "" : ` (commit ${code(finding.commit.slice(0, DOOR_LIMITS.commitShaCharacters))})`,
        finding.gate === undefined ? "" : ` (gate ${code(finding.gate)})`,
      ].join("");
      return `- **${finding.rule}**${where}: ${finding.detail}`;
    }));
  }
  const annotations: CheckAnnotation[] = [
    ...verdict.findings.filter((finding) => finding.path !== undefined).map((finding): CheckAnnotation => ({
      path: finding.path!, start_line: 1, end_line: 1, annotation_level: "failure", title: finding.rule, message: finding.detail.slice(0, DOOR_LIMITS.annotationMessageCharacters),
    })),
    ...failedTests.map((test): CheckAnnotation => ({ path: test.path, start_line: 1, end_line: 1, annotation_level: "failure", title: "test failed", message: test.message.slice(0, DOOR_LIMITS.annotationMessageCharacters) })),
  ];
  return deepFreeze({
    status: "completed",
    conclusion: verdict.conclusion,
    externalId: verdict.key,
    detailsUrl: verdict.runUrl,
    title: clip(title, DOOR_LIMITS.titleCharacters),
    summary: clip(lines.join("\n"), DOOR_LIMITS.summaryCharacters),
    annotations,
    actions: DOOR_ACTIONS.map((action) => ({ ...action })),
  });
}

/**
 * THE ATTEMPT DISCIPLINE: the earlier attempts of the run that did not pass.
 * A cancelled attempt is not a failure (the queue or a newer push stopped
 * it); a failed or timed-out one is, and it stands.
 */
export function judgeAttempts(attempts: readonly Readonly<{ attempt: number; conclusion: string | null }>[], current: number): readonly AttemptFinding[] {
  return deepFreeze(attempts
    .filter((entry) => entry.attempt < current && (entry.conclusion === "failure" || entry.conclusion === "timed_out"))
    .map((entry) => ({ rule: "attempt-laundering" as const, detail: `attempt ${String(entry.attempt)} of this run ended ${String(entry.conclusion)}; a later attempt cannot turn the same tree green (a flake is fixed at its cause, in a new tree)` })));
}

/** The failed files of a web cell's vitest report, with the first line of their first failure (for annotations; never a verdict input). */
export function failedTestFiles(report: unknown, toRepositoryPath: (name: string) => string | null): readonly Readonly<{ path: string; message: string }>[] {
  const rows = (report as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(rows)) return [];
  const failed: { path: string; message: string }[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (row === null || typeof row !== "object" || row.status === "passed") continue;
    const path = toRepositoryPath(String(row.name ?? ""));
    if (path === null) continue;
    const assertions = Array.isArray(row.assertionResults) ? (row.assertionResults as Record<string, unknown>[]) : [];
    const first = assertions.find((assertion) => assertion?.status !== "passed");
    const message = String(Array.isArray(first?.failureMessages) ? (first!.failureMessages as unknown[])[0] ?? "" : row.message ?? "").split("\n")[0] ?? "";
    failed.push({ path, message: `${first?.title === undefined ? "" : `${String(first.title)}: `}${message}`.slice(0, DOOR_LIMITS.testMessageCharacters) });
  }
  return failed;
}
