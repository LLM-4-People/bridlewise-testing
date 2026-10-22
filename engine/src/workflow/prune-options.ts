import { unknownFlag } from "./harness-command.ts";

/** `[--with-bundle] [--prune <test path>]…` for `sync`; the same without `--with-bundle` for `regenerate`. */
export function parsePruneOptions(subcommand: string, argv: readonly string[], bundleFlag: boolean): Readonly<{ prune: readonly string[]; withBundle: boolean }> {
  const prune: string[] = [];
  let withBundle = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--prune" && index + 1 < argv.length) prune.push(argv[++index]!);
    else if (arg === "--with-bundle" && bundleFlag) withBundle = true;
    else throw unknownFlag(subcommand, arg, [...(bundleFlag ? ["--with-bundle"] : []), "--prune <test path>"]);
  }
  return { prune, withBundle };
}
