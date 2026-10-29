/**
 * DEPENDABOT IS A SIGNAL, NEVER A COMMITTER — `harness deps adopt <pr>`.
 *
 * A Dependabot commit (its author the Dependabot app, its committer GitHub, no
 * sign-off) can never pass Commit records, and landing one would break the
 * identity and sign-off rule in force (GH-IDENTITY). So its pull request is
 * read as a SIGNAL and the bump is re-applied by the agent:
 *
 * 1. the pull request must be Dependabot's (its author the Dependabot app) and
 *    open, else `deps_not_dependabot` / `deps_pull_request_closed`;
 * 2. the bump is DERIVED FROM THE FILES, never the title: for npm, each
 *    `package.json` dependency-spec change (section, name, from → to); for
 *    GitHub Actions, each `uses: owner/repo@sha # version` change. Any other
 *    changed file or line refuses (`deps_bump_unrecognized`, naming it). A
 *    lockfile is never copied: the real resolver writes it;
 * 3. in an agent workspace the bump is applied to the trunk as it is now — a
 *    spec that moved on the trunk since Dependabot read it refuses
 *    (`deps_bump_drifted`) — then, for npm, the declared lockfile command and
 *    the declared install command run through the one command runner; for
 *    Actions, the pin moves in the external-surface registry (the one owner
 *    of action pins) and the workflows that use the action are rewritten
 *    from it. `harness sync` then regenerates every pin and inventory;
 * 4. the change is committed as the agent identity with sign-off, through the
 *    hooks, and published as the agent's pull request naming Dependabot's;
 * 5. only once the agent's pull request exists is Dependabot's closed, with a
 *    note linking it.
 */
import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";

/** The Dependabot app's login on a pull request it opens. */
export const DEPENDABOT_LOGIN = "dependabot[bot]";

/** The registry that owns every action pin (repository-relative). */
export const ACTION_PIN_REGISTRY = "tests/prevention/external-surface-registry.json";

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export type NpmChange = Readonly<{ section: DependencySection; name: string; from: string; to: string }>;
export type ActionChange = Readonly<{ action: string; fromSha: string; toSha: string; version: string }>;
export type Bump =
  | Readonly<{ ecosystem: "npm"; directory: string; changes: readonly NpmChange[] }>
  | Readonly<{ ecosystem: "github-actions"; changes: readonly ActionChange[] }>;

/** One changed file of the pull request: its path and its text before (base) and after (head); null where absent. */
export type ChangedFile = Readonly<{ path: string; before: string | null; after: string | null }>;

function refuse(code: string, message: string, details: Readonly<Record<string, string>> = {}): never {
  throw new HarnessError(message, code, false, details);
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function parseObject(text: string | null, path: string): Record<string, unknown> {
  if (text === null) refuse("deps_bump_unrecognized", `${path} is added or removed, not changed: a dependency bump changes a manifest in place`, { path });
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("deps_bump_unrecognized", `${path} is not a JSON object`, { path });
  return value as Record<string, unknown>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : inner);
}

/** The npm bump a `package.json` pair holds: only dependency specs may change; anything else refuses, named. */
function npmChanges(file: ChangedFile): readonly NpmChange[] {
  const before = parseObject(file.before, file.path);
  const after = parseObject(file.after, file.path);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: NpmChange[] = [];
  for (const key of keys) {
    if (!(DEPENDENCY_SECTIONS as readonly string[]).includes(key)) {
      if (canonical(before[key]) !== canonical(after[key])) refuse("deps_bump_unrecognized", `${file.path} changes its "${key}" field, which is not a dependency spec`, { path: file.path, field: key });
      continue;
    }
    const was = (before[key] ?? {}) as Record<string, unknown>;
    const now = (after[key] ?? {}) as Record<string, unknown>;
    const names = new Set([...Object.keys(was), ...Object.keys(now)]);
    for (const name of names) {
      const from = was[name];
      const to = now[name];
      if (from === to) continue;
      if (typeof from !== "string" || typeof to !== "string") refuse("deps_bump_unrecognized", `${file.path} adds or removes the ${key} entry "${name}": a bump changes an existing spec`, { path: file.path, field: `${key}.${name}` });
      changes.push({ section: key as DependencySection, name, from, to });
    }
  }
  if (changes.length === 0) refuse("deps_bump_unrecognized", `${file.path} changes no dependency spec`, { path: file.path });
  return changes;
}

