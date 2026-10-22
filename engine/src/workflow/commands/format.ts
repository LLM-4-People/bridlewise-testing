import { type HarnessCommand, unknownFlag } from "../harness-command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { wrapResult } from "../command-result.ts";
import type { HarnessFormatOutput } from "../harness-commands.ts";

export const COMMAND: HarnessCommand = {
  verb: "format",
  run: async ({ root, rest }) => {
    const write = !rest.includes("--check");
    const unknown = rest.filter((a) => a !== "--check");
    if (unknown.length > 0) throw unknownFlag("format", unknown[0]!, ["--check"]);
    const { harnessFormat } = await import("../format-command.ts");
    const formatResult = harnessFormat(root, { write });
    const output: HarnessFormatOutput = deepFreeze({
      scanned: formatResult.scanned,
      fixed: formatResult.fixed,
      write: formatResult.write,
      changedFiles: formatResult.results.filter((r) => r.changed).map((r) => r.path),
    });
    // `--check` is a gate (the workspace's validate phase runs it): a file
    // the fixer WOULD change is a failure, not a report.
    return { result: wrapResult("format", output, { status: !write && output.changedFiles.length > 0 ? "fail" : "pass" }) };
  },
};
