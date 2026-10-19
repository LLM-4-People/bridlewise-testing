import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTempDir } from "../../support/temp-dir.ts";
import { InputError } from "../../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  compileSelfProtectionConfigToSpec,
} from "../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  DEFAULT_SELF_PROTECTION_CONFIG,
  parseSelfProtectionConfig,
  type SelfProtectionConfig,
} from "../../../src/filesystem/self-protection/self-protection-config.ts";
import {
  PROJECT_ROOT_ACCESS_FLAGS,
  DEFAULT_TEMP_DIR_ACCESS,
  MAXIMUM_PROTECTED_SUBTREES,
} from "../../../src/filesystem/self-protection/self-protection-contracts.ts";
import { registerHarnessStore, type AdmittedKeyHome } from "../../../src/filesystem/self-protection/key-home.ts";
import { emptyKeepOutFacts } from "../../support/keep-out-facts.ts";

const EMPTY_KEEP_OUT = emptyKeepOutFacts();

const HARNESS_ROOT = "/opt/harness";
const PROJECT_ROOT = "/home/user/project";
const NODE_BIN = "/usr/bin/node";

/**
 * A REAL harness, project and interpreter on disk, for the arms that assert
 * what the spec EMITS: the compiler judges every rule by name but emits only
 * the paths that exist (a rule for a missing path makes the guardian refuse
 * the whole spec), so a fictional root reaches no emitted rule.
 */
function realWorld(): Readonly<{ harness: string; project: string; node: string }> {
  const harness = realpathSync(createTempDir("compile-spec-harness-"));
  mkdirSync(join(harness, "dist"), { recursive: true });
  mkdirSync(join(harness, "src"), { recursive: true });
  writeFileSync(join(harness, "src", "protected.ts"), "");
  writeFileSync(join(harness, "dist", "bundle.js"), "");
  return { harness, project: realpathSync(createTempDir("compile-spec-project-")), node: realpathSync(process.execPath) };
}

function enabledConfig(overrides: Partial<SelfProtectionConfig> = {}): SelfProtectionConfig {
  const base = Object.assign({}, DEFAULT_SELF_PROTECTION_CONFIG, { enabled: true }, overrides) as unknown;
  return parseSelfProtectionConfig(base);
}