/** One `uses:` line: the action, its pinned commit and its version comment. */
const USES_LINE = /^\s*-?\s*uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([0-9a-f]{40})\s*#\s*(\S+)\s*$/u;

/** The Actions bump a workflow pair holds: every changed line is a `uses:` pin of the same action; anything else refuses, named. */
function actionChanges(file: ChangedFile): readonly ActionChange[] {
  if (file.before === null || file.after === null) refuse("deps_bump_unrecognized", `${file.path} is added or removed, not changed`, { path: file.path });
  const was = file.before.split("\n");
  const now = file.after.split("\n");
  if (was.length !== now.length) refuse("deps_bump_unrecognized", `${file.path} adds or removes lines: an action bump only moves pins`, { path: file.path });
  const changes = new Map<string, ActionChange>();
  for (const [index, line] of was.entries()) {
    const next = now[index]!;
    if (line === next) continue;
    const from = USES_LINE.exec(line);
    const to = USES_LINE.exec(next);
    if (from === null || to === null || from[1] !== to[1]) refuse("deps_bump_unrecognized", `${file.path}:${String(index + 1)} is not an action pin moving to another commit of the same action`, { path: file.path, line: String(index + 1) });
    const change = { action: from[1]!, fromSha: from[2]!, toSha: to[2]!, version: to[3]! };
    const seen = changes.get(change.action);
    if (seen !== undefined && (seen.fromSha !== change.fromSha || seen.toSha !== change.toSha)) refuse("deps_bump_unrecognized", `${file.path} moves ${change.action} to two different commits`, { path: file.path, action: change.action });
    changes.set(change.action, change);
  }
  return [...changes.values()];
}

/**
 * THE BUMP A PULL REQUEST'S FILES HOLD, derived from the files, never the
 * title. npm: one directory's `package.json` (dependency specs only) and its
 * `package-lock.json` (never read: the resolver rewrites it). Actions:
 * workflow files whose changed lines are all `uses:` pins. Any other file, or
 * a mix of ecosystems, refuses.
 */
export function deriveBump(files: readonly ChangedFile[]): Bump {
  if (files.length === 0) refuse("deps_bump_unrecognized", "the pull request changes no file");
  const workflows = files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.path));
  if (workflows.length === files.length) {
    const merged = new Map<string, ActionChange>();
    for (const change of workflows.flatMap(actionChanges)) {
      const seen = merged.get(change.action);
      if (seen !== undefined && seen.toSha !== change.toSha) refuse("deps_bump_unrecognized", `${change.action} moves to two different commits across the workflows`, { action: change.action });
      merged.set(change.action, change);
    }
    if (merged.size === 0) refuse("deps_bump_unrecognized", "the workflows change no action pin");
    return deepFreeze({ ecosystem: "github-actions", changes: [...merged.values()] });
  }
  const manifests = files.filter((file) => /(?:^|\/)package\.json$/u.test(file.path));
  const directories = new Set(files.map((file) => directoryOf(file.path)));
  const other = files.filter((file) => !/(?:^|\/)package(?:-lock)?\.json$/u.test(file.path));
  if (other.length > 0) refuse("deps_bump_unrecognized", `the pull request changes ${other.map((file) => file.path).join(", ")}, which is no manifest or lockfile of a dependency bump`, { path: other[0]!.path });
  if (manifests.length !== 1 || directories.size !== 1) refuse("deps_bump_unrecognized", "a dependency bump changes one directory's package.json (and its lockfile)", { paths: files.map((file) => file.path).join(",") });
  return deepFreeze({ ecosystem: "npm", directory: directoryOf(manifests[0]!.path), changes: npmChanges(manifests[0]!) });
}

/**
 * The trunk's `package.json` with the bump applied, its other bytes kept: each
 * change's `"name": "from"` replaced in place. The trunk must still hold every
 * `from` (else `deps_bump_drifted`), and the result must parse to exactly the
 * trunk's object with the specs changed (a spec spelled twice refuses rather
 * than guessing which).
 */
