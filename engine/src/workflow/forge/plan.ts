/**
 * `harness forge plan|apply|audit` — settings as code (github-only §3.4;
 * runbook P2.1, P2.3):
 *
 * - PLAN reads every declared object (`declarations.ts`) from GitHub through
 *   its kind's adapter (`live-state.ts`), resolves its references (App,
 *   installation, team and user ids, by the registry's names), and answers
 *   one entry per object: `create`, `update` (with the JSON pointers that
 *   differ), `unchanged`, or `refused` (its typed code: a reference GitHub
 *   does not have yet, a permission, a plan). Fields the plan does not allow
 *   are listed per object (`unavailable_on_plan`), never written. Live
 *   objects nobody declared are listed too (`unmanaged`; drift for the
 *   exclusive kinds: rulesets and autolinks), and the declared retired ones
 *   (`retire`).
 *   A ruleset that would newly require a status check refuses that check
 *   until it has reported on the repository's default branch (its latest
 *   commit's check runs and statuses): `forge_required_check_unreported`.
 *   A required check nobody runs would block every pull request.
 * - APPLY sends exactly that plan, in declaration order, and only a whole
 *   plan (a refused entry refuses the apply: `forge_plan_incomplete`); then
 *   it plans again and answers the verification: nothing left to change.
 * - AUDIT is the plan, read-only, judged: any create, update, refused or
 *   exclusive unmanaged entry is drift (`forge.drift`).
 *
 * Nothing here waits or retries: a budget refusal (rate limit, content
 * budget) stops the run typed, with when to resume.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import { FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError, isForgeError, type ForgeCode } from "./codes.ts";
import { differences, referenceKey, referencesOf, resolveReferences, scopeName, writableBody, type ForgeObject, type ForgeObjectKind, type ForgeReference, type ForgeScope } from "./forge-state.ts";
import { FORGE_LOG_CATEGORY } from "./github.ts";
import { EXCLUSIVE_KINDS, KIND_ADAPTERS, type LiveContext, type LiveObject } from "./live-state.ts";
import { looseningOf, movedPremisesUnmet } from "./strictness.ts";

export type PlanAction = "create" | "update" | "unchanged" | "refused" | "unmanaged" | "retire";

export type PlanEntry = Readonly<{
  kind: ForgeObjectKind;
  scope: string;
  key: string;
  action: PlanAction;
  /** `update`: the JSON pointers where GitHub differs from the declaration. */
  differences?: readonly string[];
  /** Declared fields the plan does not allow (recorded, never written). */
  unavailableOnPlan?: readonly string[];
  /** `refused`: the typed code and its message. */
  code?: ForgeCode;
  message?: string;
  /** An `update` or `retire` that weakens a protection: what it weakens (never applied without its acknowledgement unless it only MOVES rules into the verified org baseline). */
  loosening?: readonly string[];
  /** The loosening only moves rules the org baseline (declared, and verified after it is applied) carries for this repository. */
  moved?: boolean;
}>;

export type ForgePlan = Readonly<{
  entries: readonly PlanEntry[];
  counts: Readonly<Record<PlanAction, number>>;
  /** Whether every declared object could be planned (no `refused` entry). */
  complete: boolean;
  /** The drift an audit reports: every entry that is not `unchanged`, except unmanaged objects of non-exclusive kinds. */
  drift: readonly PlanEntry[];
}>;

export type RetiredObject = Readonly<{ kind: "ruleset"; repository: string; name: string }>;

type Installation = Readonly<{ id: number; app_id: number; app_slug: string }>;