test("compile-spec: default enabled config produces the floor-protected src subtree + floor allow-set", () => {
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig(), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.ok(spec.protected_subtrees.includes(`${HARNESS_ROOT}/src`), "src must be protected");
  assert.equal(spec.default_deny_outside_allow_rules, true);
  assert.equal(spec.abi_version_hint, 0);
  // No temp folder unless the host names a private one (the system temp folder is never granted by default).
  assert.equal(spec.temp_dir, undefined);
  assert.equal(spec.temp_dir_access, undefined);
  const named = compileSelfProtectionConfigToSpec(enabledConfig({ tempDir: "/home/user/tmp" }), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.deepEqual([...(named.temp_dir_access ?? [])], [...DEFAULT_TEMP_DIR_ACCESS]);
  const world = realWorld();
  const emitted = compileSelfProtectionConfigToSpec(enabledConfig(), world.harness, world.project, world.node, EMPTY_KEEP_OUT);
  const allowPaths = new Set(emitted.allow_rules.map((r) => r.path));
  // EVERY FLOOR ENTRY IS PRESENT, COMPARED AS THE PLACE IT NAMES rather than
  // as the string the floor happens to spell it with. On a merged-`/usr` host
  // `/lib` is a symbolic link to `/usr/lib`, and the compiled spec now says
  // where the rule really points — asserting the literal would pin the spec to
  // one distribution's layout and would also hide the very resolution this
  // test exists to confirm. Derived from the floor, so a floor entry added
  // tomorrow is checked here with no edit.
  assert.ok(ROOT_POLICY.selfProtection.minimumAllowSet.length >= 5, "the floor allow-set must not be empty");
  for (const entry of ROOT_POLICY.selfProtection.minimumAllowSet) {
    assert.equal(
      allowPaths.has(realpathSync(entry.path)),
      true,
      `floor allow-set entry ${entry.path} must reach the spec as ${realpathSync(entry.path)}`,
    );
  }
  assert.equal(allowPaths.has(world.node), true);
  assert.equal(allowPaths.has(`${world.harness}/dist/bundle.js`), true);
  assert.equal(allowPaths.has(world.project), true);
  // The fictional roots are judged (the spec compiled) but not emitted.
  assert.equal(spec.allow_rules.some((r) => r.path === PROJECT_ROOT || r.path === `${HARNESS_ROOT}/dist/bundle.js`), false);
});

test("compile-spec: JUDGED BY NAME, EMITTED BY PRESENCE — an absent path the floor refuses is refused before it exists; an absent acceptable one compiles and is not emitted", () => {
  const world = realWorld();
  const home = realpathSync(createTempDir("compile-spec-home-"));
  const secrets = join(home, "secret-store");
  const config = (path: string): SelfProtectionConfig => enabledConfig({ additionalProtectedSubtrees: [secrets], additionalAllowRules: [{ path, access: ["READ_FILE", "READ_DIR"] }] });
  const refused = (error: unknown): boolean => error instanceof InputError && error.code === "self_protection_rule_overlaps_refused_path";
  assert.throws(() => compileSelfProtectionConfigToSpec(config(secrets), world.harness, world.project, world.node, EMPTY_KEEP_OUT), refused, "absent: refused by name");
  mkdirSync(secrets);
  assert.throws(() => compileSelfProtectionConfigToSpec(config(secrets), world.harness, world.project, world.node, EMPTY_KEEP_OUT), refused, "present: the same verdict");
  const absent = join(home, "tools-not-installed");
  const spec = compileSelfProtectionConfigToSpec(config(absent), world.harness, world.project, world.node, EMPTY_KEEP_OUT);
  assert.equal(spec.allow_rules.some((r) => r.path === absent), false, "an absent acceptable path is not emitted");
});

test("compile-spec: a floor file behind a link is granted READ_FILE at its resolved target (WSL resolv.conf DNS)", () => {
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig(), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.ok(ROOT_POLICY.selfProtection.minimumLinkedReadFiles.length >= 1, "the floor names its linked read files");
  for (const file of ROOT_POLICY.selfProtection.minimumLinkedReadFiles) {
    let target: string;
    try { target = realpathSync(file); } catch { continue; } // absent on this host: no rule, by design
    const rule = spec.allow_rules.find((r) => r.path === target);
    assert.ok(rule !== undefined, `${file} must reach the spec at its resolved target ${target}`);
    // Read-only, and nothing a directory rule would need: a file rule with a
    // directory right is refused by the kernel.
    if (target !== realpathSync("/etc") && !target.startsWith(`${realpathSync("/etc")}/`)) {
      assert.deepEqual([...rule!.access], ["READ_FILE"], `${target} is granted exactly READ_FILE`);
    }
  }
});

test("compile-spec: project root gets the full project workspace access set", () => {
  const world = realWorld();
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig(), world.harness, world.project, world.node, EMPTY_KEEP_OUT);
  const projectRule = spec.allow_rules.find((r) => r.path === world.project);
  assert.deepEqual([...projectRule!.access].sort(), [...PROJECT_ROOT_ACCESS_FLAGS].sort());
});

test("compile-spec: handled_access_fs is the full 16-flag floor by default", () => {
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig(), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.equal(spec.handled_access_fs.length, 16);
});

test("compile-spec: operator additionalProtectedSubtrees are merged with the floor", () => {
  const existing = realpathSync(createTempDir("operator-keep-out-"));
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ tempDir: "/home/user/tmp", additionalProtectedSubtrees: ["/home/user/secret", existing] }),
    HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.ok(spec.protected_subtrees.includes(`${HARNESS_ROOT}/src`), "the harness floor is always emitted");
  // ONE keep-out list: an operator entry that exists reaches the guardian;
  // a missing one is not emitted (the guardian opens each) but still refused.
  assert.ok((spec.keep_out ?? []).includes(existing), "an operator entry that exists is emitted (keep_out: the guardian skips it if it vanishes)");
  assert.ok(![...spec.protected_subtrees, ...(spec.keep_out ?? [])].includes("/home/user/secret"));
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({ additionalProtectedSubtrees: ["/home/user/secret"], additionalAllowRules: [{ path: "/home/user/secret/x", access: ["READ_FILE"] }] }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_rule_overlaps_refused_path",
  );
});

test("compile-spec: operator additionalAllowRules are merged with the floor allow-set", () => {
  const tools = realpathSync(createTempDir("compile-spec-tools-"));
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ additionalAllowRules: [{ path: tools, access: ["READ_FILE", "READ_DIR"] }] }),
    HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  const rule = spec.allow_rules.find((r) => r.path === tools);
  assert.deepEqual([...rule!.access].sort(), ["READ_DIR", "READ_FILE"]);
});

