/**
 * THE CLAIMS REGISTER — every public claim the project makes, or explicitly
 * does not make, in one file (`docs/brand/claims.json`). Every public surface
 * that states a claim (the README, the site, the roadmap's gaps, the social
 * images) renders it from here; none types its own.
 *
 * A claim is one of three kinds:
 * - `holds-when-green`: true while its bound checks pass at the rendered
 *   commit. A renderer that finds a bound check red (or not run on that
 *   commit) renders the claim RETRACTED, publicly and at once (user decision,
 *   2026-10-21): struck through, with the failing run linked.
 * - `designed`: a decision exists and the code does not yet; the claim names
 *   the decision record, whose implementation state is read, never restated.
 * - `not-claimed`: something the project deliberately does not say, with the
 *   reason (the roadmap's "known gaps").
 *
 * The register is validated whole: a malformed claim refuses the read (typed),
 * never a partial register.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../src/kernel/errors.ts";

export const CLAIMS_PATH = "docs/brand/claims.json";
export const CLAIMS_SCHEMA = "bridlewise-claims/v1";

const CLAIM_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CHECK_ID = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/u;
const DECISION_ID = /^[A-Z][A-Z0-9]*[a-z]?(?:-[A-Z0-9]+[a-z]?)*$/u;
/** A repository path (optionally `#anchor`) or an https URL. */
const EVIDENCE = /^(?:https:\/\/\S+|(?!\/)(?!.*\.\.)[^\s#]+(?:#[\w-]+)?)$/u;

export type Claim =
  | Readonly<{ id: string; kind: "holds-when-green"; text: string; checks: readonly string[]; evidence: string | null }>
  | Readonly<{ id: string; kind: "designed"; text: string; decision: string }>
  | Readonly<{ id: string; kind: "not-claimed"; text: string; reason: string; evidence: string | null }>;

function refuse(message: string): never {
  throw new InputError(`${CLAIMS_PATH}: ${message}`, "claims_register_invalid");
}

/** Every way `document` breaks the register format; `exists` answers whether a repository path exists. */
export function claimViolations(document: unknown, exists: (path: string) => boolean): readonly string[] {
  const problems: string[] = [];
  if (typeof document !== "object" || document === null || Array.isArray(document)) return ["the register is not a JSON object"];
  const record = document as Record<string, unknown>;
  if (record.schema !== CLAIMS_SCHEMA) problems.push(`schema must be ${CLAIMS_SCHEMA}`);
  for (const key of Object.keys(record)) if (key !== "schema" && key !== "claims") problems.push(`${key} is not a field of the register`);
  if (!Array.isArray(record.claims)) return [...problems, "claims must be a list"];
  const seen = new Set<string>();
  record.claims.forEach((value: unknown, index: number) => {
    const at = `claims[${index}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) { problems.push(`${at} is not an object`); return; }
    const claim = value as Record<string, unknown>;
    const id = typeof claim.id === "string" ? claim.id : "";
    if (!CLAIM_ID.test(id)) problems.push(`${at}.id must be lower-case words joined by hyphens`);
    else if (seen.has(id)) problems.push(`${at}.id ${id} is used twice`);
    seen.add(id);
    if (typeof claim.text !== "string" || claim.text.trim().length === 0) problems.push(`${id || at}: text is required`);
    const allowed: Record<string, readonly string[]> = {
      "holds-when-green": ["id", "kind", "text", "checks", "evidence"],
      designed: ["id", "kind", "text", "decision"],
      "not-claimed": ["id", "kind", "text", "reason", "evidence"],
    };
    const kind = typeof claim.kind === "string" ? claim.kind : "";
    const fields = allowed[kind];
    if (fields === undefined) { problems.push(`${id || at}: kind must be one of ${Object.keys(allowed).join(", ")}`); return; }
    for (const key of Object.keys(claim)) if (!fields.includes(key)) problems.push(`${id}: ${key} is not a field of a ${kind} claim`);
    if (kind === "holds-when-green") {
      if (!Array.isArray(claim.checks) || claim.checks.length === 0) problems.push(`${id}: a holds-when-green claim binds at least one check`);
      else for (const check of claim.checks) if (typeof check !== "string" || !CHECK_ID.test(check)) problems.push(`${id}: ${String(check)} is not a check id`);
    }
    if (kind === "designed" && (typeof claim.decision !== "string" || !DECISION_ID.test(claim.decision))) problems.push(`${id}: decision must be a decision id`);
    if (kind === "designed" && typeof claim.decision === "string" && DECISION_ID.test(claim.decision) && !exists(`decision:${claim.decision}`)) problems.push(`${id}: decision ${claim.decision} is no decision record`);
    if (kind === "not-claimed" && (typeof claim.reason !== "string" || claim.reason.trim().length === 0)) problems.push(`${id}: a not-claimed entry states its reason`);
    if (claim.evidence !== undefined) {
      if (typeof claim.evidence !== "string" || !EVIDENCE.test(claim.evidence)) problems.push(`${id}: evidence must be a repository path or an https URL`);
      else if (!claim.evidence.startsWith("https://") && !exists(claim.evidence.split("#")[0]!)) problems.push(`${id}: evidence ${claim.evidence} does not exist`);
    }
  });
  return problems;
}

/**
 * The register of the repository at `root`. `decisionIds` are the decision
 * records that exist (a `designed` claim must name one).
 */
export function readClaims(root: string, decisionIds: ReadonlySet<string>): readonly Claim[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(root, CLAIMS_PATH), "utf8"));
  } catch (error) {
    refuse(`cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const exists = (path: string): boolean => (path.startsWith("decision:") ? decisionIds.has(path.slice("decision:".length)) : existsSync(join(root, path)));
  const problems = claimViolations(document, exists);
  if (problems.length > 0) refuse(`breaks ${CLAIMS_SCHEMA}:\n${problems.join("\n")}`);
  return Object.freeze(((document as { claims: Record<string, unknown>[] }).claims).map((claim) => Object.freeze({
    ...claim,
    ...(claim.kind === "designed" ? {} : { evidence: (claim.evidence as string | undefined) ?? null }),
  }) as Claim));
}
