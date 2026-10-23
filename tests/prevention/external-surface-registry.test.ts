// @vitest-environment node
/**
 * THE EXTERNAL-SURFACE REGISTRY IS ENUMERATED, AND THE GUARD REFUSES EVERY
 * SURFACE THE REGISTRY DOES NOT DECLARE.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * The measurement contract's jurisdiction is the whole app, including what the
 * floor borrows from outside it: actions, images, the runner class, the Node
 * runtime, npm trees, the Pages/Jekyll builder. Before this file the pins were
 * a convention spread across eleven workflows and two manifests. A tag-pinned
 * action (`actions/download-artifact@v4`) and a major-tag devcontainer feature
 * were both live, and neither was visible to any test: the tree built and the
 * suite stayed green while two outside things could move under it.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *
 * The declarations live in `tests/prevention/external-surface-registry.json`,
 * one entry per outside thing, each stating how it is pinned, where it is used
 * and how drift is detected. This guard is the mechanical half:
 *
 *   action-pin / action-version-comment
 *       every external `uses:` is `owner/repo[/path]@<40-hex> # vN[.N[.N]]`;
 *       the commit and comment equal the registry entry.
 *   action-undeclared / local-workflow-undeclared
 *       an action or reusable workflow the registry does not declare.
 *   image-digest / image-undeclared
 *       every `FROM`, `image:` and devcontainer feature carries
 *       `@sha256:<64>` and matches a declared image.
 *   floating-latest
 *       `:latest`, `@latest`, `tag: latest`, or a dependency version of
 *       `latest` anywhere in the enumerated workflows/build files.
 *   node-range / node-manifest-undeclared
 *       the floor manifests share one `engines.node`; every workflow pin and
 *       `.node-version`/`.nvmrc` equals it; a declared verification tree's
 *       exact pin stays inside it; any other manifest with an engine is
 *       undeclared.
 *   lockfile-missing / lockfile-integrity / install-not-ci
 *       every declared dependency tree has its lockfile, lockfileVersion and
 *       an integrity hash on every non-link package; every install command in
 *       the universe is `npm ci`-style, never `npm install`.
 *   workflow-universe / build-universe / surface-undeclared
 *       the universe is a declared list, and the filesystem must equal it in
 *       both directions: a new workflow or build file is itself a failure, not
 *       an unguarded corner.
 *   runner-undeclared / system-package-undeclared / pages build path
 *       every runner label, apt package and Jekyll-plugin path is declared.
 *
 * ── WHY AN ENUMERATED UNIVERSE, NOT A GLOB ───────────────────────────────
 *
 * A glob answers "which files exist?" and silently absorbs a new one. Here
 * the registry names every workflow and build file; the guard lists the real
 * directory and refuses any file the registry does not name. An escaped
 * workflow is therefore a red test, which is the only property that makes the
 * rest of the scan a guarantee rather than a best effort.
 *
 * ── THE PLANTS ────────────────────────────────────────────────────────────
 *
 * The tests at the bottom drive the same audit over an overlay of the real
 * tree and plant each defect the guard names: a tag-pinned action, a
 * digest-less image, a floating `latest`, a drifted Node range, an undeclared
 * workflow, an undeclared action, a missing lockfile, and a non-ci install.
 * Each must produce its own rule; a guard that cannot see its plant is not a
 * guard. The live-tree arm asserts the unmodified population is clean.
 *
 * ── LIVENESS ──────────────────────────────────────────────────────────────
 *
 * The audit asserts a non-empty workflow universe, a non-empty action
 * population and non-empty dependency trees before judging them, so a broken
 * walk or an emptied registry refuses instead of certifying zero.
 *
 * ── EXTENSION POINT (OWNED ELSEWHERE) ─────────────────────────────────────
 *
 * The measurement-contract registry another agent is building
 * (`tests/prevention/*measurement*`, `engine/src/shared/*contract*`) owns the
 * assertion that a build/third-party number is DYNAMIC, RESILIENT,
 * LOAD-AGNOSTIC and SINGLE-OWNER. This file does not import or edit those
 * files, and it never edits `engine/src/shared/run-cpu.ts` or
 * `engine/src/shared/budget-verdict.ts`. When that registry lands, merge its
 * absolute-number findings with the list in
 * `docs/floor/external-surface-audit.md`; do not grow a second measurement
 * registry here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

// The site builder is plain Node ESM with no declaration file; the test reads the values it exports.
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { BUILDER_OWNED_CONFIG_KEYS } from "../../scripts/floor/site-pages.mjs";
import { networkInstalls } from "../helpers/network-install.ts";

const ROOT = process.cwd();
const REGISTRY_PATH = "tests/prevention/external-surface-registry.json";
const REGISTRY_SCHEMA = "bridlewise-external-surface-registry/v1";

type Finding = Readonly<{ rule: string; detail: string }>;

type Surface = Readonly<{
  id: string;
  kind: string;
  pinned: Readonly<Record<string, unknown>>;
  usedIn: readonly string[];
  drift: string;
  role?: string;
  publiclyVerifiable?: boolean;
}>;

type KnownException = Readonly<{ surface: string; reason: string; owner: string }>;

type Registry = Readonly<{
  schemaVersion: string;
  universe: Readonly<{ workflows: readonly string[]; build: readonly string[] }>;
  surfaces: readonly Surface[];
  knownExceptions: readonly KnownException[];
}>;

type Tree = Readonly<{
  has(path: string): boolean;
  read(path: string): string;
  list(dir: string): readonly string[];
  tracked(): readonly string[];
}>;

function diskTree(): Tree {
  const absolute = (path: string): string => resolve(ROOT, path);
  return {
    has(path) {
      try {
        return statSync(absolute(path)).isFile();
      } catch {
        return false;
      }
    },
    read(path) {
      return readFileSync(absolute(path), "utf8");
    },
    list(dir) {
      try {
        return readdirSync(absolute(dir)).sort();
      } catch {
        return [];
      }
    },
    tracked() {
      const output = execFileSync("git", ["ls-files", "-z"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output.split("\0").filter(Boolean).sort();
    },
  };
}

/**
 * The real tree with a handful of paths replaced (a string) or deleted (null).
 * `list` is derived from the overlay too, so a planted workflow file is
 * visible to the universe discovery, not only to a reader that already knows
 * its name.
 */
function overlayTree(base: Tree, edits: ReadonlyMap<string, string | null>): Tree {
  const normalised = new Map([...edits].map(([path, text]) => [path.split("\\").join("/"), text]));
  return {
    has(path) {
      const text = normalised.get(path);
      if (text === undefined) return base.has(path);
      return text !== null;
    },
    read(path) {
      const text = normalised.get(path);
      if (text === undefined) return base.read(path);
      if (text === null) throw new Error(`overlay deletes ${path}`);
      return text;
    },
    list(dir) {
      const names = new Set(base.list(dir));
      for (const [path, text] of normalised) {
        if (dirname(path) !== dir) continue;
        const name = path.slice(dir === "." ? 0 : dir.length + 1);
        if (name.includes("/")) continue;
        if (text === null) names.delete(name);
        else names.add(name);
      }
      return [...names].sort();
    },
    tracked() {
      return base.tracked();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry): entry is string => typeof entry === "string")) return null;
  return value;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineOf(text: string, needle: string): number {
  const index = text.indexOf(needle);
  if (index < 0) return 0;
  return text.slice(0, index).split("\n").length;
}

const HEX40 = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+(?:\.\d+){0,2}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LATEST_PATTERNS: readonly RegExp[] = [
  /:latest\b/i,
  /@latest\b/i,
  /\b(?:tag|version|ref)\s*:\s*["']?latest["']?\b/i,
  /"\s*:\s*"latest"/i,
];
const FLOATING_INSTALL = /\b(?:npm|yarn|pnpm)\s+(?:--prefix\s+\S+\s+)?(?:install|i|add|update|install-test|it)\b/;
const NODE_RANGE_TOKEN = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return null;
  return [major, minor, patch];
}