test("compile-spec: operator additionalHandledAccessFs do not duplicate floor flags", () => {
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ additionalHandledAccessFs: ["READ_FILE", "IOCTL_DEV"] }),
    HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.equal(spec.handled_access_fs.length, 16, "floor already covers all 16; additions are deduped");
  assert.deepEqual([...spec.handled_access_fs], [...ROOT_POLICY.selfProtection.handledAccessFs]);
});

test("compile-spec: tempDir from config overrides os.tmpdir", () => {
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ tempDir: "/home/user/tmp" }),
    HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.equal(spec.temp_dir, "/home/user/tmp");
});

test("compile-spec: rejects allow-rule path under the floor-protected src subtree", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({ additionalAllowRules: [{ path: `${HARNESS_ROOT}/src/secret.ts`, access: ["READ_FILE"] }] }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_allow_rule_under_protected_subtree",
  );
});

test("compile-spec: rejects allow-rule path under an additional protected subtree (the compiler, by identity)", () => {
  // ONE place decides overlaps: the compiler's keep-out verdict, by identity
  // (the schema's spelling-based superRefine duplicate is gone).
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({
        additionalProtectedSubtrees: ["/home/user/secret"],
        additionalAllowRules: [{ path: "/home/user/secret/file", access: ["READ_FILE"] }],
      }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_rule_overlaps_refused_path",
  );
});

test("compile-spec: rejects tempDir under a protected subtree", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({ tempDir: `${HARNESS_ROOT}/src/tmp` }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError && error.code === "self_protection_temp_dir_under_protected_subtree",
  );
});

test("compile-spec: rejects non-absolute harnessRoot", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(enabledConfig(), "relative/root", PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError,
  );
});

test("compile-spec: rejects non-absolute projectRoot", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(enabledConfig(), HARNESS_ROOT, "relative/project", NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError,
  );
});

test("compile-spec: rejects non-absolute nodeBinaryPath", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(enabledConfig(), HARNESS_ROOT, PROJECT_ROOT, "node", EMPTY_KEEP_OUT),
    (error: unknown) => error instanceof InputError,
  );
});

test("compile-spec: floor minimumProtectedSubtrees cannot be removed by the operator (root-policy is non-overridable)", () => {
  assert.deepEqual([...ROOT_POLICY.selfProtection.minimumProtectedSubtrees], ["src"]);
  assert.equal(ROOT_POLICY.selfProtection.mayNotBeDisabled, true);
  assert.equal(ROOT_POLICY.selfProtection.blockRead, true);
  assert.equal(ROOT_POLICY.selfProtection.blockWrite, true);
});

