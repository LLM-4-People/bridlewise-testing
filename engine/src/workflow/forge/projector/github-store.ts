/**
 * THE GITHUB PROJECTION STORE — the projection store (`store.ts`) on the
 * forge port's client (`../port.ts` `ForgeClient`): the one place the
 * projector's objects become GitHub API calls, through the one adapter and
 * the one outbound door. It never sends a request of its own, never waits
 * and never retries: a refusal is the adapter's typed `ForgeError` (a budget
 * refusal carries when to resume), and the apply algorithm stops on it.
 *
 * How each class lives on GitHub:
 *
 *   - `milestone` — a milestone THE PROJECTOR CREATED (its creator is the
 *     publisher App's bot, read from the App registry) titled
 *     `<id> · <title>`, keyed by the id; two such milestones for one id are
 *     refused typed (`projection_store_duplicate_milestone`). A person's
 *     milestone is GitHub's own, whatever its title, and never written;
 *   - `issue` — an issue THE PROJECTOR OPENED (its author is the publisher
 *     App's bot) whose body carries the projector's marker (`itemMarker`),
 *     keyed by the marker's id. Anyone can open an issue and copy a marker
 *     into it; such an issue is never read as the projector's, so it can
 *     neither take over an item nor halt a run. Only that marker and what
 *     follows it is the git-owned `block`; a reporter's text above it is
 *     GitHub-owned and kept on every write. An issue without the marker is
 *     not the projector's and is not read. Its `parent` is the sub-issue
 *     link, its `blockedBy` the issue dependencies, its `pinned` the
 *     repository's pinned issues; another person's issue in a relation is
 *     spelled `#<number>`, which no key ever is, so it always differs from D.
 *     Its `labels` are names the projector never creates or claims: every
 *     label is declared in `docs/community/labels.json` and applied by
 *     `harness forge apply`. GitHub would create a missing label it is asked
 *     to put on an issue, so the store refuses that write typed
 *     (`projection_label_missing`) and sends each name as GitHub spells it
 *     (its names are case-insensitive).
 *
 * The relations and the pin are read in one paginated GraphQL query; every
 * other read is a conditional REST list (an unchanged page costs no rate
 * limit). A relation longer than one page is refused typed, never truncated.
 */
import { HarnessError } from "../../../kernel/errors.ts";
import { compareUtf8Bytes } from "../../../kernel/ordered.ts";
import type { ForgeClient } from "../port.ts";
import { FORGE_APPS } from "../app-registry.ts";
import { repositoryPath } from "../repository-reads.ts";
import { FIELD_PHASES, findItemMarker, type Fields, type Json, type ProjectionClass } from "./model.ts";
import type { LiveObject, ProjectionStore, ProjectionWrite } from "./store.ts";

export type GithubStoreOptions = Readonly<{
  /** `owner/name` of the repository the projection lives in. */
  repository: string;
  /** The most pages any one list read takes (`forge.request.maxPages`); a longer list is the adapter's typed refusal. */
  maxPages: number;
}>;

/** GitHub's largest page. */
const PAGE_SIZE = 100;
/** An owned milestone's title: `<id> · <title>`. */
const MILESTONE_TITLE = /^([A-Z][A-Z0-9-]*) · /u;
/** The login GitHub gives the publisher App's installation: the one author whose issues and milestones are the projector's. */
const PROJECTOR_LOGIN = `${FORGE_APPS.publisher.name}[bot]`;

