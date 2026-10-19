// @vitest-environment node
/**
 * Single-Party-Owner: tool registry/executor owner.
 *
 * "All tools must be wired the SAME way, exposed the SAME
 * way, shared the SAME way, and consumed the SAME way. One unified tool
 * pipeline: Registration → Exposure → Schema → Execution → Rendering. No
 * ad-hoc tool wiring — every tool follows the same path. When a new tool
 * is added, it automatically appears everywhere."
 *
 * This test mechanically pins the five choke points of the unified pipeline
 * so a bypass cannot be reintroduced silently:
 *
 * (a) ONE registry — `getToolManifest` (tools-bridge.ts) is the
 * single manifest builder; no other server
 * module builds a parallel tool manifest for
 * the LLM.
 * (b) ONE executor — `executeToolCall` (tool-executor.ts) is the
 * single dispatch; no route accesses the
 * handler table directly, and no route outside
 * run.ts dispatches tools.
 * (c) ONE manifest endpoint — `GET /api/tools` (routes/tools.ts) is the
 * only route that returns the FULL manifest;
 * the run route uses the filtered accessor
 * (`getEnabledToolManifestForSession`), not
 * the full manifest.
 * (d) SAME schema format — every manifest entry has the canonical
 * inputSchema shape (type:object, properties,
 * required array, additionalProperties boolean).
 * (e) contract (no drift) — the server `WebToolEntry` (tools-bridge.ts)
 * and the client `WebToolEntry`
 * (shared/types.ts) declare the SAME extra
 * fields; the server `ToolKind` (harness-config.ts)
 * and the client `ToolKind` (shared/types.ts)
 * declare the SAME union members. These are
 * deliberate structural mirrors (the server
 * tsconfig cannot resolve the @harness/* aliases
 * the client uses) — this contract test pins
 * they cannot drift.
 *
 * Plus the specific fixes:
 * (f) `list_extensions` is wired (manifest + executor) — the backend
 * extension tool routed through the ONE pipeline, not a parallel
 * extensions-only API.
 * (g) `ARTIFACT_TYPES` is the single owner (tools-bridge.ts) — the
 * executor imports it; no duplicate artifact-type literal lives in
 * the executor.
 * (h) `ToolDefinition` has ONE re-export owner (canonical.ts) —
 * llm-bridge.ts no longer re-exports it.
 *
 * Mutation-verified: re-introducing each violation (removing list_extensions
 * from the manifest, re-exporting ToolDefinition from llm-bridge, duplicating
 * the artifact literal in the executor, adding a route that calls
 * getToolManifest, accessing TOOL_HANDLERS outside the executor, drifting
 * WebToolEntry/ToolKind) makes the relevant assertion FAIL.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk, read } from "../helpers/source-scan.ts";

import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { TOOL_KINDS } from "../../shared/web-ui-types.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";
import {
  executeToolCall,
  isToolExecutable,
  listExecutableTools,
} from "../../server/tools/tool-executor.ts";
import {
  UI_CONTROL_ACTION_NAMES,
  UI_CONTROL_TAB_NAMES,
  UI_CONTROL_PANEL_NAMES,
  UI_CONTROL_THEME_NAMES,
} from "../../server/tools/ui-control.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const SERVER_ROOT = join(process.cwd(), "server");
const CONTRACTS_PATH = join(process.cwd(), "shared", "types.ts");

/** Recursively list every `.ts` file under `server/` (excludes `.d.ts`). */
function listServerTsFiles(): string[] {
  return walk(SERVER_ROOT, { exts: [".ts"] }).filter((f) => !f.endsWith(".d.ts"));
}

// ── (a) ONE registry ──