/** Resolve every reference the objects hold; an unresolvable one is absent from the map. */
async function resolveAll(context: LiveContext, objects: readonly ForgeObject[]): Promise<ReadonlyMap<string, number>> {
  const references = new Map<string, ForgeReference>();
  for (const object of objects) for (const reference of referencesOf(object.desired)) references.set(referenceKey(reference), reference);
  const resolved = new Map<string, number>();
  let installations: readonly Installation[] | undefined;
  const installationOf = async (role: string): Promise<Installation | undefined> => {
    installations ??= await context.client.paginate<Installation>({ path: `/orgs/${encodeURIComponent(context.organization)}/installations` },
      { maxPages: context.maxPages, perPage: 100, items: (data) => (data as { installations?: Installation[] }).installations ?? [] });
    const slug = FORGE_APPS[role as ForgeAppRole]?.name;
    return installations.find((entry) => entry.app_slug === slug);
  };
  for (const [key, reference] of references) {
    try {
      if (reference.$ref === "app") {
        const found = await installationOf(reference.name);
        if (found !== undefined) resolved.set(key, found.app_id);
      } else if (reference.$ref === "installation") {
        const found = await installationOf(reference.name);
        if (found !== undefined) resolved.set(key, found.id);
      } else {
        const path = reference.$ref === "team"
          ? `/orgs/${encodeURIComponent(context.organization)}/teams/${encodeURIComponent(reference.name)}`
          : `/users/${encodeURIComponent(reference.name)}`;
        const answer = await context.client.rest<{ id?: number }>({ method: "GET", path });
        if (typeof answer.data?.id === "number") resolved.set(key, answer.data.id);
      }
    } catch (error) {
      if (!isForgeError(error, "github_not_found")) throw error;
    }
  }
  return resolved;
}

/** A refusal that belongs to one object (its own permission, plan or validation), never one that stops the run. */
function objectRefusal(error: unknown): ForgeError | undefined {
  if (!isForgeError(error)) return undefined;
  const kind = error.forgeClass;
  return kind === "refused" || kind === "input" ? error : undefined;
}

type Planned = Readonly<{ object: ForgeObject; entry: PlanEntry; body?: unknown; found?: LiveObject }>;

