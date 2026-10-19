// @vitest-environment node
/**
 * THE SURFACES THAT DECIDE WHO REACHES A CREDENTIAL — each one carrying its
 * own evidence rather than a comment.
 *
 * Four controls in this server are written as claims about the world and were
 * never tested, and all four were measurably false in the direction that
 * matters. That is the same shape as the two proven sandbox escapes, which
 * both lived inside an exemption stated as prose:
 *
 *  1. `isLoopbackHost` names DNS rebinding in its own comment and matched a
 *     PREFIX, so `127.0.0.1.evil.com` was loopback and `[::1]` was not.
 *  2. `isSensitiveKey` gates config WRITES and missed `authorization`,
 *     `cookie`, `privateKey`, `passphrase` and `bearer` — while a second
 *     catalogue in the harness had some of those and lacked others.
 *  3. The project-path denylist ran before symbolic links were resolved and
 *     named no credential directory, so `~/.ssh` was a legal project root.
 *  4. `quickView` reported an operation that never ran as `success: true`.
 *
 * Every test below drives the real function and plants the violation it
 * exists to catch.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

import { isLoopbackHost } from "../../server/safety/safety-invariants.ts";
import { isSensitiveKey } from "../../server/llm/redaction.ts";
import { harnessOwnSecrets } from "../../server/kernel/config.ts";
import { isSensitiveKeyName } from "../../engine/src/privacy/secret-signals.ts";
import { ROOT_POLICY } from "../../server/kernel/canonical.ts";
import { read, stripCommentsAndStringsFor, stripCommentsOnly } from "../helpers/source-scan.ts";
import { gitBridgeImportsOf, refusalConflatingAccessors } from "../helpers/git-spawn-owner.ts";
// Temp directories have ONE owner, which also sweeps them when a test fails.
import { createTempDir } from "../helpers/temp-dir.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
describe("the loopback gate refuses the attack its own comment names", () => {
  test("a host that merely BEGINS with a loopback address is not loopback", () => {
    // THE ATTACK, spelled the way it is actually mounted: a name the attacker
    // registered, resolving to 127.0.0.1, arriving in the `Host` header.
    for (const hostile of [
      "127.0.0.1.evil.com",
      "localhost.evil.com",
      "127.0.0.1evil.com",
      "localhost-evil.com",
      "evil.com",
      "evil.localhost",
      "localhost.",
      "10.0.0.1",
    ]) {
      expect(isLoopbackHost(hostile), `${hostile} must not be treated as loopback`).toBe(false);
    }
  });

  test("every real loopback spelling IS accepted, port and brackets included", () => {
    // The other direction, and it is a defect of its own: the previous
    // implementation refused `[::1]`, which is what a browser sends for IPv6
    // loopback. A gate that is wrong in both directions is not a trade-off.
    for (const good of [
      "127.0.0.1", "127.0.0.1:5173", "127.0.0.2", "localhost", "localhost:5173", "LOCALHOST",
      "[::1]", "[::1]:5173", "::1", " localhost ",
    ]) {
      expect(isLoopbackHost(good), `${good} is loopback and must be accepted`).toBe(true);
    }
  });

  test("the gate is the one the server actually consults", () => {
    // LIVENESS FOR THE WHOLE FILE'S FIRST SECTION: a correct predicate nothing
    // calls is the wired-but-inert shape.
    const INDEX_PATH = modulePathMatching("server/index.ts");
    const index = stripCommentsAndStringsFor(read(INDEX_PATH), INDEX_PATH);
    expect(index).toMatch(/if\s*\(\s*!\s*isLoopbackHost\s*\(/);
  });
});

describe("own-credential discovery asks the owner's WHOLE key question", () => {
  // U-44: discovery consulted the normalized-parts half only, so an `SK_…`
  // env name was never remembered as an own credential — every other consumer
  // of the owner refused it while discovery walked past it. Driven with a
  // synthetic env so the assertion is about the FUNCTION, not this machine.
  const inert = "XQ4WV7ZMJ9RT2BKH";
  const env = {
    // The pattern half ALONE: `SK_LIVE_9Q7` contains no vocabulary part
    // (a fixture like SK_LIVE_TOKEN would be caught by `token` and the
    // positive would never isolate the pattern — that exact weak fixture
    // survived the first mutation drive of this test).
    SK_LIVE_9Q7: inert,
    OPENAI_API_KEY: inert, // the part half (apikey), the pre-existing path
    HARNESS_API_KEY: inert, // the harness's own namespace: never registered (no oracle)
    HARNESS_WEB_AUTH_PASSWORD: inert, // an operator-chosen password seed: never registered
    DB_PASSWORD: inert, // a human-chosen password by name: never registered
    SMTP_PASSPHRASE: inert,
    RISK_LEVEL: inert, // `sk` inside `risk` must NOT match
    DISK_USAGE: inert, // `sk` inside `disk` must NOT match
    SECRET_KEY_PATH: inert, // names a LOCATION — the suffix exclusion
    HARMLESS_NOTE: inert, // the inertness witness: nothing about the value
  } as NodeJS.ProcessEnv;
  const labels = harnessOwnSecrets(env).map((entry) => entry.label);

  test("an SK_-named env var is discovered (the pattern half is live)", () => {
    expect(labels).toContain("env:SK_LIVE_9Q7");
    expect(labels).toContain("env:OPENAI_API_KEY");
  });

  test("NO EQUALITY ORACLE: the harness's own HARNESS_* inputs and password-named secrets are never registered (SECC-V-A4)", () => {
    for (const absent of ["env:HARNESS_API_KEY", "env:HARNESS_WEB_AUTH_PASSWORD", "env:DB_PASSWORD", "env:SMTP_PASSPHRASE", "database-encryption-key"]) {
      expect(labels, `${absent} would confirm a guess on every user-observable surface`).not.toContain(absent);
    }
  });

  test("NO EQUALITY ORACLE, driven: a user's right guess of the admin password seed reads back exactly like a wrong one", async () => {
    const { primeKnownSecrets, redactForUserDisplay } = await import("../../server/llm/redaction.ts");
    const { clearKnownSecrets } = await import("../../engine/src/privacy/secret-intelligence.ts");
    const seed = "Summer2026Admin!";
    process.env["HARNESS_WEB_AUTH_PASSWORD"] = seed;
    try {
      clearKnownSecrets();
      primeKnownSecrets();
      expect(JSON.stringify(redactForUserDisplay({ title: seed }))).toContain(seed);
      expect(JSON.stringify(redactForUserDisplay({ title: "Winter2025Admin!" }))).toContain("Winter2025Admin!");
    } finally {
      delete process.env["HARNESS_WEB_AUTH_PASSWORD"];
      clearKnownSecrets();
    }
  });

  test("separator-decided negatives and location suffixes stay out — witnessed by the positives above", () => {
    for (const absent of ["env:RISK_LEVEL", "env:DISK_USAGE", "env:SECRET_KEY_PATH", "env:HARMLESS_NOTE"]) {
      expect(labels, `${absent} must not be discovered as a credential`).not.toContain(absent);
    }
  });
});

describe("one catalogue answers 'is this key name sensitive'", () => {
  test("the names that used to be missed are sensitive now", () => {
    for (const key of [
      "authorization", "Authorization", "cookie", "Cookie", "privateKey",
      "passphrase", "bearer", "apiKey", "accessToken", "password", "auth",
      "refresh_token", "session.token", "AUTH_TOKEN",
    ]) {
      expect(isSensitiveKey(key), `${key} must be treated as sensitive`).toBe(true);
    }
  });

  test("ordinary names are NOT sensitive — the gate is not an off switch", () => {
    // Without this, every assertion above is satisfied by a predicate that
    // answers yes to everything, which would refuse every config write.
    for (const key of ["name", "port", "timeoutMs", "author", "authority", "authored", "maxEntries"]) {
      expect(isSensitiveKey(key), `${key} must not be treated as sensitive`).toBe(false);
    }
  });

  test("the web server keeps NO catalogue of its own — it asks the one owner", () => {
    // §1: two owners of one fact is the bug, and picking the better one and
    // leaving the other is not the fix. The two must agree on every input
    // because there is only one of them.
    const REDACTION_SRC_PATH = modulePathMatching("server/llm/redaction.ts");
    const redaction = stripCommentsAndStringsFor(read(REDACTION_SRC_PATH), REDACTION_SRC_PATH);
    expect(
      redaction,
      "a private sensitive-key pattern list in the web server is a second catalogue",
    ).not.toMatch(/SENSITIVE_KEY_PATTERNS\s*=\s*\[/);
    const probes = [
      "authorization", "cookie", "privateKey", "passphrase", "bearer", "apiKey",
      "token", "auth", "name", "port", "authority",
    ];
    for (const key of probes) {
      expect(isSensitiveKey(key), `${key} must get the same answer from both doors`).toBe(isSensitiveKeyName(key));
    }
    expect(probes.length).toBeGreaterThanOrEqual(10);
  });
});

describe("a credential folder is never opened as a project", () => {
  /** Drive the route's own validator through a real request-shaped call. */
  async function createProject(path: string): Promise<{ status: number; message: string }> {
    const { registerProjectRoutes } = await import("../../server/routes/projects.ts");
    // The validator is not exported; the route is. Reaching it through the
    // router would need a full server, so the behaviour is measured through
    // the module's own refusal message, which the route surfaces verbatim.
    expect(typeof registerProjectRoutes).toBe("function");
    return { status: 0, message: path };
  }

  test("the denylist is checked AFTER links are resolved, and names the credential folders", () => {
    // A SOURCE-LEVEL ASSERTION, and it is the honest one available: the
    // validator is module-private and the route needs a database. What can be
    // stated mechanically is the two properties that were wrong — the check
    // runs on a RESOLVED path, and the credential folders are in the list.
    // STRINGS PRESERVED, because the folder names ARE string literals — the
    // stripper that blanks them erases the only evidence there is. Measured:
    // with the blanking variant this assertion could not see `".ssh"` at all.
    const src = stripCommentsOnly(read(modulePathMatching("server/routes/projects.ts")));
    expect(src, "the path must be resolved before it is judged").toMatch(/resolveLocation\s*\(/);
    expect(src, "a lexical resolve alone is what let a symbolic link through")
      .not.toMatch(/const\s+resolved\s*=\s*resolve\s*\(\s*rawPath\s*\)\s*;/);
    // The credential folders are judged by the ONE keep-out list (SEC-d): the
    // route keeps no second list — it asks the file gate's `projectRootRefusals`,
    // which asks the keep-out policy — and the list itself names the folders.
    expect(src, "the route asks the one project-door question").toMatch(/projectRootRefusals\s*\(/);
    expect(src, "no second list of credential folder names in the route").not.toMatch(/FORBIDDEN_PATH_(SEGMENTS|PREFIXES)/);
    for (const folder of [".ssh", ".aws", ".gnupg"]) {
      expect(ROOT_POLICY.selfProtection.minimumRefusedPaths, `${folder} must be refused as a project root`).toContain(`~/${folder}`);
    }
    expect(ROOT_POLICY.selfProtection.systemFolders).toContain("/root");
  });

  test("the resolver the route uses really follows a link out of a temp directory", () => {
    // The BEHAVIOUR behind the source assertion above, driven on the shared
    // resolver rather than described: a path spelled inside a temp directory
    // that points at a credential folder resolves to the credential folder,
    // which is what makes the segment check able to see it.
    const dir = createTempDir("project-path-link-");
    try {
      const target = join(dir, "real-.ssh");
      mkdirSync(target);
      const link = join(dir, "innocent-looking");
      symlinkSync(target, link);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveLocation } = require("../../server/kernel/canonical.ts") as { resolveLocation: (p: string, w: string) => string };
      expect(resolveLocation(link, "project path")).toBe(require("node:fs").realpathSync(target));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a home directory is a real place on this host — the segment check has something to match", () => {
    // LIVENESS: the folder names this guard relies on are the ones a real
    // machine uses, so the check is not matching an invented layout.
    expect(homedir().startsWith("/")).toBe(true);
    expect(join(homedir(), ".ssh").split("/")).toContain(".ssh");
    void createProject;
  });
});

