// @vitest-environment node
/**
 * Mechanical enforcement: THE SVELTE TEMPLATE CHECK STAYS WIRED, AND STAYS
 * POINTED AT EVERY COMPONENT.
 *
 * ── What this exists to prevent ────────────────────────────────────────────
 *
 * `tsc --noEmit` does not read Svelte templates. Before `svelte-check` was
 * installed, every expression between `{` and `}` in every `.svelte` file —
 * props passed to components, bindings, template logic — was checked by NO
 * tool, and "typecheck is clean" was a far narrower claim than it read as.
 * The editor room's HTML view shipped dead because `FilePane` mounted
 * `ArtifactFrame` without its required `frameKey`, past 142 mechanical tests
 * and a green typecheck.
 *
 * ── Why this asserts WIRING and not CLEANLINESS ────────────────────────────
 *
 * The full source population stays in `npm run typecheck`. Small disposable
 * projects below exercise the installed checker and its actual config and
 * template discovery. The mechanical checks also catch the gate being quietly
 * unhooked: a `typecheck` script that stops calling it, a devDependency
 * dropped, a tsconfig that stops naming `.svelte`. Every one of those turns
 * the check into a no-op that still reports success, which is the failure mode
 * this whole area is about.
 *
 * So: templates are checked in `typecheck` (where static analysis belongs, and
 * where it gates alongside the native client, server and test programs), and `npm test` asserts that it
 * is still connected.
 *
 * ── The reachability half is not optional ──────────────────────────────────
 *
 * `tsconfig.json` includes `src/**\/*.ts`, which does not match a `.svelte`
 * path — so under it, a component is checked only if some `.ts` root
 * transitively imports it. MEASURED: with that file set, deleting the required
 * `frameKey` prop from `FilePane.svelte` produced ZERO errors, because nothing
 * in the app imports FilePane (only tests do). The gate would not have caught
 * the defect it was installed for. `tsconfig.templates.json` names the
 * `.svelte` glob so membership is a fact about the filesystem, and pointing
 * the gate back at a config without it is exactly the regression below.
 */
import { describe, test, expect } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempDir } from "../helpers/temp-dir.ts";
import { TEST_TIMEOUT_MS } from "../test-budget.ts";

type PackageJson = Readonly<{
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}>;

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const scripts = pkg.scripts ?? {};
const devDeps = pkg.devDependencies ?? {};

/** The config that decides WHICH components are checked. */
const TEMPLATE_TSCONFIG = "tsconfig.templates.json";

