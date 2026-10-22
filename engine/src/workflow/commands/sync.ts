import type { HarnessCommand } from "../harness-command.ts";
import { parsePruneOptions } from "../prune-options.ts";

export const COMMAND: HarnessCommand = {
  verb: "sync",
  run: async ({ root, rest, onProgress }) => {
    const { harnessSync } = await import("../harness-commands.ts");
    const { prune, withBundle } = parsePruneOptions("sync", rest, true);
    return { result: await harnessSync(root, { withBundle, prune, onProgress }) };
  },
};
