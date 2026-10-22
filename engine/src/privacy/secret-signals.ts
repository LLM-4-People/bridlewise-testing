import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";

export type SecretSignalProfile = "admission" | "classification";

/**
 * ── ONE CATALOGUE, BECAUSE THERE WAS ONE QUESTION AND TWO ANSWERS ─────────
 *
 * "Is this key name sensitive?" was answered here AND by a private regex list
 * in the web server's redactor, and neither was a superset of the other:
 * this list lacked bare `token`, that one lacked `authorization`, `cookie`,
 * `privateKey` and `passphrase`. The consequence was not theoretical — the web
 * list also GATES CONFIG WRITES, so `authorization` was writable through the
 * API while the harness classified it as a secret. Two owners of one fact,
 * drifted, in the direction that matters.
 *
 * They are collapsed here. The web server asks {@link isSensitiveKeyName} and
 * keeps no list of its own, so widening this catalogue widens both at once.
 */
export const SENSITIVE_KEY_PARTS = deepFreeze([
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "databaseurl",
  "dsn",
  "onetimepassword",
  "otpseed",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "sessiontoken",
  // Bare `token`, from the web catalogue. As a normalized SUBSTRING this also
  // covers `authToken`, `refresh_token` and `token-value`, which is the point:
  // the key names that carry credentials are not a closed set, and a substring
  // over a normalized key is the shape that does not need to be.
  "token",
] as const);

/**
 * Patterns that must see the key AS WRITTEN, because a SEPARATOR decides them.
 *
 * Normalisation strips `.`, `_` and `-`, which is what makes the substring
 * test above robust — and it is exactly wrong for `auth`, whose whole meaning
 * here is "the standalone word". As a normalized substring it would swallow
 * `authority`, `authored` and `authenticated`; as a separator-bounded word on
 * the raw key it catches the `auth` object and nothing else. Kept beside the
 * parts rather than in a second module, because it answers the same question.
 *
 * NOT `deepFreeze`d, unlike the string list beside it, and the difference is
 * deliberate: freezing a RegExp freezes its `lastIndex`, so the day somebody
 * adds a `g` flag the pattern would throw on use instead of matching. A
 * `readonly` array of regexes gives the immutability that matters here without
 * that trap.
 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /(?:^|[._-])auth(?:$|[._-])/iu,
  // The `sk-` / `sk_` secret-key prefix (`sk-proj-…`, `sk_live_…`, `SK_`).
  //
  // This CANNOT be a normalized-substring part: `sk` as a substring of a
  // separator-stripped key matches `task`, `disk` and `risk`, so the name
  // vocabulary is structurally unable to carry it — only a separator-bounded
  // pattern can say "sk beginning a token". Bounded on the left by
  // start-of-string or a non-alphanumeric so `MY_SK_KEY` is caught while
  // `disk_usage` and `task-id` cannot be (`_` is a word char, which is why
  // this is not `\b`). Case-insensitive unconditionally, like everything in
  // this module: the performance label gate shipped a hand-folded `[Ss]k[-_]`
  // that admitted `SK-…` through one of its two compilations, which is the
  // defect class this owner exists to end.
  /(?:^|[^\p{L}\p{N}])sk[_-]/iu,
];

/**
 * THE FORMAT CATALOG — each signal carries its redaction CATEGORY and the
 * human DESCRIPTION of what it matched: the policy's rules
 * (`privacy-policy.ts`) and the explanation (`redaction-engine.ts`) derive
 * from here, so a new format is ONE entry (three parallel tables once had to
 * agree, and a new id fell to `unknown-sensitive`).
 *
 * It is also the ONE list every scanner reads (github-only §8.2): the
 * repository scan (`scripts/check-secrets.mjs`), and, generated from it,
 * GitHub's custom patterns and the history importer's gitleaks oracle. So
 * each row declares, beside its grammar:
 * - `github`: its GitHub projection. `provider` (GitHub's native secret type
 *   detects it; push protection on), `generic` (GitHub's non-provider
 *   generic patterns), `custom` (a custom pattern in GitHub's Hyperscan
 *   subset: no lookarounds, back-references or modifiers; `mustMatch` and
 *   `mustNotMatch` carry the conjuncts a lookahead expressed), or
 *   `door-only` with the reason no GitHub form is exact.
 * - `treeScan`: `true` when the repository scan applies the row, or the
 *   reason it does not (a context grammar with benign hits in shipped text).
 * - `fixtures`: positive cases as PARTS, joined only at runtime
 *   ({@link signalFixture}), so no source file ever holds a contiguous
 *   credential-shaped literal, plus negative near misses.
 */