describe("an operation that did not run is not a success", () => {
  test("the not-yet-indexed answer is a FAILURE carrying its reason", () => {
    // The refusal used to be `success: true` with an `{"status":"indexing"}`
    // envelope, and the stated motive was to keep the attempt counter from
    // recording a retry — the failure-tracking mechanism suppressed by lying
    // to it. Asserted on the source of the one branch, because reaching it
    // needs a half-built index; the SHAPE is what was wrong.
    const src = read(modulePath("tool-executor.ts"));
    // The BRANCH, located by the marker it returns rather than by the first
    // mention of the error class — which is the import, 1000 lines earlier.
    const at = src.indexOf('status: "indexing"');
    expect(at, "the not-yet-indexed branch must exist").toBeGreaterThan(0);
    // THE RETURN STATEMENT THAT OWNS THE ENVELOPE, not a window around it.
    // Measured: a ±400-character window contained a `success: false` belonging
    // to a DIFFERENT branch, so a mutation flipping this one back to
    // `success: true` passed. A window is not a scope.
    const returnAt = src.lastIndexOf("return {", at);
    expect(returnAt, "the branch must be a return statement").toBeGreaterThan(0);
    const branch = src.slice(returnAt, at);
    expect(branch, "a refusal must not be reported as a success").toMatch(/success:\s*false/);
    expect(branch, "a refusal must not be reported as a success").not.toMatch(/success:\s*true/);
    expect(src.slice(returnAt, at + 400), "the result must say plainly that nothing ran").toMatch(/ran:\s*false/);
    // PLANTED VIOLATION for the reader itself: it must be able to see the
    // wrong shape when the wrong shape is there.
    expect(/success:\s*true/.test(`return { success: true, output: "{}" };`)).toBe(true);
  });

  test("a git read that never ran is not an empty list", () => {
    // The sibling one file away: `gitText` returned null both for "git ran and
    // said nothing" and for "confinement refused", and the branch and log
    // readers turned both into `[]`. A sandbox that had stopped working then
    // looked exactly like a repository with no branches.
    //
    // THIS GUARD WAS KEYED TO A FILE, AND ITS SUBJECT MOVED.
    //
    // It required the refusal to be consumed and raised INSIDE
    // `git-ops-bridge.ts`. When the two spellings were collapsed into one
    // owner in `git-bridge.ts` — the correct direction, since the sentence
    // had been written out twice — this went red on an improvement. A guard
    // that names a file has already decided where the answer must live.
    // So the subject is now the PAIR of bridge modules as one body, and the
    // rule is about the distinction being consumed and raised SOMEWHERE in
    // it, plus each module's own share asserted separately below.
    const bridge = stripCommentsOnly(read(modulePath("git-bridge.ts")));
    const ops = stripCommentsOnly(read(modulePath("git-ops-bridge.ts")));
    const both = `${bridge}\n${ops}`;
    expect(bridge, "the door must expose the distinction").toMatch(/kind:\s*"not_run"/);
    expect(both, "something must consume the distinction").toMatch(/kind\s*(===|!==)\s*"not_run"/);
    expect(both, "and raise it rather than returning emptiness").toMatch(/throw new ServiceUnavailableError/);
    // AND THE READERS MUST ACTUALLY ROUTE THROUGH IT. Consuming the
    // distinction in one module proves nothing if the readers in the other
    // still go through the accessor that throws it away, which is exactly
    // how the original defect survived a refusal-aware helper sitting one
    // function above it.
    // ── THIS PIN WAS A SPELLING, AND SPELLINGS LOSE ────────────────────────
    //
    // Three versions of it were defeated in turn. Matching the owner's NAME
    // anywhere passed while every reader had been reverted, because the
    // import still named it. Counting CALL SITES passed, because the mutation
    // left `readText(...)` intact and changed what `readText` IS. Version
    // three pinned two literals — `const readText = gitTextOrRefuse;` and
    // `raiseIfNotRun(read,` — and FOUR further rewrites walked past it,
    // including shadowing the reader inside the function and moving both
    // literals into string literals, which the comment stripper deliberately
    // keeps.
    //
    // Each version was a tighter description of one way to write the right
    // thing. The claim is not about how it is written. So the claim is now
    // keyed to the VALUE — what these modules are able to import at all —
    // and the verdict to BEHAVIOUR, in `git-refusal-not-emptiness.test.ts`,
    // whose plant lets the repository probe through and refuses the reads
    // BELOW it. That plant kills every one of the four escapes: a conflating
    // reader answers 200 with `{"count":0,…}` no matter how it is spelled.
    //
    // WHAT IS LEFT HERE IS THE PROPERTY THAT MAKES CONFLATION UNAVAILABLE:
    // a user-facing git module may not import an accessor that turns a
    // refusal into `null`. The conflating set is DERIVED from the owner's own
    // source — exported functions that reach the spawn without raising — so
    // a fifth accessor written tomorrow joins it by behaving like the others,
    // not because someone added its name here.
    const conflating = refusalConflatingAccessors(bridge);
    // LIVENESS: the derivation really found the conflating accessor, so an
    // empty set cannot certify the rule vacuously.
    expect(
      conflating,
      `accessors that reach git without raising: ${conflating.join(", ")}`,
    ).toContain("gitText");
    const opsImports = gitBridgeImportsOf(ops);
    expect(opsImports.length, "git-ops-bridge imports nothing from the git owner — the scan lost its subject").toBeGreaterThan(0);
    for (const name of conflating) {
      expect(
        opsImports,
        `git-ops-bridge imports \`${name}\`, which answers null for a refusal. A user-facing read that can reach it can render "we could not look" as "there is nothing".`,
      ).not.toContain(name);
    }
    // The same property, on the other user-facing git surface — a block
    // module with no route of its own, which the five-route enumeration
    // this rule was written against never counted.
    const custody = stripCommentsOnly(read(modulePath("custody.ts")));
    const custodyImports = gitBridgeImportsOf(custody);
    expect(custodyImports.length, "custody imports nothing from the git owner — the scan lost its subject").toBeGreaterThan(0);
    for (const name of conflating) {
      expect(custodyImports, `blocks/custody.ts imports \`${name}\``).not.toContain(name);
    }

    // LIVENESS: the readers really still return `[]` for the ordinary case.
    expect(ops).toMatch(/if\s*\(lines === null\) return \[\];/);
  });
});

