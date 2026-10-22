import { posix } from "node:path";
import { spawnSync } from "node:child_process";

import {
  ARCHITECTURE_MANIFEST,
  type ArchitectureEffect,
  type ArchitectureExternalCommand,
} from "../../../src/architecture-manifest.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../../src/shared/source-extensions.ts";
import { deepFreeze } from "../../../src/kernel/integrity.ts";
import { externalCommandSourceFinding } from "../../../src/kernel/architecture-external-commands.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import type { CommandEffectContract } from
  "../../../verification/benchmarks/shared/command-effect-contract.mjs";
import { analyzeArchitectureSource, type ArchitectureSourceFacts } from "../../verification/architecture.ts";
import { dependencyEffects, isSupportedJavaScriptSourcePath } from "../../verification/effect-surface.ts";

export type CommandEffectSource = Readonly<{
  executable?: boolean | "unavailable";
  fileKind?: "nonregular" | "regular" | "symlink" | "unknown";
  path: string;
  source: string;
}>;
export type CommandEffectRegistration = Readonly<{
  contract?: CommandEffectContract;
  disposition: "blocked-unqualified" | "qualified-contract";
  path: string;
}>;
export type CommandEffectInventoryInput = Readonly<{
  architectureCompositionRoots: readonly string[];
  architectureExternalCommands?: readonly ArchitectureExternalCommand[];
  packageEntrypoints?: readonly string[];
  /**
   * Repository-relative paths a preserved rejected fixture's projection
   * binds (`preservedFixtureProjectionPaths`). They are hash-pinned DATA —
   * the archive's searchable replacement content — never commands the
   * harness runs, so the census records them as `excluded-preserved-fixture`
   * instead of demanding a command registration. Derived by the caller from
   * the fixture authority, so a newly retained fixture's projection is
   * excluded the day it lands.
   */
  preservedFixturePaths?: readonly string[];
  registrations: readonly CommandEffectRegistration[];
  sources: readonly CommandEffectSource[];
}>;
export type CommandEffectInventoryEntry = Readonly<{
  closure: readonly string[];
  disposition: "blocked-unqualified" | "missing-registration" | "qualified-contract";
  effects: readonly ArchitectureEffect[];
  importSafe: boolean;
  language: "javascript" | "python" | "shell" | "unknown";
  path: string;
}>;
export type CommandEffectSourceDisposition = Readonly<{
  disposition:
    | "analyzed-command-candidate"
    | "analyzed-dependency"
    | "excluded-generated-binary"
    | "excluded-nonregular"
    | "excluded-preserved-fixture"
    | "excluded-vendor";
  path: string;
}>;
export type CommandEffectInventory = Readonly<{
  entries: readonly CommandEffectInventoryEntry[];
  ok: boolean;
  scannedSourceCount: number;
  sourceDispositions: readonly CommandEffectSourceDisposition[];
  violations: readonly string[];
}>;

type PythonImport = Readonly<{ level: number; module: string; names: readonly string[] }>;
type PythonSourceFacts = Readonly<{
  arbitraryOutput: boolean;
  dependencies: readonly PythonImport[];
  directEffects: readonly ArchitectureEffect[];
  mainGuard: boolean;
  topLevelExecution: boolean;
  temporaryEffects: boolean;
  unmodeledEffects: readonly string[];
}>;
type SourceFacts = Readonly<{
  dependencies: readonly string[];
  directEffects: readonly ArchitectureEffect[];
  importSafe: boolean;
  language: "javascript" | "python" | "shell" | "unknown";
  path: string;
  sourceDispositionExecutable: boolean;
  unmodeledEffects: readonly string[];
}>;