async function planObjects(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[]): Promise<Readonly<{ planned: readonly Planned[]; extra: readonly PlanEntry[]; retiredFound: readonly Readonly<{ retired: RetiredObject; found: LiveObject }>[] }>> {
  const resolved = await resolveAll(context, objects);
  /** The declared org baseline, its references resolved: what a move into it is judged against at plan time. */
  const baseline = baselineObject(objects);
  const declaredBaseline = baseline === undefined ? undefined : resolveReferences(baseline.desired, resolved);
  const planned: Planned[] = [];
  for (const object of objects) {
    const base = { kind: object.kind, scope: scopeName(object.scope), key: object.key, ...(object.unavailableOnPlan.length === 0 ? {} : { unavailableOnPlan: object.unavailableOnPlan }) };
    const missing = referencesOf(object.desired).filter((reference) => !resolved.has(referenceKey(reference)));
    if (missing.length > 0) {
      planned.push({ object, entry: deepFreeze({ ...base, action: "refused", code: "forge_reference_unresolved", message: `GitHub has no ${missing.map(referenceKey).join(", ")} yet.` }) });
      continue;
    }
    const body = writableBody(object, resolveReferences(object.desired, resolved));
    try {
      const found = await KIND_ADAPTERS[object.kind].read(context, object);
      // A required check is added only once it has reported on main: one nobody runs blocks every pull request.
      const unreported = await unreportedRequiredChecks(context, objects, object, body, found);
      if (unreported.length > 0) {
        planned.push({ object, entry: deepFreeze({ ...base, action: "refused", code: "forge_required_check_unreported", message: `It would require ${unreported.map((check) => `"${check}"`).join(", ")}, which never reported on the default branch's latest commit: a required check that never reports blocks every pull request.` }) });
        continue;
      }
      if (found === undefined) {
        planned.push({ object, entry: deepFreeze({ ...base, action: "create" }), body });
        continue;
      }
      const differing = differences(body, found.live);
      const loosening = differing.length === 0 ? [] : looseningOf(object.kind, body, found.live);
      const moved = loosening.length > 0 && object.kind === "ruleset" && object.scope.kind === "repo"
        && movedPremisesUnmet(loosening, found.live, declaredBaseline, declaredKindOf(objects, object.scope.repository)).length === 0;
      planned.push({ object, body, found, entry: deepFreeze({
        ...base, action: differing.length === 0 ? "unchanged" : "update",
        ...(differing.length === 0 ? {} : { differences: differing }),
        ...(loosening.length === 0 ? {} : { loosening, moved }),
      }) });
    } catch (error) {
      const refusal = objectRefusal(error);
      if (refusal === undefined) throw error;
      planned.push({ object, entry: deepFreeze({ ...base, action: "refused", code: refusal.forgeCode, message: refusal.message }) });
    }
  }
  // Undeclared live objects, per kind and scope that can list them.
  const extra: PlanEntry[] = [];
  const scopes = new Map<string, Readonly<{ kind: ForgeObjectKind; scope: ForgeScope }>>();
  for (const object of objects) if (KIND_ADAPTERS[object.kind].names !== undefined) scopes.set(`${object.kind} ${scopeName(object.scope)}`, { kind: object.kind, scope: object.scope });
  const retiredFound: { retired: RetiredObject; found: LiveObject }[] = [];
  for (const { kind, scope } of scopes.values()) {
    const declared = new Set(objects.filter((object) => object.kind === kind && scopeName(object.scope) === scopeName(scope)).map((object) => object.key));
    let names: readonly string[];
    try { names = await KIND_ADAPTERS[kind].names!(context, scope); } catch (error) {
      if (objectRefusal(error) === undefined) throw error;
      continue;
    }
    for (const name of names) {
      if (declared.has(name)) continue;
      const retiredEntry = retired.find((entry) => entry.kind === kind && scope.kind === "repo" && entry.repository === scope.repository && entry.name === name);
      if (retiredEntry !== undefined) {
        const found = await KIND_ADAPTERS[kind].read(context, { kind, scope, key: name, file: "", desired: {}, unavailableOnPlan: [] });
        if (found !== undefined) retiredFound.push({ retired: retiredEntry, found });
        extra.push(deepFreeze({ kind, scope: scopeName(scope), key: name, action: "retire", loosening: ["deletes the ruleset"], moved: false }));
      } else {
        extra.push(deepFreeze({ kind, scope: scopeName(scope), key: name, action: "unmanaged" }));
      }
    }
  }
  return { planned, extra, retiredFound };
}

/** A required status check: its context and, when declared, the App (integration) that must report it. */
type RequiredCheck = Readonly<{ context: string; integrationId: number | undefined }>;

/** The required status checks a ruleset body holds (none for another kind). */
function requiredChecks(body: unknown): readonly RequiredCheck[] {
  const rules = (body as { rules?: unknown } | undefined)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((rule: { type?: unknown; parameters?: { required_status_checks?: unknown } }) => {
    if (rule.type !== "required_status_checks" || !Array.isArray(rule.parameters?.required_status_checks)) return [];
    return (rule.parameters.required_status_checks as { context?: unknown; integration_id?: unknown }[]).flatMap((check) => typeof check.context === "string"
      ? [{ context: check.context, integrationId: typeof check.integration_id === "number" ? check.integration_id : undefined }]
      : []);
  });
}

const checkKey = (check: RequiredCheck): string => `${check.context}\u0000${String(check.integrationId ?? "")}`;

/** The repository a ruleset's checks report on: its own, or for the org baseline the trunk (the repository whose declared `kind` is `trunk`). */
function reportingRepository(objects: readonly ForgeObject[], object: ForgeObject): string | undefined {
  if (object.scope.kind === "repo") return object.scope.repository;
  const trunk = objects.find((candidate) => candidate.kind === "custom-property-values" && candidate.scope.kind === "repo" && (candidate.desired as { kind?: unknown }).kind === "trunk");
  return trunk?.scope.kind === "repo" ? trunk.scope.repository : undefined;
}

/**
 * THE SEQUENCING BARRIER OF A REQUIRED CHECK: the contexts `object` would
 * newly require (declared, not live) that have never reported on its
 * repository's default branch, judged by that branch's latest commit's
 * check runs and commit statuses, read from GitHub now. A check declared
 * with an integration is matched by name AND App id (a check run from that
 * App); one without by name. A check already required live, or one that
 * has reported, passes.
 */
