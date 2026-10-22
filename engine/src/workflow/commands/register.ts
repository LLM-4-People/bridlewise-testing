import { type HarnessCommand, unknownFlag } from "./command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";

function parseRegisterOptions(argv: readonly string[]): Readonly<{ write: boolean }> {
  for (const arg of argv) {
    if (arg !== "--write") throw unknownFlag("register", arg, ["--write"]);
  }
  return deepFreeze({ write: argv.includes("--write") });
}

export const COMMAND: HarnessCommand = {
  verb: "register",
  run: async ({ root, rest }) => {
    const { harnessRegister } = await import("../harness-commands.ts");
    return { result: harnessRegister(root, parseRegisterOptions(rest)) };
  },
};