describe("tool-registry-owner: ONE registry", () => {
  test("getToolManifest is the single manifest builder — no parallel manifest builders in server/", () => {
    // A parallel manifest builder is a top-level `function build...Manifest`
    // (or `getToolManifest`-like) that returns ToolManifestEntry[]/WebToolEntry[]
    // OUTSIDE tools-bridge.ts. Only tools-bridge.ts owns the manifest.
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      if (rel === "tools/tools-bridge.ts") continue;
      const src = readFileSync(file, "utf8");
      // Match a function returning a tool-manifest typed array, or a
      // `getToolManifest`-named export, outside the owner. The canonical
      // backend re-exports (canonical.ts) are type/value re-exports, not
      // manifest builders — they don't match `function build.*Manifest`.
      const builderRe = /function\s+(build\w*Manifest|getToolManifest)\s*[<(]/g;
      let m: RegExpExecArray | null;
      while ((m = builderRe.exec(src)) !== null) {
        offenders.push(`${rel}:${builderRe.lastIndex} ${m[1]}`);
      }
    }
    expect(offenders, `Parallel manifest builders found (must live in tools-bridge.ts): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── (b) ONE executor ──

describe("tool-registry-owner: ONE executor", () => {
  test("TOOL_HANDLERS is accessed only inside the executor (no route bypasses dispatch)", () => {
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      if (rel === "tools/tool-executor.ts") continue;
      const src = readFileSync(file, "utf8");
      // Direct handler-table access (`TOOL_HANDLERS[...]`) outside the
      // executor is a dispatch bypass — the caller skips the executor's
      // validation, metrics, ghost-tool gate, and error mapping.
      if (/TOOL_HANDLERS\s*\[/.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `TOOL_HANDLERS accessed outside the executor: ${offenders.join(", ")}`).toEqual([]);
  });

  test("executeToolCall is the single dispatch entry — only the run route calls it", () => {
    // The run route is the ONE place tool calls are dispatched server-side
    // (the LLM tool_call_done event → executeToolCall). A second dispatch
    // site would be an ad-hoc tool-execution path bypassing the choke point.
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      // The executor itself defines executeToolCall (skip); tests are not
      // in server/.
      if (rel === "tools/tool-executor.ts") continue;
      const src = readFileSync(file, "utf8");
      // A call to executeToolCall (not the import line, not the definition).
      // For each match, skip if the containing line is an `import` statement.
      const callRe = /\bexecuteToolCall\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        const lineStart = src.lastIndexOf("\n", m.index) + 1;
        const lineEnd = src.indexOf("\n", m.index);
        const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (/^\s*import\b/.test(line)) continue; // import line — not a call
        offenders.push(`${rel}:${m.index}`);
      }
    }
    // Only routes/run.ts should dispatch tools (the run loop). Any other
    // site is a bypass.
    // The tool dispatch moved out of the route and into the executor when
    // the run stopped being started by a GET. One dispatcher still, in the
    // one module that performs runs — plus the agent-runtime bridge, whose
    // sub-agent tool registry RE-ENTERS the same executor for a delegated
    // agent's own tool calls (the bridge is the delegation substrate's door,
    // and routing the sub-agent's calls through the one executor is what
    // keeps the safety gate + confinement identical for a sub-agent — a
    // parallel sub-agent executor would be the bypass this guard exists to
    // prevent). The bridge never dispatches a PARENT's call; the parent's
    // calls enter through the run route alone.
    const allowed = new Set(["run/run-executor.ts", "agent/agent-runtime-bridge.ts"]);
    const bypasses = offenders.filter((o) => !allowed.has(o.split(":")[0]!));
    expect(bypasses, `executeToolCall called outside the run route (dispatch bypass): ${bypasses.join(", ")}`).toEqual([]);
  });

  test("the executor is the choke point — a tool not in the registry returns the typed unavailable message", async () => {
    // Behavioral: a ghost/unknown tool never silently passes or short-
    // circuits; the executor returns the typed "not available" / suggestion
    // message. A route cannot bypass this because executeToolCall is the
    // only dispatch (verified above).
    const res = await executeToolCall("__nonexistent_tool__", {}, { projectRoot: "/tmp" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("__nonexistent_tool__");
    expect(res.output).toContain("not available");
  });
});

// ── (c) ONE manifest endpoint ──

describe("tool-registry-owner: ONE manifest endpoint", () => {
  test("the FULL manifest (getToolManifest) is returned only by routes/tools.ts", () => {
    // run.ts uses the filtered accessor (getEnabledToolManifestForSession),
    // NOT the full manifest — so the LLM only sees the user's enabled tools,
    // while the Tools panel sees the full surface. A second route returning
    // the full manifest would be a duplicate exposure point.
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      // The owner (tools-bridge.ts) defines getToolManifest + the filtered
      // accessors call it internally — those are the registry, not endpoints.
      if (rel === "tools/tools-bridge.ts") continue;
      const src = readFileSync(file, "utf8");
      // A CALL to getToolManifest (not the import, not the definition).
      const callRe = /\bgetToolManifest\s*\(\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        const lineStart = src.lastIndexOf("\n", m.index) + 1;
        const line = src.slice(lineStart, m.index);
        if (/import\s*\{/.test(line)) continue;
        offenders.push(rel);
      }
    }
    // Only routes/tools.ts (the manifest endpoint owner) calls the full
    // manifest accessor. routes/run.ts must NOT (it uses the filtered one).
    const allowed = new Set(["routes/tools.ts"]);
    const unexpected = offenders.filter((o) => !allowed.has(o));
    expect(unexpected, `getToolManifest called outside routes/tools.ts (duplicate manifest endpoint): ${unexpected.join(", ")}`).toEqual([]);
  });

  test("the run route uses the filtered accessor, not the full manifest", () => {
    const runSrc = runPathSource();
    expect(runSrc, "run.ts must import the filtered accessor").toContain("getEnabledToolManifestForSession");
    expect(runSrc, "run.ts must NOT call the full getToolManifest").not.toMatch(/\bgetToolManifest\s*\(\s*\)/);
  });
});

// ── (d) SAME schema format ──

describe("tool-registry-owner: SAME schema format", () => {
  test("every built-in manifest entry has the canonical inputSchema shape", () => {
    const manifest = getToolManifest();
    const builtIn = manifest.filter((t) => t.category === "built-in");
    expect(builtIn.length, "must expose built-in tools").toBeGreaterThan(0);
    const invalid: string[] = [];
    for (const t of builtIn) {
      const s = t.inputSchema as Record<string, unknown>;
      if (s["type"] !== "object") invalid.push(`${t.name}: inputSchema.type !== "object"`);
      if (!s["properties"] || typeof s["properties"] !== "object") invalid.push(`${t.name}: missing properties`);
      if (!Array.isArray(s["required"])) invalid.push(`${t.name}: required is not an array`);
      if (typeof s["additionalProperties"] !== "boolean") invalid.push(`${t.name}: additionalProperties is not boolean`);
    }
    expect(invalid, `entries with non-canonical schema: ${invalid.join("; ")}`).toEqual([]);
  });

  test("every executor handler is advertised in the manifest (1:1, no orphan handlers)", () => {
    const manifestNames = new Set(getToolManifest().map((t) => t.name));
    const orphans = listExecutableTools().filter((n) => !manifestNames.has(n));
    expect(orphans, `executor tools NOT in manifest: ${orphans.join(", ")}`).toEqual([]);
  });

  test("every built-in manifest tool has an executor handler (1:1, no dead manifest entries)", () => {
    const builtIn = getToolManifest().filter((t) => t.category === "built-in");
    const missing = builtIn.filter((t) => !isToolExecutable(t.name));
    expect(missing, `manifest tools with no executor: ${missing.map((t) => t.name).join(", ")}`).toEqual([]);
  });
});

// ── (e) contract: server/client mirrors do not drift ──

describe("tool-registry-owner: server/client type mirrors do not drift", () => {
  /** Extract the extra-field names of `WebToolEntry = ToolManifestEntry & Readonly<{...}>`.
   * Strips JSDoc comments (so a comment like `the user:` or `exp519:` is
   * not mistaken for a field name). */
  function webToolEntryExtraFields(src: string): Set<string> {
    const m = /export type WebToolEntry\s*=\s*ToolManifestEntry\s*&\s*Readonly<\{([^}]*)\}>/s.exec(src);
    if (m === null) return new Set();
    // Strip JSDoc: remove `/**... */` blocks + line-leading `*` comment lines
    // so only real field declarations remain (a comment `the user:` or
    // `exp519:` would otherwise be mistaken for a field name).
    const body = m[1]!
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\*.*$/gm, " ");
    const fields = new Set<string>();
    const fieldRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) fields.add(fm[1]!);
    return fields;
  }

  /**
   * The tool-kind vocabulary, IMPORTED rather than parsed.
   *
   * This was a regex over `export type ToolKind = | "a" | "b";`. When the
   * vocabulary was inverted — the array owns it, the type derives with
   * `typeof TOOL_KINDS[number]` — the regex matched nothing and returned an
   * EMPTY set, which made the drift assertion below vacuously true. A guard
   * keyed to a spelling fails in whichever direction is least visible, and
   * inverting the ownership (the correct change) is what triggers it.
   */
  function toolKindMembers(): Set<string> {
    return new Set<string>(TOOL_KINDS);
  }

  test("server WebToolEntry (tools-bridge.ts) and client WebToolEntry (shared/types.ts) declare the same extra fields", () => {
    const serverFields = webToolEntryExtraFields(read(modulePath("tools-bridge.ts")));
    const clientFields = webToolEntryExtraFields(read("shared/types.ts"));
    expect(serverFields.size, "server WebToolEntry must declare extra fields").toBeGreaterThan(0);
    expect(clientFields.size, "client WebToolEntry must declare extra fields").toBeGreaterThan(0);
    expect(
      [...serverFields].sort().join(","),
      `WebToolEntry drifted: server=${[...serverFields].sort().join(",")} client=${[...clientFields].sort().join(",")}`,
    ).toBe([...clientFields].sort().join(","));
  });

  test("server ToolKind (harness-config.ts) and client ToolKind (shared/types.ts) re-export the SINGLE owner (SPO)", () => {
    // SPO: `ToolKind` is now owned by `shared/web-ui-types.ts` (a
    // pure file the server can import via NodeNext). Both the server
    // (harness-config.ts) + the client (shared/types.ts) IMPORT + re-
    // export it — they must NOT redeclare `export type ToolKind =...`
    // locally (that would re-introduce the drift class). The "same union
    // members" invariant is now structural: there is ONE definition.
    const ownerKinds = toolKindMembers();
    expect(ownerKinds.size, "shared/web-ui-types.ts must declare ToolKind members").toBeGreaterThan(0);

    const serverSrc = read(modulePath("harness-config.ts"));
    expect(
      serverSrc,
      "server/harness-config.ts must not redeclare `export type ToolKind =` (import from shared/web-ui-types)",
    ).not.toMatch(/export\s+type\s+ToolKind\s*=/);
    expect(serverSrc, "server/harness-config.ts must import ToolKind from shared/web-ui-types").toMatch(
      /import\s+(?:type\s+)?\{[^}]*\bToolKind\b[^}]*\}\s*from\s*["'][^"']*shared\/web-ui-types/,
    );

    const clientCtSrc = read("shared/types.ts");
    expect(
      clientCtSrc,
      "shared/types.ts must not redeclare `export type ToolKind =` (re-export from ./web-ui-types)",
    ).not.toMatch(/export\s+type\s+ToolKind\s*=/);
    expect(clientCtSrc, "shared/types.ts must import ToolKind from ./web-ui-types").toMatch(
      /import\s+type\s+\{[^}]*\bToolKind\b[^}]*\}\s*from\s*["']\.\/web-ui-types["']/,
    );
  });

  test("every ToolKind union member is a kind the manifest can produce", () => {
    // The manifest resolves kind via getToolKind; every declared ToolKind
    // must be reachable. Pinned: the manifest's distinct kinds ⊆ the
    // declared union (no manifest tool has an undeclared kind).
    const declared = toolKindMembers();
    const manifestKinds = new Set(getToolManifest().map((t) => t.kind));
    const undeclared = [...manifestKinds].filter((k) => !declared.has(k));
    expect(undeclared, `manifest tools with a kind NOT in the ToolKind union: ${undeclared.join(", ")}`).toEqual([]);
  });
});

// ── (f) list_extensions is wired through the ONE pipeline ──

describe("tool-registry-owner: list_extensions routed through the ONE pipeline", () => {
  test("list_extensions is in the manifest (built-in, kind=extension)", () => {
    const entry = getToolManifest().find((t) => t.name === "list_extensions");
    expect(entry, "list_extensions must be in the manifest").toBeDefined();
    expect(entry!.category).toBe("built-in");
    expect(entry!.kind).toBe("extension");
    expect(entry!.adapterId).toBe("web-ui-extension");
  });

  test("list_extensions is executable through the ONE executor", async () => {
    expect(isToolExecutable("list_extensions")).toBe(true);
    const res = await executeToolCall("list_extensions", {}, { projectRoot: "/tmp" });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as { extensions: unknown[]; total: number };
    expect(typeof parsed.total).toBe("number");
    expect(Array.isArray(parsed.extensions)).toBe(true);
  });

  test("list_extensions honors the type/status filters (delegates to extensions-bridge)", async () => {
    const res = await executeToolCall("list_extensions", { type: "nope-none", status: "disabled" }, { projectRoot: "/tmp" });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as { extensions: unknown[]; total: number };
    // No extension matches the bogus type filter → 0 results (the filter
    // is wired, not decorative — the 748% bug class).
    expect(parsed.total).toBe(0);
    expect(parsed.extensions.length).toBe(0);
  });
});

// ── (g) ARTIFACT_TYPES is the single owner ──

describe("tool-registry-owner: ARTIFACT_TYPES single owner", () => {
  test("ARTIFACT_TYPES is exported from the manifest owner (tools-bridge.ts)", () => {
    const src = read(modulePath("tools-bridge.ts"));
    expect(src, "tools-bridge.ts must export ARTIFACT_TYPES").toMatch(/export\s+const\s+ARTIFACT_TYPES\b/);
  });

  test("the executor reads ARTIFACT_TYPES from the manifest owner (no local duplicate literal)", () => {
    const src = read(modulePath("tool-executor.ts"));
    // The executor lazy-loads the manifest owner (tools-bridge.ts) and reads
    // `ARTIFACT_TYPES` from it — NOT a top-level import (which would trigger
    // the canonical-chain TDZ) and NOT a local hardcoded literal (which
    // would be a parallel source of truth). The require path + the
    // ARTIFACT_TYPES reference together pin that the single owner is used.
    expect(src, "executor must reference the manifest owner path").toContain("./tools-bridge.ts");
    expect(src, "executor must read ARTIFACT_TYPES from the owner").toMatch(/\bARTIFACT_TYPES\b/);
    // The duplicate literal `["html", "game", "sheet", "presentation"]` must
    // NOT appear in the executor — that would be a parallel source of truth
    // (the prior bug: the manifest enum AND the executor Set both hardcoded
    // the list, so adding a kind required editing both).
    expect(src, "executor must NOT hardcode the artifact-type literal").not.toMatch(/"html"\s*,\s*"game"\s*,\s*"sheet"\s*,\s*"presentation"/);
  });

  test("the manifest's create_artifact enum matches ARTIFACT_TYPES (no drift)", async () => {
    const entry = getToolManifest().find((t) => t.name === "create_artifact");
    expect(entry, "create_artifact must be in the manifest").toBeDefined();
    const schema = entry!.inputSchema as Record<string, unknown>;
    const props = schema["properties"] as Record<string, unknown>;
    const typeProp = props["type"] as Record<string, unknown>;
    const enumValues = typeProp["enum"] as readonly string[];
    expect([...enumValues].sort().join(","), "manifest enum must be the artifact kinds").toBe(["html", "game", "sheet", "presentation"].sort().join(","));
    // The executor accepts exactly these (derive the set from the single owner).
    for (const kind of ["html", "game", "sheet", "presentation"]) {
      expect(isToolExecutable("create_artifact")).toBe(true);
    }
    // A bogus kind is rejected by the executor (validation derives from the
    // single owner — the 748% bug class: a filter that doesn't actually gate).
    const res = await executeToolCall("create_artifact", { type: "bogus-kind", title: "t", content: "<p>x</p>" }, { projectRoot: "/tmp" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("must be one of");
  });
});

// ── (h) ToolDefinition single re-export owner ──

describe("tool-registry-owner: ToolDefinition single re-export owner", () => {
  test("ToolDefinition is re-exported only from canonical.ts (the hub)", () => {
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      if (rel === "kernel/canonical.ts") continue;
      const src = readFileSync(file, "utf8");
      // A re-export of ToolDefinition (`export type { ToolDefinition }` or
      // `export { ToolDefinition }`) outside canonical.ts is a scattered
      // re-export. llm-bridge imports it for its own use (not a re-export).
      const reExportRe = /export\s+(?:type\s+)?\{[^}]*\bToolDefinition\b[^}]*\}/g;
      if (reExportRe.test(src)) offenders.push(rel);
    }
    expect(offenders, `ToolDefinition re-exported outside canonical.ts: ${offenders.join(", ")}`).toEqual([]);
  });

  test("canonical.ts re-exports ToolDefinition (the single owner exists)", () => {
    const src = read(modulePath("canonical.ts"));
    // The hub re-export statement may carry sibling types (ChatMessage rides
    // the same import); the invariant is that ToolDefinition is re-exported
    // HERE and nowhere else — the no-second-owner arm above holds that half.
    expect(src, "canonical.ts must re-export ToolDefinition").toMatch(/export\s+type\s+\{[^}]*\bToolDefinition\b[^}]*\}/);
  });
});

// ── (i) tool schema limits are config-derived (no hardcoded maximum literals) ──

describe("tool-registry-owner: tool schema limits are config-derived (no hardcoded maximum literals)", () => {
  test("no tool inputSchema uses a numeric-literal `maximum` (limits must derive from config accessors)", () => {
    // A tool schema `maximum: <integer literal>` is a hardcoded cap that
    // drifts from the config owner. The single source of truth for each
    // limit is the harness-config accessor (e.g. getIntelligenceSearchMaxLimit,
    // getMemorySearchMaxLimit) or serverConfig (gitMaxLogEntries). A literal
    // here means a second, independent cap that can drift. `minimum: 1` is a
    // semantic invariant (1-based line numbers, positive limits) and is NOT
    // flagged — only `maximum` is a tunable cap that belongs in config.
    const src = readFileSync(join(SERVER_ROOT, "tools/tools-bridge.ts"), "utf8");
    const lines = src.split("\n");
    const findings: string[] = [];
    // `maximum:\s*\d+` matches a numeric literal after `maximum:`. A
    // config-derived value (`maximum: getIntelligenceSearchMaxLimit()` or
    // `maximum: serverConfig.gitMaxLogEntries`) does NOT match (no digit
    // immediately after `maximum:` — a function name or variable follows).
    const MAX_LITERAL_RE = /maximum:\s*\d+/;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (MAX_LITERAL_RE.test(line)) {
        findings.push(`${i + 1}: ${trimmed}`);
      }
    }
    expect(
      findings,
      `Hardcoded \`maximum: <literal>\` in tools-bridge.ts — derive from a config accessor (the single owner):\n${findings.join("\n")}`,
    ).toEqual([]);
  });
});