const PYTHON_EFFECT_ANALYZER = String.raw`
import ast, json, sys

MAX_NODES = int(sys.argv[1])
source = sys.stdin.read()
tree = ast.parse(source, mode="exec")
nodes = list(ast.walk(tree))
if len(nodes) > MAX_NODES:
    raise ValueError("python_ast_node_limit")

imports = []
aliases = {}
effects = set()
unmodeled = set()
arbitrary_output = False
temporary_effects = False
main_guard = False
top_level_execution = False
top_level_calls = []

class TopLevelCallVisitor(ast.NodeVisitor):
    def visit_FunctionDef(self, node):
        pass
    def visit_AsyncFunctionDef(self, node):
        pass
    def visit_Lambda(self, node):
        pass
    def visit_ClassDef(self, node):
        pass
    def visit_Call(self, node):
        top_level_calls.append(node)
        self.generic_visit(node)

for statement in tree.body:
    if isinstance(statement, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        continue
    TopLevelCallVisitor().visit(statement)

READ_NAMES = {"access", "listdir", "lstat", "readlink", "scandir", "stat", "walk"}
WRITE_NAMES = {"chmod", "chown", "link", "makedirs", "mkdir", "remove", "removedirs", "rename", "replace", "rmdir", "symlink", "truncate", "unlink", "utime"}
PATH_READ_NAMES = {"exists", "glob", "is_dir", "is_file", "iterdir", "lstat", "read_bytes", "read_text", "resolve", "stat"}
PATH_WRITE_NAMES = {"chmod", "hardlink_to", "mkdir", "rename", "replace", "rmdir", "symlink_to", "touch", "unlink", "write_bytes", "write_text"}
TEMP_NAMES = {"mkdtemp", "mkstemp", "NamedTemporaryFile", "SpooledTemporaryFile", "TemporaryDirectory", "TemporaryFile"}
PROCESS_NAMES = {"call", "check_call", "check_output", "Popen", "run"}

def dotted(node):
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        owner = dotted(node.value)
        return None if owner is None else owner + "." + node.attr
    return None

def literal_string(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

def path_is_default(node):
    value = literal_string(node)
    name = dotted(node) if isinstance(node, (ast.Name, ast.Attribute)) else None
    if value in (".", "./") or name in ("cwd", "getcwd"):
        return True
    if isinstance(node, ast.Call):
        callee = dotted(node.func)
        if callee in ("os.getcwd", "pathlib.Path.cwd", "Path.cwd"):
            return True
        if callee in ("pathlib.Path", "Path") and node.args:
            return literal_string(node.args[0]) in (".", "./")
    return False

def mode_effects(node):
    if node is None:
        return {"filesystem-read"}
    mode = literal_string(node)
    if mode is None:
        unmodeled.add("python-open-mode-unmodeled")
        return {"filesystem-read", "filesystem-write"}
    write = any(token in mode for token in ("a", "w", "x", "+"))
    read = "r" in mode or "+" in mode
    return ({"filesystem-read"} if read or not write else set()) | ({"filesystem-write"} if write else set())

for node in nodes:
    if isinstance(node, ast.Import):
        for item in node.names:
            imports.append({"level": 0, "module": item.name, "names": []})
            aliases[item.asname or item.name.split(".")[0]] = item.name
    elif isinstance(node, ast.ImportFrom):
        names = [item.name for item in node.names]
        imports.append({"level": node.level, "module": node.module or "", "names": names})
        for item in node.names:
            full = ((node.module + ".") if node.module else "") + item.name
            aliases[item.asname or item.name] = full
    elif isinstance(node, ast.If):
        test = node.test
        if isinstance(test, ast.Compare) and len(test.ops) == 1 and isinstance(test.ops[0], ast.Eq):
            left = dotted(test.left)
            right = literal_string(test.comparators[0]) if len(test.comparators) == 1 else None
            if (left, right) in (("__name__", "__main__"),):
                main_guard = True
    elif isinstance(node, ast.Call):
        name = dotted(node.func)
        if name is None and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Call):
            receiver_callee = dotted(node.func.value.func)
            if receiver_callee in ("pathlib.Path", "Path"):
                name = receiver_callee + ".<instance>." + node.func.attr
        if name is None:
            unmodeled.add("python-dynamic-callee")
            continue
        short = name.rsplit(".", 1)[-1]
        if name in ("eval", "exec", "getattr", "globals", "locals", "__import__"):
            unmodeled.add("python-dynamic-execution")
        if name in ("print", "sys.stdout.write", "sys.stderr.write"):
            effects.add("process-status")
            arbitrary_output = True
        if name in ("sys.exit", "os._exit"):
            effects.add("process-status")
        if name in ("open", "io.open"):
            effects.update(mode_effects(node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)))
            if node.args and path_is_default(node.args[0]):
                unmodeled.add("python-default-repository-effect")
        if short == "open" and name not in ("open", "io.open"):
            effects.update(mode_effects(node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == "mode"), None)))
        if short in READ_NAMES or short in PATH_READ_NAMES:
            effects.add("filesystem-read")
        if short in WRITE_NAMES or short in PATH_WRITE_NAMES:
            effects.add("filesystem-write")
            if isinstance(node.func, ast.Attribute) and path_is_default(node.func.value):
                unmodeled.add("python-default-repository-effect")
        if name.startswith("shutil."):
            effects.update(("filesystem-read", "filesystem-write"))
        if short in TEMP_NAMES and (name.startswith("tempfile.") or name == short):
            effects.add("filesystem-write")
            temporary_effects = True
        if short in PROCESS_NAMES and (name.startswith("subprocess.") or name == short):
            effects.add("child-process")
            executable = node.args[0] if node.args else None
            executable_value = literal_string(executable) if executable is not None else None
            if isinstance(executable, (ast.List, ast.Tuple)) and executable.elts:
                executable_value = literal_string(executable.elts[0])
            if executable_value is None:
                effects.add("git")
                unmodeled.add("python-process-executable-unmodeled")
            elif executable_value == "git" or executable_value.endswith("/git"):
                effects.add("git")
        if name in ("os.system", "os.popen"):
            effects.add("child-process")
            command = literal_string(node.args[0]) if node.args else None
            if command is None:
                effects.add("git")
                unmodeled.add("python-shell-command-unmodeled")
            elif "git" in command.split():
                effects.add("git")

for item in imports:
    root = item["module"].split(".", 1)[0]
    if root in ("hashlib", "hmac", "secrets"):
        effects.add("cryptography")
    if root in ("http", "socket", "urllib", "requests", "aiohttp"):
        effects.add("network")

for node in top_level_calls:
    name = dotted(node.func)
    if name is None:
        continue
    short = name.rsplit(".", 1)[-1]
    if (name in ("print", "sys.stdout.write", "sys.stderr.write", "sys.exit", "os._exit", "open", "io.open", "os.system", "os.popen")
        or short in READ_NAMES or short in WRITE_NAMES or short in PATH_READ_NAMES or short in PATH_WRITE_NAMES
        or short in TEMP_NAMES or short in PROCESS_NAMES or name.startswith("shutil.")
        or name in ("sqlite3.connect",)):
        top_level_execution = True
        break

print(json.dumps({
    "arbitraryOutput": arbitrary_output,
    "dependencies": imports,
    "directEffects": sorted(effects),
    "mainGuard": main_guard,
    "topLevelExecution": top_level_execution,
    "temporaryEffects": temporary_effects,
    "unmodeledEffects": sorted(unmodeled),
}, separators=(",", ":"), sort_keys=True))
`;

