import { type HarnessCommand, unknownFlag } from "../harness-command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import type { HarnessRollbackOptions } from "../harness-commands.ts";

function parseRollbackOptions(argv: readonly string[]): HarnessRollbackOptions {
  let effectId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--effect-id" && index + 1 < argv.length) {
      effectId = argv[index + 1];
      index += 1;
    } else {
      throw unknownFlag("rollback", arg, ["--effect-id"]);
    }
  }
  if (effectId === undefined) return deepFreeze({});
  return deepFreeze({ effectId });
}

export const COMMAND: HarnessCommand = {
  verb: "rollback",
  run: async ({ root, rest }) => {
    const { harnessRollback } = await import("../harness-commands.ts");
    return { result: harnessRollback(root, parseRollbackOptions(rest)) };
  },
};