test("compile-spec: compiled spec always sets default_deny_outside_allow_rules true", () => {
  for (const overrides of [
    {},
    { additionalAllowRules: [{ path: "/opt/extra", access: ["READ_FILE"] }] },
    { additionalProtectedSubtrees: ["/opt/protected"] },
    { tempDir: "/var/tmp" },
  ] as Partial<SelfProtectionConfig>[]) {
    const spec = compileSelfProtectionConfigToSpec(
      enabledConfig(overrides), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
    assert.equal(spec.default_deny_outside_allow_rules, true);
  }
});

/**
 * THE FLOOR: a widening that would subsume the protected set is REFUSED.
 *
 * Landlock allow-rules are hierarchical and "protection" here is only
 * deny-by-omission, so allowing an ANCESTOR of a protected subtree grants
 * everything inside it. Before this refusal existed, one operator entry for
 * `$HOME` was measured to make the guardian exit 0 having applied the
 * restriction it was asked for, while the payload read the harness's own
 * `src/root-policy.ts` — a file the same spec listed as protected. Every
 * surface reported the protection as enabled.
 *
 * The tests below drive BOTH verdicts. A refusal guard that only ever sees
 * things it must refuse cannot tell "correct" from "refuses everything", and
 * refusing everything would break the operator's ability to widen at all —
 * which is an off switch reached from the other side.
 */

/** Every ancestor of the harness's protected `src`, including the awkward ones. */
test("compile-spec: an allow-rule that CONTAINS a protected subtree is refused", () => {
  const protectedSrc = `${HARNESS_ROOT}/src`;
  const subsuming = ["/", HARNESS_ROOT, "/opt"];
  // POPULATION AS A RUNTIME NUMBER: a loop over an empty list passes.
  assert.ok(subsuming.length >= 3, "the subsuming-path table must not be empty");
  for (const path of subsuming) {
    assert.throws(
      () => compileSelfProtectionConfigToSpec(
        enabledConfig({ additionalAllowRules: [{ path, access: ["READ_FILE", "READ_DIR"] }] }),
        HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
      (error: unknown) =>
        error instanceof InputError
        && error.code === "self_protection_allow_rule_subsumes_protected_subtree",
      `allowing ${path} would grant everything inside ${protectedSrc}`,
    );
  }
});

test("compile-spec: a tempDir that CONTAINS a protected subtree is refused", () => {
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({ tempDir: HARNESS_ROOT }), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    (error: unknown) =>
      error instanceof InputError
      && error.code === "self_protection_temp_dir_subsumes_protected_subtree",
  );
});

test("compile-spec: the refusal is by PATH SEGMENT, so a name-prefix of a protected path is still allowed", () => {
  // THE PATH THAT ACTUALLY EXERCISES THE SEPARATOR. The protected subtree is
  // `/opt/harness/src`, and `/opt/harness/s` is a string prefix of it while
  // being a completely different directory. A `startsWith` without the
  // separator refuses it — and an earlier version of this test used
  // `/opt/harness-other`, which is not a string prefix of anything and let
  // exactly that mutation through.
  //
  // Over-refusal is not a safe direction to fail in: widening is how an
  // operator adds the toolchain a project needs, and when widening stops
  // working the protection gets turned off instead. A safety rule that
  // refuses too much becomes an off switch from the other side.
  const world = realWorld();
  const neighbour = `${world.harness}/s`;
  mkdirSync(neighbour);
  assert.ok(`${world.harness}/src`.startsWith(neighbour), "the fixture must be a string prefix, or it tests nothing");
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ additionalAllowRules: [{ path: neighbour, access: ["READ_FILE"] }] }),
    world.harness, world.project, world.node, EMPTY_KEEP_OUT);
  assert.ok(spec.allow_rules.some((r) => r.path === neighbour));
});

test("compile-spec: a legitimate widening still succeeds (the guard is not an off switch)", () => {
  const toolchain = realpathSync(createTempDir("compile-spec-toolchain-"));
  const spec = compileSelfProtectionConfigToSpec(
    enabledConfig({ additionalAllowRules: [{ path: toolchain, access: ["EXECUTE", "READ_FILE"] }] }),
    HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT);
  assert.ok(spec.allow_rules.some((r) => r.path === toolchain));
  // And the protected subtree is still protected — the widening did not
  // silently drop it, which is the state this whole rule exists to prevent.
  assert.ok(spec.protected_subtrees.includes(`${HARNESS_ROOT}/src`));
});

