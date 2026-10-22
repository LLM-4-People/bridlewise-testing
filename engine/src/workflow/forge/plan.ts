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
  const kind = forgeClass(error.forgeCode);
  return kind === "refused" || kind === "input" ? error : undefined;
}

type Planned = Readonly<{ object: ForgeObject; entry: PlanEntry; body?: unknown; found?: LiveObject }>;

async function planObjects(context: LiveContext, objects: readonly ForgeObject[], retired: readonly RetiredObject[]): Promise<Readonly<{ planned: readonly Planned[]; extra: readonly PlanEntry[]; retiredFound: readonly Readonly<{ retired: RetiredObject; found: LiveObject }>[] }>> {
  const resolved = await resolveAll(context, objects);
  /** Each repository's declared `kind` (the custom property value), for the moved-rule judgement. */
  const kindOf = (repository: string): string | undefined => {
    const declared = objects.find((object) => object.kind === "custom-property-values" && object.scope.kind === "repo" && object.scope.repository === repository);
    return (declared?.desired as { kind?: string } | undefined)?.kind;
  };
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
      const loosening = differing.length === 0 ? [] : looseningOf(object.kind, body, found.live);
      const moved = loosening.length > 0 && object.kind === "ruleset" && object.scope.kind === "repo" && movedIntoBaseline(loosening, object.scope.repository, objects, kindOf);
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

/** The id a loosening is acknowledged by: `<kind>:<scope>:<key>`. */
export function looseningId(entry: Readonly<{ kind: string; scope: string; key: string }>): string {
  return `${entry.kind}:${entry.scope}:${entry.key}`;
}

type Rule = Readonly<{ type?: unknown; parameters?: Readonly<Record<string, unknown>> }>;
type RulesetBody = Readonly<{ enforcement?: unknown; rules?: readonly Rule[]; bypass_actors?: readonly unknown[] }>;

const ruleTypes = (body: RulesetBody): readonly string[] => (body.rules ?? []).map((rule) => String(rule.type));
const ruleOf = (body: RulesetBody, type: string): Rule | undefined => (body.rules ?? []).find((rule) => rule.type === type);
const checksOf = (body: RulesetBody): readonly string[] => ((ruleOf(body, "required_status_checks")?.parameters?.required_status_checks ?? []) as readonly { context?: unknown }[]).map((check) => String(check.context));

/**
 * WHAT AN UPDATE WEAKENS (§3.4, the review's tighten-first ruling): for a
 * ruleset, an enforcement switched off, a rule removed, a bypass actor
 * added, a required check dropped, fewer approvals or a review safeguard
 * switched off; for the security configuration, a feature disabled; for
 * Actions, SHA pinning off or every action allowed. Empty: a tightening or a
 * neutral change.
 */
export function looseningOf(kind: ForgeObjectKind, desired: unknown, live: unknown): readonly string[] {
  const reasons: string[] = [];
  const want = (desired ?? {}) as Readonly<Record<string, unknown>>;
  const have = (live ?? {}) as Readonly<Record<string, unknown>>;
  if (kind === "ruleset" || kind === "org-ruleset") {
    const next = want as RulesetBody;
    const now = have as RulesetBody;
    if (now.enforcement === "active" && next.enforcement !== "active") reasons.push("enforcement off");
    for (const type of ruleTypes(now)) if (!ruleTypes(next).includes(type)) reasons.push(`removes rule ${type}`);
    const actors = (body: RulesetBody): readonly string[] => (body.bypass_actors ?? []).map((actor) => JSON.stringify(actor));
    for (const actor of actors(next)) if (!actors(now).includes(actor)) reasons.push(`adds bypass ${actor}`);
    for (const context of checksOf(now)) if (ruleTypes(next).includes("required_status_checks") && !checksOf(next).includes(context)) reasons.push(`drops required check ${context}`);
    const nowReview = ruleOf(now, "pull_request")?.parameters;
    const nextReview = ruleOf(next, "pull_request")?.parameters;
    if (nowReview !== undefined && nextReview !== undefined) {
      if (Number(nextReview.required_approving_review_count) < Number(nowReview.required_approving_review_count)) reasons.push("fewer required approvals");
      for (const flag of ["require_last_push_approval", "dismiss_stale_reviews_on_push", "required_review_thread_resolution", "require_code_owner_review"]) {
        if (nowReview[flag] === true && nextReview[flag] === false) reasons.push(`${flag} off`);
      }
    }
  } else if (kind === "security-configuration") {
    for (const [field, value] of Object.entries(want)) if (have[field] === "enabled" && value !== "enabled") reasons.push(`${field} ${String(value)}`);
  } else if (kind === "actions-permissions") {
    if (have.sha_pinning_required === true && want.sha_pinning_required !== true) reasons.push("sha pinning off");
    if (have.allowed_actions === "selected" && want.allowed_actions !== "selected") reasons.push(`allowed actions ${String(want.allowed_actions)}`);
  }
  return reasons;
}

/** Whether every reason of a repository ruleset's loosening is a rule or check the declared org baseline carries for this repository. */
function movedIntoBaseline(reasons: readonly string[], repository: string, objects: readonly ForgeObject[], kindOf: (repository: string) => string | undefined): boolean {
  const baseline = objects.find((object) => object.kind === "org-ruleset")?.desired as (RulesetBody & { conditions?: { repository_property?: { include?: readonly { property_values?: readonly string[] }[] } } }) | undefined;
  if (baseline === undefined) return false;
  const kinds = baseline.conditions?.repository_property?.include?.flatMap((entry) => entry.property_values ?? []) ?? [];
  const kind = kindOf(repository);
  if (kind === undefined || !kinds.includes(kind)) return false;
  return reasons.every((reason) => {
    if (reason.startsWith("removes rule ")) return ruleTypes(baseline).includes(reason.slice("removes rule ".length));
    if (reason.startsWith("drops required check ")) return checksOf(baseline).includes(reason.slice("drops required check ".length));
    return false;
  });
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
  verification: ForgePlan;
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
 * 4. only then the loosenings, then the retirements;
 * 5. a fresh plan is the verification.
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
    await afterWrite(context, object);
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
    // 4. Then loosen, then retire.
    for (const item of loosening) await write(item);
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
  });
}
