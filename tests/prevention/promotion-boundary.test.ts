// @vitest-environment node
/**
 * THE SOURCE-SIDE PROMOTION GUARD — what this branch ships is decided by its
 * promotion profiles (`promotion/*.json`), and a source tree that a
 * promotion would refuse is red HERE, at every change, not at promotion time
 * (merge-door-final §17.3).
 *
 * It runs the pure projection over the WORKING TREE (what `git add -A` would
 * commit), with each profile read from disk and validated against the ONE
 * command registry: red iff the profile is invalid, a shipped module imports
 * a path the profile excludes, an import names nothing, an entry point is
 * gone, a shipped module imports a package its manifest does not declare, or
 * a kept manifest script cannot be projected. The lockfile derivation (a
 * command) and every target-side judgement (the target's edits, the deletion
 * budget) are the promotion's own, not this guard's.
 *
 * Literal npm-run references recognized by projectionAdvisories in projected
 * Markdown must name scripts carried by the derived owning package. The owner
 * documents its grammar, document-path package context and rung-5 limits; this
 * guard does not interpret shell cwd or promote advisories to protocol refusals.
 *
 * It also proves the dead-command rule the configuration schema cannot judge
 * (a registry command no workspace phase and no profile runs is dead config;
 * `harness check` judges it at every check: its `dead-commands` step) on this
 * tree, with a plant.
 *
 * Its mutation arms plant each refusal in an OVERLAY of the working tree
 * (nothing is written to the checkout): an import into an excluded folder, a
 * package nobody declares, a deleted-but-imported module.
 *
 * The working tree, its profiles and the configuration are the shared
 * promotion view's (`tests/helpers/promotion-view.ts`), the one answer every
 * guard asks about what ships.
 */
import { posix } from "node:path";
import { describe, expect, test } from "vitest";

import type { TreeReader } from "../../engine/src/git/tree-reader.ts";
import { unconsumedCommands } from "../../engine/src/workflow/checkout-setup.ts";
import { catalogueCommandNames } from "../../engine/src/workflow/gates/catalogue.ts";
import { excludedBy, profileCommandNames, type LoadedPromotionProfile } from "../../engine/src/workflow/promotion/profile.ts";
import { moduleSpecifiers, normalizeRepositoryPath } from "../../engine/src/workflow/reachability.ts";
import { classifyTree, deriveManifests, projectionAdvisories, shippedSources } from "../../engine/src/workflow/promotion/projection.ts";
import { promotionView } from "../helpers/promotion-view.ts";

const { document, tree, profiles } = promotionView();
const isolation = document.workspaceIsolation!;
const profileDirectory = document.promotion!.profileDirectory;

/** The working tree with `overrides` laid over it (a `null` deletes): a planted tree no file of the checkout is written for. */
function overlay(base: TreeReader, overrides: Readonly<Record<string, string | null>>): TreeReader {
  const paths = [...new Set([...base.paths(), ...Object.keys(overrides)])].filter((path) => overrides[path] !== null).sort();
  return {
    label: `${base.label} + plants`,
    paths: () => paths,
    entry: (path) => (path in overrides ? (overrides[path] === null ? null : { mode: "100644", oid: null }) : base.entry(path)),
    text: (path) => (path in overrides ? overrides[path]! : base.text(path)),
    prefetch: (wanted) => base.prefetch([...wanted].filter((path) => !(path in overrides))),
  };
}

/** Every refusal the source side of `loaded`'s promotion raises over `reader`, by code. */
function refusals(reader: TreeReader, loaded: LoadedPromotionProfile): readonly string[] {
  const classification = classifyTree(reader, loaded.profile);
  return [...classification.refusals, ...deriveManifests(reader, loaded.profile, classification).refusals].map((entry) => `${entry.code}: ${entry.message}`);
}

/** Use the plan's document checker against the derived manifests, not the development scripts. */
function danglingScripts(reader: TreeReader, loaded: LoadedPromotionProfile): readonly string[] {
  const classification = classifyTree(reader, loaded.profile);
  const manifests = deriveManifests(reader, loaded.profile, classification);
  return projectionAdvisories(reader, classification, manifests.texts, [])
    .filter((entry) => entry.kind === "dangling_script_reference")
    .map((entry) => `${entry.path}: ${entry.detail}`);
}