test("compile-spec: an operator's OWN additional protected subtree gets the same defence", () => {
  // Derived, not named: the rule reads the protected SET, so a subtree added
  // by an operator tomorrow is defended with no edit in the compiler.
  assert.throws(
    () => compileSelfProtectionConfigToSpec(
      enabledConfig({
        additionalProtectedSubtrees: ["/srv/secrets/keys"],
        additionalAllowRules: [{ path: "/srv/secrets", access: ["READ_FILE", "READ_DIR"] }],
      }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
    // The operator's entries are the keep-out list's, answered in its code
    // (the harness's own code keeps "this is the harness").
    (error: unknown) =>
      error instanceof InputError
      && error.code === "self_protection_rule_overlaps_refused_path",
  );
});

/**
 * THE FLOOR COMPARES LOCATIONS, NOT SPELLINGS.
 *
 * The refusal above was written against paths spelled canonically, and the
 * comparison it used was `startsWith` on the string it was handed. Six other
 * spellings of the very same directory therefore COMPILED — and three of them
 * were driven to a WRITE inside the protected subtree while every surface
 * still reported the sandbox as enforced:
 *
 *   <root>/guardian/..      a `..` segment           (allow-rule, and tempDir)
 *   //<home>                a repeated separator
 *   /<home>/.               a `.` segment
 *   a symbolic link to the harness root, and one to $HOME
 *
 * These are one defect, not six, so the tests below are generated from the
 * protected subtree rather than typed out: every case is built by SPELLING an
 * ancestor differently, so a seventh spelling of the same idea is covered by
 * adding one line to the generator and none to the assertions.
 */
function spellingsOf(canonical: string, linkDir: string): readonly Readonly<{ how: string; path: string }>[] {
  const link = join(linkDir, `link-${Buffer.from(canonical).toString("hex").slice(0, 24)}`);
  symlinkSync(canonical, link);
  return [
    { how: "canonical", path: canonical },
    { how: "a '..' segment that climbs back to it", path: `${canonical}/anything/..` },
    { how: "a '.' segment", path: `${canonical}/.` },
    { how: "a repeated leading separator", path: `/${canonical}` },
    { how: "a trailing separator", path: `${canonical}/` },
    { how: "a symbolic link pointing at it", path: link },
  ];
}

test("compile-spec: EVERY spelling of an ancestor of a protected subtree is refused", () => {
  // A REAL directory tree, because two of the spellings are symbolic links and
  // a link is only followed if it is there. The protected subtree is this
  // harness root's own `src`, exactly as in production.
  const harness = createTempDir("compile-spec-spellings-");
  const links = createTempDir("compile-spec-links-");
  const project = createTempDir("compile-spec-project-");
  try {
    // `mkdtemp` returns a path under `os.tmpdir()`, which is itself a symbolic
    // link on some hosts; resolving it here means the fixture states the same
    // place the compiler will.
    const harnessReal = realpathSync(harness);
    mkdirSync(join(harnessReal, "src"), { recursive: true });
    const spellings = spellingsOf(harnessReal, links);
    // POPULATION AS A RUNTIME NUMBER, with a floor: a generator that returned
    // nothing would satisfy every assertion in the loop.
    assert.ok(spellings.length >= 6, `spellings generated: ${spellings.length}`);
    for (const { how, path } of spellings) {
      assert.throws(
        () => compileSelfProtectionConfigToSpec(
          // The temp directory is pinned to the project root so the ONLY thing
          // this case can be refused for is the allow-rule. The fixture harness
          // lives under `os.tmpdir()`, so the default temp directory is an
          // ancestor of its protected `src` and would be refused on its own —
          // a second reason to fail, which would let the assertion pass with
          // the allow-rule half dead.
          enabledConfig({ tempDir: project, additionalAllowRules: [{ path, access: ["READ_FILE", "READ_DIR"] }] }),
          harnessReal, project, NODE_BIN, EMPTY_KEEP_OUT),
        (error: unknown) =>
          error instanceof InputError
          && error.code === "self_protection_allow_rule_subsumes_protected_subtree",
        `${how}: ${path} names ${harnessReal}, which contains its protected src`,
      );
      // THE SAME SPELLING THROUGH tempDir, which is an allow-rule in all but
      // name — it carries write, create, truncate and remove — and which was
      // the second measured bypass. Its own detector, its own liveness: a
      // conjunction whose halves are not separately driven can go green with
      // one half dead.
      assert.throws(
        () => compileSelfProtectionConfigToSpec(
          enabledConfig({ tempDir: path }), harnessReal, project, NODE_BIN, EMPTY_KEEP_OUT),
        (error: unknown) =>
          error instanceof InputError
          && error.code === "self_protection_temp_dir_subsumes_protected_subtree",
        `tempDir spelled with ${how}: ${path}`,
      );
    }
  } finally {
    rmSync(harness, { recursive: true, force: true });
    rmSync(links, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("compile-spec: a symbolic link to $HOME is refused, and a link to somewhere harmless is not", () => {
  // THE PAIR IS THE POINT. A guard that refuses every symbolic link would be
  // an off switch reached from the other side: an operator who cannot widen at
  // all turns the protection off instead. So the same mechanism is driven to
  // BOTH verdicts, on two links that differ only in where they point.
  const links = createTempDir("compile-spec-home-link-");
  const project = createTempDir("compile-spec-home-project-");
  const harness = realpathSync(createTempDir("compile-spec-home-harness-"));
  try {
    mkdirSync(join(harness, "src"), { recursive: true });
    // A PROTECTED SUBTREE WITH A FILE IN IT. An empty one is refused by the
    // compiler, and rightly: a subtree that exists and yields nothing to check
    // is a protection that proved nothing, which used to read as a clean pass.
    // The fixture is made realistic rather than the check made lenient.
    writeFileSync(join(harness, "src", "owned.ts"), "export const owned = 1;\n");
    const toHome = join(links, "to-home");
    symlinkSync(homedir(), toHome);
    const toHarmless = join(links, "to-usr-local");
    symlinkSync("/usr/local", toHarmless);
    // $HOME contains the harness in the ordinary layout, so a link to it is an
    // ancestor of the protected subtree by another name.
    if (realpathSync(homedir()) === harness || harness.startsWith(`${realpathSync(homedir())}/`)) {
      assert.throws(
        () => compileSelfProtectionConfigToSpec(
          enabledConfig({ tempDir: project, additionalAllowRules: [{ path: toHome, access: ["READ_FILE", "READ_DIR"] }] }),
          harness, project, NODE_BIN, EMPTY_KEEP_OUT),
        (error: unknown) =>
          error instanceof InputError
          && error.code === "self_protection_allow_rule_subsumes_protected_subtree",
      );
    }
    // …and the link that points somewhere with no protected subtree under it
    // still compiles, resolved to its target.
    const spec = compileSelfProtectionConfigToSpec(
      // Same reason as above: the fixture harness sits under `os.tmpdir()`,
      // so the default temp directory would be refused for containing its
      // protected `src`. Pinning it to the project root leaves the symbolic
      // link as the only thing under test.
      enabledConfig({ tempDir: project, additionalAllowRules: [{ path: toHarmless, access: ["READ_FILE", "READ_DIR"] }] }),
      harness, project, NODE_BIN, EMPTY_KEEP_OUT);
    assert.ok(
      spec.allow_rules.some((r) => r.path === realpathSync("/usr/local")),
      "the compiled rule must name the link's TARGET, so the spec says what it means",
    );
    assert.ok(
      !spec.allow_rules.some((r) => r.path === toHarmless),
      "the link's own path must not survive into the spec",
    );
  } finally {
    rmSync(links, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(harness, { recursive: true, force: true });
  }
});

test("compile-spec: the compiler itself refuses a path that is not absolute", () => {
  // THE COMPILER, NOT ONLY THE OPERATOR-CONFIG SCHEMA. The web server adds
  // DERIVED allow-rules that never pass through that schema, so absoluteness
  // enforced only there is enforced only for one of the two ways in — and
  // `"$HOME"` and `"~/"` used to be compiled and emitted, with only the pinned
  // C binary refusing them at the far end.
  const notAbsolute = ["$HOME", "~/", "relative/path", "./x"];
  assert.ok(notAbsolute.length >= 4, "the non-absolute table must not be empty");
  for (const path of notAbsolute) {
    assert.throws(
      // The schema is bypassed on purpose: this asserts the COMPILER's own
      // refusal, which is the door every caller passes through.
      () => compileSelfProtectionConfigToSpec(
        { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true, additionalAllowRules: [{ path, access: ["READ_FILE"] }] } as unknown as SelfProtectionConfig,
        HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT),
      (error: unknown) => error instanceof InputError && error.code === "path_not_absolute",
      `${path} is not absolute and must not reach the guardian`,
    );
  }
  // CLEAN CONTROL: an absolute path with no protected subtree under it still
  // compiles, so the refusal above is about absoluteness and not about
  // refusing everything.
  assert.ok(
    compileSelfProtectionConfigToSpec(
      enabledConfig({ additionalAllowRules: [{ path: "/usr/local", access: ["READ_FILE"] }] }),
      HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, EMPTY_KEEP_OUT).allow_rules.some((r) => r.path === realpathSync("/usr/local")),
  );
});

test("compile-spec: a keep-out list past 64 entries (a workstation's registered installs) still compiles, every present entry emitted", () => {
  // 64 used to be the spec's bound: reached on a real host once its installs
  // were registered, it refused EVERY confined spawn with a raw schema error.
  const facts = emptyKeepOutFacts();
  const stores = createTempDir("compile-spec-many-stores-");
  try {
    for (let index = 0; index < 100; index += 1) {
      const db = join(stores, `install-${index}`, "web.db");
      mkdirSync(join(stores, `install-${index}`));
      writeFileSync(db, "");
      registerHarnessStore(facts.registry.keyHome as AdmittedKeyHome, db);
    }
    const spec = compileSelfProtectionConfigToSpec(enabledConfig({ tempDir: "/home/user/tmp" }), HARNESS_ROOT, PROJECT_ROOT, NODE_BIN, facts);
    const keepOut = spec.keep_out ?? [];
    const stored = keepOut.filter((path) => path.startsWith(realpathSync(stores)));
    assert.equal(stored.length, 100, "every registered, present database is emitted");
    assert.ok(keepOut.length > 64 && keepOut.length <= MAXIMUM_PROTECTED_SUBTREES);
  } finally {
    rmSync(stores, { recursive: true, force: true });
  }
});