function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** A deliberately small npm-range reader: the comparators this tree uses.
 *  An unsupported spelling returns null and is a refusal, never a skip. */
function satisfies(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (parsed === null) return null;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    const match = NODE_RANGE_TOKEN.exec(token);
    if (match === null) return null;
    const bound = parseVersion(match[2] ?? "");
    if (bound === null) return null;
    const comparison = compareVersions(parsed, bound);
    const operator = match[1] ?? "=";
    const ok =
      (operator === ">=" && comparison >= 0) ||
      (operator === "<=" && comparison <= 0) ||
      (operator === ">" && comparison > 0) ||
      (operator === "<" && comparison < 0) ||
      (operator === "=" && comparison === 0);
    if (!ok) return false;
  }
  return true;
}

function scanUses(text: string): readonly { line: number; ref: string; comment: string }[] {
  const uses: { line: number; ref: string; comment: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match =
      /^\s*-\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*?))?\s*$/.exec(line) ??
      /^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.*?))?\s*$/.exec(line);
    if (match === null) continue;
    const ref = match[1];
    if (ref === undefined) continue;
    uses.push({ line: index + 1, ref, comment: (match[2] ?? "").trim() });
  }
  return uses;
}

function readJson(tree: Tree, path: string, findings: Finding[], subject: string): unknown | null {
  if (!tree.has(path)) {
    findings.push({ rule: "file-missing", detail: `${subject}: ${path} is missing` });
    return null;
  }
  try {
    return JSON.parse(tree.read(path)) as unknown;
  } catch (error) {
    findings.push({ rule: "registry-schema", detail: `${subject}: ${path} is not valid JSON: ${failureText(error)}` });
    return null;
  }
}

function hasFinding(findings: readonly Finding[], rule: string, subject: string): boolean {
  return findings.some((finding) => finding.rule === rule && finding.detail.includes(subject));
}

