import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

process.umask(0o077);
const ROOT = dirname(new URL(import.meta.url).pathname);
const WORK = join(ROOT, "work", "qualification-run");
const OUTPUT = resolve(process.argv[2] ?? join(ROOT, "artifacts", "raw", "qualification.json"));
const NODE = process.execPath;
const NPM = join(dirname(NODE), "npm");
const PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
const SAFE_ENV = {
  PATH,
  HOME: join(WORK, "empty-home"),
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  USER: process.env.USER ?? "qualification-user",
  LOGNAME: process.env.LOGNAME ?? "qualification-user",
  NPM_CONFIG_USERCONFIG: "/dev/null",
  NPM_CONFIG_CACHE: join(WORK, "npm-cache"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true, mode: 0o700 });
mkdirSync(SAFE_ENV.HOME, { recursive: true, mode: 0o700 });

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? SAFE_ENV,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code } : null,
  };
}

function mustJson(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathMetadata(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  return {
    exists: true,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    regular: stat.isFile(),
    directory: stat.isDirectory(),
    socket: stat.isSocket(),
    symlink: stat.isSymbolicLink(),
    nlink: stat.nlink,
  };
}

function filesystem(path) {
  const stat = statfsSync(path, { bigint: true });
  return {
    path,
    typeMagic: `0x${stat.type.toString(16)}`,
    blockSize: Number(stat.bsize),
    fragmentSize: Number(stat.frsize),
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function inheritedFdProbe() {
  const syntheticKey = Buffer.from(
    "75f53d3facb5bf54d91f119a1296f6d8b5511b772fbcc6a912da0a7df55859b7",
    "hex",
  );
  const expectedHash = createHash("sha256").update(syntheticKey).digest("hex");
  const child = spawn(NODE, [join(ROOT, "src", "fd-consumer.mjs")], {
    cwd: ROOT,
    env: { PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const ready = JSON.parse((await iterator.next()).value);
  const beforeCommandLine = readFileSync(`/proc/${child.pid}/cmdline`);
  const beforeEnvironment = readFileSync(`/proc/${child.pid}/environ`);
  const parentObservedKeyInChildCommandLineBeforeIntake = beforeCommandLine.indexOf(syntheticKey) !== -1;
  const parentObservedKeyInChildEnvironmentBeforeIntake = beforeEnvironment.indexOf(syntheticKey) !== -1;
  const fdTarget = readlinkSync(`/proc/${child.pid}/fd/3`);
  child.stdio[3].end(syntheticKey);
  const result = JSON.parse((await iterator.next()).value);
  const hold = JSON.parse((await iterator.next()).value);
  const afterCommandLine = readFileSync(`/proc/${child.pid}/cmdline`);
  const afterEnvironment = readFileSync(`/proc/${child.pid}/environ`);
  const parentObservedKeyInChildCommandLineAfterIntake = afterCommandLine.indexOf(syntheticKey) !== -1;
  const parentObservedKeyInChildEnvironmentAfterIntake = afterEnvironment.indexOf(syntheticKey) !== -1;
  const fdClosedAfterRead = !existsSync(`/proc/${child.pid}/fd/3`);
  child.stdin.end();
  const exit = await waitForExit(child);
  syntheticKey.fill(0);
  return {
    ready,
    inheritedDescriptorTarget: fdTarget,
    parentObservedKeyInChildCommandLineBeforeIntake,
    parentObservedKeyInChildEnvironmentBeforeIntake,
    parentObservedKeyInChildCommandLineAfterIntake,
    parentObservedKeyInChildEnvironmentAfterIntake,
    fdClosedAfterRead,
    result,
    expectedHashMatched: result.keySha256 === expectedHash,
    hold,
    exit,
    stderr: stderr.join(""),
  };
}

function compileAndRunNativeProbes() {
  const binaryDirectory = join(WORK, "bin");
  mkdirSync(binaryDirectory, { mode: 0o700 });
  const definitions = [
    ["keyring", "probe-keyring.c", []],
    ["memory", "probe-memory.c", []],
    ["openat2", "probe-openat2.c", [join(WORK, "openat2")]],
  ];
  const output = {};
  for (const [name, file, args] of definitions) {
    const binary = join(binaryDirectory, `probe-${name}`);
    const compile = run("/usr/bin/cc", ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", join(ROOT, "src", file), "-o", binary]);
    if (compile.status !== 0) throw new Error(`compile ${name} failed: ${compile.stderr}`);
    const execution = run(binary, args);
    output[name] = {
      compiler: compile,
      result: mustJson(execution, name),
      binarySha256: sha256File(binary),
    };
  }
  const mountRoot = join(WORK, "mount-swap");
  const mountTarget = join(mountRoot, "target");
  const mountAttacker = join(mountRoot, "attacker");
  mkdirSync(mountTarget, { recursive: true, mode: 0o700 });
  mkdirSync(mountAttacker, { recursive: true, mode: 0o700 });
  writeFileSync(join(mountTarget, "anchor"), "G", { mode: 0o600 });
  writeFileSync(join(mountAttacker, "anchor"), "E", { mode: 0o600 });
  const mountBinary = join(binaryDirectory, "probe-mount-openat2");
  const mountCompile = run("/usr/bin/cc", [
    "-std=c17", "-O2", "-Wall", "-Wextra", "-Werror",
    join(ROOT, "src", "probe-mount-openat2.c"), "-o", mountBinary,
  ]);
  if (mountCompile.status !== 0) throw new Error(`compile mount-openat2 failed: ${mountCompile.stderr}`);
  const mountExecution = run("/usr/bin/unshare", [
    "--user", "--map-root-user", "--mount", "--propagation", "private",
    "/bin/sh", "-c", "mount --bind \"$1\" \"$2\" && exec \"$3\" \"$4\"",
    "s3q-mount-probe", mountAttacker, mountTarget, mountBinary, mountRoot,
  ]);
  output.mountSwap = {
    compiler: mountCompile,
    execution: mountExecution,
    result: mountExecution.status === 0 ? JSON.parse(mountExecution.stdout) : null,
    binarySha256: sha256File(mountBinary),
  };
  return output;
}

function systemdProbe() {
  const input = join(WORK, "systemd-synthetic-input");
  writeFileSync(input, "S3Q_SYSTEMD_SYNTHETIC_ONLY_2026\n", { mode: 0o600 });
  chmodSync(input, 0o600);
  const nullOutput = join(WORK, "systemd-null.cred");
  const tpmOutput = join(WORK, "systemd-tpm.cred");
  const loadCredential = run("/usr/bin/systemd-run", [
    "--user", "--wait", "--pipe", "--collect", "--quiet",
    "--property=Type=exec", "--property=PrivateMounts=yes", "--property=UMask=0077",
    `--property=LoadCredential=s3q:${input}`,
    NODE, join(ROOT, "src", "systemd-credential-consumer.mjs"),
  ]);
  const nullEncryption = run("/usr/bin/systemd-creds", [
    "encrypt", "--user", "--with-key=null", "--name=s3q", input, nullOutput,
  ]);
  const tpmEncryption = run("/usr/bin/systemd-creds", [
    "encrypt", "--user", "--with-key=tpm2", "--name=s3q", input, tpmOutput,
  ]);
  const result = {
    version: run("/usr/bin/systemd-creds", ["--version"]),
    userManagerState: run("/usr/bin/systemctl", ["--user", "is-system-running"]),
    userBusSecretServiceOwnerProbe: run("/usr/bin/busctl", [
      "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "NameHasOwner", "s", "org.freedesktop.secrets",
    ]),
    tpmCapability: run("/usr/bin/systemd-analyze", ["has-tpm2"]),
    loadCredential,
    nullEncryption,
    tpmEncryption,
    hostKeyEncryptionAttempted: false,
    hostKeyReason: "Avoided because it can initialize or access persistent per-user credential state.",
    syntheticInputSha256: sha256File(input),
    generatedNullOutput: pathMetadata(nullOutput),
    generatedTpmOutput: pathMetadata(tpmOutput),
  };
  rmSync(input, { force: true });
  rmSync(nullOutput, { force: true });
  rmSync(tpmOutput, { force: true });
  return result;
}

function environmentProbe() {
  const commands = [
    "keyctl", "secret-tool", "gdbus", "dbus-send", "busctl", "dbus-daemon",
    "gnome-keyring-daemon", "systemd-creds", "systemd-run", "systemd-analyze",
    "tpm2_getcap", "tpm2_nvdefine", "tpm2_nvincrement", "tpm2_nvextend", "swtpm",
    "findmnt", "unshare", "cc",
  ];
  const availability = Object.fromEntries(commands.map((name) => {
    const found = run("/usr/bin/env", ["sh", "-c", `command -v ${name}`]);
    return [name, found.status === 0 ? found.stdout.trim() : null];
  }));
  const procStatus = readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .filter((line) => /^(?:Cap|NoNewPrivs|Seccomp|CoreDumping|VmLck):/u.test(line));
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    nodeVersions: process.versions,
    uid: process.getuid(),
    gid: process.getgid(),
    groups: process.getgroups(),
    unameWithoutNodeName: run("/usr/bin/uname", ["-s", "-r", "-v", "-m"]),
    virtualization: run("/usr/bin/systemd-detect-virt", []),
    commandAvailability: availability,
    procStatus,
    limits: readFileSync("/proc/self/limits", "utf8")
      .split("\n")
      .filter((line) => /Max (?:core file size|locked memory)/u.test(line)),
    yamaPtraceScope: existsSync("/proc/sys/kernel/yama/ptrace_scope")
      ? readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim() : null,
    corePattern: readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim(),
    suidDumpable: readFileSync("/proc/sys/fs/suid_dumpable", "utf8").trim(),
    keyProcMetadataOnly: {
      keys: pathMetadata("/proc/keys"),
      keyUsers: pathMetadata("/proc/key-users"),
      contentsRead: false,
    },
    tpmPaths: Object.fromEntries([
      "/dev/tpm0", "/dev/tpmrm0", "/sys/class/tpm/tpm0",
    ].map((path) => [path, pathMetadata(path)])),
    runtimePaths: {
      userRuntime: pathMetadata(`/run/user/${process.getuid()}`),
      userBus: pathMetadata(`/run/user/${process.getuid()}/bus`),
      systemdPrivate: pathMetadata(`/run/user/${process.getuid()}/systemd/private`),
    },
    filesystems: {
      qualification: filesystem(ROOT),
      repository: filesystem("/home/example/bridlewise"),
      qualificationMount: run("/usr/bin/findmnt", ["-T", ROOT, "-o", "TARGET,SOURCE,FSTYPE,OPTIONS", "-n"]),
      repositoryMount: run("/usr/bin/findmnt", ["-T", "/home/example/bridlewise", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS", "-n"]),
    },
    rootlessUserNamespace: run("/usr/bin/unshare", ["--user", "--map-root-user", "/usr/bin/true"]),
  };
}

function packageProbe() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const keyringAddon = join(ROOT, "node_modules", "@napi-rs", "keyring-linux-x64-gnu", "keyring.linux-x64-gnu.node");
  const sodiumAddon = join(ROOT, "node_modules", "sodium-native", "prebuilds", "linux-x64", "sodium-native.node");
  const packages = [
    "@napi-rs/keyring", "keytar", "sodium-native", "etcd3",
    "@aws-sdk/client-dynamodb", "@aws-sdk/client-kms",
  ];
  const registry = {};
  for (const name of packages) {
    const metadata = run(NPM, [
      "view", name, "version", "engines", "time.modified", "deprecated",
      "dist.integrity", "dist.tarball", "repository.url", "--json",
    ], { timeout: 60_000 });
    registry[name] = metadata.status === 0 ? JSON.parse(metadata.stdout) : metadata;
  }
  return {
    installed: {
      keyring: {
        version: lock.packages["node_modules/@napi-rs/keyring"]?.version,
        integrity: lock.packages["node_modules/@napi-rs/keyring"]?.integrity,
        addonSha256: sha256File(keyringAddon),
      },
      sodiumNative: {
        version: lock.packages["node_modules/sodium-native"]?.version,
        integrity: lock.packages["node_modules/sodium-native"]?.integrity,
        addonSha256: sha256File(sodiumAddon),
      },
      npmLs: run(NPM, ["ls", "--all", "--json"]),
    },
    registry,
    registryAccessUsedUserConfig: false,
  };
}

const native = compileAndRunNativeProbes();
const fd = await inheritedFdProbe();
const nodeKeyLibraries = mustJson(run(NODE, [join(ROOT, "src", "node-key-probes.mjs")], {
  env: { PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
}), "node key probes");
const anchor = mustJson(run(NODE, [join(ROOT, "src", "anchor-qualification.mjs"), join(WORK, "anchor")], {
  env: { PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  timeout: 60_000,
}), "anchor qualification");

const results = {
  schema: "s3-key-anchor-qualification/v1",
  scope: {
    repositoryReadOnly: true,
    realCredentialsUsed: false,
    existingSecretCollectionsEnumerated: false,
    procKeyContentsRead: false,
    productionStateWritten: false,
    syntheticOnly: true,
  },
  environment: environmentProbe(),
  native,
  inheritedFdAndWebCrypto: fd,
  nodeKeyLibraries,
  systemdCredentials: systemdProbe(),
  packages: packageProbe(),
  anchor,
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(dirname(OUTPUT), { recursive: true, mode: 0o700 });
writeFileSync(OUTPUT, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
chmodSync(OUTPUT, 0o600);
console.log(JSON.stringify({
  ok: true,
  output: OUTPUT,
  outputSha256: sha256File(OUTPUT),
  keyring: native.keyring.result,
  memory: native.memory.result,
  fd: {
    expectedHashMatched: fd.expectedHashMatched,
    exportRejected: fd.result.exportRejected,
    commandLineContainsKey: fd.result.commandLineContainsKey,
    environmentContainsKey: fd.result.environmentContainsKey,
  },
  cas: {
    attempts: anchor.mockAuthorityCas.attempts,
    winners: anchor.mockAuthorityCas.appliedWinners,
    pairedRollbackAcceptedByLocalMock: anchor.ledgerIntegration.pairedRollbackAcceptedByLocalMock,
  },
}));
