/**
 * GITHUB'S ISSUES ON THE FAKE GITHUB (`./fake-github.ts`), installed as its
 * routes for one repository: labels, milestones, issues (numbers, the
 * reporter's body, state and its reason, labels, milestone, issue type),
 * comments, sub-issues, issue dependencies, and the pinned issues — with
 * GitHub's answers: a list is paginated with a `Link` header and an ETag (a
 * matching `If-None-Match` is a 304, not counted), a missing object is 404, an
 * unknown label put on an issue is CREATED (as GitHub does), a sub-issue that already has a parent is 422 unless
 * the parent is replaced, a reopened issue's reason is `reopened`, and a
 * fourth pinned issue is a GraphQL error. The relations and pins are read
 * through the GraphQL `issues` connection, a page at a time.
 *
 * Not a test file: the projection store's tests (`github-store.test.ts`)
 * drive the forge adapter's own transport against it. `drops` plays a GitHub
 * that silently does not keep a field (V-28); `issues` is the state a test
 * edits directly to play a person's edit on GitHub (V-27).
 */
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import type { FakeAnswer, FakeGithub, FakeRequest } from "./fake-github.ts";

export type FakeIssue = {
  id: number; node_id: string; number: number; title: string; body: string | null;
  state: "open" | "closed"; state_reason: string | null;
  labels: { name: string }[]; milestone: { number: number } | null; type: { name: string } | null; user: { login: string };
  parent: number | null; blockedBy: number[]; pinned: boolean; comments: string[];
  /** Present on a pull request, which GitHub's issue list also answers. */
  pull_request?: Readonly<{ url: string }>;
};
export type FakeLabel = { name: string; color: string; description: string | null };
export type FakeMilestone = { number: number; title: string; description: string | null; state: "open" | "closed"; creator: { login: string } };

export type FakeIssues = Readonly<{
  /** By name in lower case: GitHub's label names are case-insensitive. */
  labels: Map<string, FakeLabel>;
  milestones: Map<number, FakeMilestone>;
  issues: Map<number, FakeIssue>;
  /** An issue another account opened (`login`, default a person): it may carry a copied marker. */
  open: (input: Readonly<{ title: string; body: string; login?: string }>) => FakeIssue;
  /** A milestone another account created. */
  milestone: (input: Readonly<{ title: string; login?: string }>) => FakeMilestone;
}>;

export type FakeIssuesOptions = Readonly<{
  /** Fields accepted and silently not kept, as `issue.type`. */
  drops?: readonly string[];
}>;

/** GitHub's largest number of pinned issues. */
const PIN_LIMIT = 3;

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): FakeAnswer {
  return { status, body, headers };
}

