/**
 * THE FORGE CODES — the single source of every typed answer the forge gives
 * (the GitHub adapter, App token minting, `harness forge …`): its code, its
 * class and the one remedy a person or an agent is told. A refusal raised
 * anywhere in the forge is a {@link ForgeError} carrying one of these codes,
 * so the CLI, the exposure actions and every lane that builds on the port read
 * one meaning per code. GitHub's own answers are classified ONCE, in
 * `github.ts`; no caller re-reads a status code or a message.
 *
 * Classes:
 * - `input` — the caller's request or the forge's declarations are wrong;
 * - `refused` — GitHub refused the request for a reason that a person must
 *   change (a permission, a plan, a validation rule, a conflict): retrying the
 *   same request gives the same answer;
 * - `budget` — a GitHub budget is spent (the primary rate limit, a secondary
 *   limit, the content-creation budget): the same request succeeds after the
 *   named reset, and the caller's scheduler decides when; nothing here waits;
 * - `errored` — GitHub or the network failed (5xx, an unreadable answer);
 * - `integrity` — an answer that must not happen (a token GitHub minted for
 *   other permissions than asked): stop and preserve evidence.
 */
import { HarnessError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";

/** The log category of everything the forge reports (the adapter's requests and refusals, the importer's steps). */
export const FORGE_LOG_CATEGORY = "forge";

const FORGE_CLASSES = deepFreeze(["input", "refused", "budget", "errored", "integrity"] as const);
export type ForgeClass = typeof FORGE_CLASSES[number];

type CodeEntry = Readonly<{ class: ForgeClass; remedy: string }>;

/** Every code the forge answers with (see the header). */
const FORGE_CODES = deepFreeze({
  forge_not_configured: { class: "input", remedy: "Declare the `forge` section in engine/bridlewise.config.json (its schema is `forge-config.ts`)." },
  forge_usage: { class: "input", remedy: "Run `harness forge apps manifests [--check]` or `harness forge apps create`." },
  forge_declaration_invalid: { class: "input", remedy: "Fix the declaration's owner (the forge section, the App registry, the community sources or the tree) so the generated configuration is whole: the message names what is missing or doubled." },
  forge_security_attach_failed: { class: "refused", remedy: "GitHub could not attach the security configuration to the named repositories (their status is failed): a feature the plan cannot enable there (secret scanning or push protection on a private repository without Secret Protection) is the usual cause. Fix the configuration for that visibility, then apply again." },
  forge_reference_unresolved: { class: "refused", remedy: "The object names an App, installation, team or user GitHub does not have yet: create it first (Session 1 for the Apps; `forge apply` creates the teams), then plan again." },
  forge_loosening_unacknowledged: { class: "refused", remedy: "Review each weakening the plan lists, then pass `--accept-loosening <kind:scope:key>` for each one you accept; the acknowledgement is recorded in the apply's receipt." },
  forge_tighten_unverified: { class: "integrity", remedy: "The org baseline did not read back as declared after it was applied, so nothing was loosened: run `harness forge plan` to see what differs, and investigate before applying again." },
  forge_plan_incomplete: { class: "refused", remedy: "`forge apply` sends a whole plan only: resolve every refused object (the plan lists each with its code), then apply again." },
  forge_request_invalid: { class: "input", remedy: "Fix the request: the path must be an API path starting with `/`, with no scheme, host, `..` or fragment, and a query of plain values." },
  forge_endpoint_invalid: { class: "input", remedy: "Name the API as an absolute https URL (http only for a loopback test server) with no credentials, query or fragment." },
  forge_app_unknown: { class: "input", remedy: "Name one of the App registry's roles (`app-registry.ts`)." },
  forge_app_key_unavailable: { class: "refused", remedy: "Create the App and store its key with `harness forge apps create` (the key home holds it; nobody copies a key by hand)." },
  forge_app_key_invalid: { class: "integrity", remedy: "The stored App record is unreadable or its key is not an RSA private key: recreate the key in the App's settings and store it again with `harness forge apps create`." },
  forge_token_unavailable: { class: "refused", remedy: "Provide the token the way the credential names (an environment variable set by the workflow, or the maintainer's prompt); it is never read from a file." },
  forge_token_scope_mismatch: { class: "integrity", remedy: "GitHub minted a token with permissions or repositories other than those asked: compare the App's installed permissions with the registry (`harness forge audit`) and stop until they agree." },
  forge_maintainer_cli_failed: { class: "refused", remedy: "Install `gh` and log in as the maintainer (`gh auth login`) for this one session; the forge uses it only to write environment secrets and variables while the owner credential is on the host." },
  forge_maintainer_cli_stalled: { class: "errored", remedy: "gh made no progress (no output and no CPU work) within its stall window, or passed its CPU limit (`forge.maintainerCli`): check its network and login, then run the step again; a held key is resumed, never lost." },
  forge_app_conversion_mismatch: { class: "integrity", remedy: "GitHub created an App that is not the declared one (its owner, name, permissions or events differ from the generated manifest); nothing was stored. Delete that App in the organisation's settings (Developer settings → GitHub Apps → the App → Advanced → Delete), then create it again from the page." },
  forge_app_name_taken: { class: "refused", remedy: "An App with this name already exists, but no key for it is stored here (a half-finished attempt): delete it in the organisation's settings (Developer settings → GitHub Apps → the App → Advanced → Delete), then reload the page and create it again." },
  forge_environment_missing: { class: "refused", remedy: "Create the environment first (runbook P1.4: `door`, `publish`, `release`, `rotation`, each limited to `main`); the door and publisher keys are written into them." },
  forge_apps_page_refused: { class: "input", remedy: "Open the page at the address `harness forge apps create` printed (127.0.0.1 only), and use its own buttons: a request from another origin, or with an unknown or used state, is refused." },
  forge_apps_page_unavailable: { class: "errored", remedy: "The page's port is in use or cannot be bound: free it, or set `forge.appsPage.port` (the App manifests' callback follows it after `harness sync`)." },
  github_unauthorized: { class: "refused", remedy: "The credential was refused (401): it is expired, revoked or malformed. Mint a new App token or provide a valid one." },
  github_forbidden: { class: "refused", remedy: "GitHub refused the action for this principal (403): grant the App the permission the registry declares for it, or use the principal that holds it." },
  github_not_found: { class: "refused", remedy: "GitHub answered 404: the object does not exist, or this principal cannot see it (an App not installed on the repository answers 404 too)." },
  github_conflict: { class: "refused", remedy: "GitHub answered 409: the object changed or is in a state that refuses this action; re-read it and plan again." },
  github_precondition_failed: { class: "refused", remedy: "GitHub answered 412: the precondition the request carried no longer holds; re-read the object and plan again." },
  github_validation_failed: { class: "refused", remedy: "GitHub refused the payload (422): the details name each field and the rule it breaks; fix the generator that produced it." },
  github_moved: { class: "refused", remedy: "The repository was renamed or transferred, so the API answered with a redirect, which is never followed: configure the new owner and name." },
  unavailable_on_plan: { class: "refused", remedy: "This feature is not available on the organisation's plan (or its add-ons): record it as `unavailable_on_plan` in the plan, and enforce the property through the door instead." },
  github_rate_limited: { class: "budget", remedy: "The primary rate limit of this principal is spent: the scheduler resumes after `resetAt`. Conditional requests (ETags) that answer 304 do not count against it." },
  github_secondary_rate_limited: { class: "budget", remedy: "A secondary rate limit (concurrency or CPU time) refused the request: resume after `retryAfterSeconds` (at least a minute when GitHub names none), with fewer concurrent requests." },
  github_content_budget_exhausted: { class: "budget", remedy: "The content-creation budget (about 80 per minute, 500 per hour) is spent: the projection converges over the next windows; resume after `retryAfterSeconds` (at least a minute when GitHub names none)." },
  github_unavailable: { class: "errored", remedy: "GitHub failed (5xx) or the connection did: nothing is blamed on the request; the caller's scheduler retries it later." },
  github_response_invalid: { class: "errored", remedy: "GitHub answered with a body the adapter cannot read as the declared format; preserve the request id and report it." },
  // The history importer (`history-import.ts`, `history-tools.ts`, `harness forge import-history`).
  history_import_usage: { class: "input", remedy: "Run `harness forge import-history <source> --to <target> [--dispositions <file>]`." },
  history_import_credentials_in_url: { class: "input", remedy: "Name the repository without a user or password; git reaches it through its credential helper (D-09)." },
  history_import_source_empty: { class: "input", remedy: "Name a source repository (a path, a bundle or a URL) that holds at least one ref." },
  history_import_target_not_empty: { class: "refused", remedy: "Import only into a new, empty repository: a published history is never rewritten." },
  history_import_ref_collision: { class: "input", remedy: "Rename the source ref that lands on another's name (or on the receipt's ref) before importing." },
  history_import_secret_in_name: { class: "refused", remedy: "A path or a ref name holds a secret: rename it in the source (a person's decision), rotate the credential, and import again." },
  history_import_catalogue_gap: { class: "refused", remedy: "The oracle found a secret no catalogue hit contains: add (or widen) the catalogue row in `src/privacy/secret-signals.ts` for a real format, or record a reviewed disposition (`--dispositions`, by the value's sha256) for a false positive." },
  history_import_review_invalid: { class: "input", remedy: "Write the review as the history-import-review schema: `dispositions` (each a rule, the value's sha256 and a reason; never a value) and `binaries` (each an object id and a reason)." },
  history_import_undecodable: { class: "refused", remedy: "Objects no encoding decodes are listed in undecodable.json in the run folder (id, size, paths): review each and name it under `binaries` in the review file (`--review`), or remove it from the source." },
  history_import_receipt_unsafe: { class: "integrity", remedy: "The receipt would carry an absolute or home path, or a catalogue hit: nothing was pushed; fix the field the message names (the receipt records repository-relative facts only)." },
  history_import_purge_inexpressible: { class: "refused", remedy: "A hit's line cannot be a filter-repo expression (it holds `==>` or a line break): purge that line in the source by hand, then import." },
  history_import_object_too_large: { class: "refused", remedy: "An object exceeds the git output bound: move it out of the history (or to the evidence store) before importing." },
  history_import_identity_unallowed: { class: "refused", remedy: "The history carries an address-shaped string that is not on the allowed identities (in any object, path or ref name): map it to an allowed one in the ONE identity mapping (--identity-map), or, when it is not a person's address, dispose of it by its digest in the review (addresses.json lists each by digest with its objects); both files live in the coordination repository, never the public tree." },
  history_import_identity_map_public: { class: "refused", remedy: "The identity mapping holds the addresses it replaces: keep it in the coordination repository, outside any tree that is published, and pass its path there." },
  history_import_review_public: { class: "refused", remedy: "The import review names what must never be published (digests of secrets and of addresses): keep it in the coordination repository, outside any tree that is published, and pass its path there." },
  history_import_identity_map_invalid: { class: "refused", remedy: "Fix the named line of the identity mapping (a mailmap line: Proper Name <proper> Commit Name <commit>, or a shorter form), or declare the allowed identities (forge.historyImport.allowedIdentities)." },
  history_import_identity_residue: { class: "refused", remedy: "The rewritten history (or the receipt) still carries an address not on the allowed identities, in a place no rewrite reaches (a path, a ref name, a header other than an identity, an encoding rewritten only whole): rename it in the source, or dispose of it in the review when it is not a person's address; nothing was pushed (addresses.json names the objects)." },
  history_import_residue: { class: "integrity", remedy: "The purged history still holds a secret: keep the run folder, find which expression missed (an encoding, a binary blob), fix the importer, and import again." },
  history_import_refs_changed: { class: "integrity", remedy: "The rewrite changed the set of refs: keep the run folder and compare its refs before and after; nothing was pushed." },
  history_import_push_refused: { class: "refused", remedy: "The target refused the push: a push-protection refusal is a catalogue defect to fix (never a bypass); any other refusal names its ref." },
  history_import_push_mismatch: { class: "integrity", remedy: "The target does not hold exactly the pushed refs: inspect it before anything else writes there." },
  history_import_identity_unreachable: { class: "refused", remedy: "A mapped-from address is written somewhere the rewrite cannot replace it: escaped or encoded (an entity, quoted-printable, base64), obfuscated ([at], [dot]), split over a line, in another spelling, or in a path or ref name. addresses.json names the objects by id (the address by its digest): remove it from the source, or dispose of the address in the review when it may be published; nothing was rewritten or pushed." },
  history_import_strip_unreviewed: { class: "refused", remedy: "The rewrite would strip whole blobs it cannot rewrite in place (a secret or a mapped address in UTF-16, or after a NUL in the first bytes). strip.json in the run folder lists each with its paths and why: read them, then acknowledge each by its id under `strips` in the review file (`--review`), or fix the source. Nothing is stripped silently." },
  history_import_child_failed: { class: "integrity", remedy: "The importer's bounded child (the address census or the catalogue scan) failed without a code of its own; its message (addresses withheld) says why. Record it and report it." },
  history_import_notes_unreadable: { class: "refused", remedy: "A refs/notes/* ref holds a path that names no object. Notes follow their commits through the rewrite, so a notes ref must hold notes only: move anything else out of it in the source." },
  history_import_tree_bound: { class: "refused", remedy: "The history's trees name more paths, or deeper ones, than the importer reads (historyImport.treePathsAtMost, treeDepthAtMost in the root policy): a tree bomb is refused; a real history that large is imported in parts." },
  history_import_old_id_residue: { class: "refused", remedy: "The rewritten history still names an object id from before the rewrite (in a file, a message, a path or a ref name: a notes tree naming the commits it annotated, a .git-blame-ignore-revs, an id filter-repo did not translate). An old id with the public rewritten object confirms a guess of what the rewrite removed. addresses.json lists the objects; remove or translate the ids in the source (drop the notes on rewritten commits), then import again; nothing was pushed." },
  history_import_git_answer: { class: "integrity", remedy: "git answered in a shape the importer does not read; record the git version and report it." },
  history_import_oracle_report: { class: "integrity", remedy: "The oracle's report is not gitleaks' JSON finding list: check the pinned gitleaks version." },
  history_import_write_failed: { class: "errored", remedy: "A file of the run folder could not be written: check the import home's free space and permissions." },
  history_tool_missing: { class: "refused", remedy: "Provision the pinned tool with the command the refusal prints (it checks the release archive's digest)." },
  history_tool_digest_mismatch: { class: "integrity", remedy: "The file is not the pinned tool: remove it and provision the pinned one; a pin moves only as a reviewed provenance change." },
  history_tool_platform_unpinned: { class: "refused", remedy: "Pin the tool for this platform in `history-tools.ts` (the release archive, its published checksum, the member's sha256)." },
  history_tool_failed: { class: "errored", remedy: "A pinned tool (or the host program it runs on) failed: its last stderr lines are in the message." },
  history_tool_cpu_exhausted: { class: "refused", remedy: "The tool spent its CPU budget (`toolCpuBudgetMs`): keep the run folder, measure what it was doing, and raise the budget only with that measurement." },
  history_tool_stalled: { class: "errored", remedy: "The tool produced no output and no CPU time for `toolStallMs` (a hung fetch, a lock): find what it waits on; a busy host slows a run but never stalls it." },
  history_tool_output_exceeded: { class: "refused", remedy: "The tool's output passed the bound held in memory: split its input (the oracle's chunk size) or find why it reports so much." },
  history_tool_unmeasurable: { class: "refused", remedy: "procfs cannot measure the tool's CPU time, so its budget cannot be judged: run the importer on a host with procfs (the tools are pinned for linux-x64)." },
} as const satisfies Readonly<Record<string, CodeEntry>>);

export type ForgeCode = keyof typeof FORGE_CODES;

/** Facts a forge refusal may carry: plain values only, never a credential. */
export type ForgeFacts = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** One typed refusal of the forge: a code from {@link FORGE_CODES}, its remedy, and the facts that name what was refused. */
export class ForgeError extends HarnessError {
  readonly forgeCode: ForgeCode;
  readonly forgeClass: ForgeClass;
  readonly remedy: string;
  readonly facts: ForgeFacts;

  constructor(code: ForgeCode, message: string, facts: ForgeFacts = {}) {
    const flat: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(facts)) flat[key] = Array.isArray(value) ? value.join(",") : value as string | number | boolean;
    super(message, code, FORGE_CODES[code].class === "budget" || FORGE_CODES[code].class === "errored", flat);
    this.forgeCode = code;
    this.forgeClass = FORGE_CODES[code].class;
    this.remedy = FORGE_CODES[code].remedy;
    this.facts = deepFreeze({ ...facts });
  }
}

/** Whether `error` is a forge refusal (optionally: with one of `codes`). */
export function isForgeError(error: unknown, ...codes: readonly ForgeCode[]): error is ForgeError {
  return error instanceof ForgeError && (codes.length === 0 || codes.includes(error.forgeCode));
}