/** The relations and the pin of every issue, a page at a time. */
const RELATIONS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${String(PAGE_SIZE)}, after: $cursor, states: [OPEN, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes { number isPinned parent { number } blockedBy(first: ${String(PAGE_SIZE)}) { totalCount nodes { number } } }
    }
  }
}`;

type RestLabel = Readonly<{ name: string }>;
type RestUser = Readonly<{ login: string }> | null | undefined;
type RestMilestone = Readonly<{ number: number; title: string; description: string | null; state: string; creator?: RestUser }>;
type RestIssue = Readonly<{
  id: number; node_id: string; number: number; title: string; body: string | null; state: string; state_reason: string | null;
  labels: readonly (Readonly<{ name: string }> | string)[]; milestone: Readonly<{ number: number }> | null; type?: Readonly<{ name: string }> | null;
  pull_request?: unknown; user?: RestUser;
}>;
type RelationNode = Readonly<{ number: number; isPinned: boolean; parent: Readonly<{ number: number }> | null; blockedBy: Readonly<{ totalCount: number; nodes: readonly Readonly<{ number: number }>[] }> }>;
type RelationsPage = Readonly<{ repository: Readonly<{ issues: Readonly<{ pageInfo: Readonly<{ hasNextPage: boolean; endCursor: string | null }>; nodes: readonly RelationNode[] }> }> | null }>;

/** What the store knows of one projected issue between its reads and writes. */
type IssueFacts = { number: number; id: number; nodeId: string; body: string; parent: number | null; blockedBy: number[] };

function refuse(code: string, message: string): never {
  throw new HarnessError(`${code}: ${message}`, code);
}

/** The ProjectionStore on `client` for `options.repository`. */
export function githubProjectionStore(client: ForgeClient, options: GithubStoreOptions): ProjectionStore {
  const base = repositoryPath(options.repository);
  const [owner, name] = options.repository.split("/") as [string, string];
  const issues = new Map<string, IssueFacts>();
  const keyOfNumber = new Map<number, string>();
  const milestones = new Map<string, number>();
  const keyOfMilestone = new Map<number, string>();
  /** Each label's name as GitHub holds it, by its case-insensitive key. */
  const labelNames = new Map<string, string>();

  const list = <T>(path: string, query: Readonly<Record<string, string>> = {}): Promise<readonly T[]> =>
    client.paginate<T>({ path: `${base}/${path}`, query }, { maxPages: options.maxPages, perPage: PAGE_SIZE });
  const spell = (number: number): string => keyOfNumber.get(number) ?? `#${String(number)}`;

  async function readMilestones(): Promise<LiveObject[]> {
    milestones.clear();
    keyOfMilestone.clear();
    return (await list<RestMilestone>("milestones", { state: "all" })).map((milestone): LiveObject => {
      const titled = MILESTONE_TITLE.exec(milestone.title);
      const fields = { title: milestone.title, description: milestone.description ?? "", state: milestone.state };
      // A person's milestone is GitHub's own whatever its title: it keys apart from every id and is never written.
      if (titled === null || milestone.creator?.login !== PROJECTOR_LOGIN) return { class: "milestone", key: `%${String(milestone.number)}`, owned: false, fields };
      const key = titled[1]!;
      if (milestones.has(key)) refuse("projection_store_duplicate_milestone", `milestones %${String(milestones.get(key))} and %${String(milestone.number)} are both the projector's ${key}`);
      milestones.set(key, milestone.number);
      keyOfMilestone.set(milestone.number, key);
      return { class: "milestone", key, owned: true, fields };
    });
  }

  async function relations(): Promise<Map<number, RelationNode>> {
    const byNumber = new Map<number, RelationNode>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= options.maxPages) refuse("projection_store_too_many_issues", `${options.repository} has more than ${String(options.maxPages * PAGE_SIZE)} issues (forge.request.maxPages)`);
      const answer: RelationsPage = await client.graphql<RelationsPage>(RELATIONS_QUERY, { owner, name, cursor });
      if (answer.repository === null) refuse("projection_store_repository_missing", `GraphQL answers no repository ${options.repository}`);
      for (const node of answer.repository.issues.nodes) {
        if (node.blockedBy.totalCount > node.blockedBy.nodes.length) refuse("projection_store_relation_truncated", `#${String(node.number)} is blocked by ${String(node.blockedBy.totalCount)} issues, more than one page`);
        byNumber.set(node.number, node);
      }
      if (!answer.repository.issues.pageInfo.hasNextPage) return byNumber;
      cursor = answer.repository.issues.pageInfo.endCursor;
    }
  }

  async function readIssues(): Promise<LiveObject[]> {
    issues.clear();
    keyOfNumber.clear();
    const marked = (await list<RestIssue>("issues", { state: "all" })).flatMap((issue) => {
      // A pull request is no issue; an issue the projector did not open is never its own, marker or not.
      if (issue.pull_request !== undefined || issue.user?.login !== PROJECTOR_LOGIN) return [];
      const body = issue.body ?? "";
      const marker = findItemMarker(body);
      return marker === null ? [] : [{ issue, body, key: marker.key, block: body.slice(marker.index) }];
    });
    for (const { issue, key } of marked) {
      if (keyOfNumber.has(issue.number)) continue;
      if (issues.has(key)) refuse("projection_store_duplicate_marker", `#${String(issues.get(key)!.number)} and #${String(issue.number)} both carry ${key}'s marker`);
      keyOfNumber.set(issue.number, key);
      issues.set(key, { number: issue.number, id: issue.id, nodeId: issue.node_id, body: issue.body ?? "", parent: null, blockedBy: [] });
    }
    const related = await relations();
    return marked.map(({ issue, key, block }) => {
      const relation = related.get(issue.number);
      const facts = issues.get(key)!;
      facts.parent = relation?.parent?.number ?? null;
      facts.blockedBy = (relation?.blockedBy.nodes ?? []).map((node) => node.number);
      const closed = issue.state === "closed";
      const fields: Fields = {
        title: issue.title,
        block,
        type: issue.type?.name ?? null,
        labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name).toLowerCase()).sort(compareUtf8Bytes),
        milestone: issue.milestone === null ? null : keyOfMilestone.get(issue.milestone.number) ?? `%${String(issue.milestone.number)}`,
        parent: facts.parent === null ? null : spell(facts.parent),
        blockedBy: facts.blockedBy.map(spell).sort(compareUtf8Bytes),
        state: issue.state,
        stateReason: closed ? issue.state_reason : null,
        pinned: relation?.isPinned ?? false,
      };
      return { class: "issue", key, owned: true, fields };
    });
  }

  function issueFacts(key: string): IssueFacts {
    return issues.get(key) ?? refuse("projection_store_unknown", `no issue carries ${key}'s marker (read the store first)`);
  }
  function milestoneNumber(value: Json): number | null {
    if (value === null) return null;
    return milestones.get(String(value)) ?? refuse("projection_store_unknown", `no milestone ${String(value)} (it is written before the issues that carry it)`);
  }

  /** Each label as GitHub spells it; one that does not exist is refused, never created by the issue write (labels.json and `forge apply` own them). */
  function existingLabels(value: Json, key: string): readonly string[] {
    const wanted = (value as readonly Json[]).map(String);
    const missing = wanted.filter((name) => !labelNames.has(name.toLowerCase()));
    if (missing.length > 0) refuse("projection_label_missing", `issue/${key} carries ${missing.join(", ")}, which ${options.repository} does not have: declare it in docs/community/labels.json and run harness forge apply (the projector creates no label)`);
    return wanted.map((name) => labelNames.get(name.toLowerCase())!);
  }

  async function writeMilestone(write: ProjectionWrite): Promise<void> {
    if (write.kind === "create") {
      const created = await client.rest<RestMilestone>({ method: "POST", path: `${base}/milestones`, body: { ...write.fields } });
      milestones.set(write.key, created.data.number);
      keyOfMilestone.set(created.data.number, write.key);
      return;
    }
    const number = milestones.get(write.key) ?? refuse("projection_store_unknown", `no milestone ${write.key}`);
    await client.rest({ method: "PATCH", path: `${base}/milestones/${String(number)}`, body: { ...write.fields } });
  }

  /** The REST body of an issue's own fields (`title`, `block`, `type`, `labels`, `milestone`, `state`, `stateReason`). */
  function issueBody(key: string, fields: Fields, previousBody: string): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if ("title" in fields) body.title = fields.title;
    if ("block" in fields) {
      // The reporter's text above the marker is GitHub-owned: it is kept.
      const marker = findItemMarker(previousBody);
      body.body = `${marker === null ? "" : previousBody.slice(0, marker.index)}${String(fields.block)}`;
    }
    if ("type" in fields) body.type = fields.type;
    if ("labels" in fields) body.labels = existingLabels(fields.labels!, key);
    if ("milestone" in fields) body.milestone = milestoneNumber(fields.milestone);
    if ("state" in fields) body.state = fields.state;
    if ("stateReason" in fields) body.state_reason = fields.stateReason;
    return body;
  }

  async function writeIssue(write: ProjectionWrite): Promise<void> {
    if (write.kind === "notice") {
      await client.rest({ method: "POST", path: `${base}/issues/${String(issueFacts(write.key).number)}/comments`, body: { body: String(write.fields.text) } });
      return;
    }
    if (write.kind === "create") {
      const created = await client.rest<RestIssue>({ method: "POST", path: `${base}/issues`, body: issueBody(write.key, write.fields, "") });
      issues.set(write.key, { number: created.data.number, id: created.data.id, nodeId: created.data.node_id, body: created.data.body ?? "", parent: null, blockedBy: [] });
      keyOfNumber.set(created.data.number, write.key);
      return;
    }
    const facts = issueFacts(write.key);
    const own = issueBody(write.key, write.fields, facts.body);
    if (Object.keys(own).length > 0) {
      const updated = await client.rest<RestIssue>({ method: "PATCH", path: `${base}/issues/${String(facts.number)}`, body: own });
      facts.body = updated.data.body ?? facts.body;
    }
    if ("parent" in write.fields) {
      const parent = write.fields.parent;
      if (parent === null) {
        if (facts.parent !== null) await client.rest({ method: "DELETE", path: `${base}/issues/${String(facts.parent)}/sub_issue`, body: { sub_issue_id: facts.id } });
        facts.parent = null;
      } else {
        const target = issueFacts(String(parent));
        // Already its parent: nothing to send.
        if (facts.parent !== target.number) await client.rest({ method: "POST", path: `${base}/issues/${String(target.number)}/sub_issues`, body: { sub_issue_id: facts.id, replace_parent: true } });
        facts.parent = target.number;
      }
    }
    if ("blockedBy" in write.fields) {
      const wanted = (write.fields.blockedBy as readonly Json[]).map((key) => issueFacts(String(key)));
      for (const blocker of wanted) {
        if (facts.blockedBy.includes(blocker.number)) continue;
        await client.rest({ method: "POST", path: `${base}/issues/${String(facts.number)}/dependencies/blocked_by`, body: { issue_id: blocker.id } });
      }
      const wantedNumbers = new Set(wanted.map((blocker) => blocker.number));
      for (const number of facts.blockedBy) {
        if (wantedNumbers.has(number)) continue;
        const id = [...issues.values()].find((other) => other.number === number)?.id
          ?? refuse("projection_store_unknown", `#${String(facts.number)} is blocked by #${String(number)}, which is not the projector's: it is a foreign change`);
        await client.rest({ method: "DELETE", path: `${base}/issues/${String(facts.number)}/dependencies/blocked_by/${String(id)}` });
      }
      facts.blockedBy = wanted.map((blocker) => blocker.number);
    }
    if ("pinned" in write.fields) {
      const mutation = write.fields.pinned === true ? "pinIssue" : "unpinIssue";
      await client.graphql(`mutation($issueId: ID!) { ${mutation}(input: { issueId: $issueId }) { issue { number } } }`, { issueId: facts.nodeId });
    }
  }

  return Object.freeze({
    read: async (classes: readonly ProjectionClass[]) => {
      const objects: LiveObject[] = [];
      // Labels and milestones are read whenever issues are: an issue's labels and milestone are spelled through them.
      if (classes.includes("issue")) {
        labelNames.clear();
        for (const label of await list<RestLabel>("labels")) labelNames.set(label.name.toLowerCase(), label.name);
      }
      if (classes.includes("milestone") || classes.includes("issue")) {
        const live = await readMilestones();
        if (classes.includes("milestone")) objects.push(...live);
      }
      if (classes.includes("issue")) objects.push(...await readIssues());
      return objects;
    },
    write: async (write: ProjectionWrite) => {
      const unknown = Object.keys(write.fields).filter((field) => write.kind !== "notice" && FIELD_PHASES[write.class][field] === undefined);
      if (unknown.length > 0) refuse("projection_store_field_unknown", `${write.class}/${write.key}: ${unknown.join(", ")} is not a git-owned field`);
      if (write.kind === "notice" && write.class !== "issue") refuse("projection_store_notice_unsupported", `a notice is an issue comment; ${write.class}/${write.key} has none`);
      if (write.class === "milestone") return writeMilestone(write);
      return writeIssue(write);
    },
  });
}
