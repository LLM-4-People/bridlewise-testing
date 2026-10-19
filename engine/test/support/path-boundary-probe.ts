import { spawnSync } from "node:child_process";

import { createPreflightContext } from "../../src/kernel/preflight.ts";

const root = process.argv[2];
if (!root) throw new Error("probe root is required");

const context = createPreflightContext();
const bind = inspectMountedPath(["--bind", `${root}/scratch/source`, `${root}/scratch/bind`], "scratch/bind");
const crossDevice = inspectMountedPath(["-t", "tmpfs", "tmpfs", `${root}/scratch/cross`], "scratch/cross");
process.stdout.write(`${JSON.stringify({ capability: "available", bind, crossDevice })}\n`);

function inspectMountedPath(arguments_: readonly string[], requestedPath: string): ReturnType<typeof context.inspectPath> {
  const target = arguments_.at(-1)!;
  const mounted = spawnSync("mount", arguments_, { encoding: "utf8" });
  if (mounted.status !== 0) {
    throw new Error(`mount namespace capability unavailable: ${mounted.stderr.trim()}`);
  }
  try {
    return context.inspectPath(requestedPath);
  } finally {
    const unmounted = spawnSync("umount", [target], { encoding: "utf8" });
    if (unmounted.status !== 0) throw new Error(`unmount failed: ${unmounted.stderr.trim()}`);
  }
}
