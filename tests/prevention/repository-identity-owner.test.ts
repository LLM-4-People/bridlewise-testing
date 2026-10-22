// @vitest-environment node
/**
 * THE REPOSITORY IDENTITY HAS ONE SOURCE (P1.10 prep). This repository's
 * `owner/name` is declared once, as the `forge` section's trunk repository
 * in `engine/bridlewise.config.json`, and everything else derives from
 * `engine/src/workflow/forge/repository-identity.ts` or is generated from it:
 * - `package.json`'s repository, homepage and bugs fields;
 * - `CITATION.cff`'s repository-code;
 * - the community health files and the issue chooser.
 *
 * No other tracked code or configuration spells it. Comments are not code,
 * so prose citing the name in a comment is not a second source; a literal is.
 * Otherwise the rename is a hunt instead of one value.
 *
 * Scope: every tracked source and configuration file of the code roots and
 * the workflows. Hand-written prose (Markdown) and records are not code, and
 * are judged separately.
 */
import { describe, expect, test } from "vitest";

import { configuredRepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";
import { gitTrackedPaths, read, stripCommentsOnlyFor } from "../helpers/source-scan.ts";

const CODE_ROOTS = ["engine/src/", "engine/scripts/", "scripts/", "server/", "src/", "shared/", ".github/workflows/"];
const CODE = /\.(?:ts|mts|cts|js|mjs|cjs|svelte|ya?ml|json)$/u;
/** The one source, and the files generated from it (`harness sync`'s forge-files arm and community arm). */
const SOURCE_AND_GENERATED = new Set(["engine/bridlewise.config.json", "package.json", "CITATION.cff", ".github/ISSUE_TEMPLATE/config.yml"]);

describe("this repository's owner/name is spelled only where it is declared or generated", () => {
  test("no tracked code or configuration names the repository literally", () => {
    const identity = configuredRepositoryIdentity();
    const spelled = identity.fullName.toLowerCase();
    const scanned = [...gitTrackedPaths(".")].filter((path) => CODE_ROOTS.some((root) => path.startsWith(root)) && CODE.test(path) && !SOURCE_AND_GENERATED.has(path));
    expect(scanned.length, "the scan reads the code roots, not an empty set").toBeGreaterThan(500);
    const offenders = scanned.filter((path) => stripCommentsOnlyFor(read(path), path).toLowerCase().includes(spelled));
    expect(offenders, `these files spell ${identity.fullName}; derive it from the repository identity instead`).toEqual([]);
  });

  test("the scan sees a planted literal (it is not blind)", () => {
    const spelled = configuredRepositoryIdentity().fullName;
    expect(stripCommentsOnlyFor(`export const X = "${spelled}";\n`, "planted.ts").toLowerCase()).toContain(spelled.toLowerCase());
    expect(stripCommentsOnlyFor(`// ${spelled}\nexport const X = 1;\n`, "planted.ts").toLowerCase()).not.toContain(spelled.toLowerCase());
  });
});