/** Installs `owner/name`'s issues on `fake`. */
export function installIssues(fake: FakeGithub, repository: string, options: FakeIssuesOptions = {}): FakeIssues {
  const base = `/repos/${repository}`;
  const labels = new Map<string, FakeLabel>();
  const milestones = new Map<number, FakeMilestone>();
  const issues = new Map<number, FakeIssue>();
  let nextNumber = 1;
  let nextId = 9_000;
  const dropped = (field: string): boolean => (options.drops ?? []).includes(field);
  const escaped = (path: string): RegExp => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}${path}$`, "u");

  /** One page of `items` with GitHub's `Link` header and an ETag. */
  function page(request: FakeRequest, items: readonly unknown[]): FakeAnswer {
    const perPage = Number(request.query.get("per_page") ?? "30");
    const number = Number(request.query.get("page") ?? "1");
    const slice = items.slice((number - 1) * perPage, number * perPage);
    const etag = `W/"${sha256(canonicalJson({ slice, number, perPage })).slice(0, 32)}"`;
    const headers: Record<string, string> = { etag };
    if (number * perPage < items.length) {
      const next = new URLSearchParams(request.query);
      next.set("page", String(number + 1));
      headers.link = `<${fake.apiUrl}${request.path}?${next.toString()}>; rel="next"`;
    }
    if (request.headers.get("if-none-match") === etag) return { status: 304, headers };
    return json(200, slice, headers);
  }

  const restIssue = (issue: FakeIssue): unknown => {
    const { parent: _parent, blockedBy: _blockedBy, pinned: _pinned, comments: _comments, ...rest } = issue;
    return rest;
  };
  const byId = (id: unknown): FakeIssue | undefined => [...issues.values()].find((issue) => issue.id === id);

  const PERSON = "a-person";
  const author = (request: FakeRequest): string => fake.principalOf(request) ?? "unknown";

  function create(input: Readonly<{ title: string; body: string | null; login: string }>): FakeIssue {
    const issue: FakeIssue = {
      id: nextId++, node_id: `I_${String(nextId)}`, number: nextNumber++, title: input.title, body: input.body,
      state: "open", state_reason: null, labels: [], milestone: null, type: null, user: { login: input.login }, parent: null, blockedBy: [], pinned: false, comments: [],
    };
    issues.set(issue.number, issue);
    return issue;
  }

  /**
   * Applies a create or update body to `issue` as GitHub does: an unknown
   * milestone is 422, but an unknown LABEL is created on the way (default
   * colour, no description) — the write the projector must never make.
   */
  function apply(issue: FakeIssue, body: Record<string, unknown>): FakeAnswer | undefined {
    if ("title" in body) issue.title = String(body.title);
    if ("body" in body) issue.body = body.body === null ? null : String(body.body);
    if ("labels" in body) {
      const names = body.labels as string[];
      for (const name of names) if (!labels.has(name.toLowerCase())) labels.set(name.toLowerCase(), { name, color: "ededed", description: null });
      issue.labels = names.map((name) => ({ name: labels.get(name.toLowerCase())!.name }));
    }
    if ("milestone" in body) {
      if (body.milestone !== null && !milestones.has(Number(body.milestone))) return json(422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "milestone", code: "invalid" }] });
      issue.milestone = body.milestone === null ? null : { number: Number(body.milestone) };
    }
    if ("type" in body && !dropped("issue.type")) issue.type = body.type === null ? null : { name: String(body.type) };
    if ("state" in body) {
      const reopened = issue.state === "closed" && body.state === "open";
      issue.state = body.state as FakeIssue["state"];
      if (reopened) issue.state_reason = "reopened";
      if (issue.state === "closed" && !("state_reason" in body)) issue.state_reason = "completed";
    }
    if ("state_reason" in body) issue.state_reason = body.state_reason === null ? null : String(body.state_reason);
    return undefined;
  }

  fake.route("GET", escaped("/labels"), (request) => page(request, [...labels.values()]));

  fake.route("GET", escaped("/milestones"), (request) => page(request, [...milestones.values()].filter((milestone) => request.query.get("state") === "all" || milestone.state === (request.query.get("state") ?? "open"))));
  fake.route("POST", escaped("/milestones"), (request) => {
    const body = request.body as Partial<FakeMilestone>;
    if ([...milestones.values()].some((other) => other.title === body.title)) return json(422, { message: "Validation Failed", errors: [{ resource: "Milestone", code: "already_exists", field: "title" }] });
    const milestone: FakeMilestone = { number: milestones.size + 1, title: String(body.title), description: body.description ?? null, state: body.state ?? "open", creator: { login: author(request) } };
    milestones.set(milestone.number, milestone);
    return json(201, milestone);
  });
  fake.route("PATCH", escaped("/milestones/(\\d+)"), (request, match) => {
    const milestone = milestones.get(Number(match[1]));
    if (milestone === undefined) return json(404, { message: "Not Found" });
    Object.assign(milestone, request.body as object);
    return json(200, milestone);
  });

  fake.route("GET", escaped("/issues"), (request) => page(request, [...issues.values()]
    .filter((issue) => request.query.get("state") === "all" || issue.state === (request.query.get("state") ?? "open"))
    .sort((left, right) => right.number - left.number).map(restIssue)));
  fake.route("POST", escaped("/issues"), (request) => {
    const body = request.body as Record<string, unknown>;
    const issue = create({ title: String(body.title), body: (body.body as string | undefined) ?? null, login: author(request) });
    const refused = apply(issue, body);
    if (refused !== undefined) { issues.delete(issue.number); return refused; }
    return json(201, restIssue(issue));
  });
  fake.route("PATCH", escaped("/issues/(\\d+)"), (request, match) => {
    const issue = issues.get(Number(match[1]));
    if (issue === undefined) return json(404, { message: "Not Found" });
    return apply(issue, request.body as Record<string, unknown>) ?? json(200, restIssue(issue));
  });
  fake.route("POST", escaped("/issues/(\\d+)/comments"), (request, match) => {
    const issue = issues.get(Number(match[1]));
    if (issue === undefined) return json(404, { message: "Not Found" });
    issue.comments.push(String((request.body as { body: string }).body));
    return json(201, { id: nextId++, body: issue.comments.at(-1) });
  });
  fake.route("POST", escaped("/issues/(\\d+)/sub_issues"), (request, match) => {
    const parent = issues.get(Number(match[1]));
    const body = request.body as { sub_issue_id: number; replace_parent?: boolean };
    const child = byId(body.sub_issue_id);
    if (parent === undefined || child === undefined) return json(404, { message: "Not Found" });
    if (child.parent !== null && body.replace_parent !== true) return json(422, { message: "Validation Failed: the issue already has a parent" });
    child.parent = parent.number;
    return json(201, restIssue(parent));
  });
  fake.route("DELETE", escaped("/issues/(\\d+)/sub_issue"), (request, match) => {
    const child = byId((request.body as { sub_issue_id: number }).sub_issue_id);
    if (child === undefined || child.parent !== Number(match[1])) return json(404, { message: "Not Found" });
    child.parent = null;
    return json(200, restIssue(issues.get(Number(match[1]))!));
  });
  fake.route("POST", escaped("/issues/(\\d+)/dependencies/blocked_by"), (request, match) => {
    const issue = issues.get(Number(match[1]));
    const blocker = byId((request.body as { issue_id: number }).issue_id);
    if (issue === undefined || blocker === undefined) return json(404, { message: "Not Found" });
    if (!issue.blockedBy.includes(blocker.number)) issue.blockedBy.push(blocker.number);
    return json(201, restIssue(blocker));
  });
  fake.route("DELETE", escaped("/issues/(\\d+)/dependencies/blocked_by/(\\d+)"), (_request, match) => {
    const issue = issues.get(Number(match[1]));
    const blocker = byId(Number(match[2]));
    if (issue === undefined || blocker === undefined || !issue.blockedBy.includes(blocker.number)) return json(404, { message: "Not Found" });
    issue.blockedBy = issue.blockedBy.filter((number) => number !== blocker.number);
    return json(200, restIssue(blocker));
  });

  fake.route("POST", /^\/graphql$/u, (request) => {
    const { query, variables } = request.body as { query: string; variables: Record<string, unknown> };
    const pin = /\b(pinIssue|unpinIssue)\(/u.exec(query);
    if (pin !== null) {
      const issue = [...issues.values()].find((candidate) => candidate.node_id === variables.issueId);
      if (issue === undefined) return json(200, { data: null, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${String(variables.issueId)}'` }] });
      if (pin[1] === "pinIssue" && !issue.pinned && [...issues.values()].filter((candidate) => candidate.pinned).length >= PIN_LIMIT) {
        return json(200, { data: null, errors: [{ type: "UNPROCESSABLE", message: `A repository can pin at most ${String(PIN_LIMIT)} issues` }] });
      }
      issue.pinned = pin[1] === "pinIssue";
      return json(200, { data: { [pin[1]!]: { issue: { number: issue.number } } } });
    }
    if (!/\bissues\(first: (\d+)/u.test(query) || `${String(variables.owner)}/${String(variables.name)}` !== repository) return undefined;
    const size = Number(/\bissues\(first: (\d+)/u.exec(query)![1]);
    const relationSize = Number(/\bblockedBy\(first: (\d+)/u.exec(query)?.[1] ?? "0");
    const all = [...issues.values()].sort((left, right) => left.number - right.number);
    const start = variables.cursor === null || variables.cursor === undefined ? 0 : Number(variables.cursor);
    const slice = all.slice(start, start + size);
    return json(200, { data: { repository: { issues: {
      pageInfo: { hasNextPage: start + size < all.length, endCursor: slice.length === 0 ? null : String(start + slice.length) },
      nodes: slice.map((issue) => ({
        number: issue.number, isPinned: issue.pinned, parent: issue.parent === null ? null : { number: issue.parent },
        blockedBy: { totalCount: issue.blockedBy.length, nodes: issue.blockedBy.slice(0, relationSize).map((number) => ({ number })) },
      })),
    } } } });
  });

  return Object.freeze({
    labels, milestones, issues,
    open: (input) => create({ title: input.title, body: input.body, login: input.login ?? PERSON }),
    milestone: (input) => {
      const planted: FakeMilestone = { number: milestones.size + 1, title: input.title, description: null, state: "open", creator: { login: input.login ?? PERSON } };
      milestones.set(planted.number, planted);
      return planted;
    },
  });
}