async function unreportedRequiredChecks(context: LiveContext, objects: readonly ForgeObject[], object: ForgeObject, body: unknown, found: LiveObject | undefined): Promise<readonly string[]> {
  if (object.kind !== "ruleset" && object.kind !== "org-ruleset") return [];
  const live = new Set(requiredChecks(found?.live).map(checkKey));
  const added = requiredChecks(body).filter((check) => !live.has(checkKey(check)));
  if (added.length === 0) return [];
  const repository = reportingRepository(objects, object);
  if (repository === undefined) throw new ForgeError("forge_declaration_invalid", `${object.kind} ${object.key} requires checks, and no repository is declared the trunk to judge where they report.`, { key: object.key });
  const path = `/repos/${encodeURIComponent(context.organization)}/${encodeURIComponent(repository)}`;
  const branch = (await context.client.rest<{ default_branch?: unknown }>({ method: "GET", path })).data?.default_branch;
  if (typeof branch !== "string" || branch === "") throw new ForgeError("github_response_invalid", `GET ${path}: the repository answers no default branch.`, { path });
  const head = `${path}/commits/${branch}`;
  type CheckRun = Readonly<{ name?: unknown; app?: Readonly<{ id?: unknown }> | null }>;
  const runs = await context.client.paginate<CheckRun>({ path: `${head}/check-runs`, query: { filter: "latest" } }, { maxPages: context.maxPages, perPage: 100, items: (data) => (data as { check_runs?: readonly CheckRun[] }).check_runs ?? [] });
  const statuses = await context.client.paginate<{ context?: unknown }>({ path: `${head}/statuses` }, { maxPages: context.maxPages, perPage: 100 });
  // A check declared with an integration is met only by a check run of that name FROM that App (a same-named check or a
  // commit status from anyone else does not count: a status carries no App id to match). One declared without an
  // integration is met by any check run or status of that name.
  const reported = (check: RequiredCheck): boolean => check.integrationId === undefined
    ? runs.some((run) => run.name === check.context) || statuses.some((status) => status.context === check.context)
    : runs.some((run) => run.name === check.context && run.app?.id === check.integrationId);
  return added.filter((check) => !reported(check)).map((check) => check.integrationId === undefined ? check.context : `${check.context} (integration ${String(check.integrationId)})`);
}

/** The id a loosening is acknowledged by: `<kind>:<scope>:<key>`. */
function looseningId(entry: Readonly<{ kind: string; scope: string; key: string }>): string {
  return `${entry.kind}:${entry.scope}:${entry.key}`;
}

/** The declared org baseline ruleset (one, by the declarations). */
function baselineObject(objects: readonly ForgeObject[]): ForgeObject | undefined {
  return objects.find((object) => object.kind === "org-ruleset");
}

/** The declared custom-property values object of `repository`. */
function propertyValuesObject(objects: readonly ForgeObject[], repository: string): ForgeObject | undefined {
  return objects.find((object) => object.kind === "custom-property-values" && object.scope.kind === "repo" && object.scope.repository === repository);
}

/** A repository's declared `kind` (the custom property value). */
function declaredKindOf(objects: readonly ForgeObject[], repository: string): string | undefined {
  return (propertyValuesObject(objects, repository)?.desired as { kind?: string } | undefined)?.kind;
}

/**
 * THE MOVE'S PREMISES, READ FROM GITHUB: before any loosening is written,
 * each moved one is judged again against what GitHub holds now, never
 * against the declarations. That means the repository's live `kind`
 * property, the live org baseline (its enforcement, target, conditions,
 * bypass actors and rules), and the live repository ruleset being
 * loosened. Every unmet premise is named, by loosening id.
 */