export function verifyCommandEffectInventory(input: CommandEffectInventoryInput): CommandEffectInventory {
  const violations: string[] = [];
  const sourceByPath = uniqueSources(input.sources, violations);
  const registrations = uniqueRegistrations(input.registrations, violations);
  const externalCommands = uniqueExternalCommands(input.architectureExternalCommands ?? [], violations);
  const architectureRoots = new Set([
    ...input.architectureCompositionRoots,
    ...externalCommands.keys(),
    ROOT_POLICY.filesystemInfrastructure.privateState.directoryWorker.sourcePath,
  ]);
  const packageEntrypoints = new Set(input.packageEntrypoints ?? []);
  const factsByPath = new Map<string, SourceFacts>();
  const sourceDispositions: CommandEffectSourceDisposition[] = [];
  const preservedFixturePaths = new Set(input.preservedFixturePaths ?? []);
  for (const source of input.sources) {
    if (preservedFixturePaths.has(source.path)) {
      sourceDispositions.push({ path: source.path, disposition: "excluded-preserved-fixture" });
      continue;
    }
    const excluded = excludedSourceDisposition(source);
    if (excluded !== undefined) {
      sourceDispositions.push({ path: source.path, disposition: excluded });
      continue;
    }
    const facts = analyzeSource(source, sourceByPath, violations);
    if (facts) {
      factsByPath.set(source.path, facts);
      sourceDispositions.push({
        path: source.path,
        disposition: facts.sourceDispositionExecutable ? "analyzed-command-candidate" : "analyzed-dependency",
      });
    }
  }
  for (const command of externalCommands.values()) {
    // The one publication rule: a declared absence is still refused by name.
    const finding = externalCommandSourceFinding(command, sourceByPath.get(command.path));
    if (finding.kind !== "current") violations.push(finding.violation);
  }

  const discovered = [...factsByPath.values()].filter((facts) =>
    facts.sourceDispositionExecutable || packageEntrypoints.has(facts.path) || registrations.has(facts.path) ||
      architectureRoots.has(facts.path)
  ).map((facts) => facts.path).toSorted();
  const entries: CommandEffectInventoryEntry[] = [];
  const commandIds = new Set<string>();
  for (const path of discovered) {
    const closure = commandClosure(path, factsByPath, violations);
    const effects = new Set<ArchitectureEffect>();
    let unmodeled = false;
    for (const closurePath of closure) {
      const facts = factsByPath.get(closurePath);
      if (!facts) continue;
      for (const effect of facts.directEffects) effects.add(effect);
      if (facts.unmodeledEffects.length > 0) {
        unmodeled = true;
        for (const reason of facts.unmodeledEffects) {
          violations.push(`command-effect-unmodeled:${path}:${closurePath}:${reason}`);
        }
      }
    }
    if (effects.size === 0 && !unmodeled) continue;
    const registration = registrations.get(path);
    const architectureRegistered = architectureRoots.has(path);
    const disposition = registration?.disposition ??
      (architectureRegistered ? "blocked-unqualified" : "missing-registration");
    const facts = factsByPath.get(path)!;
    if (!registration && !architectureRegistered) violations.push(`command-effect-registration-missing:${path}`);
    if (!architectureRegistered) violations.push(`command-effect-composition-root-missing:${path}`);
    const externalCommand = externalCommands.get(path);
    if (externalCommand !== undefined && !sameEffects([...effects], externalCommand.effects)) {
      violations.push(`command-effect-external-effects-drift:${path}`);
    }
    if (externalCommand !== undefined && registration?.disposition === "qualified-contract") {
      violations.push(`command-effect-external-qualified-forbidden:${path}`);
    }
    if (registration?.disposition === "qualified-contract") {
      if (!registration.contract) {
        violations.push(`command-effect-contract-missing:${path}`);
      } else {
        if (commandIds.has(registration.contract.commandId)) {
          violations.push(`command-effect-contract-id-duplicate:${registration.contract.commandId}`);
        }
        commandIds.add(registration.contract.commandId);
        const declaredEffects = new Set<string>(registration.contract.modes.flatMap((mode) => mode.effects));
        const missing = [...effects].filter((effect) => !declaredEffects.has(effect)).toSorted();
        if (missing.length > 0) violations.push(`command-effect-contract-incomplete:${path}:${missing.join(",")}`);
        if (!facts.importSafe) violations.push(`command-effect-import-guard-missing:${path}`);
      }
    } else if (registration?.contract !== undefined) {
      violations.push(`command-effect-blocked-registration-has-contract:${path}`);
    }
    entries.push(deepFreeze({
      closure,
      disposition,
      effects: [...effects].toSorted(),
      importSafe: facts.importSafe,
      language: facts.language,
      path,
    }));
  }
  for (const path of registrations.keys()) {
    if (!factsByPath.has(path)) violations.push(`command-effect-registration-source-missing:${path}`);
  }
  return deepFreeze({
    entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)),
    ok: violations.length === 0,
    scannedSourceCount: sourceByPath.size,
    sourceDispositions: sourceDispositions.toSorted((left, right) => left.path.localeCompare(right.path)),
    violations: [...new Set(violations)].toSorted(),
  });
}

