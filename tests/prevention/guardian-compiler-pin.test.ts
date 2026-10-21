// @vitest-environment node
/**
 * THE GUARDIAN'S COMPILER IS ONE DECLARATION.
 *
 * The compiler used to be selected at three places — `CC=gcc-14` in ci.yml,
 * `CC=gcc-14` in test-shards.yml, and a `cc | gcc | clang` search list inside
 * engine/guardian/build.ts — while the Makefile accepted any of the three. A
 * workflow edit that dropped the prefix, or a local `make` with another
 * compiler, changed the artifact with every guard still green. The binary was
 * bound by its sha256 then, which made the compiler part of the measured
 * artifact and made two toolchains disagree on the pin.
 *
 * The binary is now bound by a reproducible build stamp over the sealed
 * sources and flags (`guardian/build-stamp.spec`), so the compiler is a
 * build-tool pin, not a trust anchor. It is still declared ONCE here: a build
 * host must have the package the workflows install and the docs name.
 *
 * The Makefile's `CC := …` line is the ONE declaration. Both workflows install
 * that package and invoke the Makefile without a CC= literal; build.ts invokes
 * `make` and carries no list of its own. This guard reads the declaration and
 * refuses any of those duplicates.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const MAKEFILE = "engine/guardian/Makefile";
const BUILD = "engine/guardian/build.ts";
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/test-shards.yml"] as const;
const REGISTRY = "tests/prevention/external-surface-registry.json";

function declaredCompiler(): string {
  const match = /^CC\s*:=\s*(\S+)$/mu.exec(readFileSync(MAKEFILE, "utf8"));
  if (match === null) throw new Error(`${MAKEFILE} declares no CC := … line`);
  return match[1]!;
}

describe("the guardian compiler pin", () => {
  test("the build owner declares exactly one compiler", () => {
    const compiler = declaredCompiler();
    expect(compiler).toMatch(/^gcc-\d+$/u);
    // One assignment, not a search list: a Makefile that fell back to `cc`
    // would silently build a different artifact on a host without the pin.
    const declarations = readFileSync(MAKEFILE, "utf8").split("\n").filter((line) => /^CC\s*:?=/u.test(line));
    expect(declarations).toHaveLength(1);
  });

  test("the Node build helper does not carry its own compiler search list", () => {
    const build = readFileSync(BUILD, "utf8");
    expect(build).not.toMatch(/\[['"]cc['"],\s*['"]gcc['"],\s*['"]clang['"]\]/u);
    expect(build).toContain("spawnSync('make'");
  });

  test("both workflows install the declared package and never spell the compiler again", () => {
    const compiler = declaredCompiler();
    for (const workflow of WORKFLOWS) {
      const text = readFileSync(workflow, "utf8");
      expect(text, `${workflow} must install ${compiler}, the declared pin`).toContain(`sudo apt-get install -y ${compiler}`);
      expect(text, `${workflow} must not pass CC=; the Makefile owns the choice`).not.toMatch(/\bCC=/u);
      expect(text, `${workflow} must invoke the guardian build owner`).toMatch(/make -C engine\/guardian (?:all|test)/u);
    }
  });

  test("the declared compiler is the package the external-surface registry names", () => {
    const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
      surfaces: readonly { id: string; pinned?: { package?: string } }[];
    };
    const surface = registry.surfaces.find((entry) => entry.id === "apt:gcc-14");
    expect(surface?.pinned?.package).toBe(declaredCompiler());
  });

  test("the setup documents name the declared compiler, not a search list", () => {
    // The pin is part of the artifact: a host with only `gcc` cannot build the
    // guardian, so the setup documents must name the package to install. This
    // was stale when the Makefile moved to gcc-14 and the docs still said "a C
    // compiler".
    const compiler = declaredCompiler();
    for (const document of ["CONTRIBUTING.md", "docs/testing.md", "engine/guardian/README.md"]) {
      expect(readFileSync(document, "utf8"), `${document} must name ${compiler}, the declared pin`).toContain(compiler);
    }
    expect(readFileSync("engine/guardian/README.md", "utf8")).not.toContain("`cc`/`gcc`/`clang`");
  });
});
