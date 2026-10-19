// Shared subprocess mock helper for unit tests.
//
// Node.js built-in module exports (node:child_process) are frozen — their
// spawnSync/execSync/execFileSync properties cannot be redefined, so
// node:test's mock.method cannot patch them. Named imports
// (import { spawnSync } from "node:child_process") create live bindings to
// the frozen exports that cannot be intercepted either.
//
// This helper provides a mutable wrapper object that test files import
// instead of importing node:child_process directly. The wrapper re-exports
// the real functions; installSubprocessMock patches the wrapper's
// properties with canned handlers; restoreSubprocessMock reverts. Test
// files that want subprocess mocking import { subprocess } from this
// module and call subprocess.spawnSync(...) instead of the bare import.
//
// The handler receives (command, args) and returns a canned result or
// undefined to fall through to the real subprocess (for integration tests
// that verify the real code path). This lets unit tests verify the LOGIC
// (what args were passed, how the result is parsed) without paying the
// 50-200ms process-creation overhead, while integration tests keep the
// real spawn.

import { spawnSync as realSpawnSync, execSync as realExecSync, execFileSync as realExecFileSync, type SpawnSyncOptions, type ExecSyncOptions, type ExecFileSyncOptions } from "node:child_process";

export type SubprocessResult = Readonly<{
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}>;

export type SubprocessHandler = (
  command: string,
  args: readonly string[],
) => SubprocessResult | undefined;

type SpawnSyncSignature = {
  (command: string): ReturnType<typeof realSpawnSync>;
  (command: string, args: readonly string[], options?: SpawnSyncOptions): ReturnType<typeof realSpawnSync>;
};

type ExecSyncSignature = {
  (command: string): string | Buffer;
  (command: string, options?: ExecSyncOptions): string | Buffer;
};

type ExecFileSyncSignature = {
  (command: string): string | Buffer;
  (command: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
};

const noop = (): undefined => undefined;
let activeHandler: SubprocessHandler | undefined;

function toSpawnSyncResult(result: SubprocessResult, options?: SpawnSyncOptions): ReturnType<typeof realSpawnSync> {
  const encoding = typeof options?.encoding === "string" ? options.encoding : null;
  const stdout = encoding === "buffer" || encoding === null ? Buffer.from(result.stdout) : result.stdout;
  const stderr = encoding === "buffer" || encoding === null ? Buffer.from(result.stderr) : result.stderr;
  return {
    status: result.status,
    stdout: stdout as string | Buffer,
    stderr: stderr as string | Buffer,
    signal: null,
    output: [stdout, stdout, stderr] as [string | Buffer | null, string | Buffer | null, string | Buffer | null],
    pid: 0,
  } as ReturnType<typeof realSpawnSync>;
}

function execToStdout(result: SubprocessResult, options?: ExecSyncOptions | ExecFileSyncOptions): string | Buffer {
  const encoding = typeof (options as { encoding?: string } | undefined)?.encoding === "string"
    ? (options as { encoding: string }).encoding
    : "utf8";
  if (encoding === "buffer") return Buffer.from(result.stdout);
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString(encoding as BufferEncoding);
}

export const subprocess = {
  spawnSync: ((command: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, maybeOptions?: SpawnSyncOptions): ReturnType<typeof realSpawnSync> => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? maybeOptions : (argsOrOptions as SpawnSyncOptions | undefined);
    if (activeHandler !== undefined) {
      const result = activeHandler(command, args);
      if (result !== undefined) return toSpawnSyncResult(result, options);
    }
    return Array.isArray(argsOrOptions)
      ? realSpawnSync(command, args as string[], options)
      : realSpawnSync(command, options);
  }) as SpawnSyncSignature,

  execSync: ((command: string, options?: ExecSyncOptions): string | Buffer => {
    if (activeHandler !== undefined) {
      const parts = command.split(/\s+/);
      const result = activeHandler(parts[0] ?? command, parts.slice(1));
      if (result !== undefined) return execToStdout(result, options);
    }
    return realExecSync(command, options);
  }) as ExecSyncSignature,

  execFileSync: ((command: string, argsOrOptions?: readonly string[] | ExecFileSyncOptions, maybeOptions?: ExecFileSyncOptions): string | Buffer => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? maybeOptions : (argsOrOptions as ExecFileSyncOptions | undefined);
    if (activeHandler !== undefined) {
      const result = activeHandler(command, args);
      if (result !== undefined) return execToStdout(result, options);
    }
    return Array.isArray(argsOrOptions)
      ? realExecFileSync(command, args as string[], options)
      : realExecFileSync(command, options);
  }) as ExecFileSyncSignature,
};

export function installSubprocessMock(handler: SubprocessHandler): () => void {
  const previous = activeHandler;
  activeHandler = handler;
  return () => {
    activeHandler = previous;
  };
}

export { noop };
