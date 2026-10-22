// @vitest-environment node
/**
 * DECISIONS ARE FILES (`docs/decisions/`): one file per decision, each with
 * its front matter, each listed in the folder's README — so a decision is
 * found by name and cited by id, never only in a scratch plan.
 *
 * Judged by the one checker (`engine/scripts/verification/tracker-entries.ts`):
 * ids in the form the plan and the specs cite (`DECISION_ID`) name their files and are unique together with their `covers` aliases;
 * `superseded_by` and `overrides` name decisions that exist; `implementation`
 * says how far the decision is carried out, with the task that carries it
 * (`route`) or where it was carried out (`acted_in`, repository paths the
 * commit that writes the decision holds: the commit door judges that, once).
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readEntries } from "../../engine/src/workflow/failure-owners.ts";
import { DECISIONS_DIRECTORY, decisionViolations, renderDecisionIndex } from "../../engine/scripts/verification/tracker-entries.ts";
import { DECISION_INDEX, spliceGeneratedBlock } from "../../engine/src/kernel/verification-paths.ts";

const ROOT = process.cwd();

describe("docs/decisions", () => {
  test("every decision file is well formed, and the README's index is the generator's output (harness sync)", () => {
    const entries = readEntries(ROOT, DECISIONS_DIRECTORY);
    expect(entries.length, "the folder holds no decision").toBeGreaterThan(5);
    const index = readFileSync(join(ROOT, DECISIONS_DIRECTORY, "README.md"), "utf8");
    // acted_in paths judged by shape here; whether git holds them is judged by the commit that writes them.
    expect(decisionViolations(entries)).toEqual([]);
    // wf-1b3a-design M1: the index restates each file's state, so it is generated, never typed.
    expect(spliceGeneratedBlock(index, DECISION_INDEX, renderDecisionIndex(entries)), "docs/decisions/README.md's index is stale: run harness sync").toBe(index);
    for (const { name } of entries) expect(index, `${name} is missing from the index`).toContain(`(${name})`);
  });

  test("the format check refuses what it names (planted)", () => {
    const tracked = new Set(["engine/src/a.ts"]);
    const entry = (name: string, front: string): { name: string; text: string } => ({ name, text: `---\n${front}\n---\n# Title\n` });
    const base = "id: D-09\ndate: 2026-09-28\nby: user\ngroup: process\nstatus: in-force\nimplementation: standing";
    const other = entry("U2-other.md", "id: U2\ndate: 2026-09-28\nby: user\ngroup: prompt-cache\nstatus: in-force\nimplementation: done\nacted_in: [engine/src/a.ts]\ncovers: [UD-C1, X3b]");
    expect(decisionViolations([entry("D-09-x.md", base), other], tracked)).toEqual([]);
    const amendedOther = entry("U2-other.md", "id: U2\ndate: 2026-09-28\nby: user\ngroup: prompt-cache\nstatus: in-force\nimplementation: done\nacted_in: [engine/src/a.ts]\ncovers: [UD-C1, X3b]\namended_by: [D-09]");
    expect(decisionViolations([entry("D-09-x.md", `${base}\noverrides: [U2, UD-C1]`), amendedOther], tracked)).toEqual([]);
    // An amendment is recorded on both ends: an override the amended decision does not name, or an amended_by no override backs, is refused.
    expect(decisionViolations([entry("D-09-x.md", `${base}\noverrides: [U2]`), other], tracked)).toEqual(["U2-other.md: D-09 overrides it, so its amended_by must name D-09"]);
    expect(decisionViolations([entry("D-09-x.md", `${base}\noverrides: [UD-C1]`), other], tracked), "through a covered alias").toEqual(["U2-other.md: D-09 overrides it, so its amended_by must name D-09"]);
    expect(decisionViolations([entry("D-09-x.md", base), amendedOther], tracked)).toEqual(["U2-other.md: amended_by D-09 does not override this decision (its overrides must name U2)"]);
    expect(renderDecisionIndex([entry("D-09-x.md", `${base}\noverrides: [U2]`), amendedOther])).toContain("| [U2](U2-other.md) | Title (covers UD-C1, X3b) | user | done, amended by D-09 |");
    expect(decisionViolations([entry("D-09-x.md", base.replace("in-force", "superseded") + "\nsuperseded_by: U2"), other], tracked)).toEqual([]);
    const broken: Record<string, string> = {
      "no date": base.replace("date: 2026-09-28\n", ""),
      "no group": base.replace("group: process\n", ""),
      "an unknown group": base.replace("group: process", "group: misc"),
      "an unknown author": base.replace("by: user", "by: someone"),
      "an id in another form": base.replace("id: D-09", "id: d09"),
      "superseded without superseded_by": base.replace("in-force", "superseded"),
      "superseded_by an unknown id": `${base.replace("in-force", "superseded")}\nsuperseded_by: D-99`,
      "superseded_by on an in-force decision": `${base}\nsuperseded_by: U2`,
      "overrides an unknown id": `${base}\noverrides: [D-99]`,
      "covers an id another decision holds": `${base}\ncovers: [UD-C1]`,
      "no implementation": base.replace("\nimplementation: standing", ""),
      "pending without a route": base.replace("standing", "pending"),
      "done without acted_in": base.replace("standing", "done"),
      "acted_in an untracked path": `${base.replace("standing", "done")}\nacted_in: [no/such.ts]`,
      // wf-1b3a-correctness L4: route and acted_in belong to their states alone;
      // a decision never supersedes or overrides itself; a field is spelled once.
      "a route on a standing decision": `${base}\nroute: RC-06`,
      "acted_in on a standing decision": `${base}\nacted_in: [engine/src/a.ts]`,
      "partial without acted_in": `${base.replace("standing", "partial")}\nroute: RC-06`,
      "superseded by itself": `${base.replace("in-force", "superseded")}\nsuperseded_by: D-09`,
      "overrides itself": `${base}\noverrides: [D-09]`,
      "a field spelled twice": `${base}\nby: coordinator`,
    };
    for (const [shape, front] of Object.entries(broken)) expect(decisionViolations([entry("D-09-x.md", front), other], tracked).length, shape).toBe(1);
    // A supersession chain ends at a decision in force: a cycle, or a chain ending at a superseded decision, is refused.
    const superseded = (id: string, by: string): { name: string; text: string } =>
      entry(`${id}-x.md`, `id: ${id}\ndate: 2026-09-28\nby: user\ngroup: process\nstatus: superseded\nsuperseded_by: ${by}\nimplementation: standing`);
    expect(decisionViolations([superseded("D-01", "D-02"), superseded("D-02", "D-01"), other], tracked).length, "a cycle").toBeGreaterThan(0);
    expect(decisionViolations([superseded("D-01", "D-02"), superseded("D-02", "U2"), other], tracked), "a chain ending in force").toEqual([]);
    expect(decisionViolations([superseded("D-01", "UD-C1"), other], tracked), "a chain through a covered alias").toEqual([]);
    expect(decisionViolations([entry("D-10-x.md", base), other], tracked).length, "an id that does not name its file").toBe(1);
    // The index renders each file's state from its front matter, grouped, in file order.
    const pending = entry("D-04-p.md", "id: D-04\ndate: 2026-09-28\nby: coordinator\ngroup: engine\nstatus: in-force\nimplementation: pending\nroute: RC-06");
    const rendered = renderDecisionIndex([pending, entry("D-09-x.md", base.replace("in-force", "superseded") + "\nsuperseded_by: U2"), other]);
    expect(rendered).toContain("## Process decisions (coordinator)\n\n| Id | Decision | By | State |\n|---|---|---|---|\n| [D-09](D-09-x.md) | Title | user | superseded by U2 |");
    expect(rendered).toContain("| [D-04](D-04-p.md) | Title | coordinator | pending (RC-06) |");
    expect(rendered).toContain("| [U2](U2-other.md) | Title (covers UD-C1, X3b) | user | done |");
    expect(rendered.indexOf("## Process decisions")).toBeLessThan(rendered.indexOf("## Earlier engine decisions"));
    const readme = `# Decisions\n\nprose\n\n${DECISION_INDEX.begin}\n\nstale\n${DECISION_INDEX.end}\n`;
    expect(spliceGeneratedBlock(readme, DECISION_INDEX, rendered)).toBe(`# Decisions\n\nprose\n\n${DECISION_INDEX.begin}\n\n${rendered}\n${DECISION_INDEX.end}\n`);
    expect(spliceGeneratedBlock("# Decisions\n", DECISION_INDEX, rendered), "a README without the markers is refused, never left ungenerated").toBeNull();
  });
});