describe("the svelte template check is wired into the typecheck gate", () => {
  test("a `typecheck:templates` script exists and runs the template-check runner", () => {
    const script = scripts["typecheck:templates"];
    expect(script, "package.json must declare a `typecheck:templates` script").toBeDefined();
    expect(script, "`typecheck:templates` must run scripts/template-check.ts").toContain(
      "scripts/template-check.ts",
    );
  });

  test("`npm run typecheck` GATES on it — a template error must fail the same command tsc fails", () => {
    const typecheck = scripts["typecheck"]!;
    expect(typecheck, "package.json must declare a `typecheck` script").toBeDefined();
    expect(
      typecheck,
      "`typecheck` must chain `typecheck:templates`, or Svelte templates are checked by nothing again",
    ).toContain("typecheck:templates");
    // `&&` and not `;`: a chain joined by `;` reports the LAST command's status,
    // so a failing tsc would exit 0 as long as the template check passed.
    expect(
      typecheck.includes(";"),
      "`typecheck` must chain with && so any leg's failure fails the command",
    ).toBe(false);
  });

  test("the check is pointed at the config that includes EVERY .svelte file, not only the imported ones", () => {
    const script = scripts["typecheck:templates"] ?? "";
    expect(
      script,
      `typecheck:templates must use --tsconfig ./${TEMPLATE_TSCONFIG}; under the plain ` +
        `tsconfig.json a component nothing imports is silently unchecked (measured: ` +
        `removing a required prop from FilePane.svelte produced zero errors)`,
    ).toContain(TEMPLATE_TSCONFIG);

    const raw = readFileSync(TEMPLATE_TSCONFIG, "utf8");
    const cfg = JSON.parse(raw) as Readonly<{ include?: readonly string[]; extends?: string }>;
    expect(cfg.extends, `${TEMPLATE_TSCONFIG} must extend tsconfig.json so templates inherit the same strictness`).toBe(
      "./tsconfig.json",
    );
    expect(
      (cfg.include ?? []).some((p) => p.endsWith("*.svelte")),
      `${TEMPLATE_TSCONFIG} must name a .svelte glob in "include" — without it the ` +
        `file set falls back to import reachability and unreferenced components go unchecked`,
    ).toBe(true);
  });

  test("both halves of the toolchain are declared: svelte-check, and the TypeScript 5 it needs", () => {
    expect(devDeps["svelte-check"], "svelte-check must be a devDependency").toBeDefined();
    // svelte-check is built on the TypeScript 5.x JavaScript compiler API. This
    // project's own TypeScript is 7 (the native compiler), whose package exports
    // no compiler API at all — so the checker needs a 5.x alongside it, under an
    // alias. Losing the alias is losing the checker.
    const alias = devDeps["typescript5"];
    expect(
      alias,
      "typescript5 (npm:typescript@5.x) must be a devDependency — svelte-check cannot " +
        "run on TypeScript 7, whose package exposes no JS compiler API",
    ).toBeDefined();
    // A caret/tilde range is fine — both pin the MAJOR, which is the part that
    // matters: the API svelte-check needs disappeared in 7, so a range that
    // could drift off 5 would silently reproduce the original breakage.
    expect(alias).toMatch(/^npm:typescript@[\^~]?5\./);
  });

  test("the runner refuses to report a verdict on the wrong TypeScript (a silent no-op reads as a pass)", () => {
    // The single most dangerous failure here is a checker that loads, finds
    // nothing because it is misconfigured, and prints success. The runner
    // asserts the TypeScript it actually got before handing off; this pins that
    // self-check in place.
    const runner = readFileSync("scripts/template-check.ts", "utf8");
    expect(runner).toContain('require("typescript")');
    expect(
      runner,
      "the runner must verify the loaded TypeScript version before running svelte-check",
    ).toMatch(/loaded\.version !== aliasVersion/);
    expect(runner, "a failed self-check must exit non-zero").toMatch(/process\.exit\(1\)/);
  });
});

/** This fixture executes the shipped simple Node argv, not a second runner. */
/**
 * svelte-check's machine lines — `<ms> ERROR "<file>" <line>:<col> "<message>"`
 * — as records, so an assertion names ONE diagnostic (its kind, file and
 * message) instead of a line window between two anchors. The message is
 * everything between the third quote and the last, so quotes inside it survive.
 */
function machineDiagnostics(output: string): readonly Readonly<{ kind: string; file: string; message: string }>[] {
  return output.split("\n").flatMap((line) => {
    const parts = line.split('"');
    const kind = parts[0]?.trim().split(" ")[1];
    if (parts.length < 5 || (kind !== "ERROR" && kind !== "WARNING")) return [];
    return [{ kind, file: parts[1]!, message: parts.slice(3, -1).join('"') }];
  });
}