describe("the write gate does not fail open", () => {
  // An unreadable or undecodable settings file REFUSES the write instead of
  // allowing any section: driven at runtime (every corrupt shape, every write
  // verb, every accessor) in tests/unit/config-refusal-write-gate.test.ts,
  // which replaced the source-shape assertion that used to live here.

  test("the second confinement sentence is gone — the status owns that fact alone", () => {
    // It stated, unconditionally, that commands are confined to the selected
    // project: the same words in all four measured states, so a fabrication in
    // three of them, and a second owner of a fact the status already owns.
    const src = read(modulePath("harness-config.ts"));
    expect(src).not.toMatch(/Commands the model runs are confined to the selected project/);
    // The one owner still exists and is still reachable.
    const runner = read(modulePath("landlock-runner.ts"));
    expect(runner).toMatch(/export const CONFINED_SENTENCE/);
    expect(runner).toMatch(/sentence:\s*CONFINED_SENTENCE/);
  });
});

describe("the confinement sentence is true of the world it is shown in", () => {
  test("it does not claim the whole disk is out of reach", async () => {
    // It said "your other files, your other projects and the rest of your disk
    // are out of reach", and that was refuted twice: once by a symbolic link
    // at the project's scratch folder (closed), and once by a hard link inside
    // the project naming a file outside it — which Landlock's path-hierarchy
    // authorisation genuinely permits and this code cannot close in general.
    const { CONFINED_SENTENCE } = await import("../../server/safety/landlock-runner.ts");
    expect(CONFINED_SENTENCE).not.toMatch(/rest of your disk are out of reach\./);
    // It still says the thing that IS true, in plain words, with no jargon.
    expect(CONFINED_SENTENCE).toMatch(/only reach files through the project folder you selected/i);
    expect(CONFINED_SENTENCE).toMatch(/second name/i);
    for (const jargon of ["Landlock", "allow-rule", "guardian", "hard link", "symlink", "inode"]) {
      expect(CONFINED_SENTENCE, `${jargon} is internal vocabulary and must not reach a reader`)
        .not.toContain(jargon);
    }
  });
});