function audit(tree: Tree): Finding[] {
  const findings: Finding[] = [];
  const raw = readJson(tree, REGISTRY_PATH, findings, "external-surface registry");
  if (raw === null) return findings;

  // ── the registry itself ────────────────────────────────────────────────
  if (!isRecord(raw)) {
    findings.push({ rule: "registry-schema", detail: "the external-surface registry must be an object" });
    return findings;
  }
  if (raw["schemaVersion"] !== REGISTRY_SCHEMA) {
    findings.push({
      rule: "registry-schema",
      detail: `schemaVersion must be ${REGISTRY_SCHEMA}, got ${JSON.stringify(raw["schemaVersion"])}`,
    });
  }
  const universeRaw = raw["universe"];
  const workflows = isRecord(universeRaw) ? stringArray(universeRaw["workflows"]) : null;
  const build = isRecord(universeRaw) ? stringArray(universeRaw["build"]) : null;
  if (workflows === null || workflows.length === 0) {
    findings.push({ rule: "workflow-universe", detail: "the registry must declare a non-empty workflow universe" });
    return findings;
  }
  if (build === null || build.length === 0) {
    findings.push({ rule: "build-universe", detail: "the registry must declare a non-empty build universe" });
    return findings;
  }
  if (new Set(workflows).size !== workflows.length) {
    findings.push({ rule: "registry-schema", detail: "the workflow universe repeats a path" });
  }
  if (new Set(build).size !== build.length) {
    findings.push({ rule: "registry-schema", detail: "the build universe repeats a path" });
  }

  const surfaceRaw = raw["surfaces"];
  const surfaces: Surface[] = [];
  if (!Array.isArray(surfaceRaw) || surfaceRaw.length === 0) {
    findings.push({ rule: "registry-schema", detail: "the registry must declare a non-empty surfaces array" });
    return findings;
  }
  const knownKinds = new Set([
    "github-action",
    "local-workflow",
    "runner",
    "node-runtime",
    "package-manager",
    "dependency-tree",
    "container-image",
    "build-path",
    "system-package",
    "private-service",
  ]);
  for (const [index, entry] of surfaceRaw.entries()) {
    if (!isRecord(entry)) {
      findings.push({ rule: "registry-schema", detail: `surface ${index} is not an object` });
      continue;
    }
    const id = entry["id"];
    const kind = entry["kind"];
    const pinned = entry["pinned"];
    const usedIn = stringArray(entry["usedIn"]);
    const drift = entry["drift"];
    if (typeof id !== "string" || id.length === 0) {
      findings.push({ rule: "registry-schema", detail: `surface ${index} has no id` });
      continue;
    }
    if (typeof kind !== "string" || !knownKinds.has(kind)) {
      findings.push({ rule: "registry-schema", detail: `${id} has unknown kind ${JSON.stringify(kind)}` });
      continue;
    }
    if (!isRecord(pinned)) {
      findings.push({ rule: "registry-schema", detail: `${id} has no pinned object` });
      continue;
    }
    if (usedIn === null) {
      findings.push({ rule: "registry-schema", detail: `${id} has no usedIn string array` });
      continue;
    }
    if (typeof drift !== "string" || drift.trim().length < 20) {
      findings.push({ rule: "registry-schema", detail: `${id} has no drift-detection statement` });
    }
    if (kind !== "private-service" && usedIn.length === 0) {
      findings.push({ rule: "registry-schema", detail: `${id} does not say where it is used` });
    }
    const role = entry["role"];
    const publiclyVerifiable = entry["publiclyVerifiable"];
    surfaces.push({
      id,
      kind,
      pinned,
      usedIn,
      drift: typeof drift === "string" ? drift : "",
      ...(typeof role === "string" ? { role } : {}),
      ...(typeof publiclyVerifiable === "boolean" ? { publiclyVerifiable } : {}),
    });
  }
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (ids.has(surface.id)) findings.push({ rule: "registry-schema", detail: `duplicate surface id ${surface.id}` });
    ids.add(surface.id);
  }

  const exceptionRaw = raw["knownExceptions"];
  const exceptions: KnownException[] = [];
  if (!Array.isArray(exceptionRaw) || exceptionRaw.length === 0) {
    findings.push({ rule: "registry-schema", detail: "knownExceptions must be a declared array (an empty one hides drift)" });
  } else {
    for (const entry of exceptionRaw) {
      if (!isRecord(entry) || typeof entry["surface"] !== "string" || typeof entry["reason"] !== "string" || typeof entry["owner"] !== "string") {
        findings.push({ rule: "registry-schema", detail: "a knownException is missing surface, reason or owner" });
        continue;
      }
      if (entry["reason"].trim().length < 40) {
        findings.push({ rule: "registry-schema", detail: `knownException ${entry["surface"]} has no substantive reason` });
      }
      exceptions.push({ surface: entry["surface"], reason: entry["reason"], owner: entry["owner"] });
    }
  }

  const registry: Registry = {
    schemaVersion: REGISTRY_SCHEMA,
    universe: { workflows, build },
    surfaces,
    knownExceptions: exceptions,
  };
  const ofKind = (kind: string): readonly Surface[] => registry.surfaces.filter((surface) => surface.kind === kind);
  const one = (kind: string): Surface | null => {
    const matches = ofKind(kind);
    if (matches.length !== 1) {
      findings.push({ rule: "registry-schema", detail: `expected exactly one ${kind} surface, found ${matches.length}` });
      return null;
    }
    return matches[0] ?? null;
  };
  const usedInExists = (surface: Surface): void => {
    for (const path of surface.usedIn) {
      if (!tree.has(path)) {
        findings.push({ rule: "registry-usedin-missing", detail: `${surface.id} declares usedIn ${path}, which does not exist` });
      }
    }
  };
  const compareUsedIn = (surface: Surface, actual: ReadonlySet<string>, rule: string): void => {
    const declared = new Set(surface.usedIn);
    for (const path of actual) {
      if (!declared.has(path)) findings.push({ rule, detail: `${surface.id} is used in ${path}, which the registry does not list` });
    }
    for (const path of declared) {
      if (!actual.has(path)) findings.push({ rule, detail: `${surface.id} lists ${path}, which does not use it` });
    }
  };
  for (const surface of registry.surfaces) usedInExists(surface);

  // ── workflow universe ─────────────────────────────────────────────────
  const actualWorkflows = tree
    .list(".github/workflows")
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
  for (const path of actualWorkflows) {
    if (!workflows.includes(path)) {
      findings.push({
        rule: "workflow-universe",
        detail: `${path} is a workflow outside the enumerated universe; a new workflow file escaped the guard`,
      });
    }
  }
  for (const path of workflows) {
    if (!tree.has(path)) findings.push({ rule: "workflow-universe", detail: `declared workflow ${path} is missing` });
  }
  if (actualWorkflows.length === 0) {
    findings.push({ rule: "workflow-universe", detail: "the workflow directory walk returned nothing" });
  }

  // ── build universe ────────────────────────────────────────────────────
  for (const path of build) {
    if (!tree.has(path)) findings.push({ rule: "build-universe", detail: `declared build file ${path} is missing` });
  }
  const declaredDevcontainer = new Set(
    build.filter((path) => path.startsWith(".devcontainer/")).map((path) => path.slice(".devcontainer/".length)),
  );
  for (const name of tree.list(".devcontainer")) {
    // The folder's README documents it (the README census requires one,
    // since the folder ships) and is no build input; every other file is.
    if (name === "README.md") continue;
    if (!declaredDevcontainer.has(name)) {
      findings.push({ rule: "build-universe", detail: `.devcontainer/${name} is a build file outside the enumerated universe` });
    }
  }
  for (const name of tree.list(".")) {
    if (!/^(?:Dockerfile[A-Za-z0-9._-]{0,64}|docker-compose[A-Za-z0-9._-]{0,64}\.ya?ml|Makefile)$/.test(name)) continue;
    if (!build.includes(name)) findings.push({ rule: "build-universe", detail: `${name} is a build file outside the enumerated universe` });
  }

  const universeTexts: { path: string; text: string }[] = [];
  for (const path of [...workflows, ...build]) {
    if (!tree.has(path)) continue;
    const text = tree.read(path);
    universeTexts.push({ path, text });
  }
  if (universeTexts.length === 0) {
    findings.push({ rule: "build-universe", detail: "the build/workflow text population is empty" });
  }

  let trackedFiles: readonly string[] = [];
  try {
    trackedFiles = tree.tracked();
  } catch (error) {
    findings.push({
      rule: "surface-undeclared",
      detail: `the git index is unreadable; the tracked file population cannot be enumerated: ${failureText(error)}`,
    });
  }
  for (const path of trackedFiles) {
    if (/(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|devcontainer\.json)$/.test(path) && !build.includes(path)) {
      findings.push({ rule: "build-universe", detail: `${path} is a tracked build file outside the enumerated universe` });
    }
  }

  // ── GitHub Actions and local reusable workflows ───────────────────────
  const actions = ofKind("github-action");
  if (actions.length === 0) findings.push({ rule: "action-undeclared", detail: "the registry declares no GitHub Action" });
  const actionsById = new Map(actions.map((surface) => [surface.id, surface]));
  const actualActionFiles = new Map<string, Set<string>>();
  const actualLocalFiles = new Map<string, Set<string>>();
  for (const path of workflows) {
    if (!tree.has(path)) continue;
    const text = tree.read(path);
    for (const use of scanUses(text)) {
      if (use.ref.startsWith("./")) {
        const target = use.ref.slice(2);
        if (!workflowUniverseIncludes(workflows, target) || !tree.has(target)) {
          findings.push({
            rule: "local-workflow-undeclared",
            detail: `${path}:${use.line} calls ${use.ref}, which is not a workflow in the enumerated universe`,
          });
        }
        const declared = registry.surfaces.find((surface) => surface.kind === "local-workflow" && surface.id === use.ref);
        if (declared === undefined) {
          findings.push({ rule: "local-workflow-undeclared", detail: `${path}:${use.line} calls undeclared local workflow ${use.ref}` });
        } else {
          if (declared.pinned["path"] !== target) {
            findings.push({ rule: "local-workflow-undeclared", detail: `${use.ref} declares a different target than ${target}` });
          }
          const set = actualLocalFiles.get(use.ref) ?? new Set<string>();
          set.add(path);
          actualLocalFiles.set(use.ref, set);
        }
        continue;
      }
      const at = use.ref.lastIndexOf("@");
      const id = at > 0 ? use.ref.slice(0, at) : use.ref;
      const revision = at > 0 ? use.ref.slice(at + 1) : "";
      if (!HEX40.test(revision)) {
        findings.push({
          rule: "action-pin",
          detail: `${path}:${use.line} ${use.ref} is not pinned to a full 40-hex commit SHA`,
        });
      }
      if (!VERSION_COMMENT.test(use.comment)) {
        findings.push({
          rule: "action-version-comment",
          detail: `${path}:${use.line} ${use.ref} has no version comment (got ${JSON.stringify(use.comment)})`,
        });
      }
      const declared = actionsById.get(id);
      if (declared === undefined) {
        findings.push({ rule: "action-undeclared", detail: `${path}:${use.line} uses ${id}, which the registry does not declare` });
        continue;
      }
      if (declared.pinned["commit"] !== revision) {
        findings.push({
          rule: "action-pin-mismatch",
          detail: `${id} is used at ${revision}, but the registry pins ${String(declared.pinned["commit"])}`,
        });
      }
      if (declared.pinned["version"] !== use.comment) {
        findings.push({
          rule: "action-version-mismatch",
          detail: `${id} carries version comment ${JSON.stringify(use.comment)}, but the registry declares ${JSON.stringify(declared.pinned["version"])}`,
        });
      }
      const set = actualActionFiles.get(id) ?? new Set<string>();
      set.add(path);
      actualActionFiles.set(id, set);
    }
  }
  for (const action of actions) {
    if (typeof action.pinned["commit"] !== "string" || typeof action.pinned["version"] !== "string") {
      findings.push({ rule: "registry-schema", detail: `${action.id} needs commit and version pins` });
    }
    compareUsedIn(action, actualActionFiles.get(action.id) ?? new Set<string>(), "action-usedin-mismatch");
  }
  for (const local of ofKind("local-workflow")) {
    compareUsedIn(local, actualLocalFiles.get(local.id) ?? new Set<string>(), "local-workflow-usedin-mismatch");
  }

  // ── one CodeQL release across every entry ─────────────────────────────
  // The three entries are ONE release, and the registry's own drift texts
  // say so. Each entry is checked against its workflow independently, so a
  // half-upgraded tree (init at v4.39.0, upload-sarif still v4.38.0) used to
  // pass: every `uses:` matched its own entry, and the two jobs silently ran
  // different CodeQL versions. The release is a property of the SET.
  const codeql = actions.filter((surface) => surface.id.startsWith("github/codeql-action/"));
  const releases = new Map<string, string[]>();
  for (const surface of codeql) {
    const key = `${String(surface.pinned["commit"])}@${String(surface.pinned["version"])}`;
    releases.set(key, [...(releases.get(key) ?? []), surface.id]);
  }
  if (codeql.length !== 3) {
    findings.push({ rule: "codeql-release-mixed", detail: `expected the three CodeQL actions (init, analyze, upload-sarif), found ${codeql.length}` });
  }
  if (releases.size > 1) {
    findings.push({
      rule: "codeql-release-mixed",
      detail: `CodeQL actions declare ${releases.size} releases: ${[...releases].map(([release, ids]) => `${release} (${ids.join(", ")})`).join("; ")}`,
    });
  }

  // ── images ────────────────────────────────────────────────────────────
  const images = ofKind("container-image");
  const actualImageFiles = new Map<string, Set<string>>();
  const noteImageUse = (surface: Surface, file: string): void => {
    const set = actualImageFiles.get(surface.id) ?? new Set<string>();
    set.add(file);
    actualImageFiles.set(surface.id, set);
  };
  const checkImage = (file: string, line: number, reference: string): void => {
    const cleaned = reference.trim().replace(/^["']|["']$/g, "");
    const withoutAlias = cleaned.split(/\s+AS\s+/i)[0] ?? cleaned;
    const value = withoutAlias.split(/\s+/).find((token) => !token.startsWith("--")) ?? withoutAlias;
    if (value.includes("${{")) {
      findings.push({ rule: "image-digest", detail: `${file}:${line} image reference is computed at run time: ${value}` });
      return;
    }
    const at = value.lastIndexOf("@");
    const digest = at >= 0 ? value.slice(at + 1) : "";
    if (!DIGEST.test(digest)) {
      findings.push({ rule: "image-digest", detail: `${file}:${line} ${value} has no @sha256:<64> digest` });
      return;
    }
    const base = value.slice(0, at);
    const declared = images.find((surface) => surface.pinned["reference"] === base);
    if (declared === undefined) {
      findings.push({ rule: "image-undeclared", detail: `${file}:${line} uses image ${base}, which the registry does not declare` });
      return;
    }
    if (declared.pinned["digest"] !== digest) {
      findings.push({
        rule: "image-digest-mismatch",
        detail: `${base} is used with ${digest}, but the registry pins ${String(declared.pinned["digest"])}`,
      });
    }
    noteImageUse(declared, file);
  };

  for (const path of build) {
    if (!tree.has(path)) continue;
    const text = tree.read(path);
    if (path === "Dockerfile" || path.endsWith("/Dockerfile")) {
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^\s*FROM\s+(.+?)\s*$/.exec(lines[index] ?? "");
        if (match?.[1] !== undefined) checkImage(path, index + 1, match[1]);
      }
    }
    if (path.endsWith("devcontainer.json")) {
      const parsed = readJson(tree, path, findings, "devcontainer");
      if (isRecord(parsed)) {
        const features = parsed["features"];
        if (isRecord(features)) {
          for (const key of Object.keys(features)) checkImage(path, lineOf(text, key), key);
        }
        const image = parsed["image"];
        if (typeof image === "string") checkImage(path, lineOf(text, image), image);
      }
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*(?:image|container):\s*(\S+)\s*$/.exec(lines[index] ?? "");
      if (match?.[1] !== undefined && !path.endsWith("devcontainer.json")) checkImage(path, index + 1, match[1]);
    }
  }
  // Workflow-level containers are images too. The scan used to walk `build`
  // only, so a job's `container: image:` was outside the checked population
  // entirely: no digest requirement, no declaration, no usedIn accounting.
  for (const path of workflows) {
    if (!tree.has(path)) continue;
    const lines = tree.read(path).split(/\r?\n/);
    let containerIndent: number | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (containerIndent !== null && line.trim().length > 0 && indent <= containerIndent) containerIndent = null;
      const inline = /^(\s*)container:\s*(\S+)\s*$/.exec(line);
      if (inline?.[2] !== undefined && inline[2] !== "{}") {
        checkImage(path, index + 1, inline[2]);
        continue;
      }
      const block = /^(\s*)container:\s*$/.exec(line);
      if (block !== null) {
        containerIndent = block[1]?.length ?? 0;
        continue;
      }
      const image = /^(\s+)image:\s*(\S+)\s*$/.exec(line);
      if (image?.[2] !== undefined && containerIndent !== null && (image[1]?.length ?? 0) > containerIndent) {
        checkImage(path, index + 1, image[2]);
      }
    }
  }
  if (images.length === 0) findings.push({ rule: "image-undeclared", detail: "the registry declares no container image" });
  for (const image of images) {
    if (typeof image.pinned["reference"] !== "string" || typeof image.pinned["digest"] !== "string") {
      findings.push({ rule: "registry-schema", detail: `${image.id} needs reference and digest pins` });
    }
    compareUsedIn(image, actualImageFiles.get(image.id) ?? new Set<string>(), "image-usedin-mismatch");
  }

  // ── floating latest ──────────────────────────────────────────────────
  for (const { path, text } of universeTexts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (LATEST_PATTERNS.some((pattern) => pattern.test(line))) {
        findings.push({ rule: "floating-latest", detail: `${path}:${index + 1} carries a floating latest reference: ${line.trim()}` });
      }
    }
  }

  // ── Node runtime, floor manifests and verification trees ─────────────
  const node = one("node-runtime");
  if (node !== null) {
    const exact = node.pinned["exact"];
    const floorRange = node.pinned["floorRange"];
    const verificationRange = node.pinned["verificationRange"];
    const floorManifests = stringArray(node.pinned["floorManifests"]);
    const verificationManifests = stringArray(node.pinned["verificationManifests"]);
    const pinFiles = stringArray(node.pinned["pinFiles"]);
    if (
      typeof exact !== "string" ||
      typeof floorRange !== "string" ||
      typeof verificationRange !== "string" ||
      floorManifests === null ||
      verificationManifests === null ||
      pinFiles === null
    ) {
      findings.push({ rule: "registry-schema", detail: "the node-runtime surface is incomplete" });
    } else {
      if (satisfies(exact, floorRange) !== true) {
        findings.push({ rule: "node-range", detail: `pinned Node ${exact} does not satisfy the floor range ${floorRange}` });
      }
      for (const path of pinFiles) {
        if (!tree.has(path)) {
          findings.push({ rule: "node-range", detail: `Node pin file ${path} is missing` });
        } else if (tree.read(path).trim() !== exact) {
          findings.push({ rule: "node-range", detail: `${path} is ${JSON.stringify(tree.read(path).trim())}, not ${exact}` });
        }
      }
      const readEngine = (path: string): string | null => {
        const parsed = readJson(tree, path, findings, "package manifest");
        if (!isRecord(parsed)) return null;
        const engines = parsed["engines"];
        if (!isRecord(engines) || typeof engines["node"] !== "string") {
          findings.push({ rule: "node-range", detail: `${path} has no engines.node` });
          return null;
        }
        return engines["node"];
      };
      for (const path of floorManifests) {
        const engine = readEngine(path);
        if (engine !== null && engine !== floorRange) {
          findings.push({ rule: "node-range", detail: `${path} declares ${JSON.stringify(engine)}, but the floor range is ${JSON.stringify(floorRange)}` });
        }
      }
      for (const path of verificationManifests) {
        const engine = readEngine(path);
        if (engine === null) continue;
        if (engine !== verificationRange) {
          findings.push({ rule: "node-range", detail: `${path} declares ${JSON.stringify(engine)}, but the declared verification pin is ${JSON.stringify(verificationRange)}` });
        }
        if (satisfies(engine, floorRange) !== true) {
          findings.push({ rule: "node-range", detail: `${path} declares ${JSON.stringify(engine)}, which is outside the floor range ${JSON.stringify(floorRange)}` });
        }
      }
      // ONE pin, read from .nvmrc. The exact version used to be a literal in
      // eight workflow sites, so a Node move touched nine files and a missed
      // site was caught only by comparing each literal — the copies were the
      // drift. Every setup-node call now names the pin FILE and a workflow
      // that spells an exact `node-version:` is refused.
      const pinFile = ".nvmrc";
      if (!pinFiles.includes(pinFile)) {
        findings.push({ rule: "node-range", detail: `the node-runtime surface must list ${pinFile} in pinFiles` });
      }
      for (const path of workflows) {
        if (!tree.has(path)) continue;
        const text = tree.read(path);
        const lines = text.split(/\r?\n/);
        let pinFileRefs = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const literal = /^\s*node-version:\s*(\S+)\s*$/.exec(lines[index] ?? "");
          if (literal?.[1] !== undefined) {
            findings.push({
              rule: "node-range",
              detail: `${path}:${index + 1} spells node-version ${JSON.stringify(literal[1].replace(/^["']|["']$/g, ""))}; the pin lives in ${pinFile}, so say node-version-file: ${pinFile}`,
            });
          }
          const ref = /^\s*node-version-file:\s*(\S+)\s*$/.exec(lines[index] ?? "");
          if (ref?.[1] !== undefined) {
            const value = ref[1].replace(/^["']|["']$/g, "");
            if (value !== pinFile) {
              findings.push({ rule: "node-range", detail: `${path}:${index + 1} reads Node from ${value}, not ${pinFile}` });
            } else {
              pinFileRefs += 1;
            }
          }
        }
        if (/uses:\s*actions\/setup-node@/u.test(text) && pinFileRefs === 0) {
          findings.push({ rule: "node-range", detail: `${path} sets up Node but does not read ${pinFile}` });
        }
      }

      const actualNodeFiles = new Set<string>([...pinFiles, ...floorManifests]);
      for (const path of workflows) {
        if (!tree.has(path)) continue;
        if (/^\s*node-version-file:\s*\.nvmrc\s*$/m.test(tree.read(path))) actualNodeFiles.add(path);
      }
      compareUsedIn(node, actualNodeFiles, "node-usedin-mismatch");

      const tracked = trackedFiles;
      const declaredManifests = new Set([...floorManifests, ...verificationManifests]);
      for (const path of tracked.filter((entry) => entry === "package.json" || entry.endsWith("/package.json"))) {
        if (declaredManifests.has(path)) continue;
        if (!tree.has(path)) continue;
        const parsed = readJson(tree, path, findings, "package manifest");
        if (!isRecord(parsed)) continue;
        const engines = parsed["engines"];
        if (isRecord(engines) && typeof engines["node"] === "string") {
          findings.push({
            rule: "node-manifest-undeclared",
            detail: `${path} declares engines.node ${JSON.stringify(engines["node"])}, but the registry does not declare this manifest`,
          });
        }
      }
    }
  }

  // ── npm itself ───────────────────────────────────────────────────────
  const npm = one("package-manager");
  if (npm !== null) {
    const name = npm.pinned["name"];
    const version = npm.pinned["version"];
    const parsed = readJson(tree, "package.json", findings, "package manifest");
    if (typeof name !== "string" || typeof version !== "string") {
      findings.push({ rule: "registry-schema", detail: "the package-manager surface needs name and version" });
    } else if (isRecord(parsed) && parsed["packageManager"] !== `${name}@${version}`) {
      findings.push({
        rule: "package-manager",
        detail: `package.json declares packageManager ${JSON.stringify(parsed["packageManager"])}, not ${name}@${version}`,
      });
    }
    compareUsedIn(npm, new Set(["package.json"]), "package-manager-usedin-mismatch");
  }

  // ── dependency trees, lockfiles and install integrity ────────────────
  const trees = ofKind("dependency-tree");
  if (trees.length === 0) findings.push({ rule: "lockfile-missing", detail: "the registry declares no dependency tree" });
  const declaredLockfiles = new Set<string>();
  for (const surface of trees) {
    const manifest = surface.pinned["manifest"];
    const lockfile = surface.pinned["lockfile"];
    const lockfileVersion = surface.pinned["lockfileVersion"];
    const install = surface.pinned["install"];
    if (typeof manifest !== "string" || typeof lockfile !== "string" || typeof lockfileVersion !== "number" || typeof install !== "string") {
      findings.push({ rule: "registry-schema", detail: `${surface.id} is missing manifest, lockfile, lockfileVersion or install` });
      continue;
    }
    declaredLockfiles.add(lockfile);
    if (!tree.has(manifest)) findings.push({ rule: "lockfile-missing", detail: `${surface.id}: manifest ${manifest} is missing` });
    if (!tree.has(lockfile)) {
      findings.push({ rule: "lockfile-missing", detail: `${surface.id}: lockfile ${lockfile} is missing` });
      continue;
    }
    if (surface.role === "floor") {
      if (!/\bnpm(?:\s+--prefix\s+\S+)?\s+ci\b/.test(install)) {
        findings.push({ rule: "install-not-ci", detail: `${surface.id} declares install ${JSON.stringify(install)}, not npm ci` });
      }
    } else if (surface.role !== "verification" && surface.role !== "frozen-record") {
      findings.push({ rule: "registry-schema", detail: `${surface.id} has no dependency-tree role` });
    }
    const parsed = readJson(tree, lockfile, findings, "lockfile");
    if (!isRecord(parsed)) continue;
    if (parsed["lockfileVersion"] !== lockfileVersion) {
      findings.push({
        rule: "lockfile-version",
        detail: `${lockfile} carries lockfileVersion ${String(parsed["lockfileVersion"])}, but ${surface.id} declares ${String(lockfileVersion)}`,
      });
    }
    const packages = parsed["packages"];
    if (!isRecord(packages)) {
      findings.push({ rule: "lockfile-integrity", detail: `${lockfile} has no packages object; its dependency tree cannot be verified` });
      continue;
    }
    const entries = Object.entries(packages);
    if (entries.length === 0) {
      findings.push({ rule: "lockfile-integrity", detail: `${lockfile} has an empty packages object` });
    }
    let missingIntegrity = 0;
    for (const [key, metadata] of entries) {
      if (key === "" || !isRecord(metadata) || metadata["link"] === true) continue;
      const integrity = metadata["integrity"];
      if (typeof integrity !== "string" || !/^sha(?:1|256|512)-[A-Za-z0-9+/=]+$/.test(integrity)) {
        missingIntegrity += 1;
        if (missingIntegrity <= 5) {
          findings.push({ rule: "lockfile-integrity", detail: `${lockfile}: package ${key} has no integrity hash (installed without ci-style integrity)` });
        }
      }
    }
    const rootEntry = packages[""];
    if (isRecord(rootEntry)) {
      // package lock records the root name; compare when the manifest parses.
      const manifestParsed = tree.has(manifest) ? readJson(tree, manifest, findings, "package manifest") : null;
      if (isRecord(manifestParsed) && typeof rootEntry["name"] === "string" && typeof manifestParsed["name"] === "string" && rootEntry["name"] !== manifestParsed["name"]) {
        findings.push({
          rule: "lockfile-manifest-mismatch",
          detail: `${lockfile} names ${rootEntry["name"]}, but ${manifest} names ${manifestParsed["name"]}`,
        });
      }
    }
  }
  let trackedLockfiles: readonly string[] = [];
  trackedLockfiles = trackedFiles;
  for (const path of trackedLockfiles.filter((entry) => entry.endsWith("package-lock.json"))) {
    if (!declaredLockfiles.has(path)) {
      findings.push({ rule: "surface-undeclared", detail: `${path} is a dependency tree the registry does not declare` });
    }
  }
  for (const { path, text } of universeTexts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (FLOATING_INSTALL.test(line)) {
        findings.push({ rule: "install-not-ci", detail: `${path}:${index + 1} installs dependencies without npm ci: ${line.trim()}` });
      }
    }
  }

  // ── runner class ────────────────────────────────────────────────────
  const runners = ofKind("runner");
  const runnerLabels = new Set<string>();
  for (const runner of runners) {
    const label = runner.pinned["label"];
    if (typeof label !== "string") {
      findings.push({ rule: "registry-schema", detail: `${runner.id} needs a label` });
    } else {
      runnerLabels.add(label);
    }
  }
  if (runnerLabels.size === 0) findings.push({ rule: "runner-undeclared", detail: "the registry declares no runner label" });
  const actualRunnerFiles = new Map<string, Set<string>>();
  for (const { path, text } of universeTexts) {
    if (!path.startsWith(".github/workflows/")) continue;
    for (const match of text.matchAll(/(?:^|\s)((?:ubuntu|windows|macos)-[A-Za-z0-9._-]+)\b/g)) {
      const label = match[1];
      if (label === undefined) continue;
      if (!runnerLabels.has(label)) {
        findings.push({ rule: "runner-undeclared", detail: `${path} names runner label ${label}, which the registry does not declare` });
      } else {
        const set = actualRunnerFiles.get(label) ?? new Set<string>();
        set.add(path);
        actualRunnerFiles.set(label, set);
      }
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^\s*runs-on:\s*(.+?)\s*$/.exec(lines[index] ?? "");
      if (match?.[1] === undefined) continue;
      const value = match[1];
      if (value.includes("${{")) continue;
      for (const label of value.replace(/[\[\]"']/g, "").split(/\s*,\s*/).filter(Boolean)) {
        if (!runnerLabels.has(label)) {
          findings.push({ rule: "runner-undeclared", detail: `${path}:${index + 1} runs on ${label}, which the registry does not declare` });
        }
      }
    }
  }
  for (const runner of runners) {
    const label = runner.pinned["label"];
    if (typeof label === "string") compareUsedIn(runner, actualRunnerFiles.get(label) ?? new Set<string>(), "runner-usedin-mismatch");
  }

  // ── Pages/Jekyll build path ──────────────────────────────────────────
  // Both files are READ AS YAML (the repository's one YAML reader): a comment
  // inside a list, a repeated key, a flow mapping and a flow list are the same
  // document to Jekyll and to GitHub, so they are to this guard. A file that
  // does not parse is itself a finding: what the guard cannot read, it cannot
  // certify.
  const buildPath = one("build-path");
  if (buildPath !== null) {
    const workflow = buildPath.pinned["workflow"];
    const builder = buildPath.pinned["builder"];
    const config = buildPath.pinned["config"];
    const plugins = buildPath.pinned["plugins"];
    if (typeof workflow !== "string" || typeof builder !== "string" || typeof config !== "string" || !Array.isArray(plugins)) {
      findings.push({ rule: "registry-schema", detail: "the build-path surface needs workflow, builder, config and plugins" });
    } else {
      for (const [what, path] of [["Pages workflow", workflow], ["site builder", builder], ["site config", config]] as const) {
        if (!tree.has(path)) findings.push({ rule: "pages-build-path", detail: `${what} ${path} is missing` });
      }
      const parsed = (path: string): Document | null => {
        const document = parseDocument(tree.read(path), { uniqueKeys: true, prettyErrors: false });
        const errors = [...document.errors, ...document.warnings];
        for (const error of errors) findings.push({ rule: "pages-build-path", detail: `${path} is unreadable YAML: ${error.message.split("\n")[0] ?? ""}` });
        if (errors.length === 0 && !isMap(document.contents)) findings.push({ rule: "pages-build-path", detail: `${path} is not a mapping` });
        return errors.length === 0 && isMap(document.contents) ? document : null;
      };
      if (tree.has(workflow)) {
        const document = parsed(workflow);
        const steps: Record<string, unknown>[] = [];
        const jobs = document?.toJS() as { jobs?: Record<string, { steps?: unknown }> } | undefined;
        for (const job of Object.values(jobs?.jobs ?? {})) {
          if (Array.isArray(job?.steps)) for (const step of job.steps) if (isRecord(step)) steps.push(step);
        }
        const jekyll = steps.filter((step) => typeof step["uses"] === "string" && step["uses"].startsWith("actions/jekyll-build-pages@"));
        if (document !== null && jekyll.length === 0) {
          findings.push({ rule: "pages-build-path", detail: `${workflow} no longer builds through actions/jekyll-build-pages` });
        }
        for (const step of jekyll) {
          const withBlock = step["with"];
          if (!isRecord(withBlock) || withBlock["build_revision"] !== "${{ github.sha }}") {
            findings.push({ rule: "pages-build-path", detail: `${workflow} no longer hands the built commit to Jekyll as build_revision` });
          }
        }
        for (const step of steps) {
          const withBlock = step["with"];
          if (isRecord(withBlock) && "repository" in withBlock) {
            findings.push({ rule: "pages-build-path", detail: `${workflow} checks out another repository (${String(withBlock["repository"])}); the site's only source is this tree's docs/` });
          }
          const run = step["run"];
          if (typeof run === "string" && /\b(?:git\s+(?:clone|fetch|pull|remote\s+add)|gh\s+repo\s+clone)\b/u.test(run)) {
            findings.push({ rule: "pages-build-path", detail: `${workflow} fetches another tree in a run step; the site's only source is this tree's docs/` });
          }
        }
      }
      if (tree.has(config)) {
        const document = parsed(config);
        if (document !== null) {
          const node = document.get("plugins", true);
          const loaded = isSeq(node) ? node.items.map((item) => (isScalar(item) ? String(item.value) : JSON.stringify(item))) : node === undefined ? [] : [JSON.stringify(document.toJS().plugins)];
          if (JSON.stringify(loaded) !== JSON.stringify(plugins)) {
            findings.push({ rule: "pages-build-path", detail: `${config} loads the plugins [${loaded.join(", ")}], the declaration pins [${plugins.join(", ")}]` });
          }
          for (const key of ["gems", "theme", "remote_theme", "whitelist"]) {
            if (document.has(key)) findings.push({ rule: "pages-build-path", detail: `${config} adds a Jekyll ${key}; that surface has no declared pin` });
          }
        }
      }
      // The builder writes only the keys it owns (its config writer refuses any
      // other), so it cannot add a plugin, gem or theme behind the config's back.
      for (const key of ["plugins", "gems", "theme", "remote_theme", "whitelist"]) {
        if ((BUILDER_OWNED_CONFIG_KEYS as readonly string[]).includes(key)) findings.push({ rule: "pages-build-path", detail: `the site builder owns the Jekyll key ${key}; that surface has no declared pin` });
      }
      const actualBuildPathFiles = new Set<string>();
      for (const path of [workflow, config, builder, "scripts/floor/site.mjs"]) {
        if (tree.has(path)) actualBuildPathFiles.add(path);
      }
      compareUsedIn(buildPath, actualBuildPathFiles, "pages-build-path-usedin-mismatch");
    }
  }

  // ── apt packages ─────────────────────────────────────────────────────
  // The declaration carries the whole install command, flags included. The
  // guard used to read only the package tokens, so a line that added
  // `--no-install-recommends` or dropped `-y` still "matched" a declaration
  // whose `install` string said something else. Normalise both sides to the
  // same command text and compare them as text.
  const normalizeInstall = (command: string): string =>
    command.replace(/\\\s*$/u, "").trim().replace(/\s+/gu, " ").replace(/^sudo\s+/u, "");
  const declaredPackages = new Set<string>();
  const declaredInstalls = new Map<string, string>();
  // A package the runner image ships is PROBED (`pinned.probe`), never
  // installed: a network install only ever waited on a mirror (#333). Its
  // call sites are the files that carry the probe, and an apt line that
  // installs it anyway is refused as drift from its declaration.
  const declaredProbes = new Map<string, string>();
  for (const surface of ofKind("system-package")) {
    const name = surface.pinned["package"];
    const install = surface.pinned["install"];
    const probe = surface.pinned["probe"];
    if (typeof name === "string") {
      declaredPackages.add(name);
      if (typeof install === "string" && install.trim().length > 0) declaredInstalls.set(name, normalizeInstall(install));
      else if (typeof probe === "string" && probe.trim().length > 0) declaredProbes.set(name, probe.trim());
      else findings.push({ rule: "registry-schema", detail: `${surface.id} needs the install command or the probe it declares` });
    } else findings.push({ rule: "registry-schema", detail: `${surface.id} needs a package name` });
  }
  const actualPackageFiles = new Map<string, Set<string>>();
  for (const { path, text } of universeTexts) {
    for (const install of networkInstalls(text).filter((entry) => entry.subcommand === "install" || entry.subcommand === "add")) {
      const at = lineOf(text, install.manager);
      for (const token of install.packages) {
        if (!declaredPackages.has(token)) {
          findings.push({
            rule: "system-package-undeclared",
            detail: `${path}:${at} installs ${token}, which the registry does not declare`,
          });
        } else {
          const actualInstall = normalizeInstall(install.command);
          const declared = declaredInstalls.get(token);
          if (declaredProbes.has(token)) {
            findings.push({
              rule: "system-package-install-drift",
              detail: `${path}:${at} installs ${token} from the network, but ${token} is declared probed from the runner image (${declaredProbes.get(token)!})`,
            });
          } else if (declared !== undefined && declared !== actualInstall) {
            findings.push({
              rule: "system-package-install-drift",
              detail: `${path}:${at} installs with ${JSON.stringify(actualInstall)}, but ${token} declares ${JSON.stringify(declared)}`,
            });
          }
          const set = actualPackageFiles.get(token) ?? new Set<string>();
          set.add(path);
          actualPackageFiles.set(token, set);
        }
      }
    }
  }
  for (const [name, probe] of declaredProbes) {
    for (const { path, text } of universeTexts) {
      if (!text.includes(probe)) continue;
      const set = actualPackageFiles.get(name) ?? new Set<string>();
      set.add(path);
      actualPackageFiles.set(name, set);
    }
  }
  for (const surface of ofKind("system-package")) {
    const name = surface.pinned["package"];
    if (typeof name === "string") compareUsedIn(surface, actualPackageFiles.get(name) ?? new Set<string>(), "system-package-usedin-mismatch");
  }

  // ── private services and named exceptions ────────────────────────────
  const privateSurfaces = ofKind("private-service");
  if (privateSurfaces.length !== 2) {
    findings.push({ rule: "private-surface", detail: `expected the two private services (Gitea, act_runner), found ${privateSurfaces.length}` });
  }
  for (const surface of privateSurfaces) {
    if (surface.publiclyVerifiable !== false) {
      findings.push({ rule: "private-surface", detail: `${surface.id} must be marked publiclyVerifiable: false` });
    }
    if (surface.usedIn.length !== 0) {
      findings.push({ rule: "private-surface", detail: `${surface.id} must not name a public call site` });
    }
    const keys = Object.keys(surface.pinned);
    if (keys.length !== 1 || keys[0] !== "statement") {
      findings.push({
        rule: "private-surface",
        detail: `${surface.id} may record only a pinned-and-verified statement, never a version, hostname or token (found ${keys.join(", ")})`,
      });
    }
    const statement = surface.pinned["statement"];
    if (typeof statement !== "string" || !/pinned and verified/i.test(statement)) {
      findings.push({ rule: "private-surface", detail: `${surface.id} does not state that it is pinned and verified` });
    }
    if (typeof statement === "string" && /:\/\//.test(statement)) {
      findings.push({ rule: "private-surface", detail: `${surface.id} contains a URL; private endpoints do not belong in this public registry` });
    }
  }
  const exemptableKinds = new Set(["system-package"]);
  for (const exception of exceptions) {
    const surface = registry.surfaces.find((entry) => entry.id === exception.surface);
    if (surface === undefined) {
      findings.push({ rule: "registry-schema", detail: `knownException names undeclared surface ${exception.surface}` });
      continue;
    }
    if (!exemptableKinds.has(surface.kind)) {
      findings.push({ rule: "registry-schema", detail: `${exception.surface} is not a surface whose pin is allowed to be an exception` });
    }
    if (!tree.has(exception.owner) && !workflows.includes(exception.owner)) {
      findings.push({ rule: "registry-schema", detail: `knownException ${exception.surface} names missing owner ${exception.owner}` });
    }
  }

  return findings;
}

function workflowUniverseIncludes(workflows: readonly string[], path: string): boolean {
  return workflows.includes(path);
}

const LIVE = diskTree();
const LIVE_REGISTRY = JSON.parse(readFileSync(join(ROOT, REGISTRY_PATH), "utf8")) as Registry;

function format(findings: readonly Finding[]): string {
  return findings.map((finding) => `${finding.rule}: ${finding.detail}`).join("\n") || "(no findings)";
}

function planted(edits: Record<string, string | null>): Finding[] {
  return audit(overlayTree(LIVE, new Map(Object.entries(edits))));
}

function expectRule(findings: readonly Finding[], rule: string, subject: string): void {
  expect(findings.length, "a plant must produce at least one finding").toBeGreaterThan(0);
  expect(findings.some((finding) => finding.rule === rule), `expected ${rule}; got:\n${format(findings)}`).toBe(true);
  expect(
    findings.some((finding) => finding.rule === rule && finding.detail.includes(subject)),
    `expected ${rule} to name ${subject}; got:\n${format(findings)}`,
  ).toBe(true);
}

describe("external surfaces — the live tree is declared and pinned", () => {
  test("the registry is the enumerated universe and every outside thing is declared", () => {
    const findings = audit(LIVE);
    expect(findings, `undeclared or drifting external surface:\n${format(findings)}`).toEqual([]);
  });

  test("liveness: the registry actually declares the populations it judges", () => {
    expect(LIVE_REGISTRY.surfaces.length).toBeGreaterThan(20);
    expect(LIVE_REGISTRY.universe.workflows.length).toBeGreaterThan(5);
    expect(LIVE_REGISTRY.surfaces.filter((surface) => surface.kind === "github-action").length).toBeGreaterThan(5);
    expect(LIVE_REGISTRY.surfaces.filter((surface) => surface.kind === "dependency-tree").length).toBeGreaterThanOrEqual(2);
    expect(LIVE_REGISTRY.surfaces.filter((surface) => surface.kind === "container-image").length).toBeGreaterThanOrEqual(2);
  });
});

describe("external surfaces — plants fail for the defect they name", () => {
  test("a tag-pinned action is refused", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    const changed = original.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
      "actions/checkout@v7 # v7",
    );
    expect(changed).not.toBe(original);
    expectRule(planted({ ".github/workflows/ci.yml": changed }), "action-pin", "actions/checkout@v7");
  });

  test("a digest-less image is refused", () => {
    const original = LIVE.read(".devcontainer/Dockerfile");
    const changed = original.replace(/@sha256:[0-9a-f]{64}/, "");
    expect(changed).not.toBe(original);
    expectRule(planted({ ".devcontainer/Dockerfile": changed }), "image-digest", "mcr.microsoft.com/devcontainers/typescript-node");
  });

  test("a floating latest is refused", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    const changed = `${original}\n      - name: Drifted pull\n        run: docker pull ghcr.io/example/tool:latest\n`;
    expectRule(planted({ ".github/workflows/ci.yml": changed }), "floating-latest", "ci.yml");
  });

  test("a drifted Node range is refused", () => {
    const manifest = JSON.parse(LIVE.read("engine/package.json")) as Record<string, unknown>;
    const engines = manifest["engines"];
    if (!isRecord(engines)) throw new Error("engine/package.json lost its engines object");
    const changed = JSON.stringify({ ...manifest, engines: { ...engines, node: ">=20.0.0 <25.0.0" } }, null, 2) + "\n";
    expectRule(planted({ "engine/package.json": changed }), "node-range", "engine/package.json");
  });

  test("an undeclared devcontainer file is refused; the folder's README is documentation, not a build input", () => {
    expectRule(planted({ ".devcontainer/compose.override.yml": "services: {}\n" }), "build-universe", ".devcontainer/compose.override.yml");
    expectRule(planted({ ".devcontainer/README.txt": "a near-miss of the README name\n" }), "build-universe", ".devcontainer/README.txt");
    expect(planted({ ".devcontainer/README.md": "# .devcontainer\n\nRewritten documentation.\n" }).filter((finding) => finding.rule === "build-universe")).toEqual([]);
  });

  test("an undeclared workflow file is refused", () => {
    const rogue = "name: Rogue\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs: {}\n";
    const findings = planted({ ".github/workflows/rogue.yml": rogue });
    expectRule(findings, "workflow-universe", ".github/workflows/rogue.yml");
  });

  test("an undeclared action is refused even when it is SHA-pinned", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    const changed = `${original}\n      - name: Undeclared action\n        uses: example/undeclared-action@${"a".repeat(40)} # v1\n`;
    expectRule(planted({ ".github/workflows/ci.yml": changed }), "action-undeclared", "example/undeclared-action");
  });

  test("a missing lockfile is refused", () => {
    expectRule(planted({ "package-lock.json": null }), "lockfile-missing", "package-lock.json");
  });

  test("a non-ci install is refused", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    const changed = original.replace("npm ci --no-audit --no-fund", "npm install --no-audit --no-fund");
    expect(changed).not.toBe(original);
    expectRule(planted({ ".github/workflows/ci.yml": changed }), "install-not-ci", "ci.yml");
  });

  test("a workflow-level container image is checked like any other image", () => {
    // The image population used to be walked from the build files only, so a
    // job's `container:` block was outside the guard entirely.
    const original = LIVE.read(".github/workflows/ci.yml");
    const digestless = `${original}\n  containerised:\n    runs-on: ubuntu-24.04\n    container:\n      image: ghcr.io/example/tool:1.0\n`;
    expectRule(planted({ ".github/workflows/ci.yml": digestless }), "image-digest", "ghcr.io/example/tool:1.0");
    const undeclared = `${original}\n  containerised:\n    runs-on: ubuntu-24.04\n    container:\n      image: ghcr.io/example/tool@sha256:${"a".repeat(64)}\n`;
    expectRule(planted({ ".github/workflows/ci.yml": undeclared }), "image-undeclared", "ghcr.io/example/tool");
  });

  test("a workflow that spells the Node pin instead of reading .nvmrc is refused", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    const changed = original.replace("node-version-file: .nvmrc", "node-version: 24.20.0");
    expect(changed).not.toBe(original);
    expectRule(planted({ ".github/workflows/ci.yml": changed }), "node-range", "spells node-version");
  });

  test("a network install of the probed compiler is refused, and so is a lost probe", () => {
    const original = LIVE.read(".github/workflows/ci.yml");
    for (const install of [
      "sudo apt-get install -y gcc-14",
      // Options before the subcommand, a continued line, a prefixed environment (review of #335).
      "sudo apt-get -o Acquire::Retries=3 install -y gcc-14",
      "sudo apt-get \\\n            install -y gcc-14",
      "env DEBIAN_FRONTEND=noninteractive apt-get install -y gcc-14",
      // A package manager named through a variable (review of #335).
      "sudo $PM install -y gcc-14",
      "timeout 60 ${PM:-apt-get} install -y gcc-14",
      "bash -c \"$PM install -y gcc-14\"",
      "eval \"apt-get install -y gcc-14\"",
    ]) {
      const installed = original.replace("command -v gcc-14 >/dev/null ||", `${install} && command -v gcc-14 >/dev/null ||`);
      expect(installed).not.toBe(original);
      expectRule(planted({ ".github/workflows/ci.yml": installed }), "system-package-install-drift", "gcc-14");
    }
    const unprobed = original.replaceAll("command -v gcc-14", "which gcc-14");
    expect(unprobed).not.toBe(original);
    expectRule(planted({ ".github/workflows/ci.yml": unprobed }), "system-package-usedin-mismatch", "gcc-14");
  });

  test("a half-upgraded CodeQL release is refused", () => {
    const registry = JSON.parse(LIVE.read(REGISTRY_PATH)) as Record<string, unknown>;
    const surfaces = registry["surfaces"];
    if (!Array.isArray(surfaces)) throw new Error("the registry lost its surfaces");
    const changed = JSON.stringify({
      ...registry,
      surfaces: surfaces.map((surface) => {
        if (!isRecord(surface) || surface["id"] !== "github/codeql-action/upload-sarif") return surface;
        return { ...surface, pinned: { ...(isRecord(surface["pinned"]) ? surface["pinned"] : {}), commit: "b".repeat(40), version: "v4.38.0" } };
      }),
    }, null, 2) + "\n";
    expectRule(planted({ [REGISTRY_PATH]: changed }), "codeql-release-mixed", "upload-sarif");
  });

  test("a dependency without a lockfile integrity hash is refused", () => {
    const lock = JSON.parse(LIVE.read("package-lock.json")) as Record<string, unknown>;
    const packages = lock["packages"];
    if (!isRecord(packages)) throw new Error("package-lock.json lost its packages object");
    const victim = Object.keys(packages).find((key) => key !== "" && isRecord(packages[key]) && packages[key]["link"] !== true);
    if (victim === undefined) throw new Error("package-lock.json has no package to mutate");
    const entry = packages[victim];
    if (!isRecord(entry)) throw new Error("package-lock.json entry is not an object");
    const changed = JSON.stringify({ ...lock, packages: { ...packages, [victim]: { ...entry, integrity: undefined } } }, null, 2) + "\n";
    expectRule(planted({ "package-lock.json": changed }), "lockfile-integrity", victim);
  });

  test("the site build path: an undeclared plugin, a theme, another repository's checkout and a lost build revision are refused", () => {
    const config = LIVE.read("docs/_config.yml");
    const declared = "plugins:\n  - jekyll-sitemap\n";
    expect(config).toContain(declared);
    const withConfig = (text: string): Finding[] => planted({ "docs/_config.yml": text }).filter((finding) => finding.rule === "pages-build-path");
    expectRule(planted({ "docs/_config.yml": config.replace(declared, `${declared}  - jekyll-redirect-from\n`) }), "pages-build-path", "jekyll-redirect-from");
    // The review's bypasses: a comment inside the list, a second plugins key, and a flow list.
    expectRule(planted({ "docs/_config.yml": config.replace(declared, `${declared}  # extra\n  - jekyll-redirect-from\n`) }), "pages-build-path", "jekyll-redirect-from");
    expectRule(planted({ "docs/_config.yml": `${config}plugins:\n  - jekyll-redirect-from\n` }), "pages-build-path", "docs/_config.yml is unreadable YAML");
    expectRule(planted({ "docs/_config.yml": config.replace(declared, "plugins: [jekyll-sitemap, jekyll-redirect-from]\n") }), "pages-build-path", "jekyll-redirect-from");
    expectRule(planted({ "docs/_config.yml": `${config}remote_theme: someone/theme\n` }), "pages-build-path", "adds a Jekyll remote_theme");
    expectRule(planted({ "docs/_config.yml": `${config}whitelist: [jekyll-feed]\n` }), "pages-build-path", "adds a Jekyll whitelist");

    const workflow = LIVE.read(".github/workflows/pages.yml");
    const checkout = "        with:\n          persist-credentials: false\n";
    expect(workflow).toContain(checkout);
    expectRule(planted({ ".github/workflows/pages.yml": workflow.replace(checkout, "        with:\n          repository: LLM-4-People/elsewhere\n          persist-credentials: false\n") }), "pages-build-path", "checks out another repository");
    expectRule(planted({ ".github/workflows/pages.yml": workflow.replace(checkout, "        with: { repository: LLM-4-People/elsewhere, persist-credentials: false }\n") }), "pages-build-path", "checks out another repository");
    const build = "      - name: Build the site source\n";
    expect(workflow).toContain(build);
    expectRule(planted({ ".github/workflows/pages.yml": workflow.replace(build, "      - name: Fetch\n        run: git clone https://github.com/LLM-4-People/elsewhere product\n\n" + build) }), "pages-build-path", "fetches another tree");
    const revision = workflow.replace("build_revision: ${{ github.sha }}", "build_revision: main");
    expect(revision).not.toBe(workflow);
    expectRule(planted({ ".github/workflows/pages.yml": revision }), "pages-build-path", "build_revision");
    expectRule(planted({ ".github/workflows/pages.yml": workflow.replace("uses: actions/jekyll-build-pages@", "uses: someone/jekyll-build-pages@") }), "pages-build-path", "no longer builds through actions/jekyll-build-pages");

    // Near misses: the declared list with extra spacing, a comment naming a
    // plugin outside the list, and a flow list of exactly the declaration.
    expect(withConfig(config.replace(declared, "plugins:\n  -   jekyll-sitemap\n"))).toEqual([]);
    expect(withConfig(`${config}# plugins like jekyll-redirect-from are not loaded\n`)).toEqual([]);
    expect(withConfig(config.replace(declared, "plugins: [jekyll-sitemap]\n"))).toEqual([]);
  });
});
