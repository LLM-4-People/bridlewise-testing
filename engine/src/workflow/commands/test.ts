import { type HarnessCommand, unknownFlag } from "./command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import type { HarnessTestOptions } from "../harness-commands.ts";

function parseTestOptions(argv: readonly string[]): HarnessTestOptions {
  const options: { file?: string; all?: boolean; writeResults?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--file" && index + 1 < argv.length) {
      const fileArg = argv[index + 1];
      if (fileArg !== undefined) options.file = fileArg;
      index += 1;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--no-write") {
      options.writeResults = false;
    } else {
      throw unknownFlag("test", arg, ["--file", "--all", "--no-write"]);
    }
  }
  return deepFreeze(options);
}

export const COMMAND: HarnessCommand = {
  verb: "test",
  run: async ({ root, rest, onProgress }) => {
    const { harnessTest } = await import("../harness-commands.ts");
    return { result: await harnessTest(root, { ...parseTestOptions(rest), onProgress }) };
  },
};