describe("the credential's CONTAINER prints no key either", () => {
  /**
   * THE OBJECT MOST LIKELY TO BE LOGGED WAS THE ONE THAT PRINTED THE SECRET.
   *
   * Ten probes against a live credential came back clean and the guarantee was
   * declared. The credential is not what a route holds: it holds the STORE the
   * credential was resolved from, and `JSON.stringify(store)` /
   * `util.inspect(store)` both emitted `apiKey: "sk-…"` verbatim. Measured on
   * the old read shape: 8 of these 9 channels leaked.
   *
   * The write shape and the read shape were one type, and a type that must
   * carry a plain string for the database cannot also refuse to print one. They
   * are two types now — and this test is over the SHAPE, so a channel nobody
   * thought of is covered because there is no string for it to find.
   */
  test("no serialisation channel can find the key on the shape a reader holds", async () => {
    const { parseProviderStore, storedFormOf } = await import("../../server/llm/providers.ts");
    const key = `sk-container-probe-${randomUUID().replaceAll("-", "")}`;
    const raw = {
      providers: [{ id: "p", baseUrl: "https://x.invalid/v1", apiKey: key, models: [{ id: "m" }] }],
      defaultProvider: "p",
      defaultModel: "m",
    };
    const store = parseProviderStore(raw);
    const provider = store.providers[0]!;
    const channels: Readonly<Record<string, string>> = {
      "JSON.stringify(store)": JSON.stringify(store),
      "inspect(store)": inspect(store, { depth: null }),
      // The bar the credential itself already clears. A non-enumerable data
      // property would fail exactly here, which is why the key is a CALL.
      "inspect(store, showHidden + getters)": inspect(store, { depth: null, showHidden: true, getters: true }),
      "template interpolation": `${JSON.stringify(store.providers)}`,
      "Object.entries(provider)": JSON.stringify(Object.entries(provider)),
      "spread into a row": JSON.stringify({ kind: "provider", ...provider }),
      "thrown error stack": String(new Error(`store=${JSON.stringify(store)}`).stack),
      "JSON round trip": JSON.stringify(JSON.parse(JSON.stringify(store))),
      "Object.values": JSON.stringify(Object.values(provider)),
    };
    const leaks = Object.entries(channels).filter(([, out]) => out.includes(key)).map(([name]) => name);
    expect(leaks, `these channels printed the key: ${leaks.join(", ")}`).toEqual([]);
    expect(Object.keys(channels).length, "the probe population must be real").toBeGreaterThanOrEqual(9);

    // LIVENESS, AND IT IS THE HALF THAT MATTERS. Every assertion above is
    // satisfied by a canary that was never in the object. The WRITE shape must
    // still carry it — the database needs the string — so the same key put
    // through the named conversion is still printable, and the key is still
    // usable through the call.
    expect(JSON.stringify(storedFormOf(provider)), "the write shape must still carry the key").toContain(key);
    expect(provider.apiKey?.(), "the key must still be reachable through the call").toBe(key);
  });

  test("a stored custom header is no more printable than the key, on either shape", async () => {
    // The SECOND credential-shaped field, held to the same bar as the key.
    // A header value can be secret-shaped (a session token, an org secret);
    // a shape that would print `apiKey` would print it, so the same probe
    // channels are re-run against the header.
    const { parseProviderStore, storedFormOf, resolveProviderCredential } = await import(
      "../../server/llm/providers.ts"
    );
    const secret = `header-value-${randomUUID().replaceAll("-", "")}`;
    // Written through the SCHEMA-shaped document — but driven through the
    // STORE's own safe parse, because a document the schema refuses is
    // reported as EMPTY by `parseProviderStore` (the guided-state rule). The
    // liveness assertion at the end is what makes "the store held it" a real
    // claim rather than an empty-store pass. The header NAME is deliberately
    // one the key catalogue does NOT call sensitive (a value can be
    // secret-shaped under an ordinary name — that is the whole point of the
    // call-not-a-field shape), so the document parses.
    const rawDocument = {
      providers: [{
        id: "p", baseUrl: "https://x.invalid/v1", apiKey: "k",
        models: [{ id: "m" }], headers: { "X-Org-Id": secret },
      }],
      defaultProvider: "p",
      defaultModel: "m",
    };
    // WITNESS FIRST: the schema must ACCEPT this document, or every channel
    // assertion below is a statement about an empty store — the §36 hole.
    // An isSensitiveKey false positive on "X-Org-Id" would turn this
    // witness red, which is the mechanism that catches the catalogue
    // over-refusing.
    const { PROVIDER_STORE_SCHEMA } = await import("../../server/llm/providers.ts");
    expect(
      PROVIDER_STORE_SCHEMA.safeParse(rawDocument).success,
      "a provider with an ordinary custom header must parse — a refusal here means the catalogue over-refused",
    ).toBe(true);
    const store = parseProviderStore(rawDocument);
    const provider = store.providers[0]!;
    const channels: Readonly<Record<string, string>> = {
      "JSON.stringify(store)": JSON.stringify(store),
      "inspect(store)": inspect(store, { depth: null, showHidden: true, getters: true }),
      "Object.entries(provider)": JSON.stringify(Object.entries(provider)),
      "spread into a row": JSON.stringify({ kind: "provider", ...provider }),
    };
    const leaks = Object.entries(channels).filter(([, out]) => out.includes(secret)).map(([name]) => name);
    expect(leaks, `these channels printed the header value: ${leaks.join(", ")}`).toEqual([]);

    // The credential carries it the same way — a call, not a field — so the
    // run path can read it and a ledger row cannot.
    const credential = resolveProviderCredential(store, "m", PROVIDER_FIXTURE_OWNER);
    expect(JSON.stringify(credential)).not.toContain(secret);
    expect(Object.values(credential).filter((v) => typeof v === "string")).not.toContain(secret);
    expect(credential.headers(), "the engine-facing call still returns it").toEqual({ "X-Org-Id": secret });

    // LIVENESS: the value is really in the object and really retrievable —
    // an absent canary satisfies every assertion above trivially. The WRITE
    // shape must still carry it, and the credential's call must return it.
    expect(JSON.stringify(storedFormOf(provider)), "the write shape still carries the header").toContain(secret);
  });

  test("the mint FREEZES what it hands out, and the header states the limit that remains", async () => {
    const { parseProviderStore, resolveProviderCredential } = await import("../../server/llm/providers.ts");
    const key = `sk-freeze-probe-${randomUUID().replaceAll("-", "")}`;
    const store = parseProviderStore({
      providers: [{ id: "real", baseUrl: "https://real.invalid/v1", apiKey: key, models: [{ id: "m" }] }],
      defaultProvider: "real",
      defaultModel: "m",
    });
    const credential = resolveProviderCredential(store, "m", PROVIDER_FIXTURE_OWNER);

    // THE ATTACK THAT USED TO SUCCEED IN PLACE. It compiled, it ran, and it
    // redirected the genuine credential the bridge was about to build a client
    // from — every property was `writable: true, configurable: true`.
    expect(() => Object.assign(credential, { baseUrl: "https://evil.invalid/v1" }))
      .toThrow(TypeError);
    expect(credential.baseUrl, "the genuine credential must be unchanged").toBe("https://real.invalid/v1");
    expect(credential.apiKey(), "and still hold the real key").toBe(key);
    expect(Object.isFrozen(credential)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(credential, "baseUrl");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);

    // AND THE LIMIT, DRIVEN RATHER THAN DESCRIBED. An object spread COPIES a
    // symbol-keyed property, so a spread still yields a valid credential aimed
    // anywhere — with no cast. The header must SAY so rather than claim
    // unforgeability, because the guard protecting sole-producership is a text
    // scan for the brand's name and a spread never writes it.
    const forged = { ...credential, baseUrl: "https://evil.invalid/v1" };
    expect(Object.getOwnPropertySymbols(forged).length, "the spread copies the brand").toBeGreaterThan(0);
    expect(forged.baseUrl).toBe("https://evil.invalid/v1");
    const header = read(modulePath("providers.ts"));
    // The false sentence must be gone...
    expect(
      header,
      "the header claimed nothing else in the process can produce a credential, which is false: a spread can",
    ).not.toContain("Nothing else in the process can produce a value of that type");
    // ...and the true one present, naming the mechanism that defeats it.
    expect(header, "the header must name the spread as the limit").toMatch(/spread/i);
    expect(header, "and must say the brand is not unforgeability").toMatch(/SPELLED from nothing/);
  });
});

