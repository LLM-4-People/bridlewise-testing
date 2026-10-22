import type { HarnessCommand } from "./command.ts";
import { INPUT_ERROR_CODE, InputError } from "../../kernel/errors.ts";

export const COMMAND: HarnessCommand = {
  verb: "new-module",
  run: async ({ root, rest }) => {
    if (rest.length === 0) throw new InputError("new-module requires a module path", INPUT_ERROR_CODE);
    if (rest.length > 1) throw new InputError("new-module accepts exactly one module path", INPUT_ERROR_CODE);
    const { harnessNewModule } = await import("../harness-commands.ts");
    return { result: harnessNewModule(root, rest[0]!) };
  },
};
