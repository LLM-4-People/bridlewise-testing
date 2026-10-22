/**
 * THE POST-LAND SEAL (github-only §5.3 step 7, ci §6.3): on every `push` to
 * `main`, a tripwire that `main` holds only trees the door judged. The new
 * `main` commit must carry the door's `bridlewise/door` check, posted by the
 * door App, concluded `success`, keyed by K (its `external_id`), and the door's
 * attested verdict for K (located by name, proven by `gh attestation verify`
 * in the workflow) must name exactly this commit's tree. Anything else — a
 * bypass, a misconfigured ruleset, a queue regression that landed another
 * tree — fails the `bridlewise/main-integrity` job on that commit, visibly.
 *
 * It is a pure comparison of what GitHub records; it runs nothing of the
 * tree.
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { FORGE_APPS } from "../forge/app-registry.ts";
import type { ForgeClient } from "../forge/port.ts";
import { judgeReuseProof } from "./reuse.ts";

/** The door's check name and the App that alone may post it (the App registry's door App). */
export const DOOR_CHECK = deepFreeze({ name: "bridlewise/door", appSlug: FORGE_APPS.door.name } as const);

export type DoorCheckFacts = Readonly<{ key: string; conclusion: string | null; appSlug: string | null }>;

/** The latest `bridlewise/door` check on `sha`, or null when the commit carries none. */
export async function doorCheckOn(client: ForgeClient, repository: Readonly<{ owner: string; name: string }>, sha: string): Promise<DoorCheckFacts | null> {
  const answer = (await client.rest({ method: "GET", path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${sha}/check-runs`, query: { check_name: DOOR_CHECK.name, filter: "latest" } })).data as { check_runs?: unknown };
  if (!Array.isArray(answer.check_runs)) throw new InputError("GitHub answered a check-run list without check runs", "main_integrity_unreadable");
  const first = (answer.check_runs as Readonly<Record<string, unknown>>[])[0];
  if (first === undefined) return null;
  return deepFreeze({
    key: typeof first.external_id === "string" ? first.external_id : "",
    conclusion: typeof first.conclusion === "string" ? first.conclusion : null,
    appSlug: typeof (first.app as { slug?: unknown } | undefined)?.slug === "string" ? (first.app as { slug: string }).slug : null,
  });
}

export type IntegrityVerdict = Readonly<{ sealed: boolean; findings: readonly string[] }>;

/**
 * Judges a `main` commit: its door check (present, the door App's, success,
 * keyed by a full K), and — given the located key document and its verified
 * attestation — that the attested verdict for K names this commit's tree.
 */
export function judgeMainIntegrity(inputs: Readonly<{
  treeId: string;
  check: DoorCheckFacts | null;
  keyDocument: string | Buffer | null;
  verified: unknown;
}>): IntegrityVerdict {
  const findings: string[] = [];
  const check = inputs.check;
  if (check === null) {
    findings.push("this main commit carries no bridlewise/door check: it reached main without the door judging it");
  } else {
    if (check.appSlug !== DOOR_CHECK.appSlug) findings.push(`its bridlewise/door check was posted by ${String(check.appSlug)}, not the door App`);
    if (check.conclusion !== "success") findings.push(`its bridlewise/door check concluded ${String(check.conclusion)}`);
    if (!/^[0-9a-f]{64}$/u.test(check.key)) findings.push("its bridlewise/door check names no key");
  }
  if (findings.length === 0) {
    if (inputs.keyDocument === null) {
      findings.push("the door's verdict for this key could not be located");
    } else {
      try {
        judgeReuseProof(check!.key, inputs.keyDocument, inputs.verified);
        const document = JSON.parse(Buffer.from(inputs.keyDocument).toString("utf8")) as { treeId?: unknown };
        if (document.treeId !== inputs.treeId) findings.push(`the door judged tree ${String(document.treeId)}, but main holds ${inputs.treeId}`);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        findings.push(error.message);
      }
    }
  }
  return deepFreeze({ sealed: findings.length === 0, findings });
}