function sameEffects(left: readonly ArchitectureEffect[], right: readonly ArchitectureEffect[]): boolean {
  const normalizedLeft = [...new Set(left)].toSorted();
  const normalizedRight = [...new Set(right)].toSorted();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((effect, index) => effect === normalizedRight[index]);
}

function analyzeSource(
  source: CommandEffectSource,
  sourceByPath: ReadonlyMap<string, string>,
  violations: string[],
): SourceFacts | undefined {
  if (Buffer.byteLength(source.source, "utf8") > ARCHITECTURE_MANIFEST.analysisLimits.maximumSourceBytes) {
    violations.push(`command-effect-source-size:${source.path}`);
    return undefined;
  }
  const shebang = source.source.startsWith("#!") ? source.source.slice(0, source.source.indexOf("\n") < 0
    ? source.source.length : source.source.indexOf("\n")) : "";
  if (isSupportedJavaScriptSourcePath(source.path)) {
    let facts: ArchitectureSourceFacts;
    try {
      facts = analyzeArchitectureSource(source.path, source.source);
    } catch {
      violations.push(`command-effect-parse:${source.path}`);
      return undefined;
    }
    const effects = new Set<ArchitectureEffect>();
    for (const dependency of facts.dependencies) {
      for (const effect of dependencyEffects(dependency)) effects.add(effect);
    }
    for (const fact of facts.directEffectFacts) {
      for (const effect of fact.effects) effects.add(effect);
    }
    if (facts.nodeCount > ARCHITECTURE_MANIFEST.analysisLimits.maximumAstNodes) {
      violations.push(`command-effect-node-limit:${source.path}`);
    }
    return deepFreeze({
      dependencies: facts.dependencies.flatMap((dependency) =>
        resolveJavaScriptDependency(source.path, dependency, sourceByPath, violations)
      ),
      directEffects: [...effects].toSorted(),
      importSafe: facts.directExecutionEntrypoint,
      language: "javascript",
      path: source.path,
      sourceDispositionExecutable: source.executable === true || source.source.startsWith("#!") ||
        facts.directExecutionEntrypoint ||
        (facts.exportedNames.length === 0 && facts.topLevelExecution),
      unmodeledEffects: facts.unmodeledEffects,
    });
  }
  if (source.path.endsWith(".py") || /(?:^|[/ ])python(?:3(?:\.[0-9]+)?)?(?:\s|$)/u.test(shebang)) {
    const facts = analyzePythonSource(source, violations);
    if (!facts) return undefined;
    return deepFreeze({
      dependencies: resolvePythonDependencies(source.path, facts.dependencies, sourceByPath, violations),
      directEffects: facts.directEffects,
      importSafe: facts.mainGuard,
      language: "python",
      path: source.path,
      sourceDispositionExecutable: source.executable === true || source.source.startsWith("#!") ||
        facts.mainGuard || facts.topLevelExecution,
      unmodeledEffects: facts.unmodeledEffects,
    });
  }
  if (ROOT_POLICY.verification.commandEffectInventory.shellExtensions.some((extension) =>
    source.path.endsWith(extension)
  ) || /(?:^|[/ ])(?:ba|da|k|z)?sh(?:\s|$)/u.test(shebang)) {
    return analyzeShellSource(source);
  }
  if (source.executable === true || source.executable === "unavailable" || shebang.length > 0) {
    return deepFreeze({
      dependencies: [],
      directEffects: allArchitectureEffects(),
      importSafe: false,
      language: "unknown",
      path: source.path,
      sourceDispositionExecutable: true,
      unmodeledEffects: [source.executable === "unavailable"
        ? "unknown-executable-language-mode-unavailable"
        : "unknown-executable-language"],
    });
  }
  return undefined;
}