async function liveMovePremisesUnmet(context: LiveContext, objects: readonly ForgeObject[], moves: readonly Planned[]): Promise<readonly string[]> {
  const unmet: string[] = [];
  const baseline = baselineObject(objects);
  const liveBaseline = baseline === undefined ? undefined : (await KIND_ADAPTERS[baseline.kind].read(context, baseline))?.live;
  for (const { object, body, entry } of moves) {
    const id = looseningId(entry);
    const repository = object.scope.kind === "repo" ? object.scope.repository : "";
    const values = propertyValuesObject(objects, repository);
    const liveKind = values === undefined ? undefined : ((await KIND_ADAPTERS[values.kind].read(context, values))?.live as { kind?: unknown } | undefined)?.kind;
    const liveRuleset = (await KIND_ADAPTERS[object.kind].read(context, object))?.live;
    if (liveRuleset === undefined) { unmet.push(`${id}: the ruleset is gone from GitHub`); continue; }
    const reasons = looseningOf(object.kind, body, liveRuleset);
    unmet.push(...movedPremisesUnmet(reasons, liveRuleset, liveBaseline, typeof liveKind === "string" ? liveKind : undefined).map((premise) => `${id}: ${premise}`));
  }
  return unmet;
}

function summarize(entries: readonly PlanEntry[]): ForgePlan {
  const counts = { create: 0, update: 0, unchanged: 0, refused: 0, unmanaged: 0, retire: 0 };
  for (const entry of entries) counts[entry.action] += 1;
  const drift = entries.filter((entry) => entry.action !== "unchanged" && (entry.action !== "unmanaged" || EXCLUSIVE_KINDS.has(entry.kind)));
  return deepFreeze({ entries, counts, complete: counts.refused === 0, drift });
}

/** PLAN (read-only). */
export async function forgePlan(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[]): Promise<ForgePlan> {
  const { planned, extra } = await planObjects(context, objects, retired);
  return summarize([...planned.map((entry) => entry.entry), ...extra]);
}

export type ForgeApplyResult = Readonly<{
  applied: readonly PlanEntry[];
  /** The loosenings applied on the maintainer's explicit acknowledgement (`--accept-loosening <id>`): the receipt of each. */
  acceptedLoosening: readonly Readonly<{ id: string; loosening: readonly string[] }>[];
  /** The loosenings that only moved rules into the org baseline, applied after the baseline was read back and verified. */
  movedLoosening: readonly string[];
  /** The post-apply audit: a fresh plan of everything declared. */
  verification: ForgePlan;
  /** THE VERDICT: the post-apply audit found no drift. An apply that left any drift (a write GitHub ignored, an exclusive object nobody declared) has failed. */
  verified: boolean;
}>;

/**
 * APPLY, TIGHTEN-FIRST (the review's ruling, §3.4):
 * 1. the whole plan is checked first: a refused entry refuses the apply, and
 *    so does a loosening that is neither acknowledged (`accepted`, by
 *    {@link looseningId}) nor a pure move into the org baseline — before
 *    anything is written;
 * 2. every create and every update that loosens nothing is applied, in
 *    declaration order (the org baseline before the repository rulesets);
 * 3. the org baseline is READ BACK: it must hold exactly what is declared, or
 *    the apply stops (`forge_tighten_unverified`) with nothing loosened;
 * 4. the acknowledged loosenings (each accepted by id);
 * 5. every MOVE is judged again on what GitHub holds now
 *    ({@link liveMovePremisesUnmet}: the repository's live `kind`, the live
 *    baseline, the live ruleset), never on the declarations, and refused
 *    (`forge_tighten_unverified`) with no protection moved unless every
 *    premise holds; only then the moves;
 * 6. the retirements; a fresh plan is the verification.
 * So no step leaves `main` with less protection than before it.
 */
