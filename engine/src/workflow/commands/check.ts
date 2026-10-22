import { type HarnessCommand, unknownFlag } from "./command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import type { HarnessCheckOptions } from "../harness-commands.ts";

function parseCheckOptions(argv: readonly string[]): HarnessCheckOptions {
  const options: { skipTypecheck?: boolean; skipArchitecture?: boolean; skipInventory?: boolean } = {};
  for (const arg of argv) {
    if (arg === "--skip-typecheck") options.skipTypecheck = true;
    else if (arg === "--skip-architecture") options.skipArchitecture = true;
    else if (arg === "--skip-inventory") options.skipInventory = true;
    else throw unknownFlag("check", arg, ["--skip-typecheck", "--skip-architecture", "--skip-inventory"]);
  }
  return deepFreeze(options);
}

export const COMMAND: HarnessCommand = {
  verb: "check",
  run: async ({ root, rest, onProgress }) => {
    const { harnessCheck } = await import("../harness-commands.ts");
    return { result: await harnessCheck(root, { ...parseCheckOptions(rest), onProgress }) };
  },
};
