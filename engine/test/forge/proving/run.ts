/**
 * THE PROVING-GROUND RUNNER of the workspace's scenarios (runbook P1.11,
 * P3.8): `node test/forge/proving/run.ts <step>…` from the engine folder,
 * where a step is `seed` (the repository's first commit on `main`, made by
 * the agent while it is empty), `check` (the configuration the scenarios
 * need, read only), `V-6`, `V-14` or `V-15` (the workspace's, as the `agent`
 * App from the host key home), or `V-25` or `V-28` (the projector's, as the
 * publisher App: run in the publish job, with the installation tokens it
 * hands in `BRIDLEWISE_PUBLISHER_TOKEN` and, narrowed to `issues: write`,
 * `BRIDLEWISE_PUBLISHER_ISSUES_TOKEN`). Each step prints ONE JSON line (its
 * verdict, detail and evidence URLs) and the runner exits 1 when any failed.
 * Each App's ground is reached only when a step asks for it; no credential
 * is printed. Its scratch is the process's own temporary
 * folder (`createTempDir`), removed when it exits.
 */
import { createTempDir } from "../../support/temp-dir.ts";
import { requireConfigured, seedMain, type Verdict } from "../proving-ground-api.ts";
import { v25, v28 } from "./projection-scenarios.ts";
import { provingGround, publisherProvingGround } from "./proving-ground.ts";
import { v14, v15, v6 } from "./workspace-scenarios.ts";

const steps = process.argv.slice(2);
const known = new Set(["seed", "check", "V-6", "V-14", "V-15", "V-25", "V-28"]);
if (steps.length === 0 || steps.some((step) => !known.has(step))) {
  process.stderr.write(`usage: node test/forge/proving/run.ts <${[...known].join("|")}>…\n`);
  process.exit(2);
}
/** The agent's ground, reached on the first workspace step (the publish job holds no agent key). */
let agentGround: ReturnType<typeof provingGround> | undefined;
const ground = (): ReturnType<typeof provingGround> => (agentGround ??= provingGround());
// The process's own temporary folder (removed when it exits): the clone and the worktrees; the evidence is on GitHub.
const scratch = createTempDir("proving-ground-");
let failed = false;
for (const step of steps) {
  let verdict: Verdict;
  try {
    if (step === "seed") {
      const seeded = await seedMain(ground());
      verdict = { v: "seed", status: "pass", detail: seeded.created ? "main seeded by the agent" : "main already exists", evidence: [`${ground().webUrl}/${ground().owner}/${ground().name}/commit/${seeded.head}`] };
    } else if (step === "check") {
      await requireConfigured(ground());
      verdict = { v: "check", status: "pass", detail: "main exists; merge_queue and required_signatures in force on it; delete_branch_on_merge on", evidence: [] };
    } else if (step === "V-25") {
      verdict = await v25(publisherProvingGround("BRIDLEWISE_PUBLISHER_TOKEN"));
    } else if (step === "V-28") {
      verdict = await v28(publisherProvingGround("BRIDLEWISE_PUBLISHER_ISSUES_TOKEN"));
    } else {
      verdict = await (step === "V-6" ? v6 : step === "V-14" ? v14 : v15)(ground(), scratch);
    }
  } catch (error) {
    const typed = error as { code?: unknown; forgeCode?: unknown; message?: unknown };
    verdict = { v: step, status: "fail", detail: `${String(typed.forgeCode ?? typed.code ?? "error")}: ${String(typed.message).slice(0, 600)}`, evidence: [] };
  }
  failed ||= verdict.status === "fail";
  process.stdout.write(`${JSON.stringify({ ...verdict, at: new Date().toISOString() })}\n`);
}
process.exit(failed ? 1 : 0);
