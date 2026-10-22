import { type HarnessCommand, unknownFlag } from "../harness-command.ts";
import { InputError } from "../../kernel/errors.ts";

export const COMMAND: HarnessCommand = {
  verb: "extension",
  run: async ({ rest }) => {
    const extensionSub = rest[0];
    if (extensionSub === "list") {
      if (rest.length > 1) throw unknownFlag("extension list", rest[1]!, []);
      const { harnessExtensionList } = await import("../harness-commands.ts");
      return { result: harnessExtensionList() };
    }
    throw new InputError(`unknown extension subcommand: ${extensionSub ?? "(none)"} (supported: list)`, "command_unavailable");
  },
};