export async function forgeApply(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[], accepted: ReadonlySet<string> = new Set()): Promise<ForgeApplyResult> {
  const { planned, extra, retiredFound } = await planObjects(context, objects, retired);
  const plan = summarize([...planned.map((entry) => entry.entry), ...extra]);
  if (!plan.complete) {
    throw new ForgeError("forge_plan_incomplete", `${String(plan.counts.refused)} declared object(s) cannot be planned; nothing was applied.`, { refused: plan.entries.filter((entry) => entry.action === "refused").map((entry) => `${entry.kind}:${entry.scope}:${entry.key}:${entry.code ?? ""}`) });
  }
  const loosenings = plan.entries.filter((entry) => entry.loosening !== undefined && (entry.action === "update" || entry.action === "retire"));
  const unacknowledged = loosenings.filter((entry) => entry.moved !== true && !accepted.has(looseningId(entry)));
  if (unacknowledged.length > 0) {
    throw new ForgeError("forge_loosening_unacknowledged", `${String(unacknowledged.length)} change(s) would weaken a protection; nothing was applied. Review each, then pass --accept-loosening <id> for each one you accept: ${unacknowledged.map((entry) => `${looseningId(entry)} (${entry.loosening!.join("; ")})`).join(", ")}.`, { loosening: unacknowledged.map(looseningId) });
  }
  const applied: PlanEntry[] = [];
  const write = async (item: Planned): Promise<void> => {
    const { object, entry, body, found } = item;
    if (entry.action === "create") await KIND_ADAPTERS[object.kind].create(context, object, body);
    else await KIND_ADAPTERS[object.kind].update(context, object, body, found!);
    applied.push(entry);
    debugLog(FORGE_LOG_CATEGORY, "info", "forge_object_applied", () => ({ kind: entry.kind, scope: entry.scope, key: entry.key, action: entry.action }));
  };
  // 2. Tighten: every create and every non-loosening update.
  for (const item of planned) if ((item.entry.action === "create" || item.entry.action === "update") && item.entry.loosening === undefined) await write(item);
  const loosening = planned.filter((item) => item.entry.action === "update" && item.entry.loosening !== undefined);
  if (loosening.length > 0 || retiredFound.length > 0) {
    // 3. Read the org baseline back before anything is weakened.
    const baseline = objects.filter((object) => object.kind === "org-ruleset");
    const readBack = await forgePlan(context, baseline, []);
    const unheld = readBack.entries.filter((entry) => entry.action !== "unchanged" && entry.action !== "unmanaged");
    if (unheld.length > 0) {
      throw new ForgeError("forge_tighten_unverified", `The org baseline does not hold what was declared after it was applied (${unheld.map(looseningId).join(", ")}); nothing was loosened.`, { unheld: unheld.map(looseningId) });
    }
    // 4. The acknowledged loosenings: the maintainer accepted each by id, and a move may rely on one (a kind set on the repository).
    for (const item of loosening) if (item.entry.moved !== true) await write(item);
    // 5. Every MOVE's premises, read back from GitHub (the repository's live kind, the live baseline, the live ruleset), and only then the moves.
    const moves = loosening.filter((item) => item.entry.moved === true);
    const unmet = await liveMovePremisesUnmet(context, objects, moves);
    if (unmet.length > 0) {
      throw new ForgeError("forge_tighten_unverified", `A move into the org baseline does not hold on GitHub (${unmet.join("; ")}); no protection was moved out of a repository.`, { unheld: unmet });
    }
    for (const item of moves) await write(item);
    // 6. The retirements (each acknowledged).
    for (const { retired: entry, found } of retiredFound) {
      const scope: ForgeScope = { kind: "repo", repository: entry.repository };
      await KIND_ADAPTERS[entry.kind].remove!(context, found, scope);
      applied.push(deepFreeze({ kind: entry.kind, scope: entry.repository, key: entry.name, action: "retire", loosening: ["deletes the ruleset"], moved: false }));
    }
  }
  const verification = await forgePlan(context, objects, retired);
  return deepFreeze({
    applied,
    acceptedLoosening: loosenings.filter((entry) => entry.moved !== true).map((entry) => ({ id: looseningId(entry), loosening: entry.loosening! })),
    movedLoosening: loosenings.filter((entry) => entry.moved === true).map(looseningId),
    verification,
    verified: verification.drift.length === 0,
  });
}