export function applyNpmBump(text: string, changes: readonly NpmChange[], path: string): string {
  const trunk = parseObject(text, path);
  let applied = text;
  const expected = JSON.parse(text) as Record<string, Record<string, unknown>>;
  for (const change of changes) {
    if (((trunk[change.section] ?? {}) as Record<string, unknown>)[change.name] !== change.from) {
      refuse("deps_bump_drifted", `${path}'s ${change.section} entry "${change.name}" is no longer "${change.from}" on the trunk: Dependabot's bump no longer applies; let it rebase`, { path, name: change.name });
    }
    const spelled = `${JSON.stringify(change.name)}: ${JSON.stringify(change.from)}`;
    if (applied.split(spelled).length !== 2) refuse("deps_bump_unrecognized", `${path} spells "${change.name}": "${change.from}" other than exactly once`, { path, name: change.name });
    applied = applied.replace(spelled, `${JSON.stringify(change.name)}: ${JSON.stringify(change.to)}`);
    expected[change.section]![change.name] = change.to;
  }
  if (canonical(JSON.parse(applied)) !== canonical(expected)) refuse("deps_bump_unrecognized", `${path} did not take the bump in place`, { path });
  return applied;
}

type RegistryEntry = { id: string; kind: string; pinned?: { commit?: string; version?: string }; usedIn?: string[] };

/**
 * The registry with each action's pin moved (the one owner of action pins):
 * every changed action must be an entry pinned at `fromSha` on the trunk (else
 * `deps_bump_drifted`). Returns the registry text and the workflows to rewrite.
 */
export function moveActionPins(registryText: string, changes: readonly ActionChange[]): Readonly<{ text: string; workflows: readonly string[] }> {
  const registry = JSON.parse(registryText) as { entries?: RegistryEntry[] } & Record<string, unknown>;
  const entries = registry.entries ?? refuse("deps_bump_unrecognized", `${ACTION_PIN_REGISTRY} holds no entries`);
  const workflows = new Set<string>();
  for (const change of changes) {
    const entry = entries.find((candidate) => candidate.kind === "github-action" && candidate.id === change.action);
    if (entry === undefined) refuse("deps_bump_unrecognized", `${change.action} is not an action the external-surface registry pins`, { action: change.action });
    if (entry.pinned?.commit !== change.fromSha) refuse("deps_bump_drifted", `${change.action} is no longer pinned at ${change.fromSha} on the trunk: Dependabot's bump no longer applies`, { action: change.action });
    entry.pinned = { ...entry.pinned, commit: change.toSha, version: change.version };
    for (const path of entry.usedIn ?? []) workflows.add(path);
  }
  return deepFreeze({ text: `${JSON.stringify(registry, null, 2)}\n`, workflows: [...workflows].toSorted() });
}

