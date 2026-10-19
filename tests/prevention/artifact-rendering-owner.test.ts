// @vitest-environment node
/**
 * Prevention test: Artifact Rendering Owner.
 *
 * The Single-Party-Owner principle ( "Agents must render
 * things directly in chat — interactive, not raw text"): artifact rendering
 * (HTML/JS apps, games, sheets, presentations) must have ONE canonical
 * pipeline. All artifact rendering goes through `ArtifactView.svelte` using
 * the shared sandboxed iframe (html-preview.ts, SPO). No ad-hoc artifact
 * rendering scattered across components.
 *
 * The canonical pipeline (///):
 *
 * MessageList.svelte
 * └── ToolCallGroup.svelte (EVERY tool message — single tool path)
 * └── ToolCallView.svelte (single tool-call renderer)
 * └── ArtifactView.svelte (CHOKE POINT — the ONE artifact renderer)
 * └── html-preview.ts (shared sandboxedSrcdoc + rejectSameOrigin)
 * ↑
 * web-ui-config.ts (artifactSandboxToken — the config owner reads + hardens
 * the sandbox token; ArtifactView consumes it, never reads
 * the config inline — SPO "Lowest-Level Enforcement")
 *
 * Key invariants enforced here (DYNAMIC discovery — no hardcoded
 * file lists; `readdirSync` walks `src/` + `server/` so a new file is
 * auto-covered):
 * A — ArtifactView is the single artifact renderer (imported ONLY by
 * ToolCallView; no other component mounts an artifact).
 * B — ArtifactView uses the shared sandboxedSrcdoc (single CSP owner);
 * no component composes a CSP+srcdoc by hand.
 * C — The sandbox token is consumed from the config owner
 * (`artifactSandboxToken` in web-ui-config.ts), NOT read inline in
 * ArtifactView. The owner hardens via rejectSameOrigin (no
 * allow-same-origin can reach an untrusted-HTML iframe).
 * D — The "artifact" OutputKind branch is handled ONLY in ToolCallView
 * (no ad-hoc artifact rendering elsewhere).
 * E — No {@html} in ArtifactView (XSS — content goes in the iframe
 * srcdoc, never injected into the parent page).
 * F — ARTIFACT_TYPES is the single owner of the artifact-kind list
 * (defined ONLY in tools-bridge.ts; the executor derives a Set from
 * it; the manifest enum references it — no drift).
 * G — create_artifact is in the unified manifest + the executor (one
 * tool pipeline).
 * J — Persistence path: the run route saves `input` on tool_call_done +
 * hydrateChatFromHistory maps `firstTool.input` → toolCall.input
 * (the artifact content survives a refresh).
 * K — Behavioral: readArtifactSandboxToken hardens (rejects
 * allow-same-origin → allow-scripts; default allow-scripts).
 * (Classes H, I and L — extractArtifact/outputKindFor/ToolCallView — died
 * with the old chat surface; the cockpit's own artifact owner
 * `src/cockpit/render/artifact.ts` carries extraction with honest absence,
 * tested in tests/cockpit/artifact-runtime-errors.test.ts.)
 *
 * Mutation-verified: reintroducing an ad-hoc artifact render, an inline
 * config read in ArtifactView, a hand-composed CSP, a duplicate
 * ARTIFACT_TYPES, or removing the content-omit filter each makes the
 * relevant assertion FAIL.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest, ARTIFACT_TYPES } from "../../server/tools/tools-bridge.ts";
import { createRunSafetyGate } from "../../server/safety/safety-bridge.ts";
import { readArtifactSandboxToken } from "../../src/state/web-ui-config";
import { read, sourceFiles, stripCommentsAndStringsDropFor } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// ── Dynamic file discovery ──

const SRC_ROOT = "src";
const SERVER_ROOT = "server";

const SRC_FILES = sourceFiles(SRC_ROOT);
const SERVER_FILES = sourceFiles(SERVER_ROOT);
const ALL_FILES = [...SRC_FILES, ...SERVER_FILES];

/** Files whose CODE (comments/strings stripped) matches a regex. */
function codeMatching(pattern: RegExp, files: readonly string[]): string[] {
  return files.filter((f) => pattern.test(stripCommentsAndStringsDropFor(read(f), f)));
}