function analyzeShellSource(source: CommandEffectSource): SourceFacts {
  // DELIBERATE SUBSET: 4 of 9 — the effects a shell script has by merely
  // BEING one. The remaining five (network, cryptography, git, environment
  // access, time) are evidence-gated below, because a script that does not
  // reach the network must not be recorded as if it might.
  const effects = new Set<ArchitectureEffect>([
    "child-process", "filesystem-read", "filesystem-write", "process-status",
  ]);
  if (/(?:^|[^A-Za-z0-9_])(?:curl|wget|nc|ncat|ssh|scp)(?:[^A-Za-z0-9_]|$)|https?:\/\//mu.test(source.source)) {
    effects.add("network");
  }
  if (/(?:^|[^A-Za-z0-9_])(?:gpg|gpgv|openssl|sha(?:1|224|256|384|512)sum)(?:[^A-Za-z0-9_]|$)/mu
    .test(source.source)) effects.add("cryptography");
  if (/(?:^|[;&|(\n])\s*(?:command\s+)?(?:\/usr\/bin\/)?git(?:\s|$)/mu.test(source.source)) {
    effects.add("git");
  }
  const unmodeledEffects: string[] = [];
  if (/(?:^|[;&|()\s])(?:eval|source|\.)\s/u.test(source.source)) {
    unmodeledEffects.push("shell-dynamic-source-or-eval");
  }
  return deepFreeze({
    dependencies: [],
    directEffects: [...effects].toSorted(),
    importSafe: false,
    language: "shell",
    path: source.path,
    sourceDispositionExecutable: source.executable === true || source.executable === "unavailable" ||
      ROOT_POLICY.verification.commandEffectInventory.shellExtensions.some((extension) =>
        source.path.endsWith(extension)
      ) || source.source.startsWith("#!"),
    unmodeledEffects,
  });
}

function excludedSourceDisposition(
  source: CommandEffectSource,
): Extract<CommandEffectSourceDisposition["disposition"],
  "excluded-generated-binary" | "excluded-nonregular" | "excluded-vendor"> | undefined {
  if (source.fileKind === "symlink" || source.fileKind === "nonregular" || source.fileKind === "unknown") {
    return "excluded-nonregular";
  }
  if (source.path.split("/").some((segment) =>
    ROOT_POLICY.verification.commandEffectInventory.vendorPathSegments.includes(segment as
      typeof ROOT_POLICY.verification.commandEffectInventory.vendorPathSegments[number])
  )) return "excluded-vendor";
  if (source.source.includes("\0")) return "excluded-generated-binary";
  return undefined;
}

function allArchitectureEffects(): readonly ArchitectureEffect[] {
  return [
    "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
    "process-status",
  ];
}

function analyzePythonSource(
  source: CommandEffectSource,
  violations: string[],
): PythonSourceFacts | undefined {
  const pythonExecutable = ROOT_POLICY.verification.commandEffectInventory.pythonExecutable;
  if (!pythonExecutable.startsWith("/") || pythonExecutable.includes("\0")) {
    violations.push("command-effect-python-executable-invalid");
    return undefined;
  }
  const result = spawnSync(ROOT_POLICY.verification.commandEffectInventory.pythonExecutable, [
    "-I", "-S", "-c", PYTHON_EFFECT_ANALYZER, String(ARCHITECTURE_MANIFEST.analysisLimits.maximumAstNodes),
  ], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "" },
    input: source.source,
    maxBuffer: ARCHITECTURE_MANIFEST.analysisLimits.maximumSourceBytes * 2,
    shell: false,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    violations.push(`command-effect-python-parse:${source.path}`);
    return undefined;
  }
  try {
    return validatePythonFacts(JSON.parse(result.stdout));
  } catch {
    violations.push(`command-effect-python-result-invalid:${source.path}`);
    return undefined;
  }
}

