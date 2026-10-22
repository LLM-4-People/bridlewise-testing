/**
 * THE REUSE KEY K (github-only §5.4, TEST-10X §3.1): the canonical JSON of
 * everything a verdict depends on, whose sha256 IS K. The key document is
 * the subject of the door's verdict attestation, so `gh attestation verify
 * <keydoc.json>` works on the file itself.
 *
 * It names:
 *   - the TREE (the git tree id the gates ran on);
 *   - the GATE CATALOGUE (its version and digest: every gate's command);
 *   - the TOOLCHAIN (the Node version file and the running Node, both
 *     lockfiles' digests, the runner image the provider names);
 *   - the pinned CONFIG (the configuration document's digest);
 *   - the RUNNER: its class and the capability probes (CPU model, cgroup v2,
 *     Landlock, user namespaces, a CPU performance-counter unit) — measured,
 *     never assumed (one package, probe don't branch).
 *
 * Two keys are equal only when every input is; a tree that is the same but
 * ran under another toolchain is another key.
 */
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { GATE_CATALOGUE_VERSION, GATE_RUNNER } from "./catalogue.ts";

export const GATE_KEY_SCHEMA = schemaId("gate-key", 1);

/** The files the toolchain part of K digests, repository-relative. */
export const KEY_INPUT_FILES = deepFreeze({
  nodeVersion: ".nvmrc",
  webLockfile: "package-lock.json",
  engineLockfile: "engine/package-lock.json",
  config: "engine/bridlewise.config.json",
} as const);

export type RunnerProbes = Readonly<{
  cpuModel: string;
  cgroupV2: boolean;
  landlock: boolean;
  userNamespaces: boolean;
  cpuCounters: boolean;
}>;

export type GateKeyDocument = Readonly<{
  schemaVersion: typeof GATE_KEY_SCHEMA;
  treeId: string;
  catalogue: Readonly<{ version: typeof GATE_CATALOGUE_VERSION; digest: string }>;
  toolchain: Readonly<{ nodeVersionFile: string; node: string; webLockfile: string; engineLockfile: string; runnerImage: string }>;
  config: string;
  runner: Readonly<{ class: string; probes: RunnerProbes }>;
}>;

/** What a file of the tree hashes to, read through `readText` (a checkout's file, or a commit's blob). */
export type TreeFileReader = (path: string) => string | Buffer | null;

function digestOf(read: TreeFileReader, path: string): string {
  const bytes = read(path);
  if (bytes === null) throw new InputError(`the key input ${path} is absent from the tree`, "gate_key_input_missing");
  return sha256(bytes);
}

/** The toolchain and config inputs of K from a tree (the door reads them from the commit, CI from its checkout). */
export function treeKeyInputs(read: TreeFileReader): Readonly<{ nodeVersionFile: string; webLockfile: string; engineLockfile: string; config: string }> {
  return deepFreeze({
    nodeVersionFile: digestOf(read, KEY_INPUT_FILES.nodeVersion),
    webLockfile: digestOf(read, KEY_INPUT_FILES.webLockfile),
    engineLockfile: digestOf(read, KEY_INPUT_FILES.engineLockfile),
    config: digestOf(read, KEY_INPUT_FILES.config),
  });
}

function readable(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The capability probes of THIS machine (each a read of what the kernel exposes, never an assumption). */
export function probeRunner(): RunnerProbes {
  const lsm = readable("/sys/kernel/security/lsm") ?? "";
  const maxNamespaces = Number.parseInt(readable("/proc/sys/user/max_user_namespaces") ?? "0", 10);
  return deepFreeze({
    cpuModel: cpus()[0]?.model.trim() ?? "unknown",
    cgroupV2: existsSync("/sys/fs/cgroup/cgroup.controllers"),
    landlock: lsm.split(",").map((name) => name.trim()).includes("landlock"),
    userNamespaces: Number.isFinite(maxNamespaces) && maxNamespaces > 0,
    cpuCounters: existsSync("/sys/bus/event_source/devices/cpu"),
  });
}

/** The runner image the provider names (`ImageOS`/`ImageVersion` on a hosted runner), or `local` off it. */
export function runnerImage(environment: NodeJS.ProcessEnv = process.env): string {
  const os = environment.ImageOS;
  const version = environment.ImageVersion;
  return os !== undefined && os !== "" && version !== undefined && version !== "" ? `${os}/${version}` : "local";
}

export type KeyInputs = Readonly<{
  treeId: string;
  catalogueDigest: string;
  read: TreeFileReader;
  node: string;
  runnerImage: string;
  runnerClass?: string;
  probes: RunnerProbes;
}>;

export function gateKeyDocument(inputs: KeyInputs): GateKeyDocument {
  if (!/^[0-9a-f]{40}$/u.test(inputs.treeId)) throw new InputError("a key names a full tree id", "gate_key_input_missing");
  const tree = treeKeyInputs(inputs.read);
  return deepFreeze({
    schemaVersion: GATE_KEY_SCHEMA,
    treeId: inputs.treeId,
    catalogue: { version: GATE_CATALOGUE_VERSION, digest: inputs.catalogueDigest },
    toolchain: { nodeVersionFile: tree.nodeVersionFile, node: inputs.node, webLockfile: tree.webLockfile, engineLockfile: tree.engineLockfile, runnerImage: inputs.runnerImage },
    config: tree.config,
    runner: { class: inputs.runnerClass ?? GATE_RUNNER, probes: inputs.probes },
  });
}

/** The key document's bytes: canonical JSON, the attestation's subject. */
export function keyDocumentBytes(document: GateKeyDocument): string {
  return canonicalJson(document);
}

/** K: the sha256 of the key document's canonical bytes. */
export function gateKey(document: GateKeyDocument): string {
  return canonicalHash(document);
}

/** The key of a working tree on this machine (CI's plan, a local validation). */
export function workingTreeKey(repositoryRoot: string, treeId: string, catalogueDigest: string): GateKeyDocument {
  return gateKeyDocument({
    treeId,
    catalogueDigest,
    read: (path) => {
      const absolute = join(repositoryRoot, path);
      return existsSync(absolute) ? readFileSync(absolute) : null;
    },
    node: process.version,
    runnerImage: runnerImage(),
    probes: probeRunner(),
  });
}
