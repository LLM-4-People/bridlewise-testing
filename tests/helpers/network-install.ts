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
 * A command word that is a variable expansion (`$PM install`) is read as a
 * package manager unless the variable is a declared constant.
 *
 * The reading: line continuations are joined; the text is cut into commands
 * at newlines and `;`, `&&`, `||`, `|`; each command is tokenized (quotes
 * removed). A PROGRAM the reader cannot rule out is found ANYWHERE in it — a
 * named package manager, or any token that is an undeclared shell expansion
 * (`$PM`, `${PM:-apt-get}`, `${PM[0]}`, `$(…)`), whatever precedes it
 * (`sudo`, `timeout`, `nice`, `doas`, `xargs`, …: prefixes are not
 * enumerated) — and a subcommand anywhere after it. The string argument of
 * `eval` and of `sh|bash|dash|zsh -c` is read again as commands. Package
 * names are the non-option tokens after the subcommand.
 */

const MANAGERS: ReadonlySet<string> = new Set(["apt-get", "apt", "aptitude", "yum", "dnf", "apk", "brew", "snap"]);
const SUBCOMMANDS: ReadonlySet<string> = new Set(["update", "install", "upgrade", "add", "dist-upgrade", "full-upgrade"]);

/**
 * Variables that may stand before a subcommand without being read as a
 * package manager: each a DECLARED CONSTANT naming something else. Empty. An
 * expansion hides which program runs, so it is read as a package manager
 * unless it is the plain spelling (`$NAME`, `${NAME}`) of a name declared here.
 */
const DECLARED_COMMAND_VARIABLES: ReadonlySet<string> = new Set([]);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh"]);

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** A token the reader cannot see through: any `$…`, `${…}` or `$(…)` form, unless a declared plain variable. */
function undeclaredExpansion(word: string): boolean {
  if (!word.includes("$")) return false;
  const plain = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(word);
  const name = plain?.[1] ?? plain?.[2];
  return name === undefined || !DECLARED_COMMAND_VARIABLES.has(name);
}

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
  const found = new Map<string, NetworkInstall>();
  for (const source of shellCommands(text)) {
    const words = tokens(source);
    // A program the reader cannot rule out, anywhere: the first one a subcommand follows.
    for (let at = 0; at < words.length; at += 1) {
      const word = words[at]!;
      if (!MANAGERS.has(programName(word)) && !undeclaredExpansion(word)) continue;
      const subcommandAt = words.findIndex((candidate, index) => index > at && SUBCOMMANDS.has(candidate));
      if (subcommandAt === -1) continue;
      const command = words.slice(at).join(" ");
      found.set(command, {
        manager: MANAGERS.has(programName(word)) ? programName(word) : word,
        subcommand: words[subcommandAt]!,
        packages: words.slice(subcommandAt + 1).filter((candidate) => !candidate.startsWith("-") && !candidate.includes("=")),
        command,
        source,
      });
      break;
    }
    // The string an `eval` or a shell's `-c` runs is a command line of its own.
    for (let at = 0; at < words.length; at += 1) {
      const word = programName(words[at]!);
      const argumentAt = word === "eval"
        ? at + 1
        : SHELLS.has(word) ? words.findIndex((candidate, index) => index > at && /^-[A-Za-z]*c[A-Za-z]*$/u.test(candidate)) + 1 : 0;
      if (argumentAt <= 0 || argumentAt >= words.length) continue;
      for (const inner of networkInstalls(words.slice(argumentAt).join(" "))) found.set(inner.command, { ...inner, source });
    }
  }
  return [...found.values()];
}