function validatePythonFacts(value: unknown): PythonSourceFacts {
  if (!isRecord(value) || typeof value.arbitraryOutput !== "boolean" ||
    typeof value.mainGuard !== "boolean" || typeof value.topLevelExecution !== "boolean" ||
    typeof value.temporaryEffects !== "boolean" ||
    !Array.isArray(value.dependencies) || !Array.isArray(value.directEffects) ||
    !Array.isArray(value.unmodeledEffects)) throw new Error("invalid Python facts");
  const effects = value.directEffects.filter(isArchitectureEffect);
  if (effects.length !== value.directEffects.length ||
    value.unmodeledEffects.some((entry) => typeof entry !== "string")) throw new Error("invalid Python facts");
  const dependencies = value.dependencies.map((entry) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.level) || Number(entry.level) < 0 ||
      typeof entry.module !== "string" || !Array.isArray(entry.names) ||
      entry.names.some((name) => typeof name !== "string")) throw new Error("invalid Python import");
    return { level: Number(entry.level), module: entry.module, names: entry.names as string[] };
  });
  return deepFreeze({
    arbitraryOutput: value.arbitraryOutput,
    dependencies,
    directEffects: effects,
    mainGuard: value.mainGuard,
    topLevelExecution: value.topLevelExecution,
    temporaryEffects: value.temporaryEffects,
    unmodeledEffects: value.unmodeledEffects as string[],
  });
}

function resolveJavaScriptDependency(
  owner: string,
  dependency: string,
  sources: ReadonlyMap<string, string>,
  violations: string[],
): readonly string[] {
  if (sources.has(dependency)) return [dependency];
  const candidates = javascriptResolutionCandidates(dependency);
  const resolved = candidates.find((candidate) => sources.has(candidate));
  if (resolved) return [resolved];
  const ownerDirectory = `${posix.dirname(owner)}/`;
  const repositorySourceRoots = new Set([...sources.keys()].map((path) => path.split("/")[0]));
  const dependencyRoot = dependency.split("/")[0];
  if (dependency.startsWith(ownerDirectory) || repositorySourceRoots.has(dependencyRoot)) {
    violations.push(`command-effect-local-import-missing:${owner}:${dependency}`);
  }
  return [];
}