function checkerFixture() {
  const script = scripts["typecheck:templates"] ?? "";
  expect(script, "keep this command as explicit Node argv; shell syntax needs an owning design")
    .toMatch(/^node(?: [A-Za-z0-9_./=-]+)+$/u);
  const [command, ...argv] = script.split(" ");
  expect(command).toBe("node");
  const root = createTempDir("template-config-discovery-");
  const put = (name: string, text: string): void => {
    const destination = join(root, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, text);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  for (const name of ["scripts/template-check.ts", "tsconfig.json", TEMPLATE_TSCONFIG]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    copyFileSync(name, join(root, name));
  }
  // Individual installed packages preserve normal resolution without linking
  // product source, another checkout's config, or the whole workspace.
  for (const name of ["svelte-check", "typescript5", "svelte", "vite", "@sveltejs/vite-plugin-svelte", "@types/node"]) {
    const target = realpathSync(resolve("node_modules", name));
    expect(target).toContain("/node_modules/");
    const destination = join(root, "node_modules", name);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(target, destination, "dir");
  }
  put("src/App.svelte", "<h1>Valid template</h1>\n");
  // An importing entry of the scratch tree (a made-up name: no real module's location).
  put("src/fixture-entry.ts", "import './App.svelte';\n");
  put("src/Unimported.svelte", "<p>Also checked without an import</p>\n");
  put("svelte.config.ts", "export default {};\n");
  put("vite.config.ts", `import {writeFileSync} from 'node:fs';
import {svelte} from '@sveltejs/vite-plugin-svelte';
writeFileSync(${JSON.stringify(join(root, "root-config-seen"))}, 'selected');
export default {plugins:[svelte()]};\n`);
  const outside = ["research/nested", "unrelated/archive"];
  put(".gitignore", outside.join("/\n") + "/\n");
  for (const name of outside) {
    put(name + "/vite.config.ts", `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root, name, "config-seen"))}, 'outside');
throw new TypeError('out-of-scope-config-canary');\n`);
  }
  const observation = join(root, "process-observation.jsonl");
  put("observe.mjs", `import cp from 'node:child_process';
import {appendFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const record=event=>appendFileSync(${JSON.stringify(observation)},JSON.stringify(event)+'\\n');
record({kind:'observer',pid:process.pid});
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
 const original=cp[method];cp[method]=function(...args){record({kind:'child-process',method});return Reflect.apply(original,this,args);};
}syncBuiltinESMExports();\n`);
  return { root, put, outside, run() {
    // The wrapper requires svelte-check in this same child. SIGKILL bounds
    // that child; this does not claim arbitrary escaped-descendant cleanup.
    const child = spawnSync(process.execPath, [...argv, "--output", "machine"], {
      cwd: root, encoding: "utf8", timeout: TEST_TIMEOUT_MS, killSignal: "SIGKILL",
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(root, "observe.mjs")).href}` },
    });
    const output = child.stdout + child.stderr;
    expect(child.error, output).toBeUndefined();
    expect(child.signal, output).toBeNull();
    const observed = readFileSync(observation, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { kind: string; pid?: number; method?: string });
    expect(observed.some((event) => event.kind === "observer" && event.pid === child.pid)).toBe(true);
    expect(observed.filter((event) => event.kind === "child-process"),
      "this bounded fixture must not launch commands through Node child_process").toEqual([]);
    return { ...child, output };
  } };
}

describe("the real template checker uses only its selected config and complete file set", () => {
  test("ignored nested configs never execute while in-scope templates are checked", () => {
    const fixture = checkerFixture();
    const child = fixture.run();
    expect(child.status, child.output).toBe(0);
    expect(existsSync(join(fixture.root, "root-config-seen"))).toBe(true);
    expect(fixture.outside.map((name) => ({ name, executed: existsSync(join(fixture.root, name, "config-seen")) })))
      .toEqual(fixture.outside.map((name) => ({ name, executed: false })));
    expect(child.output).toMatch(/COMPLETED [1-9]\d* FILES 0 ERRORS 0 WARNINGS/u);
    expect(child.output).not.toContain("Error while loading config");
    expect(child.output).not.toContain("out-of-scope-config-canary");
  });

  test("failure of the selected root config becomes a component diagnostic", () => {
    const fixture = checkerFixture();
    fixture.put("vite.config.ts", `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(fixture.root, "root-config-seen"))}, 'selected failure');
throw new TypeError('selected-root-config-canary');\n`);
    const child = fixture.run();
    expect(existsSync(join(fixture.root, "root-config-seen"))).toBe(true);
    expect(child.status, child.output).toBe(1);
    expect(machineDiagnostics(child.output)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ERROR", file: "src/Unimported.svelte", message: expect.stringContaining("selected-root-config-canary") }),
      expect.objectContaining({ kind: "ERROR", file: "src/App.svelte", message: expect.stringContaining("selected-root-config-canary") }),
    ]));
    expect(child.output).toMatch(/COMPLETED [1-9]\d* FILES 2 ERRORS/u);
  });

  test("an unimported in-scope component error fails and its correction passes", () => {
    const fixture = checkerFixture();
    fixture.put("src/Unimported.svelte", '<script lang="ts">const count: number = "template-count-invalid";</script><p>{count}</p>\n');
    const failed = fixture.run();
    expect(failed.status, failed.output).toBe(1);
    expect(machineDiagnostics(failed.output)).toContainEqual(expect.objectContaining({
      kind: "ERROR", file: "src/Unimported.svelte", message: expect.stringContaining("Type 'string' is not assignable to type 'number'"),
    }));
    expect(failed.output).toMatch(/COMPLETED [1-9]\d* FILES 1 ERRORS/u);
    fixture.put("src/Unimported.svelte", '<script lang="ts">const count: number = 7;</script><p>{count}</p>\n');
    const restored = fixture.run();
    expect(restored.status, restored.output).toBe(0);
    expect(restored.output).toMatch(/COMPLETED [1-9]\d* FILES 0 ERRORS 0 WARNINGS/u);
  });
});
