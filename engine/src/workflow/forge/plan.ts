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
import { ForgeError, forgeClass, isForgeError, type ForgeCode } from "./codes.ts";
import { differences, referenceKey, referencesOf, resolveReferences, scopeName, writableBody, type ForgeObject, type ForgeObjectKind, type ForgeReference, type ForgeScope } from "./forge-state.ts";
import { FORGE_LOG_CATEGORY } from "./github.ts";
import { afterWrite, EXCLUSIVE_KINDS, KIND_ADAPTERS, type LiveContext, type LiveObject } from "./live-state.ts";

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
  const kind = forgeClass(error.forgeCode);
  return kind === "refused" || kind === "input" ? error : undefined;
}

type Planned = Readonly<{ object: ForgeObject; entry: PlanEntry; body?: unknown; found?: LiveObject }>;

async function planObjects(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[]): Promise<Readonly<{ planned: readonly Planned[]; extra: readonly PlanEntry[]; retiredFound: readonly Readonly<{ retired: RetiredObject; found: LiveObject }>[] }>> {
  const resolved = await resolveAll(context, objects);
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
      if (found === undefined) {
        planned.push({ object, entry: deepFreeze({ ...base, action: "create" }), body });
        continue;
      }
      const differing = differences(body, found.live);
      planned.push({ object, body, found, entry: deepFreeze({ ...base, action: differing.length === 0 ? "unchanged" : "update", ...(differing.length === 0 ? {} : { differences: differing }) }) });
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
        extra.push(deepFreeze({ kind, scope: scopeName(scope), key: name, action: "retire" }));
      } else {
        extra.push(deepFreeze({ kind, scope: scopeName(scope), key: name, action: "unmanaged" }));
      }
    }
  }
  return { planned, extra, retiredFound };
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

export type ForgeApplyResult = Readonly<{ applied: readonly PlanEntry[]; verification: ForgePlan }>;

/** APPLY: the whole plan, in declaration order, then a fresh plan as the verification. */
export async function forgeApply(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[]): Promise<ForgeApplyResult> {
  const { planned, extra, retiredFound } = await planObjects(context, objects, retired);
  const plan = summarize([...planned.map((entry) => entry.entry), ...extra]);
  if (!plan.complete) {
    throw new ForgeError("forge_plan_incomplete", `${String(plan.counts.refused)} declared object(s) cannot be planned; nothing was applied.`, { refused: plan.entries.filter((entry) => entry.action === "refused").map((entry) => `${entry.kind}:${entry.scope}:${entry.key}:${entry.code ?? ""}`) });
  }
  const applied: PlanEntry[] = [];
  for (const { object, entry, body, found } of planned) {
    if (entry.action === "create") await KIND_ADAPTERS[object.kind].create(context, object, body);
    else if (entry.action === "update") await KIND_ADAPTERS[object.kind].update(context, object, body, found!);
    else continue;
    await afterWrite(context, object);
    applied.push(entry);
    debugLog(FORGE_LOG_CATEGORY, "info", "forge_object_applied", () => ({ kind: entry.kind, scope: entry.scope, key: entry.key, action: entry.action }));
  }
  for (const { retired: entry, found } of retiredFound) {
    const scope: ForgeScope = { kind: "repo", repository: entry.repository };
    await KIND_ADAPTERS[entry.kind].remove!(context, found, scope);
    applied.push(deepFreeze({ kind: entry.kind, scope: entry.repository, key: entry.name, action: "retire" }));
  }
  const verification = await forgePlan(context, objects, retired);
  return deepFreeze({ applied, verification });
}