/** A workflow's text with each changed action's `uses:` pin rewritten from the registry's new pin (`# version` kept in step). */
export function rewriteActionPins(text: string, changes: readonly ActionChange[]): string {
  return text.split("\n").map((line) => {
    const pin = USES_LINE.exec(line);
    const change = pin === null ? undefined : changes.find((candidate) => candidate.action === pin[1] && candidate.fromSha === pin[2]);
    return change === undefined ? line : line.replace(`${change.action}@${change.fromSha}`, `${change.action}@${change.toSha}`).replace(/#\s*\S+\s*$/u, `# ${change.version}`);
  }).join("\n");
}

/** What the adoption needs from the world: the forge, the workspace, the declared commands. */
export type DepsAdoptPorts = Readonly<{
  readPullRequest(number: number): Promise<Readonly<{ authorLogin: string; state: "open" | "closed"; baseSha: string; headSha: string; files: readonly Readonly<{ path: string }>[] }>>;
  readFileAt(path: string, ref: string): Promise<string | null>;
  /** A feature workspace for the agent, leasing `writeSet`; answers its id and worktree path. */
  createWorkspace(writeSet: readonly string[]): Promise<Readonly<{ id: string; worktree: string }>>;
  readWorkspaceFile(worktree: string, path: string): string;
  writeWorkspaceFile(worktree: string, path: string, text: string): void;
  /** One declared command (`bridlewise.config.json` `workspaceIsolation.commands`) through the one runner; a failure refuses. */
  runDeclaredCommand(worktree: string, name: string): Promise<void>;
  /** `harness sync` in the worktree. */
  sync(worktree: string): Promise<void>;
  /** Commit every change as the agent identity with sign-off, through the hooks. */
  commit(worktree: string, message: string): Promise<void>;
  /** Publish the workspace: answers the agent pull request it opened. */
  publish(id: string): Promise<Readonly<{ number: number }>>;
  closePullRequest(number: number, comment: string): Promise<void>;
}>;

export type AdoptReceipt = Readonly<{ dependabot: number; bump: Bump; workspace: string; agentPullRequest: number }>;

/** Per npm directory a bump may change, the declared commands it runs in order: the lockfile from the real resolver, then the install. */
const NPM_DIRECTORY_COMMANDS: Readonly<Record<string, readonly string[]>> = deepFreeze({ "": ["lockfile", "web-deps"], engine: ["engine-lockfile", "engine-deps"] });

/** The workspace's declared regenerate command the adoption syncs with. */
export const DEPS_ADOPT_SYNC_COMMAND = "harness-sync";

/** Every declared command the adoption runs (the dead-command check counts them as consumed). */
export const DEPS_ADOPT_COMMANDS: readonly string[] = deepFreeze([...new Set([...Object.values(NPM_DIRECTORY_COMMANDS).flat(), DEPS_ADOPT_SYNC_COMMAND])]);

/** The declared commands an npm bump in `directory` runs, in order. */
export function npmCommandsFor(directory: string): readonly string[] {
  return NPM_DIRECTORY_COMMANDS[directory] ?? refuse("deps_bump_unrecognized", `no declared commands resolve dependencies in ${directory}/`, { directory });
}

function describe(bump: Bump): string {
  return bump.ecosystem === "npm"
    ? bump.changes.map((change) => `${change.name} from ${change.from} to ${change.to}`).join(", ") + ` in /${bump.directory}`
    : bump.changes.map((change) => `${change.action} to ${change.version}`).join(", ");
}

/** THE ADOPTION (see the header): Dependabot's pull request `number` re-applied by the agent, and closed only after the agent's is open. */
export async function adoptDependabotPullRequest(number: number, ports: DepsAdoptPorts): Promise<AdoptReceipt> {
  const pull = await ports.readPullRequest(number);
  if (pull.authorLogin !== DEPENDABOT_LOGIN) refuse("deps_not_dependabot", `pull request #${String(number)} is by ${pull.authorLogin}, not Dependabot: only Dependabot's bumps are adopted`, { number: String(number) });
  if (pull.state !== "open") refuse("deps_pull_request_closed", `pull request #${String(number)} is closed: there is nothing to adopt`, { number: String(number) });
  const files = await Promise.all(pull.files.map(async ({ path }) => ({ path, before: await ports.readFileAt(path, pull.baseSha), after: await ports.readFileAt(path, pull.headSha) })));
  const bump = deriveBump(files);
  const manifest = bump.ecosystem === "npm" ? (bump.directory === "" ? "package.json" : `${bump.directory}/package.json`) : null;
  const writeSet = bump.ecosystem === "npm"
    ? [manifest!, manifest!.replace(/package\.json$/u, "package-lock.json")]
    : [ACTION_PIN_REGISTRY, ...pull.files.map((file) => file.path)];
  const workspace = await ports.createWorkspace(writeSet);
  if (bump.ecosystem === "npm") {
    ports.writeWorkspaceFile(workspace.worktree, manifest!, applyNpmBump(ports.readWorkspaceFile(workspace.worktree, manifest!), bump.changes, manifest!));
    for (const command of npmCommandsFor(bump.directory)) await ports.runDeclaredCommand(workspace.worktree, command);
  } else {
    const moved = moveActionPins(ports.readWorkspaceFile(workspace.worktree, ACTION_PIN_REGISTRY), bump.changes);
    ports.writeWorkspaceFile(workspace.worktree, ACTION_PIN_REGISTRY, moved.text);
    for (const workflow of moved.workflows) ports.writeWorkspaceFile(workspace.worktree, workflow, rewriteActionPins(ports.readWorkspaceFile(workspace.worktree, workflow), bump.changes));
  }
  await ports.sync(workspace.worktree);
  await ports.commit(workspace.worktree, `Adopt Dependabot #${String(number)}: bump ${describe(bump)}\n\nRe-applied by the agent from the pull request's files (harness deps adopt): Dependabot is a signal, never a committer.`);
  const agent = await ports.publish(workspace.id);
  await ports.closePullRequest(number, `Adopted as #${String(agent.number)} (\`harness deps adopt\`): the bump is re-applied by the agent identity through the hooks, with the lockfile from the real resolver. Dependabot is a signal here, never a committer.`);
  return deepFreeze({ dependabot: number, bump, workspace: workspace.id, agentPullRequest: agent.number });
}