describe("the source-side promotion guard", () => {
  test("the repository declares its promotions, each valid against the command registry", () => {
    expect(profiles.length, `no promotion profile under ${profileDirectory}/ — this guard's universe is empty`).toBeGreaterThan(0);
    for (const { profile, path } of profiles) expect(path).toBe(`${profileDirectory}/${profile.name}.json`);
  });

  test.each(profiles.map((loaded) => [loaded.profile.name, loaded] as const))("%s: the working tree raises no refusal a promotion would", (_name, loaded) => {
    const started = Date.now();
    expect(refusals(tree, loaded)).toEqual([]);
    expect(Date.now() - started, "the pure projection of the whole tree stays a guard, not a suite").toBeLessThan(60_000);
  });

  test.each(profiles.map((loaded) => [loaded.profile.name, loaded] as const))("%s: shipped documents name scripts the derived package carries", (_name, loaded) => {
    expect(danglingScripts(tree, loaded)).toEqual([]);
  });

  test.each(profiles.map((loaded) => [loaded.profile.name, loaded] as const))("%s: missing, different and inert script references cannot evade the document guard", (_name, loaded) => {
    const classification = classifyTree(tree, loaded.profile);
    const { texts } = deriveManifests(tree, loaded.profile, classification);
    // Every shipped path with the source path its bytes come from: the
    // overlay's files (the product's own README) are planted where they live.
    const shipped = shippedSources(classification);
    let checkedDocuments = 0;
    for (const [manifest, text] of texts) {
      const scripts = Object.keys((JSON.parse(text) as { scripts: Record<string, string> }).scripts);
      expect(scripts.length, `${manifest}: the passing control must exercise a real projected script`).toBeGreaterThan(0);
      const document = `${posix.dirname(manifest) === "." ? "" : `${posix.dirname(manifest)}/`}README.md`;
      // A package with no shipped README has no document to plant into. The
      // product's root README ships from the profile's overlay folder and the
      // engine's as a companion, so both packages prove the guard sees a real
      // document, wherever its bytes live on the source.
      const source = shipped.get(document);
      if (source === undefined) continue;
      checkedDocuments += 1;
      const planted = (body: string): readonly string[] => danglingScripts(overlay(tree, { [source]: body }), loaded)
        .filter((entry) => entry.startsWith(`${document}:`));
      expect(planted(`Run npm run ${scripts[0]}.`)).toEqual([]);
      expect(planted("No runnable script is offered here.")).toEqual([]);
      for (const name of ["missing-script", "other-missing-script"]) {
        expect(planted(`Run npm run ${name}.`)).toEqual([`${document}: names \`npm run ${name}\`, which the derived ${manifest} does not carry`]);
      }
      // Naming the absent script as prose is inert, but placing its invocation
      // anywhere in that same document still has to be judged.
      expect(planted("The development-only `missing-script` is historical.\nRun npm run missing-script."))
        .toEqual([`${document}: names \`npm run missing-script\`, which the derived ${manifest} does not carry`]);
    }
    expect(checkedDocuments, "no shipped README was exercised — the document guard's universe collapsed").toBeGreaterThan(0);
  });

  test("every registry command is run by a workspace phase, a promotion profile or a gate (no dead command)", () => {
    // The consumers are the ones `harness check`'s dead-commands step counts: the profiles and the gate catalogue.
    const consumers = [...catalogueCommandNames(), ...profiles.flatMap((loaded) => profileCommandNames(loaded.profile))];
    expect(unconsumedCommands(isolation, consumers)).toEqual([]);
    // The plant: a declared command nothing runs is named.
    expect(unconsumedCommands({ ...isolation, commands: { ...isolation.commands, "planted-dead": { cwd: ".", argv: ["true"], timeoutMs: 1 } } }, consumers)).toEqual(["planted-dead"]);
  });

  test.each(profiles.map((loaded) => [loaded.profile.name, loaded] as const))("%s: each planted refusal turns the guard red, by name", (_name, loaded) => {
    const classification = classifyTree(tree, loaded.profile);
    // A shipped module reached by a plain relative import (so deleting it dangles that import), outside the engine.
    const importedPlainly = (path: string): boolean => {
      const parent = classification.reachability.reachedFrom.get(path);
      if (parent === undefined) return false;
      return moduleSpecifiers(parent, tree.text(parent) ?? "").imports.some((specifier) => specifier.startsWith(".") && normalizeRepositoryPath(posix.dirname(parent) === "." ? "" : `${posix.dirname(parent)}/`, specifier) === path);
    };
    const importer = [...classification.projected].find(([path, reason]) => reason.rule === "import" && path.endsWith(".ts") && !path.startsWith("engine/") && importedPlainly(path))![0];
    const excludedModule = tree.paths().find((path) => path.endsWith(".ts") && excludedBy(loaded.profile, path) !== null)!;
    const specifier = posix.relative(posix.dirname(importer), excludedModule);
    const planted = (text: string): string => refusals(overlay(tree, { [importer]: `${text}\n${tree.text(importer)!}` }), loaded).join("\n");
    expect(planted(`import "./${specifier}";`.replace("./../", "../"))).toContain(`promotion_import_into_excluded: ${importer} imports`);
    expect(planted('import { planted } from "a-package-nobody-declares";')).toContain(`promotion_dependency_undeclared: ${importer} imports the package a-package-nobody-declares`);
    const parent = classification.reachability.reachedFrom.get(importer)!;
    expect(refusals(overlay(tree, { [importer]: null }), loaded).join("\n")).toContain(`promotion_unresolved_import: ${parent} imports`);
  });
});
