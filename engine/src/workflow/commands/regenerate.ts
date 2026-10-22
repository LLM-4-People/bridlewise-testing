import type { HarnessCommand } from "./command.ts";
import { parsePruneOptions } from "./prune-options.ts";

export const COMMAND: HarnessCommand = {
  verb: "regenerate",
  run: async ({ root, rest }) => {
    const { harnessRegenerate } = await import("../harness-commands.ts");
    const { prune } = parsePruneOptions("regenerate", rest, false);
    return { result: harnessRegenerate(root, { write: true, prune }) };
  },
};
