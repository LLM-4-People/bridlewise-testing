/**
 * THE ONE READER OF "THIS SHELL TEXT INSTALLS SYSTEM PACKAGES FROM THE NETWORK".
 *
 * Three guards ask it (workflow-policy, the external-surface registry and the
 * guardian compiler pin), so they cannot disagree about a spelling (#333:
 * the CI toolchain is probed from the runner image, never installed). Each
 * used to carry its own regex, and each let a different spelling through:
 * options before the subcommand (`apt-get -o Acquire::Retries=3 install`), a
 * backslash-continued command (`apt-get \` / `install`), or a prefix
 * (`env DEBIAN_FRONTEND=noninteractive apt-get install`).
 *
 * The reading: line continuations are joined; the text is cut into commands
 * at newlines and `;`, `&&`, `||`, `|`; each command is tokenized (quotes
 * removed); a package manager is found ANYWHERE in it (after `sudo`, `env`,
 * assignments or options), and a subcommand anywhere after the manager.
 * Package names are the non-option tokens after the subcommand.
 */

const MANAGERS: ReadonlySet<string> = new Set(["apt-get", "apt", "aptitude", "yum", "dnf", "apk", "brew", "snap"]);
const SUBCOMMANDS: ReadonlySet<string> = new Set(["update", "install", "upgrade", "add", "dist-upgrade", "full-upgrade"]);

export type NetworkInstall = Readonly<{
  /** The package manager as spelled (`apt-get`). */
  manager: string;
  /** The subcommand found after it (`install`). */
  subcommand: string;
  /** The non-option tokens after the subcommand. */
  packages: readonly string[];
  /** The command from the manager on, whitespace-normalised (`apt-get install -y gcc-14`). */
  command: string;
  /** The whole command as written, continuations joined. */
  source: string;
}>;

/** The text's commands: continuations joined, cut at newlines and `;` `&&` `||` `|`. */
export function shellCommands(text: string): readonly string[] {
  return text
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n|;|&&|\|\||\|/u)
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && !command.startsWith("#"));
}

function tokens(command: string): readonly string[] {
  return command.split(/\s+/u).map((token) => token.replace(/^["']|["']$/gu, "")).filter((token) => token.length > 0);
}

/** Every system-package install, update or upgrade the text runs. */
export function networkInstalls(text: string): readonly NetworkInstall[] {
  const found: NetworkInstall[] = [];
  for (const source of shellCommands(text)) {
    const words = tokens(source);
    const managerAt = words.findIndex((word) => MANAGERS.has(word.slice(word.lastIndexOf("/") + 1)));
    if (managerAt === -1) continue;
    const subcommandAt = words.findIndex((word, index) => index > managerAt && SUBCOMMANDS.has(word));
    if (subcommandAt === -1) continue;
    const manager = words[managerAt]!;
    found.push({
      manager: manager.slice(manager.lastIndexOf("/") + 1),
      subcommand: words[subcommandAt]!,
      packages: words.slice(subcommandAt + 1).filter((word) => !word.startsWith("-") && !word.includes("=")),
      command: words.slice(managerAt).join(" "),
      source,
    });
  }
  return found;
}
