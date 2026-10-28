/**
 * THE PROJECTION, over a real repository (merge-door-final §17.2, task 1):
 * every path's reason, the refusals the source can earn, the target-side
 * judgements (target edits, the never-rule, the deletion budget, the two
 * short-circuits) and the plan's purity toward refs, worktrees, the index and
 * the checkout. Branches `dev` → `prod` (never testing/master: T-G4).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { EVIDENCE_IGNORE_BLOCK } from "../../../src/kernel/verification-paths.ts";
import { commitTreeReader } from "../../../src/git/tree-reader.ts";
import { classifyTree, explainPaths } from "../../../src/workflow/promotion/projection.ts";
import { repositoryRegistry, repositoryRegistryArea } from "../../../src/workflow/repository-registry.ts";
import { PROFILE_PATH, SOURCE, SOURCE_MANIFEST, TARGET, fixtureProfile, json, promotionFixture } from "./promotion-fixture.ts";

const codes = (plan: Readonly<{ refusals: readonly Readonly<{ code: string }>[] }>): readonly string[] => plan.refusals.map((entry) => entry.code);

test("T-P1/T-P13: the projection of the untouched source IS the target (unchanged); a product change is planned with its reasons, and planning changes no ref, worktree, index or checkout", async () => {
  const fixture = promotionFixture("promotion-p1");
  const unchanged = await fixture.plan();
  assert.deepEqual(codes(unchanged), [], JSON.stringify(unchanged.refusals));
  assert.equal(unchanged.code, "promotion_unchanged", "the source changed only what never ships (dev/, the profile, dev scripts)");
  // The fixture's shipped `.gitignore` is a generated output since its evidence block is one (EVIDENCE_IGNORE_BLOCK, LAND-OC-FIX round 5 M9).
  assert.deepEqual(unchanged.summary, { added: 0, modified: 0, deleted: 0, derived: 2, generated: 1 });

  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 2;\n", "product/feature/new.ts": "export const fresh = 1;\n", "product/main.ts": `import "./feature/new.ts";\n${readFileSync(join(fixture.root, "product/main.ts"), "utf8")}` });
  const digest = (): string => createHash("sha256").update(JSON.stringify({
    refs: fixture.git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    worktrees: fixture.git(["worktree", "list", "--porcelain"]),
    index: readFileSync(join(fixture.root, ".git", "index")).toString("hex"),
    porcelain: fixture.git(["status", "--porcelain=v2", "--untracked-files=all"]),
  })).digest("hex");
  const before = digest();
  const plan = await fixture.plan();
  assert.equal(digest(), before, "plan wrote a ref, a worktree, the index or a checkout file");
  assert.equal(plan.code, "promotion_planned");
  // T-P4: a new reachable module in a new folder ships, with no admission.
  assert.deepEqual(plan.paths.added, [{ path: "product/feature/new.ts", reason: "reached from product/main.ts" }]);
  assert.deepEqual(plan.paths.modified.map((entry) => entry.path).sort(), ["product/lib/helper.ts", "product/main.ts"]);
  assert.equal(plan.paths.modified.find((entry) => entry.path === "product/lib/helper.ts")?.reason, "reached from product/main.ts");
  assert.deepEqual(plan.paths.deleted, []);
  assert.equal(plan.lastPromoted.bootstrap, true, "no promotion yet: the merge base is the last promoted state");
  assert.match(plan.planId, /^[0-9a-f]{64}$/u);
  // PC-1: the projected tree holds EXACTLY the planned entries (never the empty tree, never a stale one).
  const projected = commitTreeReader(fixture.repository, plan.projection.tree);
  assert.equal(projected.paths().length, plan.projection.paths);
  const source = commitTreeReader(fixture.repository, fixture.tip(SOURCE));
  for (const path of ["product/feature/new.ts", "product/lib/helper.ts", "assets/logo.png"]) assert.deepEqual(projected.entry(path), source.entry(path), path);
});

test("T-P2: every projected entry keeps the source's object id and mode — a binary, a symlink, an executable", async () => {
  const fixture = promotionFixture("promotion-p2");
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 3;\n" });
  const plan = await fixture.plan();
  const projected = commitTreeReader(fixture.repository, plan.projection.tree);
  const source = commitTreeReader(fixture.repository, fixture.tip(SOURCE));
  for (const path of ["assets/logo.png", "product/link.ts", "product/run.sh", "product/main.ts"]) {
    assert.deepEqual(projected.entry(path), source.entry(path), path);
  }
  assert.equal(source.entry("product/link.ts")?.mode, "120000");
  assert.equal(source.entry("product/run.sh")?.mode, "100755");
});

test("T-P3: an unreachable dev file in a product folder does not ship, says why, and is advised as new", async () => {
  const fixture = promotionFixture("promotion-p3");
  fixture.commit(SOURCE, { "product/zz-dev-probe.ts": "export const probe = 1;\n" });
  const plan = await fixture.plan();
  assert.equal(plan.paths.added.some((entry) => entry.path === "product/zz-dev-probe.ts"), false);
  assert.ok(plan.advisories.some((advisory) => advisory.kind === "new_unprojected_paths" && advisory.path === "product/zz-dev-probe.ts"), JSON.stringify(plan.advisories));
  const classification = classifyTree(commitTreeReader(fixture.repository, fixture.tip(SOURCE)), fixture.loaded().profile);
  assert.deepEqual(explainPaths(classification, ["product/zz-dev-probe.ts", "product/lib/helper.ts", "dev/tool.ts"]).map((entry) => [entry.path, entry.projected, entry.reason, entry.chain]), [
    ["product/zz-dev-probe.ts", false, "unreachable (deny by default)", []],
    ["product/lib/helper.ts", true, "reached from product/main.ts", ["product/main.ts", "product/lib/helper.ts"]],
    ["dev/tool.ts", false, "excluded (dev/)", []],
  ]);
});

test("T-P5/T-P6: a deletion and a rename on the source are absent on the target; an edit to a file the target dropped stays out, with no conflict", async () => {
  const fixture = promotionFixture("promotion-p5");
  const main = readFileSync(join(fixture.root, "product/main.ts"), "utf8").replace("./lib/helper.ts", "./lib/renamed.ts");
  fixture.commit(SOURCE, {
    "product/lib/renamed.ts": readFileSync(join(fixture.root, "product/lib/helper.ts"), "utf8"),
    "product/lib/helper.ts": null,
    "product/link.ts": null,
    "product/main.ts": main,
    "product/tools/gen.ts": null,
    "dev/tool.ts": "export const tool = 2;\n",
  });
  fixture.commit(SOURCE, { "product/main.ts": main.replace('runScript(home.pathname, "tools/gen.ts");', "") });
  const plan = await fixture.plan();
  assert.deepEqual(codes(plan), []);
  assert.deepEqual(plan.paths.deleted.map((entry) => entry.path).sort(), ["product/lib/helper.ts", "product/link.ts", "product/tools/gen.ts"]);
  assert.equal(plan.paths.deleted.find((entry) => entry.path === "product/lib/helper.ts")?.reason, "absent on the source");
  const stat = fixture.git(["diff", "-M", "--stat", fixture.tip(TARGET), plan.projection.tree]);
  assert.match(stat, /product\/lib\/\{helper\.ts => renamed\.ts\}/u, stat);
  assert.equal(plan.paths.added.concat(plan.paths.modified).some((entry) => entry.path.startsWith("dev/")), false);
});

test("T-P7/T-P8/T-P11: an import into an excluded path, a dangling import, a missing entry point and an undeclared package are refused, each naming its importer", async () => {
  const fixture = promotionFixture("promotion-p7");
  const main = readFileSync(join(fixture.root, "product/main.ts"), "utf8");
  fixture.commit(SOURCE, {
    "product/main.ts": `import "../dev/tool.ts";\nimport "./gone.ts";\nimport left from "left-pad";\nimport { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";\nimport path from "path";\n${main}`,
  });
  const plan = await fixture.plan();
  assert.deepEqual([...new Set(codes(plan))].sort(), ["promotion_dependency_undeclared", "promotion_import_into_excluded", "promotion_unresolved_import"]);
  assert.deepEqual(plan.refusals.find((entry) => entry.code === "promotion_import_into_excluded")?.facts, { importer: "product/main.ts", specifier: "../dev/tool.ts", target: "dev/tool.ts" });
  assert.deepEqual(plan.refusals.find((entry) => entry.code === "promotion_unresolved_import")?.facts, { importer: "product/main.ts", specifier: "./gone.ts" });
  assert.deepEqual(plan.refusals.filter((entry) => entry.code === "promotion_dependency_undeclared").map((entry) => entry.facts["package"]), ["left-pad"], "builtins (node:fs, path) are never packages");
  assert.equal(plan.code, plan.refusals[0]!.code);

  const missing = promotionFixture("promotion-p8", { boundary: { entryPoints: ["product/main.ts", "product/absent.ts"] } });
  assert.deepEqual(codes(await missing.plan()), ["promotion_entry_missing"]);
});

test("T-P9: a boundary typo that drops most of the target is refused by the deletion budget", async () => {
  const fixture = promotionFixture("promotion-p9");
  fixture.commit(SOURCE, { [PROFILE_PATH]: json(fixtureProfile({ boundary: { include: [".gitignore", "package.json", "package-lock.json"], exclude: ["dev/", "promotion/", "product/"] , entryPoints: ["package.json"] } })) });
  const plan = await fixture.plan();
  const budget = plan.refusals.find((entry) => entry.code === "promotion_deletion_budget");
  assert.ok(budget !== undefined, JSON.stringify(plan.refusals));
  assert.ok((budget.facts["deleted"] as number) / (budget.facts["target"] as number) > 0.5, JSON.stringify(budget.facts));
});

test("T-P12: companions — a README ships iff its folder holds a projected path; the excluded folder's never", async () => {
  const fixture = promotionFixture("promotion-p12");
  fixture.commit(SOURCE, { "orphan/README.md": "# nothing here ships\n", "product/pages/README.md": "# pages\n" });
  const classification = classifyTree(commitTreeReader(fixture.repository, fixture.tip(SOURCE)), fixture.loaded().profile);
  const readmes = [...classification.projected].filter(([path]) => path.endsWith("README.md")).map(([path, reason]) => [path, reason.rule]).sort();
  assert.deepEqual(readmes, [["README.md", "companion"], ["product/lib/README.md", "companion"], ["product/pages/README.md", "companion"]]);
  assert.equal(classification.notProjected.get("dev/README.md")?.rule, "excluded");
  assert.equal(classification.notProjected.get("orphan/README.md")?.rule, "unreachable");
});

test("the overlay: each file of its folder ships at its path without the prefix, says why, and is read by the advisories", async () => {
  const overlaid = { boundary: { exclude: ["dev/", "promotion/", "target-only/"], overlay: { folder: "target-only/", kinds: ["*.md", "*.txt"] } } };
  const fixture = promotionFixture("promotion-overlay", overlaid);
  fixture.commit(SOURCE, {
    "target-only/NOTICE.txt": "the product's notice\n",
    "target-only/docs/start.md": "Run `npm run build`, then `npm run not-shipped`.\n",
    "target-only/docs/UPPER.MD": "a declared kind in another case is that kind\n",
    "NOTICE.txt": "the source's own notice never ships\n",
  });
  const plan = await fixture.plan();
  assert.deepEqual(codes(plan), []);
  assert.deepEqual(plan.paths.added.filter((entry) => !entry.path.startsWith("product/")).map((entry) => [entry.path, entry.reason]).sort(), [
    ["NOTICE.txt", "overlaid from target-only/NOTICE.txt"],
    ["docs/UPPER.MD", "overlaid from target-only/docs/UPPER.MD"],
    ["docs/start.md", "overlaid from target-only/docs/start.md"],
  ]);
  assert.equal(fixture.git(["cat-file", "-p", `${plan.projection.tree}:NOTICE.txt`]), "the product's notice", "the overlay's bytes, not the source's file at that path");
  assert.equal(plan.paths.added.concat(plan.paths.modified).some((entry) => entry.path.startsWith("target-only/")), false, "the folder never ships at its own path");
  assert.deepEqual(plan.advisories.filter((advisory) => advisory.kind === "dangling_script_reference").map((advisory) => [advisory.path, advisory.detail.includes("not-shipped")]), [["docs/start.md", true]], "an overlaid document is judged at its shipped path; `build` is carried, `not-shipped` is not");
  const classification = classifyTree(commitTreeReader(fixture.repository, fixture.tip(SOURCE)), fixture.loaded().profile);
  assert.deepEqual(explainPaths(classification, ["NOTICE.txt", "target-only/NOTICE.txt"]).map((entry) => [entry.path, entry.projected, entry.reason]), [
    ["NOTICE.txt", true, "overlaid from target-only/NOTICE.txt"],
    ["target-only/NOTICE.txt", false, "excluded (target-only/)"],
  ]);
  assert.equal((await fixture.plan()).projection.tree, plan.projection.tree, "the same source projects the same tree");
});

test("the product's Makefile is derived from the source's: the kept rules ship, the dropped ones do not, and the recipe advisory reads the derived text", async () => {
  const base = (fixtureProfile() as { transforms: unknown[] }).transforms;
  const fixture = promotionFixture("promotion-makefile", { transforms: [{ kind: "makefile", path: "Makefile", targets: ["run"] }, ...base] });
  fixture.commit(SOURCE, { "Makefile": ".PHONY: run tool\n\nrun:\n\tnode product/main.ts\n\tnode dev/kept.ts\n\ntool:\n\tnode dev/tool.ts\n" });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(codes(plan), []);
  assert.equal(fixture.git(["cat-file", "-p", `${plan.projection.tree}:Makefile`]), ".PHONY: run\n\nrun:\n\tnode product/main.ts\n\tnode dev/kept.ts", "the derived text, not the source's");
  assert.deepEqual(plan.paths.added.filter((entry) => entry.path === "Makefile").map((entry) => entry.reason), ["derived (makefile)"]);
  assert.deepEqual(plan.transforms.filter((entry) => entry.path === "Makefile"), [{ path: "Makefile", keptTargets: ["run"], droppedTargets: ["tool"] }]);
  fixture.commit(SOURCE, { "dev/kept.ts": "export {};\n", "dev/tool.ts": "export {};\n" });
  const advised = await fixture.plan({ lockfiles: false });
  assert.deepEqual(advised.advisories.filter((advisory) => advisory.kind === "dangling_recipe_path").map((advisory) => [advisory.path, advisory.detail]), [["Makefile", "names dev/kept.ts, which the projection does not carry"]], "a kept rule's path is advised; a dropped rule's is not");
  fixture.commit(SOURCE, { "Makefile": "run:\n\tnode product/main.ts\nX = 1\n" });
  assert.deepEqual(codes(await fixture.plan({ lockfiles: false })), ["promotion_makefile_unparseable"], "a source Makefile outside the grammar refuses the plan");
});

test("the overlay ships only its declared kinds: a collision, a link, an excluded target, an undeclared kind (code among them) are refused; a declared near-miss ships", async () => {
  const overlaid = { boundary: { exclude: ["dev/", "promotion/", "target-only/"], overlay: { folder: "target-only/", kinds: ["*.md"] } } };
  const fixture = promotionFixture("promotion-overlay-refused", overlaid);
  fixture.commit(SOURCE, {
    "target-only/README.md": "# a second root README\n",
    "target-only/product/notes.md": "a near-miss: a declared kind no projected path names\n",
    "target-only/product/main.ts": "export {};\n",
    "target-only/dev/notes.md": "would ship into an excluded folder\n",
    "target-only/promotion/rogue.md": "would ship into the profile directory\n",
    "target-only/target-only/inner.md": "would ship at the overlay folder's own path\n",
    "target-only/product/evil.ts": "import \"../dev/secret.ts\";\nimport pad from \"left-pad\";\nexport default pad;\n",
    "target-only/product/evil.mts": "import \"../dev/secret.ts\";\nexport {};\n",
    "target-only/product/evil.cts": "import \"../dev/secret.ts\";\nexport {};\n",
    "target-only/product/evil.jsx": "import \"../dev/secret.ts\";\n",
    "target-only/run.sh": "#!/bin/sh\n",
    "target-only/data.json": "{}\n",
    "target-only/Makefile": "a recipe: derived by the makefile transform, never overlaid\n",
    "target-only/Makefile.orig": "a near-miss of the Makefile kind\n",
  });
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["update-index", "--add", "--cacheinfo", `120000,${fixture.git(["rev-parse", `${TARGET}:product/link.ts`])},target-only/link.md`]);
  fixture.git(["commit", "-q", "-m", "a symbolic link in the overlay"]);
  const plan = await fixture.plan({ lockfiles: false });
  const refused = plan.refusals.filter((entry) => entry.code === "promotion_overlay_invalid").map((entry) => entry.facts["overlay"]).sort();
  assert.deepEqual(refused, ["target-only/Makefile", "target-only/Makefile.orig", "target-only/README.md", "target-only/data.json", "target-only/dev/notes.md", "target-only/link.md", "target-only/product/evil.cts", "target-only/product/evil.jsx", "target-only/product/evil.mts", "target-only/product/evil.ts", "target-only/product/main.ts", "target-only/promotion/rogue.md", "target-only/run.sh", "target-only/target-only/inner.md"]);
  const message = (overlay: string): string => plan.refusals.find((entry) => entry.facts["overlay"] === overlay)!.message;
  assert.match(message("target-only/README.md"), /companion/u, "the collision names the reason the path already ships for");
  for (const [overlay, by] of [["target-only/dev/notes.md", "dev/"], ["target-only/promotion/rogue.md", "promotion/"], ["target-only/target-only/inner.md", "target-only/"]] as const) {
    assert.match(message(overlay), new RegExp(`excludes \\(by ${by}\\)`, "u"), `${overlay}: the excludes hold at the shipped path`);
  }
  for (const undeclared of ["product/evil.ts", "product/evil.mts", "product/evil.cts", "product/evil.jsx", "product/main.ts", "run.sh", "data.json", "Makefile", "Makefile.orig"]) assert.match(message(`target-only/${undeclared}`), /not a kind the overlay declares/u, `${undeclared}: only a declared kind ships`);
  assert.match(message("target-only/link.md"), /symbolic link/u);
  assert.ok(plan.paths.added.some((entry) => entry.path === "product/notes.md"), "the declared near-miss ships");
  assert.equal(plan.paths.added.concat(plan.paths.modified).some((entry) => /^(?:dev|promotion|target-only)\//u.test(entry.path) || entry.path.startsWith("product/evil.") || ["run.sh", "data.json"].includes(entry.path)), false, "no refused overlay file ships");
  assert.equal(plan.code, "promotion_overlay_invalid");
});


test("T-P13: up to date — the target's last promotion carries this source: no work", async () => {
  const fixture = promotionFixture("promotion-p13");
  const source = fixture.tip(SOURCE);
  const blob = fixture.loaded().blob!;
  const tree = fixture.git(["rev-parse", `${TARGET}^{tree}`]);
  const promoted = fixture.git(["commit-tree", tree, "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: dev-to-prod@${blob}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promoted]);
  const started = Date.now();
  const plan = await fixture.plan();
  assert.equal(plan.code, "promotion_up_to_date");
  assert.deepEqual(plan.lastPromoted, { commit: promoted, source, bootstrap: false });
  assert.ok(Date.now() - started < 10_000, "the short-circuit is cheap");
  assert.equal(fixture.git(["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "no worktree was created");
});

test("T-P14: a gitlink in the projection is refused", async () => {
  const fixture = promotionFixture("promotion-p14");
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["update-index", "--add", "--cacheinfo", `160000,${fixture.tip(TARGET)},assets/vendored`]);
  fixture.git(["commit", "-q", "-m", "a submodule under an included folder"]);
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(plan.refusals.filter((entry) => entry.code === "promotion_gitlink_unsupported").map((entry) => entry.facts["path"]), ["assets/vendored"]);
});

test("T-D1 (bootstrap form): a direct edit of the target since the base is listed with a patch, not overwritten; a deletion both sides agree on is not an edit", async () => {
  const fixture = promotionFixture("promotion-d1");
  fixture.commit(TARGET, { "README.md": "# edited on the target\n", "product/base.css": null }, "a direct edit of the target");
  fixture.commit(SOURCE, { "product/styles.css": "body { color: red; }\n", "product/base.css": null });
  const plan = await fixture.plan();
  assert.deepEqual(plan.targetEdits, ["README.md"]);
  assert.deepEqual(codes(plan), ["promotion_target_edits"]);
  const patch = readFileSync(plan.targetEditsPatch!, "utf8");
  assert.match(patch, /\+# edited on the target/u, patch);
});

test("T-D3: the source merged with the target after a promotion is refused (the never-rule)", async () => {
  const fixture = promotionFixture("promotion-d3");
  const source = fixture.tip(SOURCE);
  const promoted = fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: dev-to-prod@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promoted]);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 4;\n" });
  // The forbidden shape: the target merged into the source (its tree kept, its history taken).
  fixture.git(["merge", "-q", "-s", "ours", "--no-edit", TARGET]);
  const plan = await fixture.plan();
  assert.deepEqual(plan.refusals.filter((entry) => entry.code === "promotion_never_rule").map((entry) => entry.facts["promotion"]), [promoted]);
});

test("T-G4: the projection's module names no branch of this repository", () => {
  for (const file of ["projection.ts", "profile.ts", "transforms.ts", "context.ts", "promote-cli.ts", "codes.ts"]) {
    const text = readFileSync(new URL(`../../../src/workflow/promotion/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /["'`](?:testing|master)["'`]/u, file);
  }
});

test("PC-1: a leftover private index in the scratch (a crashed plan) never leaks into the projection", async () => {
  const fixture = promotionFixture("promotion-pc1");
  const clean = await fixture.plan({ lockfiles: false });
  const scratch = join(repositoryRegistryArea(repositoryRegistry(fixture.git(["rev-parse", "--absolute-git-dir"])), "promotion"), "dev-to-prod", "scratch");
  const stale = join(scratch, "index-crashed");
  mkdirSync(stale, { recursive: true });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${fixture.git(["rev-parse", `${TARGET}:README.md`])},dev/PLANTED-STALE.md`], { cwd: fixture.root, env: { ...process.env, GIT_INDEX_FILE: join(stale, "index") } });
  const again = await fixture.plan({ lockfiles: false });
  assert.equal(again.projection.tree, clean.projection.tree, "the same plan writes the same tree, whatever the scratch holds");
  assert.equal(commitTreeReader(fixture.repository, again.projection.tree).entry("dev/PLANTED-STALE.md"), null);
});

test("PC-1: a source tree git's index cannot reproduce (a hostile `.git` entry) is an integrity refusal, never a silently smaller tree", async () => {
  const fixture = promotionFixture("promotion-integrity");
  const mktree = (lines: readonly string[]): string => execFileSync("git", ["mktree"], { cwd: fixture.root, input: `${lines.join("\n")}\n`, encoding: "utf8" }).trim();
  const blob = fixture.git(["rev-parse", `${SOURCE}:README.md`]);
  const hostile = mktree([`100644 blob ${blob}\tconfig`]);
  const assets = mktree([...fixture.git(["ls-tree", `${SOURCE}:assets`]).split("\n"), `040000 tree ${hostile}\t.git`]);
  const root = mktree(fixture.git(["ls-tree", SOURCE]).split("\n").map((line) => (line.endsWith("\tassets") ? `040000 tree ${assets}\tassets` : line)));
  const commit = fixture.git(["commit-tree", root, "-p", fixture.tip(SOURCE), "-m", "a crafted tree"]);
  fixture.git(["update-ref", `refs/heads/${SOURCE}`, commit]);
  await assert.rejects(fixture.plan({ lockfiles: false }), (error: unknown) => (error as { promotionCode?: string }).promotionCode === "promotion_projection_mismatch" && /assets\/\.git\/config/u.test((error as Error).message));
});

test("H2: an INCLUDED module is walked like a reached one: its edges are judged, its packages count, and what it imports ships", async () => {
  const fixture = promotionFixture("promotion-h2", { boundary: { include: [".gitignore", "assets/", "product/run.sh", "product/link.ts", "package.json", "package-lock.json", "product/extra/"] } });
  fixture.commit(SOURCE, {
    "product/extra/tool.ts": 'import { helper } from "../shared/helper.ts";\nexport const tool = helper;\n',
    "product/shared/helper.ts": "export const helper = 1;\n",
    "product/unlisted/needed.ts": "export const needed = 1;\n",
  });
  const clean = classifyTree(commitTreeReader(fixture.repository, fixture.tip(SOURCE)), fixture.loaded().profile);
  assert.deepEqual(clean.projected.get("product/extra/tool.ts"), { rule: "include", detail: "product/extra/" });
  assert.deepEqual(clean.projected.get("product/shared/helper.ts"), { rule: "import", detail: "product/extra/tool.ts" }, "what an included module imports ships, reached from it");
  fixture.commit(SOURCE, {
    "product/extra/tool.ts": 'import "../../dev/tool.ts";\nimport { pad } from "left-pad";\nimport "./gone.ts";\nimport "../unlisted/needed.ts";\nexport const tool = pad;\n',
  });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual([...new Set(codes(plan))].sort(), ["promotion_dependency_undeclared", "promotion_import_into_excluded", "promotion_unresolved_import"]);
  for (const refusal of plan.refusals) assert.equal(refusal.facts["importer"], "product/extra/tool.ts", JSON.stringify(refusal));
  assert.deepEqual(plan.paths.added.find((entry) => entry.path === "product/unlisted/needed.ts"), { path: "product/unlisted/needed.ts", reason: "reached from product/extra/tool.ts" });
});

test("PC-2: a symbolic link reaches its target, and an edge no literal names is advised, never silently dropped", async () => {
  const fixture = promotionFixture("promotion-pc2");
  fixture.git(["checkout", "-q", SOURCE]);
  mkdirSync(join(fixture.root, "product/linked"), { recursive: true });
  writeFileSync(join(fixture.root, "product/linked/only.ts"), "export const only = 1;\n");
  symlinkSync("linked/only.ts", join(fixture.root, "product/via-link.ts"));
  fixture.commit(SOURCE, {
    "product/main.ts": `import "./via-link.ts";\nconst name = "./lib/helper.ts";\nconst lazy = () => import(name);\n${readFileSync(join(fixture.root, "product/main.ts"), "utf8")}`,
  });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(codes(plan), [], JSON.stringify(plan.refusals));
  assert.deepEqual(plan.paths.added.map((entry) => [entry.path, entry.reason]).sort(), [["product/linked/only.ts", "reached from product/via-link.ts"], ["product/via-link.ts", "reached from product/main.ts"]]);
  // (A glob that matches nothing is the same report: engine/test/workflow/reachability.test.ts.)
  assert.deepEqual(plan.advisories.filter((advisory) => advisory.kind === "opaque_edge").map((advisory) => [advisory.path, advisory.detail.split(":")[0]]), [
    ["product/main.ts", "import(<computed>)"],
  ]);
});

test("V1/V29: a generated output differing only in its generated part is no change, and the target regenerating it is no direct edit", async () => {
  const fixture = promotionFixture("promotion-gen");
  // A generated block in an authored file: the root ignore file's evidence block.
  const block = (body: string, title = "node_modules/\nbuild/"): string => `${title}\n${EVIDENCE_IGNORE_BLOCK.begin}\n${body}\n${EVIDENCE_IGNORE_BLOCK.end}\n`;
  // The last promotion carries an ignore file whose evidence block the source generated.
  const promotedSource = fixture.commit(SOURCE, { [EVIDENCE_IGNORE_BLOCK.path]: block("/a/evidence/") });
  fixture.commit(TARGET, { [EVIDENCE_IGNORE_BLOCK.path]: block("/a/evidence/") }, "the promoted state");
  const promotion = fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-p", fixture.tip(TARGET), "-p", promotedSource, "-m", `promote\n\nProjected-From: ${promotedSource}\nPromotion-Profile: dev-to-prod@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promotion]);
  // The target regenerates the block; the source moves on elsewhere.
  fixture.commit(TARGET, { [EVIDENCE_IGNORE_BLOCK.path]: block("/b/evidence/") }, "the target regenerated a block");
  fixture.commit(SOURCE, { "dev/tool.ts": "export const tool = 3;\n" });
  const plan = await fixture.plan();
  assert.deepEqual(codes(plan), [], "a regenerated block on the target is not a direct edit");
  assert.equal(plan.code, "promotion_unchanged", "a generated part alone never makes the projection differ");
  assert.deepEqual(plan.paths.modified.map((entry) => [entry.path, entry.reason.endsWith("regenerated at build")]), [[EVIDENCE_IGNORE_BLOCK.path, true]]);
  // The authored part changes on the source: a change, and still no target edit (the target only regenerated).
  fixture.commit(SOURCE, { [EVIDENCE_IGNORE_BLOCK.path]: block("/a/evidence/", "node_modules/\nbuild/\ndist/") });
  const authored = await fixture.plan();
  assert.equal(authored.code, "promotion_planned");
  assert.deepEqual(authored.targetEdits, []);
});

test("V7/V8: only THIS profile's promotions on the target's FIRST-PARENT line count as promotions", async () => {
  const fixture = promotionFixture("promotion-history");
  const source = fixture.tip(SOURCE);
  const tree = fixture.git(["rev-parse", `${TARGET}^{tree}`]);
  // Another pair's promotion of the same source on the target's own line.
  const other = fixture.git(["commit-tree", tree, "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: other-pair@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, other]);
  const notOurs = await fixture.plan({ lockfiles: false });
  assert.equal(notOurs.lastPromoted.bootstrap, true, "another profile's trailer is not this pair's promotion");
  assert.notEqual(notOurs.code, "promotion_up_to_date");
  // This profile's promotion reached only through a merged side line (second parent).
  fixture.git(["branch", "side", fixture.tip(TARGET)]);
  const side = fixture.git(["commit-tree", tree, "-p", fixture.tip("side"), "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: dev-to-prod@${fixture.loaded().blob!}`]);
  const merged = fixture.git(["commit-tree", tree, "-p", fixture.tip(TARGET), "-p", side, "-m", "merge a side line"]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, merged]);
  const sideLine = await fixture.plan({ lockfiles: false });
  assert.equal(sideLine.lastPromoted.bootstrap, true, "a promotion off the first-parent line is not the target's");
});

test("V4: an underived lockfile is never \"unchanged\" (a light plan cannot vouch for it)", async () => {
  const fixture = promotionFixture("promotion-underived");
  const light = await fixture.plan({ lockfiles: false });
  assert.deepEqual(light.projection.underived, ["package-lock.json"]);
  assert.equal(light.code, "promotion_planned");
});

test("V5: the deletion budget refuses only MORE than its fraction", async () => {
  const fixture = promotionFixture("promotion-budget");
  const targetPaths = fixture.git(["ls-tree", "-r", "--name-only", TARGET]).split("\n").length;
  fixture.commit(SOURCE, { [PROFILE_PATH]: json(fixtureProfile({ safety: { maxDeletedFraction: 1 / targetPaths } })), "product/run.sh": null });
  assert.equal((await fixture.plan({ lockfiles: false })).refusals.some((entry) => entry.code === "promotion_deletion_budget"), false, "exactly the fraction is within budget");
  fixture.commit(SOURCE, { "assets/logo.png": null });
  assert.ok((await fixture.plan({ lockfiles: false })).refusals.some((entry) => entry.code === "promotion_deletion_budget"), "one more is over it");
});

test("V2: only a path ADDED since the last promotion is advised as new; a modified unprojected one is not", async () => {
  const fixture = promotionFixture("promotion-added");
  const first = fixture.commit(SOURCE, { "product/zz-notes.ts": "export const notes = 1;\n" });
  const promoted = fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-p", fixture.tip(TARGET), "-p", first, "-m", `promote\n\nProjected-From: ${first}\nPromotion-Profile: dev-to-prod@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promoted]);
  fixture.commit(SOURCE, { "product/zz-notes.ts": "export const notes = 2;\n" });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(plan.advisories.filter((advisory) => advisory.kind === "new_unprojected_paths"), []);
});

test("V27: a projected build recipe naming a file the projection drops is advised", async () => {
  const fixture = promotionFixture("promotion-recipe", { boundary: { include: [".gitignore", "assets/", "product/run.sh", "product/link.ts", "package.json", "package-lock.json", "product/Makefile"] } });
  fixture.commit(SOURCE, { "product/Makefile": "tool:\n\tnode ../dev/tool.ts\n" });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(plan.advisories.filter((advisory) => advisory.kind === "dangling_recipe_path").map((advisory) => [advisory.path, advisory.detail]), [["product/Makefile", "names dev/tool.ts, which the projection does not carry"]]);
});

test("projected document scripts are checked against the derived package, with duplicate references reported once", async () => {
  const fixture = promotionFixture("promotion-document-scripts");
  fixture.commit(SOURCE, { "README.md": "Run npm run build. Then npm run test. Again npm run test.\n" });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(plan.advisories.filter((entry) => entry.kind === "dangling_script_reference"), [
    { kind: "dangling_script_reference", path: "README.md", detail: "names `npm run test`, which the derived package.json does not carry" },
  ]);
  assert.deepEqual(codes(plan), [], "document advisories do not change the promotion refusal protocol");
});

test("PC-9: the plan id is a function of every input — the same plan has the same id; a changed registry command argv changes it", async () => {
  const fixture = promotionFixture("promotion-plan-id");
  const first = await fixture.plan({ lockfiles: false });
  assert.equal((await fixture.plan({ lockfiles: false })).planId, first.planId);
  const commands = { ...fixture.commands, lockfile: { ...fixture.commands["lockfile"]!, argv: [...fixture.commands["lockfile"]!.argv, "--prefer-dedupe"] } };
  assert.notEqual((await fixture.plan({ lockfiles: false, commands })).planId, first.planId, "the lockfile command decides the derived lockfile");
});

test("L3: a source lockfile that is not JSON is a typed refusal naming it, never a crash", async () => {
  const fixture = promotionFixture("promotion-bad-lock");
  fixture.commit(SOURCE, { "package-lock.json": "{ not json" });
  const plan = await fixture.plan({ lockfiles: false });
  assert.deepEqual(plan.refusals.filter((entry) => entry.code === "promotion_source_json_invalid").map((entry) => entry.facts["path"]), ["package-lock.json"]);
});

test("L12: the plan's code is its most severe refusal's, whatever the order they were found in", async () => {
  const fixture = promotionFixture("promotion-severity");
  fixture.markLockfile("enotcached");
  // The lockfile errors (the machine's) BEFORE the target edit is judged (the source's to fix).
  fixture.commit(TARGET, { "README.md": "# edited on the target\n" }, "a direct edit");
  fixture.commit(SOURCE, { "package.json": json({ ...SOURCE_MANIFEST, dependencies: { zod: "^2.0.0" } }) });
  const plan = await fixture.plan({ retries: 0 });
  assert.deepEqual(codes(plan), ["promotion_transform_errored", "promotion_target_edits"], "found in this order");
  assert.equal(plan.code, "promotion_target_edits", "an errored transform (the machine's) never answers for a refusal the source must fix");
});