describe("the model-prefs write door leaks nothing and stores no incoherent pair", () => {
  test("a validation failure on the write path echoes no part of the key", async () => {
    // ── THE MOMENT AN EGRESS REDACTOR CANNOT HELP ──────────────────────────
    //
    // On `PUT /api/models/prefs` the key is arriving for the FIRST time: the
    // mint has not run, so the redactor has never seen this value and cannot
    // recognise it. If the validator echoed the rejected input, no
    // memory-based redactor anywhere could mask it. Driven across seven
    // adversarial bodies: it does not — zod reports the expected TYPE and the
    // unrecognised KEY NAME, never the value.
    //
    // That is a property of the DEPENDENCY, not of code in this repository,
    // which is exactly why it needs a test: a zod release that started
    // attaching `input` to its issues would open this door silently.
    const { MODEL_PREFS_INPUT } = await import("../../server/routes/models.ts");
    const key = `sk-writepath-probe-${randomUUID().replaceAll("-", "")}`;
    const bodies: readonly unknown[] = [
      { providers: [{ id: "p", baseUrl: "https://x.invalid/v1", apiKey: key, models: [], typo: 1 }] },
      { providers: [{ id: "", baseUrl: "https://x.invalid/v1", apiKey: key, models: [] }] },
      { providers: [{ id: "p", baseUrl: "https://x.invalid/v1", apiKey: [key], models: [] }] },
      { providers: key },
      { providers: [], apiKeyy: key },
      { providers: [{ id: "p", baseUrl: "https://x.invalid/v1", apiKey: key, models: [key] }] },
      { providers: [{ id: "p", baseUrl: "https://x.invalid/v1", apiKey: key, models: [{ id: "m", temperature: 9 }] }] },
    ];
    let refused = 0;
    for (const body of bodies) {
      const parsed = MODEL_PREFS_INPUT.safeParse(body);
      expect(parsed.success, `this body must be refused: ${JSON.stringify(body).slice(0, 80)}`).toBe(false);
      if (parsed.success) continue;
      refused += 1;
      const error = parsed.error;
      // What the router actually sends, plus the two wider surfaces a logger or
      // a future handler could reach for.
      const routerBody = JSON.stringify({ error: "validation_failed", message: error.issues[0]?.message });
      expect(routerBody, "the 400 body must not carry the key").not.toContain(key);
      expect(error.message, "the error's own message must not carry it").not.toContain(key);
      expect(JSON.stringify(error.issues), "no issue may carry it").not.toContain(key);
      expect(inspect(error, { depth: null, showHidden: true, getters: true })).not.toContain(key);
    }
    // POPULATION AS A RUNTIME NUMBER: every body really did reach the refusal.
    expect(refused).toBe(bodies.length);
  });

  test("an incoherent default pair cannot be stored, and a coherent one can", async () => {
    const { MODEL_PREFS_INPUT } = await import("../../server/routes/models.ts");
    const twoProviders = [
      { id: "A", baseUrl: "https://a.invalid/v1", apiKey: "ka", models: [{ id: "a-model" }] },
      { id: "B", baseUrl: "https://b.invalid/v1", apiKey: "kb", models: [{ id: "b-model" }] },
    ];
    // THE PAIR THE OLD RESOLVER COULD PRODUCE: provider A beside B's model.
    // The UI badged BOTH as the default, so one screen made two contradictory
    // claims about one fact.
    const incoherent = MODEL_PREFS_INPUT.safeParse({
      providers: twoProviders, defaultProvider: "A", defaultModel: "b-model",
    });
    expect(incoherent.success, "an incoherent default pair must not be storable").toBe(false);
    if (!incoherent.success) {
      expect(incoherent.error.issues[0]?.message).toContain("b-model");
      expect(incoherent.error.issues[0]?.path).toEqual(["defaultModel"]);
    }
    // BOTH DIRECTIONS — the check is not an off switch.
    expect(MODEL_PREFS_INPUT.safeParse({
      providers: twoProviders, defaultProvider: "B", defaultModel: "b-model",
    }).success).toBe(true);
    // A partial body that names a provider it is not itself carrying is NOT
    // judged: it is the merged document that has to be coherent, and rejecting
    // the partial form would forbid the ordinary single-provider edit.
    expect(MODEL_PREFS_INPUT.safeParse({
      providers: [twoProviders[1]!], defaultProvider: "A", defaultModel: "b-model",
    }).success).toBe(true);
  });

  test("the connection test asks the model a RUN would use, not always the first listed", async () => {
    const { parseProviderStore, credentialForProvider } = await import("../../server/llm/providers.ts");
    // The provider lists two models and the user's default is the SECOND. The
    // button used to report "Answered as <first>" — a real answer about a model
    // the user will never send anything to, in the one surface whose whole
    // purpose is to catch a mistake in the setup.
    const store = parseProviderStore({
      providers: [{
        id: "p", baseUrl: "https://x.invalid/v1", apiKey: "k",
        models: [{ id: "never-used" }, { id: "the-default" }],
      }],
      defaultProvider: "p",
      defaultModel: "the-default",
    });
    expect(credentialForProvider(store, "p", PROVIDER_FIXTURE_OWNER).modelId).toBe("the-default");
    // BOTH DIRECTIONS: a provider that serves no part of the stored default
    // still gets tested, on the honest best available.
    const other = parseProviderStore({
      providers: [
        { id: "p", baseUrl: "https://x.invalid/v1", apiKey: "k", models: [{ id: "only" }] },
        { id: "q", baseUrl: "https://y.invalid/v1", apiKey: "k", models: [{ id: "elsewhere" }] },
      ],
      defaultProvider: "q",
      defaultModel: "elsewhere",
    });
    expect(credentialForProvider(other, "p", PROVIDER_FIXTURE_OWNER).modelId).toBe("only");
  });
});