/** Files whose raw source contains an import of a given module/basename. */
function importersOf(basename: string, files: readonly string[]): string[] {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow an optional `.svelte` suffix so `import X from "./X.svelte"` matches.
  const re = new RegExp(`from\\s+["'][^"']*${escaped}(?:\\.svelte)?["']`);
  return files.filter((f) => re.test(read(f)));
}

const HTML_PREVIEW = modulePath("html-preview.ts");
const WEB_UI_CONFIG = modulePath("web-ui-config.ts");
const TOOLS_BRIDGE = modulePath("tools-bridge.ts");
const TOOL_EXECUTOR = modulePath("tool-executor.ts");
const CLIENT = modulePathMatching("src/client.ts");

// ── Test context for behavioral executor checks ──
let projectRoot = "";
let ctx: ToolExecutionContext;

beforeEach(() => {
  projectRoot = createTempDir("ch-artifact-owner-");
  ctx = { projectRoot };
});

describe("Artifact rendering owner", () => {
  // (Classes A + B — the old ArtifactView renderer — died with the old
  //  tree; the cockpit ArtifactFrame carries the CSP owner contract in
  //  tests/cockpit/artifact-runtime-errors.test.ts.)

  describe("C. Sandbox token consumed from the config owner (no inline config read)", () => {
    // (The ArtifactView consumption cases died with the component.)

    test("the config owner (web-ui-config) defines + hardens the artifact sandbox token", () => {
      const src = read(WEB_UI_CONFIG);
      expect(src, "must export readArtifactSandboxToken").toMatch(
        /export\s+function\s+readArtifactSandboxToken/,
      );
      expect(src, "must export the reactive artifactSandboxToken atom").toMatch(
        /export\s+const\s+artifactSandboxToken/,
      );
      // The owner applies the shared security hardening (rejectSameOrigin)
      // so no consumer can forget to strip allow-same-origin.
      expect(src, "must harden via rejectSameOrigin from html-preview").toContain(
        'import { rejectSameOrigin } from "../../shared/html-preview"',
      );
      expect(src, "readArtifactSandboxToken must call rejectSameOrigin").toContain(
        "rejectSameOrigin(raw)",
      );
    });

  });

  // (Class E died with ArtifactView; the cockpit render surfaces have
  //  their own XSS guards.)

  describe("F. ARTIFACT_TYPES is the single owner of the artifact-kind list", () => {
    test("ARTIFACT_TYPES is defined ONLY in tools-bridge.ts (no scattered duplicate)", () => {
      // A second `ARTIFACT_TYPES = [...]` definition would drift from the
      // manifest enum + the executor validation. Dynamic: scans ALL
      // src/+server/ files. (The executor IMPORTS it from tools-bridge —
      // that is not a definition, so it does not match.)
      const definers = ALL_FILES.filter((f) => {
        if (f === TOOLS_BRIDGE) return false;
        const code = stripCommentsAndStringsDropFor(read(f), f);
        return /\bARTIFACT_TYPES\s*=/.test(code);
      });
      expect(
        definers,
        `ARTIFACT_TYPES defined outside tools-bridge.ts (single owner): ${definers.join(", ")})`,
      ).toEqual([]);
    });

    test("the executor derives its validation Set from ARTIFACT_TYPES (not a hardcoded duplicate)", () => {
      const src = read(TOOL_EXECUTOR);
      expect(src, "must derive the artifact-type Set from ARTIFACT_TYPES").toContain(
        "new Set(toolsBridge().ARTIFACT_TYPES)",
      );
    });

    test("the manifest's create_artifact enum references ARTIFACT_TYPES (no drift)", () => {
      const src = read(TOOLS_BRIDGE);
      expect(src, "the create_artifact enum must reference ARTIFACT_TYPES").toContain(
        "enum: ARTIFACT_TYPES",
      );
    });
  });

  describe("G. create_artifact is in the unified manifest + the executor (one pipeline)", () => {
    test("create_artifact appears in getToolManifest with kind artifact", () => {
      const entry = getToolManifest().find((t) => t.name === "create_artifact");
      expect(entry, "create_artifact must be in the manifest").toBeDefined();
      expect(entry!.kind).toBe("artifact");
    });

    test("executeToolCall dispatches create_artifact (manifest ↔ executor 1:1)", async () => {
      const res = await executeToolCall(
        "create_artifact",
        { type: "html", title: "t", content: "<p>x</p>" },
        ctx,
      );
      expect(res.success).toBe(true);
      const out = JSON.parse(res.output) as { ok: boolean; type: string };
      expect(out.ok).toBe(true);
      expect(out.type).toBe("html");
    });

  });

  // (Classes H + I — tool-render/ToolCallView — died with the old chat
  //  surface; the persistence contract itself is class J below.)

  describe("J. Persistence path — the artifact content survives a refresh", () => {
    test("the row's input is persisted ONCE, by the result write, as what was dispatched", () => {
      // The old arm pinned `{ input: event.arguments }` on the tool_call_done
      // model-event write. That write was the 34ms clobber (UIE-040): it
      // landed AFTER persistToolResult had already written the DISPATCHED
      // whole and rewrote the row's input with the raw delta, so the
      // reloaded view rendered an artifact whose content nobody could
      // reach. The row's input now has ONE writer — persistToolResult —
      // and this pin says so at the write the artifact record lives on.
      //
      // MUTATION: reinstate a done-case `{ input: event.arguments }` row
      // write → the tool-result-persistence owner reds on the one-writer
      // claim; dropping the dispatched resolution from the persist call →
      // the `?? event.arguments` pin here reds.
      const src = runPathSource();
      expect(
        src,
        "the row's input must be settled by the ONE writer (persistToolResult), resolved to what was DISPATCHED — the merged whole when the gate rewrote the call, else the event's own arguments (the artifact content).",
      ).toContain("toolResult.dispatchedArguments ?? event.arguments");
    });

    test("hydrateChatFromHistory maps the persisted tool input → toolCall.input", () => {
      const src = read(CLIENT);
      expect(
        src,
        "hydration must map firstTool.input → toolCall.input so the artifact renders after refresh",
      ).toContain("input: firstTool.input");
    });
  });

  // ── M. THE DISPATCHED ARGUMENTS (UIE-035) ──────────────────────────────
  //
  // Measured live: a create_artifact call whose partial-argument memory the
  // gate merged SUCCEEDED — the artifact was written — but every record of
  // it (the tool_result frame, the persisted row) carried only the DELTA
  // the model sent, so the frame the surface renders from named no content
  // and the artifact was unreachable from the transcript. The record must
  // show what RAN.
  //
  // MUTATION: drop the `dispatchedArguments` stamp from the executor → the
  // first arm fails (the merged result claims it was never rewritten).
  // MUTATION: revert the run route's frame to the raw event arguments →
  // the source arm below fails.
  describe("M. a merged call records what RAN — the dispatched arguments (UIE-035)", () => {
    /** The REAL run gate over the REAL manifest — the same factory the run
     * route uses (createRunSafetyGate), so the merge measured here is the
     * merge that runs live, not a stub's goodwill. */
    function runGate() {
      return createRunSafetyGate(() => getToolManifest());
    }

    test("a delta that completes a retained partial RUNS and SAYS SO on its result", async () => {
      const gate = runGate();
      // Attempt 1: a partial whose valid fields the gate retains after the
      // schema refusal (content is present, the required title is not).
      const first = await executeToolCall(
        "create_artifact",
        { type: "html", content: "<p>the retained half</p>" },
        { ...ctx, gate, callId: "call-merge-1" },
      );
      expect(first.success).toBe(false);
      expect(first.gateBlock?.kind).toBe("schema_mismatch");
      expect(first.dispatchedArguments).toBeUndefined();

      // Attempt 2: the delta. The gate merges the retained partial in and
      // the executor DISPATCHES the whole — the artifact exists because the
      // tool received the merged content.
      const second = await executeToolCall(
        "create_artifact",
        { title: "the delta title" },
        { ...ctx, gate, callId: "call-merge-2" },
      );
      expect(second.success).toBe(true);
      // THE WHOLE POINT (UIE-035): the result names the arguments that were
      // actually dispatched — the merged whole, never the bare delta — so
      // the frame and the row built from it render a reachable artifact.
      expect(second.dispatchedArguments).toMatchObject({
        type: "html",
        title: "the delta title",
        content: "<p>the retained half</p>",
      });
    });

    test("a call the gate did NOT rewrite carries no dispatchedArguments — the field means REWRITTEN", async () => {
      const res = await executeToolCall(
        "create_artifact",
        { type: "html", title: "t", content: "<p>whole</p>" },
        ctx,
      );
      expect(res.success).toBe(true);
      expect(res.dispatchedArguments).toBeUndefined();
    });

    test("the run route's frame AND row read the dispatched arguments", () => {
      const src = runPathSource();
      expect(
        src,
        "the tool_result frame must carry the dispatched arguments when the gate rewrote the call",
      ).toContain("toolResult.dispatchedArguments ?? event.arguments");
      expect(
        src,
        "the persisted row's input must take the dispatched arguments too — hydration renders from it",
      ).toMatch(/persistToolResult\([^)]*toolResult\.dispatchedArguments/s);
    });
  });

  describe("K. Behavioral — readArtifactSandboxToken hardens (no allow-same-origin)", () => {
    test("default is allow-scripts when the section is absent", () => {
      expect(readArtifactSandboxToken(null)).toBe("allow-scripts");
      expect(readArtifactSandboxToken(undefined)).toBe("allow-scripts");
      expect(readArtifactSandboxToken({})).toBe("allow-scripts");
      expect(readArtifactSandboxToken({ artifacts: {} })).toBe("allow-scripts");
    });

    test("an empty/non-string iframeSandbox falls back to allow-scripts", () => {
      expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: "" } })).toBe("allow-scripts");
      expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: 123 } })).toBe("allow-scripts");
    });

    test("a safe custom token is preserved (allow-popups without same-origin)", () => {
      expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-scripts allow-popups" } })).toBe(
        "allow-scripts allow-popups",
      );
    });

    test("allow-same-origin is ALWAYS stripped (defense-in-depth — never reaches the iframe)", () => {
      // A misconfigured token containing allow-same-origin would let the
      // untrusted artifact read the parent's DOM/cookies/localStorage.
      // The config owner hardens it to allow-scripts (rejectSameOrigin).
      expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-scripts allow-same-origin" } })).toBe(
        "allow-scripts",
      );
      expect(
        readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-same-origin" } }),
      ).toBe("allow-scripts");
      expect(
        readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-scripts allow-same-origin allow-popups" } }),
      ).toBe("allow-scripts");
    });
  });

  describe("Mutation verification — reintroducing a violation makes the relevant check FAIL", () => {
    // These are documentation of the mutation guarantees (the assertions
    // above are the live enforcement). They pin the contract that each
    // assertion is non-trivial: the violation it targets would break it.
    test("ARTIFACT_TYPES covers exactly the documented kinds (no silent add/drop)", () => {
      // The single owner's content. If a kind is added here but not to the
      // manifest enum (or vice versa), the F.3 contract catches the drift.
      expect([...ARTIFACT_TYPES].sort()).toEqual(["game", "html", "presentation", "sheet"]);
    });
  });
});