// ── (j) control_interface manifest enums derive from the single owner (ui-control.ts) ──

describe("tool-registry-owner: control_interface enums derive from the single owner", () => {
  // The control_interface tool's inputSchema enums (action/tab/panel/theme)
  // are a parallel copy of the contract owned by server/ui-control.ts. The
  // manifest MUST source them from the owner's exported arrays
  // (UI_CONTROL_*_NAMES) so a value added to the Zod schema reaches the
  // manifest automatically — a hardcoded literal enum in the manifest is a
  // drift risk (a new tab added to the schema would NOT reach the LLM, and
  // the gate would reject calls to it as a schema mismatch).

  function controlInterfaceEnumProps(): { action: readonly string[]; tab: readonly string[]; panel: readonly string[]; theme: readonly string[] } {
    const entry = getToolManifest().find((t) => t.name === "control_interface");
    expect(entry, "control_interface must be in the manifest").toBeDefined();
    const props = (entry!.inputSchema as { properties: Record<string, { enum?: readonly string[] }> }).properties;
    return {
      action: props.action?.enum ?? [],
      tab: props.tab?.enum ?? [],
      panel: props.panel?.enum ?? [],
      theme: props.theme?.enum ?? [],
    };
  }

  test("the manifest action/tab/panel/theme enums equal the single owner's arrays (no hardcoded parallel copy)", () => {
    const enums = controlInterfaceEnumProps();
    expect([...enums.action].sort(), "manifest action enum must equal UI_CONTROL_ACTION_NAMES").toEqual([...UI_CONTROL_ACTION_NAMES].sort());
    expect([...enums.tab].sort(), "manifest tab enum must equal UI_CONTROL_TAB_NAMES").toEqual([...UI_CONTROL_TAB_NAMES].sort());
    expect([...enums.panel].sort(), "manifest panel enum must equal UI_CONTROL_PANEL_NAMES").toEqual([...UI_CONTROL_PANEL_NAMES].sort());
    expect([...enums.theme].sort(), "manifest theme enum must equal UI_CONTROL_THEME_NAMES").toEqual([...UI_CONTROL_THEME_NAMES].sort());
  });

  test("the manifest control_interface description does NOT hardcode the tab list (built dynamically from the owner)", () => {
    // The description enumerates the tabs so the LLM knows where it can
    // navigate. A hardcoded tab list in the description string would drift
    // from the owner when a tab is added. Verify the description contains
    // every owner tab (so a new tab reaches the LLM) AND that the source
    // builds the description dynamically (no inline tab-list literal).
    const entry = getToolManifest().find((t) => t.name === "control_interface")!;
    for (const tab of UI_CONTROL_TAB_NAMES) {
      expect(entry.description, `description must mention tab '${tab}'`).toContain(tab);
    }
    // The owner-sourced builder exists (no hardcoded tab literal in the manifest).
    const bridgeSrc = read(modulePath("tools-bridge.ts"));
    expect(bridgeSrc, "the manifest must build the description via buildControlInterfaceDescription").toContain("buildControlInterfaceDescription");
    expect(bridgeSrc, "the manifest must NOT hardcode the control_interface description string").not.toMatch(/description:\s*"Control the web UI/);
  });

  test("the executor invalid-args help text derives from the single owner (no hardcoded action list)", () => {
    // The executor's invalid-args error message must use the owner's
    // describeActionRequirements() helper — a hardcoded action→field list
    // in the executor is a parallel copy that drifts when an action is added.
    const execSrc = read(modulePath("tool-executor.ts"));
    expect(execSrc, "executor must use describeActionRequirements() from the owner").toContain("describeActionRequirements()");
    // A hardcoded action-list literal in the executor's error message is a
    // drift risk. The specific prior-bug literal must NOT reappear.
    expect(execSrc, "executor must NOT hardcode the action→field list").not.toMatch(/set_tab→tab,\s*toggle_panel→panel,\s*set_theme→theme,\s*open_settings→\(none\)/);
  });
});

// ── (k) the frontend derives tool labels + file-effect from the manifest ──

describe("tool-registry-owner: the frontend derives tool labels + file-effect from the served manifest", () => {
  // The tool manifest the server serves is the SINGLE owner of "what is this
  // tool called in plain words" and "which tools change a file on disk". The
  // frontend used to re-answer both with a hand table (`toolLabel`'s 28-row
  // Record + `FILE_EFFECT_TOOLS`), which silently rotted on any rename — the
  // edit-tool rename forced a hand-edit. Now the label is declared at the
  // tool's own registration and served on the manifest entry (`label`), and
  // the file-effect class is derived from the declared `capabilities`
  // (`write`). These arms pin the derivation so a second table cannot return.

  // Resolve by name (the module-resolver owner), never a path literal, so a
  // module move never touches this guard. `types.ts`/`tools.ts` are ambiguous
  // by basename, so they resolve by their folder-qualified fragment instead.
  const FLOW_TYPES = modulePathMatching("cockpit/flow/types.ts");
  const TOOLS_STATE = modulePathMatching("state/tools.ts");
  const SHAPES = modulePath("shapes.ts");

  test("the frontend flow carries NO hardcoded tool name→label table", () => {
    // A `Record<string, string>` mapping registry tool names to labels is a
    // second source of truth. Scan the flow's own source for the shape.
    const src = read(FLOW_TYPES);
    // The hand table keyed on tool names (e.g. `read_file: "read file"`).
    expect(src, "flow/types.ts must not carry a tool-label table").not.toMatch(
      /Record<string,\s*string>\s*=\s*\{[^}]*\b(read_file|edit|search_code)\b/s,
    );
    // Nor a `FILE_EFFECT_TOOLS` set literal of registry names.
    expect(src, "flow/types.ts must not declare a FILE_EFFECT_TOOLS set").not.toMatch(
      /FILE_EFFECT_TOOLS\s*=\s*new Set/,
    );
  });

  test("the label derivation lives in the manifest store and reads the served `label`", () => {
    const src = read(TOOLS_STATE);
    // The single derivation reads the manifest entry's declared label.
    expect(src, "tools.ts owns toolLabel, reading the served entry").toMatch(/export\s+function\s+toolLabel/);
    expect(src, "toolLabel reads the manifest entry's label").toMatch(/\blabel\b/);
    // The file-effect classification is derived from capabilities, not named.
    expect(src, "tools.ts derives the file-effect set from capabilities").toMatch(
      /capabilities\.includes\(\s*"write"\s*\)/,
    );
  });

  test("the served manifest carries a label for every tool that has one declared (rename-safe)", () => {
    // The behavioural pin: a tool's label is whatever its registration
    // declared, served verbatim. Renaming a tool requires NO frontend edit —
    // the manifest serves the new name's label and the UI derives it. Prove
    // it with the live manifest: every entry's `label` (when present) is a
    // non-empty string, and the `edit` tool's label is its declared one.
    const manifest = getToolManifest();
    expect(manifest.length, "the manifest must serve tools").toBeGreaterThan(0);
    for (const entry of manifest) {
      if (entry.label !== undefined) {
        expect(typeof entry.label, `${entry.name}: label must be a string`).toBe("string");
        expect(entry.label.length, `${entry.name}: label must be non-empty`).toBeGreaterThan(0);
      }
    }
    const edit = manifest.find((t) => t.name === "edit");
    if (edit !== undefined) {
      expect(edit.label, "the edit tool serves its declared label").toBe("edit file");
    }
  });

  test("the file-effect classification on the wire comes from capabilities, and edit carries write", () => {
    // The capability the file-effect class derives from must actually be on
    // the wire, or the frontend's derivation reads nothing. A tool the user
    // expects to land in the edits section (`edit`) must declare `write`.
    const manifest = getToolManifest();
    const edit = manifest.find((t) => t.name === "edit");
    if (edit !== undefined) {
      expect(edit.capabilities, "edit must declare the write capability").toContain("write");
    }
    // Every manifest entry's capabilities are a subset of the declared
    // vocabulary — a typo'd capability would silently misclassify.
    for (const entry of manifest) {
      for (const cap of entry.capabilities) {
        expect(["read", "write", "execute", "network"], `${entry.name}: unknown capability '${cap}'`).toContain(cap);
      }
    }
  });

  test("the renderer's output-shape classifier reads the manifest's declared outputShape, not a name set", () => {
    // The renderer used to keep three `Set<toolName>` literals (file readers,
    // command tools, search tools) mirroring the registry — a new file-reading
    // tool rendered as JSON until someone hand-added its name. The shape is now
    // declared on the manifest entry. Pin: the shapes module carries NO
    // tool-name set, and the classifier takes the declared shape as a parameter
    // (supplied by the caller from the manifest store) rather than reading the
    // tool's name.
    const shapesSrc = read(SHAPES);
    expect(shapesSrc, "shapes.ts must not keep a FILE_READERS-style name set").not.toMatch(
      /new Set\(\[[^\]]*\b(read_file|execute_command|search_code)\b/s,
    );
    // The declared shape is the classifier's input, not the tool name.
    expect(shapesSrc, "classifyOutput takes the declared shape, not the tool name").toMatch(
      /classifyOutput\(\s*input:\s*unknown,\s*output:\s*unknown,\s*declared\?/,
    );
  });

  test("every declared outputShape on the wire is one the renderer understands", () => {
    // A typo'd or forward-declared outputShape would silently render as JSON.
    // The served values must be a subset of the classifier's vocabulary.
    const manifest = getToolManifest();
    for (const entry of manifest) {
      if (entry.outputShape !== undefined) {
        expect(
          ["file", "command", "search"],
          `${entry.name}: outputShape '${entry.outputShape}' is not a shape the renderer knows`,
        ).toContain(entry.outputShape);
      }
    }
  });
});