function javascriptResolutionCandidates(path: string): readonly string[] {
  const output = [path];
  for (const extension of ARCHITECTURE_SOURCE_EXTENSIONS) output.push(`${path}${extension}`);
  if (path.endsWith(".js")) output.push(`${path.slice(0, -3)}.ts`, `${path.slice(0, -3)}.tsx`);
  if (path.endsWith(".mjs")) output.push(`${path.slice(0, -4)}.mts`);
  if (path.endsWith(".cjs")) output.push(`${path.slice(0, -4)}.cts`);
  for (const extension of ARCHITECTURE_SOURCE_EXTENSIONS) output.push(`${path}/index${extension}`);
  return [...new Set(output)];
}

function resolvePythonDependencies(
  owner: string,
  dependencies: readonly PythonImport[],
  sources: ReadonlyMap<string, string>,
  violations: string[],
): readonly string[] {
  const output = new Set<string>();
  for (const dependency of dependencies) {
    const ownerParts = posix.dirname(owner).split("/").filter(Boolean);
    const baseParts = dependency.level === 0
      ? []
      : ownerParts.slice(0, Math.max(0, ownerParts.length - dependency.level + 1));
    const moduleParts = dependency.module.split(".").filter(Boolean);
    const candidates = pythonModuleCandidates([...baseParts, ...moduleParts].join("/"));
    let matched = candidates.find((candidate) => sources.has(candidate));
    if (!matched && dependency.module.length === 0) {
      matched = dependency.names.flatMap((name) =>
        pythonModuleCandidates([...baseParts, name].join("/"))
      ).find((candidate) => sources.has(candidate));
    }
    if (matched) output.add(matched);
    else if (dependency.level > 0) {
      violations.push(`command-effect-local-import-missing:${owner}:${dependency.module || dependency.names.join(",")}`);
    }
  }
  return [...output].toSorted();
}

function pythonModuleCandidates(modulePath: string): readonly string[] {
  return modulePath.length === 0 ? [] : [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function commandClosure(
  root: string,
  factsByPath: ReadonlyMap<string, SourceFacts>,
  violations: string[],
): readonly string[] {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    if (visited.size >= ARCHITECTURE_MANIFEST.analysisLimits.maximumAstNodes) {
      violations.push(`command-effect-closure-limit:${root}`);
      break;
    }
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const facts = factsByPath.get(path);
    if (!facts) {
      violations.push(`command-effect-closure-source-missing:${root}:${path}`);
      continue;
    }
    pending.push(...facts.dependencies);
  }
  return [...visited].toSorted();
}

function uniqueSources(sources: readonly CommandEffectSource[], violations: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const source of sources) {
    if (!isRepositoryPath(source.path) || output.has(source.path)) {
      violations.push(`command-effect-source-path-invalid:${source.path}`);
      continue;
    }
    output.set(source.path, source.source);
  }
  return output;
}

function uniqueRegistrations(
  registrations: readonly CommandEffectRegistration[],
  violations: string[],
): Map<string, CommandEffectRegistration> {
  const output = new Map<string, CommandEffectRegistration>();
  for (const registration of registrations) {
    if (!isRepositoryPath(registration.path) || output.has(registration.path)) {
      violations.push(`command-effect-registration-path-invalid:${registration.path}`);
      continue;
    }
    output.set(registration.path, registration);
  }
  return output;
}

function uniqueExternalCommands(
  commands: readonly ArchitectureExternalCommand[],
  violations: string[],
): Map<string, ArchitectureExternalCommand> {
  const output = new Map<string, ArchitectureExternalCommand>();
  for (const command of commands) {
    if (!isRepositoryPath(command.path) || output.has(command.path)) {
      violations.push(`command-effect-external-path-invalid:${command.path}`);
      continue;
    }
    output.set(command.path, command);
  }
  return output;
}

function isRepositoryPath(path: string): boolean {
  return path.length > 0 && path === posix.normalize(path) && !path.startsWith("/") &&
    path !== ".." && !path.startsWith("../") && !path.includes("\0");
}

function isArchitectureEffect(value: unknown): value is ArchitectureEffect {
  return [
    "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
    "process-status",
  ].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