export const SECRET_TEXT_SIGNAL_CATALOG = deepFreeze([
  { id: "makora-key",
    github: { kind: "custom", pattern: "mbh_[A-Za-z0-9_-]{20,}" }, treeScan: true,
    fixtures: { positive: [["mb", "h_", "Fx7".repeat(8)]], negative: ["mbh_short"] },
    category: "api-key", description: "Makora API key", admission: /\bmbh_[A-Za-z0-9_-]{20,}\b/u, classification: /\bmbh_[A-Za-z0-9_-]{20,}\b/u },
  // The coralbricks key (`cb_` + a mixed-case alphanumeric body): a BARE key
  // pasted into a file or a log matched nothing (friction-audit-1: the
  // scanner must know provider key formats). The body must carry a digit and
  // an uppercase letter and no further `_`, so a snake_case identifier that
  // happens to start `cb_` (a callback name) is never a secret.
  { id: "coralbricks-key",
    github: { kind: "custom", pattern: "cb_[A-Za-z0-9]{24,}", mustMatch: ["[0-9]", "[A-Z]"] }, treeScan: true,
    fixtures: { positive: [["cb", "_", "Q9w".repeat(9)]], negative: ["cb_on_message_received_handler_for_the_queue"] },
    category: "api-key", description: "coralbricks API key", admission: /\bcb_(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{24,}\b/u, classification: /\bcb_[A-Za-z0-9]{24,}\b/u },
  // THE SEPARATOR IS `[_-]`, NOT `_`, AND THAT WAS A REAL HOLE.
  //
  // This read `(?:sk|rk|pk|ghp|github_pat)_` — underscore only. OpenAI and
  // Anthropic keys use a HYPHEN (`sk-proj-…`, `sk-ant-api03-…`), which is the
  // single most common credential format there is, so the most common key in
  // the world was invisible to this detector unless something else — a
  // `key =` assignment, a declaration — happened to catch it. Measured: 3 of
  // 36 corpus positives were missed for exactly this reason and are caught
  // now.
  //
  // The widening is bounded by the `\b` and the 20-character tail: `risk-…`
  // and `desk-…` cannot match, because `\bsk` requires a word boundary
  // immediately before `sk`.
  { id: "token-prefix",
    github: { kind: "custom", pattern: "(?:sk|rk|pk)[_-][A-Za-z0-9_-]{20,}" }, treeScan: true,
    fixtures: { positive: [["s", "k-", "proj", "Zr4".repeat(8)], ["r", "k_", "Lm2".repeat(8)]], negative: ["risk-assessment-for-the-quarter-planning", "task_scheduler_configuration_value"] },
    category: "token", description: "provider API token", admission: /\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{20,}\b/u, classification: /\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{20,}\b/u },
  // ── GITHUB'S TOKENS ──────────────────────────────────────────────────────
  //
  // `ghp_`/`github_pat_` lived inside `token-prefix`; they are their own row
  // because GitHub detects them natively (a provider projection), while
  // `sk`/`rk`/`pk` need a custom pattern. The grammar is unchanged.
  //
  // The rest were unknown here: an App installation token (`ghs_`, the
  // `GITHUB_TOKEN` of every Actions run included), an OAuth token (`gho_`),
  // a user-to-server token (`ghu_`) and a refresh token (`ghr_`). Since
  // 2026-10-02 installation tokens are stateless JWTs of about 520 characters
  // WITH DOTS, so the `ghs_` body admits `.`; the last character may not be a
  // dot, so a sentence's full stop is never part of the token.
  { id: "github-personal-token",
    github: { kind: "provider", secretTypes: ["github_personal_access_token"] }, treeScan: true,
    fixtures: { positive: [["gh", "p_", "Ab1".repeat(12)], ["github", "_pat_", "11AB", "Cd2".repeat(20)]], negative: ["ghp_short"] },
    category: "token", description: "GitHub personal access token", admission: /\b(?:ghp|github_pat)[_-][A-Za-z0-9_-]{20,}\b/u, classification: /\b(?:ghp|github_pat)[_-][A-Za-z0-9_-]{20,}\b/u },
  { id: "github-installation-token",
    github: { kind: "provider", secretTypes: ["github_app_installation_access_token"] }, treeScan: true,
    fixtures: {
      positive: [["gh", "s_", "aB3dE".repeat(20), ".", "fG5hI".repeat(60), ".", "jK7lM".repeat(22), "jK7l"], ["gh", "s_", "Pq8".repeat(12)]],
      negative: ["ghs_tooShort.x", "ghs_"],
    },
    category: "token", description: "GitHub App installation token", admission: /\bghs_[A-Za-z0-9._-]{35,}[A-Za-z0-9_-]/u, classification: /\bghs_[A-Za-z0-9._-]{35,}[A-Za-z0-9_-]/u },
  { id: "github-oauth-token",
    github: { kind: "provider", secretTypes: ["github_oauth_access_token"] }, treeScan: true,
    fixtures: { positive: [["gh", "o_", "Rs9".repeat(12)]], negative: ["gho_short"] },
    category: "token", description: "GitHub OAuth token", admission: /\bgho_[A-Za-z0-9]{36,}\b/u, classification: /\bgho_[A-Za-z0-9]{36,}\b/u },
  // GitHub's provider list names no type for `ghu_`, so it is a custom pattern.
  { id: "github-user-to-server-token",
    github: { kind: "custom", pattern: "ghu_[A-Za-z0-9]{36,}" }, treeScan: true,
    fixtures: { positive: [["gh", "u_", "Tv6".repeat(12)]], negative: ["ghu_short"] },
    category: "token", description: "GitHub user-to-server token", admission: /\bghu_[A-Za-z0-9]{36,}\b/u, classification: /\bghu_[A-Za-z0-9]{36,}\b/u },
  { id: "github-refresh-token",
    github: { kind: "provider", secretTypes: ["github_refresh_token"] }, treeScan: true,
    fixtures: { positive: [["gh", "r_", "Wx4".repeat(26)]], negative: ["ghr_short"] },
    category: "token", description: "GitHub refresh token", admission: /\bghr_[A-Za-z0-9]{36,}\b/u, classification: /\bghr_[A-Za-z0-9]{36,}\b/u },
  // The provider key format that once leaked (rotated): `sk-` and exactly 64
  // lowercase hex digits. `token-prefix` matches it too; its own row gives it
  // its own push-protected pattern and its own id in every finding.
  { id: "neuralwatt-key",
    github: { kind: "custom", pattern: "sk-[0-9a-f]{64}" }, treeScan: true,
    fixtures: { positive: [["s", "k-", "0a1b2c3d".repeat(8)]], negative: ["sk-0a1b2c3d"] },
    category: "api-key", description: "Neuralwatt API key", admission: /\bsk-[0-9a-f]{64}\b/u, classification: /\bsk-[0-9a-f]{64}\b/u },
  { id: "aws-access-key",
    github: { kind: "provider", secretTypes: ["aws_access_key_id"] }, treeScan: true,
    fixtures: { positive: [["AK", "IA", "Q7XZ".repeat(4)]], negative: ["AKIA123"] },
    category: "api-key", description: "AWS access key id", admission: /\bAKIA[A-Z0-9]{16}\b/u, classification: /\bAKIA[A-Z0-9]{16}\b/u },
  { id: "bearer-token",
    github: { kind: "custom", startDelimiter: "[Bb][Ee][Aa][Rr][Ee][Rr][ \\t]+", pattern: "[A-Za-z0-9._~+/-]{16,}={0,2}" }, treeScan: true,
    fixtures: { positive: [["Bea", "rer ", "Tz5x".repeat(5)]], negative: ["Bearer short"] },
    category: "bearer-token", description: "bearer token", admission: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu, classification: /\bBearer\s+\S+/iu },
  // A PGP key's header ends with ` BLOCK`. The repository scanner knew that
  // and this row did not, so the redaction engine missed a PGP private key.
  { id: "private-key",
    github: { kind: "generic", secretTypes: ["rsa_private_key", "ec_private_key", "generic_private_key", "openssh_private_key", "pgp_private_key"] }, treeScan: true,
    fixtures: { positive: [["-----BEGIN RSA PRI", "VATE KEY-----"], ["-----BEGIN ENCRYPTED PRI", "VATE KEY-----"], ["-----BEGIN PGP PRI", "VATE KEY BLOCK-----"]], negative: ["-----BEGIN PUBLIC KEY-----"] },
    category: "private-key", description: "private key block", admission: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u, classification: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u },
  {
    id: "credential-assignment",
    github: { kind: "door-only", reason: "its negative lookaheads inspect the value's context (a call after it, an identifier or hex shape), which GitHub's Hyperscan subset cannot express" },
    treeScan: { reason: "a context grammar with known benign hits in shipped code (an enum value such as `credentialSecret: \"credential-secret\"`); the door's tree judge enforces it" },
    fixtures: { positive: [["api_key = \"", "Zm9vYmFyYmF6cXV4MTIz", "\""]], negative: ["password = getPasswordFromVault()"] },
    category: "credential",
    description: "credential assignment",
    admission: /(?:api[_ -]?key|authorization|password|private[_ -]?key|secret|session[_ -]?token)\s*[:=]\s*["']?(?![A-Za-z0-9+/_-]{16,}\s*\()(?!(?:[A-Za-z]*_[A-Za-z_]*|[0-9a-f]{32,})(?:[^A-Za-z0-9_$]|$))[A-Za-z0-9+/_-]{16,}/iu,
    classification: /(?:api[_ -]?key|authorization|password|private[_ -]?key|secret|session[_ -]?token)\s*[:=]\s*\S+/iu,
  },
  {
    // A URL's userinfo is a credential when it carries a PASSWORD:
    // `scheme://user:pass@host`. The benign twin `scheme://user@host` has no
    // colon in the userinfo and cannot match — that is the veto, and it is
    // structural rather than a keyword. The span stops at the `@` so the host
    // and database name stay visible after redaction, and the lookahead
    // requires a host so `scheme://user:pass@` (no host) is not a URL.
    //
    // A KEEP MARK IS NOT A PASSWORD. The write-only secret primitive
    // (`secret-parts.ts`, `‹keep:<place>›`) masks a whole userinfo and emits
    // the marker in its place; the marker's own `:` would otherwise read as
    // the user/password separator, and an egress redactor would replace the
    // marker with `[REDACTED:credential]` and destroy the write-back
    // contract (MCP SECC-V S3). The lookahead vetoes only a userinfo that IS
    // exactly the labelled mark, so a password merely containing those
    // characters, or a real password in front of a marked query, still
    // matches. The marker spelling is the MCP owner's contract
    // (`engine/src/privacy/secret-parts.ts`); this signal is the owner of
    // deciding it is not a credential.
    //
    // ── THE DELIMITER IS THE LAST `@`, NOT THE FIRST ──
    //
    // WHATWG URL delimits the userinfo at the LAST `@` before `/`, `?` or
    // `#`; a username may itself contain one (`alice@example.com`) and a
    // kept userinfo followed by a real password is `mark@user:pass@host`.
    // The first/@ grammar below split at the first colon-before-at, so it
    // read `user@host:pass@host` as no URL at all and read
    // `‹keep:x›@user:pass@host` as one already-concealed mark.
    //
    // The alternative therefore runs the userinfo GREEDILY to the authority's
    // last `@` and carries the host after it, for two reasons: the userinfo
    // may itself contain an `@` (a password written raw), and a span that
    // stopped at `@` can be shorter than an email-shaped fragment inside the
    // password (`Real!Pass123@db.internal`) — the overlap resolver keeps the
    // longest span, so the shorter one would leave `Real!` on the wire. The
    // second alternative starts at the `@` AFTER a keep mark and preserves
    // the mark; the mark's own `:` is not re-read as a password separator.
    id: "connection-string",
    github: { kind: "door-only", reason: "the keep-mark veto and the last-@ userinfo grammar are lookarounds; GitHub's generic postgres/mongodb/mysql patterns cover only some schemes" },
    treeScan: { reason: "shipped documentation and the redaction owner's own grammar sources spell example connection strings; the door's tree judge enforces it" },
    fixtures: { positive: [["postgres://app:", "Hunter2pass", "@db.internal/app"]], negative: ["postgres://app@db.internal/app"] },
    category: "credential",
    description: "connection-string credential",
    admission: /\b[a-z][a-z0-9+.-]*:\/\/(?!(?:‹keep:[^›\s]{1,200}›)@)[^\s/?#]*:[^\s/?#]+@[^\s/?#]+|@[^\s/?#]*:[^\s/?#]+@[^\s/?#]+/iu,
    classification: /\b[a-z][a-z0-9+.-]*:\/\/(?!(?:‹keep:[^›\s]{1,200}›)@)[^\s/?#]*:[^\s/?#]+@[^\s/?#]+|@[^\s/?#]*:[^\s/?#]+@[^\s/?#]+/iu,
  },
  {
    // ── THE OTHER STANDARD CONNECTION STRINGS ──
    //
    // `scheme://user:pass@host` is one spelling of a credential, not the
    // only one. ADO.NET/SQL Server (and every DSN that copied it) uses
    // `Password=` / the standard alias `Pwd=`; Oracle's EZConnect form is
    // `thin:user/pass@host`; a JDBC SQL Server URL carries the same keys in
    // its `;` parameter list; and a PostgreSQL URL can put credentials in
    // its query (`?user=app&password=…`). The 16-character admission floor
    // of `credential-assignment` is not a licence to miss a short password:
    // these grammars name the credential structurally, so the VALUE may be
    // any non-empty token.
    //
    // The value is matched without its key so the key and separators stay
    // readable after redaction, and a keep mark or an existing mask is not
    // re-read as a value (the write-back contract again).
    id: "dsn-credential",
    github: { kind: "custom", startDelimiter: "(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Ww][Dd])[ \\t]*=[ \\t]*", pattern: "[^\\s;&\"'`]+", mustNotMatch: ["^(?:null|undefined|true|false)$", "^[‹\\[<`\"'\\\\]"] },
    treeScan: { reason: "shipped documentation and the redaction owner's own grammar sources spell example DSNs; the door's tree judge enforces it" },
    fixtures: { positive: [["Server=db;User Id=app;Pass", "word=", "Hunter2pass;"]], negative: ["Password=null"] },
    category: "credential",
    description: "connection-string credential",
    admission: /(?<=(?<![A-Za-z0-9])(?:password|pwd)\s*=\s*)(?!(?:null|undefined|true|false)\b|‹|\[|<|`|"|'|\\)[^\s;&"'`]+/iu,
    classification: /(?<=(?<![A-Za-z0-9])(?:password|pwd)\s*=\s*)(?!(?:null|undefined|true|false)\b|‹|\[|<|`|"|'|\\)[^\s;&"'`]+/iu,
  },
  {
    // Oracle EZConnect: `[jdbc:]oracle:(thin|oci):user/pass@host`. There is
    // no key=value noun to cue on and no `://` for the URL grammar, so the
    // `user/pass@` segment itself is the evidence. A userinfo without the
    // slash (no password) cannot match.
    id: "oracle-connection-string",
    github: { kind: "custom", pattern: "(?:jdbc:)?oracle:(?:thin|oci):[^\\s@/:]+/[^\\s@/?#]+@", endDelimiter: "[^\\s/?#]" }, treeScan: true,
    fixtures: { positive: [["jdbc:oracle:thin:app/", "Hunter2pass", "@db.internal:1521/XE"]], negative: ["jdbc:oracle:thin:@db.internal:1521/XE"] },
    category: "credential",
    description: "Oracle connection-string credential",
    admission: /\b(?:jdbc:)?oracle:(?:thin|oci):[^\s@/:]+\/[^\s@/?#]+@(?=[^\s/?#])/iu,
    classification: /\b(?:jdbc:)?oracle:(?:thin|oci):[^\s@/:]+\/[^\s@/?#]+@(?=[^\s/?#])/iu,
  },
] as const);

export type SecretTextSignal = (typeof SECRET_TEXT_SIGNAL_CATALOG)[number];
export type SecretTextSignalId = SecretTextSignal["id"];

/**
 * A positive fixture of one catalogue row, assembled from its parts at
 * runtime: the one way a test, a guard or a generator obtains a
 * credential-shaped value, so the value never sits in a source file.
 */
export function signalFixture(id: SecretTextSignalId, index = 0): string {
  const signal = SECRET_TEXT_SIGNAL_CATALOG.find((entry) => entry.id === id);
  const parts = signal?.fixtures.positive[index];
  if (parts === undefined) throw new HarnessError(`the secret signal ${id} has no positive fixture ${String(index)}`, "secret_signal_fixture_missing");
  return parts.join("");
}

/** The rows the repository scan applies (`treeScan: true`). */
export function treeScannedSignals(): readonly SecretTextSignal[] {
  return SECRET_TEXT_SIGNAL_CATALOG.filter((signal) => signal.treeScan === true);
}

/**
 * THE PUBLICATION PRIVACY ROWS (`category: "privacy"`): text that is not a
 * credential but must never be published, for the repository scan only.
 * They live beside the credential rows so the repository scan has one list,
 * and they are a separate array because the redaction engine reads every
 * credential row: a home path in a tool's output is not something to redact.
 *
 * `appliesTo: "text"` rows run over every line and every tracked path;
 * `"file-name"` rows run over the tracked path's last segment.
 */
const HOME_PATH_PLACEHOLDERS = deepFreeze([
  "example", "user", "runner", "bridlewise", "ubuntu", "node", "app",
  "workspace", "demo", "x", "u", "me", "alice", "bob", "jane", "jdoe",
  "username", "test", "foo", "bar", "baz",
] as const);

// A placeholder must be a whole segment: a documented name followed by a
// sentence period is still the placeholder; a dotted account (`jane.doe`) or
// a name merely BEGINNING with a placeholder (`example123`) is not.
const HOME_PLACEHOLDER_GUARD = `(?!(?:${HOME_PATH_PLACEHOLDERS.join("|")})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9]))`;

export const PUBLICATION_PRIVACY_SIGNALS = deepFreeze([
  { id: "home-path", category: "privacy", appliesTo: "text", description: "absolute home path", pattern: new RegExp(`\\/home\\/${HOME_PLACEHOLDER_GUARD}[A-Za-z0-9._-]+`, "u") },
  { id: "internal-git-host", category: "privacy", appliesTo: "text", description: "internal Git host", pattern: /git\.localserver\.ca\b/u },
  { id: "internal-provider-host", category: "privacy", appliesTo: "text", description: "internal provider host", pattern: /api\.neuralwatt\.com\b/u },
  { id: "internal-scratch-path", category: "privacy", appliesTo: "text", description: "internal scratch path", pattern: /\/tmp\/opencode\b/u },
  { id: "local-evidence-state", category: "privacy", appliesTo: "text", description: "local evidence state directory", pattern: /\bcode-harness\.fresh-evidence\b/u },
  // A database or SQLite state file (and its -wal/-shm/-journal sidecars) is
  // not a credential file, but a local data blob that is never published.
  { id: "database-state", category: "privacy", appliesTo: "file-name", description: "database state", pattern: /\.(?:db|sqlite3?)(?:-[a-z]+)?$/iu },
] as const);

export function secretTextSignalIds(
  value: string,
  profile: SecretSignalProfile,
): readonly string[] {
  return SECRET_TEXT_SIGNAL_CATALOG
    .filter((signal) => signal[profile].test(value))
    .map((signal) => signal.id);
}

export function hasSecretTextSignal(value: string, profile: SecretSignalProfile): boolean {
  return secretTextSignalIds(value, profile).length > 0;
}

// Module-private since S36: every outside consumer now asks
// `isSensitiveKeyName`, which carries BOTH halves of the key question. A
// caller reaching for the part half alone is exactly how `SK_TEST` egressed
// as `public` (U-42) — so the narrower question is no longer offered.
function normalizedKeyHasSensitivePart(normalizedKey: string): boolean {
  return SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part));
}

/**
 * The one form a key name is compared in: NFKC-normalised, lower-cased, and
 * stripped of everything that is not a letter or a digit.
 *
 * Owned here rather than in the classifier that used to hold it, because the
 * comparison and the normalisation are one rule: a second caller that
 * normalised differently would be asking a different question while appearing
 * to ask the same one.
 *
 * PERCENT-DECODING IS THE CALLER'S, and deliberately not part of this. Only
 * the data classifier sees keys that may arrive URL-encoded, and decoding can
 * fail on malformed input, which needs the shared best-effort owner — an
 * import that drags this module's whole dependency chain into every consumer.
 * This module is reached from the web server's config loader, which is loaded
 * in a browser environment by part of that suite, and the extra edge broke
 * module resolution for 76 files. So the shape stays minimal and the one
 * caller that needs the decode composes it.
 */
export function normalizeSecretKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

/**
 * Whether a key name is sensitive. THE single owner of that question for both
 * repositories: the harness's data classifier and the web server's redactor
 * and config write gate all consume this, so a name added here is covered
 * everywhere at once and the two cannot drift apart again.
 */
export function isSensitiveKeyName(key: string): boolean {
  if (normalizedKeyHasSensitivePart(normalizeSecretKey(key))) return true;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function secretLikeValuePaths(value: unknown, profile: SecretSignalProfile): readonly string[] {
  const paths: string[] = [];
  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      if (hasSecretTextSignal(current, profile)) paths.push(path);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$");
  return Object.freeze(paths);
}
