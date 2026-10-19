/**
 * PREVENTION: EVERY MARKDOWN LINK NAMES SOMETHING THAT EXISTS — a file or
 * folder of the tree, or a path an evidence manifest records
 * (`evidence:<path>`, src/workflow/evidence-store.ts).
 *
 * The scan is the runtime's (`deadMarkdownLinks`, src/workflow/record-links.ts),
 * registered with its baseline's generator
 * (`scripts/verification/ratchet-baselines.ts`, id `dead-markdown-links`), so
 * this guard, `harness check` (which fails on new debt) and `harness sync`'s
 * prune judge the same keys. The links come from the one Markdown parser
 * (shared/markdown.ts: code is never a link), and a document under a frozen
 * record root (ROOT_POLICY.verification.frozenRecordRoots) is history, exempted
 * by the root. The 206 links dead when the ratchet was introduced (2026-10-07)
 * are gone: the 46 in live documents were fixed (12 were the old regex's code
 * false positives) and the 160 in imported records sit under frozen roots — so
 * the baseline is EMPTY and stays so: any dead link fails `harness check`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { committedRatchetBaseline, judgeRatchet, parseRatchetBaseline, ratchetFailure } from "../../scripts/verification/ratchet.ts";
import { ratchetBaseline } from "../../scripts/verification/ratchet-baselines.ts";
import { repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { ratchetBaselinesStep } from "../../src/workflow/harness-commands.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPOSITORY_ROOT = repositoryToplevel(ROOT, "directory") ?? dirname(ROOT);
const DEAD_LINKS = ratchetBaseline("dead-markdown-links");

test("prevention: no Markdown document gains a link to a path that is neither in the tree nor recorded by an evidence manifest", () => {
  const baseline = parseRatchetBaseline(readFileSync(join(REPOSITORY_ROOT, DEAD_LINKS.path), "utf8"), DEAD_LINKS.path);
  const findings = DEAD_LINKS.findings(REPOSITORY_ROOT);
  const where = new Map(findings.map((finding) => [finding.key, finding.where]));
  const verdict = judgeRatchet(findings.map((finding) => finding.key), baseline, committedRatchetBaseline(REPOSITORY_ROOT, DEAD_LINKS.id));
  const failure = ratchetFailure(DEAD_LINKS.path, { ...verdict, unbaselined: verdict.unbaselined.map((key) => where.get(key) ?? key) });
  assert.equal(
    failure,
    undefined,
    `${failure ?? ""}\n  Fix: link a file of the tree by its relative path, or stored evidence as evidence:<recorded path> (cd engine && node src/cli.ts harness evidence ingest --manifest <dir>/evidence-manifest.json <path> stores and records it).`,
  );
});

test("prevention scanner: the guard sees a planted dead link, a relative link into stored evidence and an unrecorded evidence link", () => {
  const keys = (findings: readonly { key: string }[]): readonly string[] => findings.map((finding) => finding.key);
  const baseline = parseRatchetBaseline(readFileSync(join(REPOSITORY_ROOT, DEAD_LINKS.path), "utf8"), DEAD_LINKS.path);
  const current = keys(DEAD_LINKS.findings(REPOSITORY_ROOT));
  const planted = ["docs/x.md: ../gone.md", "docs/x.md: evidence/run.log.txt", "docs/x.md: evidence:docs/none.txt"];
  assert.deepEqual(judgeRatchet([...current, ...planted], baseline, baseline).unbaselined, planted, "each planted dead link is new debt");
});

test("prevention: the accepted list is EMPTY — no dead link is accepted debt", () => {
  const baseline = parseRatchetBaseline(readFileSync(join(REPOSITORY_ROOT, DEAD_LINKS.path), "utf8"), DEAD_LINKS.path);
  assert.deepEqual(baseline.entries, [], "every live dead link is fixed and every frozen record is exempt by its root");
});

test("harness check FAILS on a new dead link and names it (correctness N3): the ratchet step judges new debt, not only stale entries", () => {
  const arm = (unbaselined: readonly string[]) => ({ status: "current" as const, converged: true, results: [{ id: DEAD_LINKS.id, path: DEAD_LINKS.path, status: "current", stale: [], unbaselined }] });
  const red = ratchetBaselinesStep(arm(["docs/x.md: gone.md"]));
  assert.equal(red.status, "fail");
  assert.ok(red.message.startsWith("new debt no ratchet baseline accepts"), red.message);
  assert.ok(red.message.includes("dead-markdown-links: docs/x.md: gone.md"), `the new debt is named: ${red.message}`);
  assert.equal(ratchetBaselinesStep(arm([])).status, "pass", "no new debt and nothing stale passes");
  assert.equal(ratchetBaselinesStep({ ...arm([]), converged: false }).status, "fail", "stale debt still fails");
});