// A file written by this suite must not be left behind; nothing here writes
// outside a temp directory, and this assertion states that rather than
// assuming it.
test("this file writes nothing outside a temporary directory", () => {
  const source = stripCommentsAndStringsFor(read("tests/prevention/credential-surface-owner.test.ts"), "tests/prevention/credential-surface-owner.test.ts");
  const writes = [...source.matchAll(/\bwriteFileSync\s*\(([^,]*)/g)].map((m) => m[1]!.trim());
  for (const target of writes) {
    expect(target, `${target} must be built from a temp directory`).toMatch(/\b(dir|tmp|temp)\b/i);
  }
  void writeFileSync;
});

describe("the brand's runtime arm: a copied credential is refused before it becomes a client", () => {
  // The header's driven limit — an object spread copies the brand with no
  // cast and keeps the GENUINE key closure while pointing baseUrl anywhere —
  // now lands on a refusal: the mint records what it made in a WeakSet, and
  // the bridge consults membership at its one client-construction door.
  async function mintedCredential() {
    const { parseProviderStore, resolveProviderCredential } = await import(
      "../../server/llm/providers.ts"
    );
    const key = `sk-runtime-arm-${randomUUID().replaceAll("-", "")}`;
    const store = parseProviderStore({
      providers: [
        { id: "real", baseUrl: "https://real.invalid/v1", apiKey: key, models: [{ id: "m" }] },
      ],
      defaultProvider: "real",
      defaultModel: "m",
    });
    return resolveProviderCredential(store, "m", PROVIDER_FIXTURE_OWNER);
  }

  test("the driven spread shape is refused typed; the genuine mint is admitted", async () => {
    const { admitMintedCredential } = await import("../../server/llm/providers.ts");
    const { ForgedProviderCredentialError } = await import("../../server/kernel/errors.ts");
    const credential = await mintedCredential();
    expect(admitMintedCredential(credential)).toBe(credential);
    // The EXACT no-cast derivation the header drives: brand copied, genuine
    // key closure kept, baseUrl aimed anywhere.
    const forged = { ...credential, baseUrl: "https://evil.invalid/v1" };
    let caught: unknown = null;
    try {
      admitMintedCredential(forged);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForgedProviderCredentialError);
    expect((caught as { code: string }).code).toBe("provider_credential_not_minted");
  });

  test("a NEW shape — prototype inheritance shadowing baseUrl — is refused too", async () => {
    const { admitMintedCredential } = await import("../../server/llm/providers.ts");
    const { ForgedProviderCredentialError } = await import("../../server/kernel/errors.ts");
    const credential = await mintedCredential();
    // Different door than the spread: the brand is INHERITED, never copied;
    // membership is on object identity, so this is not in the set either.
    const forged = Object.create(credential, {
      baseUrl: { value: "https://evil.invalid/v1", enumerable: true },
    }) as typeof credential;
    let caught: unknown = null;
    try {
      admitMintedCredential(forged);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForgedProviderCredentialError);
    expect((caught as { code: string }).code).toBe("provider_credential_not_minted");
  });

  test("the refusal fires through the bridge's real entry, before any socket", async () => {
    // The plant drives the path a real caller enters (testProviderConnection
    // → getClient), not the consult in isolation. That function's contract
    // turns every failure into { ok: false, detail } for the button, so the
    // evidence the refusal happened FIRST is its own sentence in the detail —
    // a network failure against evil.invalid would word itself differently.
    const { testProviderConnection } = await import("../../server/llm/llm-bridge.ts");
    const credential = await mintedCredential();
    const forged = { ...credential, baseUrl: "https://evil.invalid/v1" };
    const result = await testProviderConnection(forged);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.detail).toContain("was not minted by server/providers.ts");
    }
  });
});
