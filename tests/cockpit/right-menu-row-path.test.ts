// @vitest-environment jsdom
/**
 * THE RIGHT MENU'S ROW PATHS — every clickable row's deep surface.
 *
 * The user's standing directive, verbatim: "things should be clickable
 * whenever we can". A row earns a click only when something real is
 * behind it, and the click must REACH that surface through the one-shot
 * seams the surfaces own:
 *
 *   a turn row  → `requestBeatAction(id, "scope")`  (flow/beat-request.ts)
 *   a call row  → `requestBeatAction(id, "reveal")` (same seam)
 *   an edit row → `shell.openScope` with the DiffSheet body, through the
 *                 shell context under the menu (the PathChip precedent)
 *   a captured range row → `requestBandGo(t0)`      (sweep/band-request.ts)
 *
 * This suite pins BOTH halves of each path: the seam's ONE-SHOT CONTRACT
 * (request → pending; consume → cleared; junk refused) and the ROW WIRING
 * (the click really writes the seam; a dead button is the wired-but-inert
 * class this suite exists to catch). The CONSUMERS' halves are pinned
 * where the consumers live: the Sweep's `setHead` consumption in
 * sweep-component.test.ts, the Flow's open/reveal consumption in
 * flow-beat-request.test.ts.
 *
 * NO FAKE BUTTONS is the other half of the same law: the agents' rows have
 * no deeper surface than their own facts, so they render NO button —
 * asserted here so a future "make it look clickable" pass cannot fake one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// PARTIAL broker mock: only the arm.flags READ is faked (the record's own
// door, exactly what the arm-sync suite stubs); the rest of the Broker is
// the real module — RunPane's imports reach the real invalidation seams.
vi.mock("../../src/data/broker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/data/broker.ts")>();
  return {
    ...actual,
    read: vi.fn(),
    action: vi.fn(),
  };
});
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { mount, unmount } from "svelte";

import RunPane from "../../src/cockpit/flow/RunPane.svelte";
import ArmMenuBody from "../../src/cockpit/sweep/ArmMenuBody.svelte";
import {
  consumeBeatRequest,
  pendingBeatRequest,
  requestBeatAction,
} from "../../src/cockpit/flow/beat-request.ts";
import {
  consumeBandGoRequest,
  pendingBandGo,
  requestBandGo,
} from "../../src/cockpit/sweep/band-request.ts";
import { armedTriggers } from "../../src/cockpit/sweep/sweep-store.ts";
import { armVocabularyFields } from "../../shared/arm-vocabulary.ts";
import { ClientError } from "../../src/data/errors.ts";
import { action as brokerAction } from "../../src/data/broker.ts";
import { SHELL_CONTEXT_KEY, type ShellApi, type ScopeRequest } from "../../src/cockpit/shell/contract.ts";
import DiffSheet from "../../src/cockpit/rooms/DiffSheet.svelte";
import {
  appendAssistantMessage,
  appendToolCall,
  clearMessages,
  updateLastAssistantMessage,
} from "../../src/state/chat-messages.ts";
import { projects, currentProjectId } from "../../src/state/projects.ts";
import { refreshCapturedRanges } from "../../src/cockpit/sweep/arm-sync.ts";
import { deskLine, resetAdmission } from "../../src/cockpit/computer/admission.ts";
import { read as brokerRead } from "../../src/data/broker.ts";
import { currentChatId, setChats } from "../../src/state/chats.ts";
import { workspaces } from "../../src/state/workspaces.ts";
import { setTools, resetTools } from "../../src/state/tools.ts";
import type { WebToolEntry } from "../../shared/types.ts";

function toolEntry(
  name: string,
  capabilities: readonly ("read" | "write")[],
  label?: string,
): WebToolEntry {
  return {
    id: name,
    name,
    description: `${name} tool`,
    inputSchema: {},
    capabilities: Object.freeze([...capabilities]),
    bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 },
    adapterId: "adapter",
    category: "built-in",
    kind: "filesystem",
    ...(label !== undefined ? { label } : {}),
  };
}

beforeEach(() => {
  workspaces.set([]);
  window.sessionStorage.clear();
  clearMessages();
  projects.set([]);
  currentProjectId.set("p1");
  projects.set([{ id: "p1", name: "Inspector project", path: "/test/inspector", createdAt: "t", updatedAt: "t" }]);
  setChats([{ id: "inspector-chat", projectId: "p1", title: "Inspector conversation", createdAt: "t", updatedAt: "t", modelId: null, pinned: false }]);
  currentChatId.set("inspector-chat");
  setTools([
    toolEntry("edit", ["write"], "edit file"),
    toolEntry("read_file", ["read"]),
  ]);
  armedTriggers.set([]);
  consumeBeatRequest();
  consumeBandGoRequest();
});

async function openSection(container: HTMLElement, id: string): Promise<void> {
  await tick();
  const grip = container.querySelector<HTMLButtonElement>(`[data-verb-id="disclosure.${id}"]`);
  expect(grip, `The actual ${id} disclosure must be reachable`).not.toBeNull();
  if (grip!.getAttribute("aria-expanded") !== "true") grip!.click();
  await tick();
}

afterEach(() => {
  cleanup();
  resetTools();
  clearMessages();
  armedTriggers.set([]);
  currentChatId.set(null);
  consumeBeatRequest();
  consumeBandGoRequest();
});

// ── The seams' one-shot contracts ──────────────────────────────────────────

describe("the beat-request seam (the pane → flow one-shot)", () => {
  test("a request lands on the pending atom and consuming clears it", () => {
    expect(pendingBeatRequest.get()).toBeNull();
    requestBeatAction("b-m1", "scope");
    expect(pendingBeatRequest.get()).toEqual({ id: "b-m1", want: "scope" });
    expect(consumeBeatRequest()).toEqual({ id: "b-m1", want: "scope" });
    expect(pendingBeatRequest.get(), "one-shot: consuming clears").toBeNull();
    expect(consumeBeatRequest(), "a second consume takes nothing").toBeNull();
  });

  test("the newest ask wins — an unconsumed earlier ask is overwritten", () => {
    requestBeatAction("b-old", "reveal");
    requestBeatAction("b-new", "scope");
    expect(pendingBeatRequest.get()).toEqual({ id: "b-new", want: "scope" });
  });

  test("a blank id is refused — nothing navigates to no beat", () => {
    requestBeatAction("   ", "scope");
    requestBeatAction("", "reveal");
    expect(pendingBeatRequest.get()).toBeNull();
  });
});

describe("the band-request seam (the menu → sweep one-shot)", () => {
  test("a finite ask lands and consuming clears it", () => {
    expect(pendingBandGo.get()).toBeNull();
    requestBandGo(1_726_000_000_000);
    expect(pendingBandGo.get()).toBe(1_726_000_000_000);
    expect(consumeBandGoRequest()).toBe(1_726_000_000_000);
    expect(pendingBandGo.get(), "one-shot: consuming clears").toBeNull();
  });

  test("a non-finite ask is refused — the head never plants at a fabricated time", () => {
    requestBandGo(Number.NaN);
    requestBandGo(Number.POSITIVE_INFINITY);
    expect(pendingBandGo.get()).toBeNull();
  });
});

// ── The row wiring ─────────────────────────────────────────────────────────

describe("the run pane's row heads write the seams", () => {
  test("a TURN row's head asks for its beat's scope", async () => {
    appendAssistantMessage("the answer");
    const { container } = render(RunPane, {});
    await openSection(container, "run-sec-turns");
    const row = container.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.turn-scope"]')!;
    expect(row.textContent).toContain("Turn 1");
    row.click();
    await tick();
    // The id is the MESSAGE id — the flow resolves `b-<id>` itself.
    expect(pendingBeatRequest.get()).toEqual({
      id: expect.any(String),
      want: "scope",
    });
    const asked = pendingBeatRequest.get()!;
    const last = (await import("../../src/state/chat-messages.ts")).messages.get().at(-1)!;
    expect(asked.id).toBe(last.id);
  });

  test("a CALL row's head asks for its beat's reveal", async () => {
    appendToolCall({
      id: "call-1",
      name: "read_file",
      input: {},
      output: null,
      status: "done",
      startedAt: Date.now() - 100,
    });
    const { container } = render(RunPane, {});
    await openSection(container, "run-sec-calls");
    const row = container.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.call-reveal"]')!;
    expect(row.textContent).toContain("read file");
    row.click();
    await tick();
    // The id is the tool call's MESSAGE id — the flow resolves `b-<id>`.
    const asked = pendingBeatRequest.get()!;
    expect(asked.want).toBe("reveal");
    const last = (await import("../../src/state/chat-messages.ts")).messages.get().at(-1)!;
    expect(asked.id).toBe(last.id);
  });

  test("an EDIT row's head opens the difference sheet through the shell context", async () => {
    // The PathChip precedent: a non-outlet component under the shell reads
    // the ShellApi from context. This mount provides a recording stub.
    const opened: ScopeRequest[] = [];
    const stub = {
      openScope: (req: ScopeRequest) => {
        opened.push(req);
      },
    } as unknown as ShellApi;
    appendToolCall({
      id: "edit-1",
      name: "edit",
      input: { path: "src/app.ts", old_string: "a", new_string: "b" },
      output: null,
      status: "done",
      startedAt: Date.now() - 100,
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    // A project must be open: the diff sheet is project-scoped.
    projects.set([
      { id: "p1", name: "proj", path: "/tmp/proj", createdAt: "2026-01-01T00:00:00Z" } as never,
    ]);
    currentProjectId.set("p1");
    const app = mount(RunPane, {
      target,
      context: new Map([[SHELL_CONTEXT_KEY, stub]]),
    });
    await tick();
    await openSection(target, "run-sec-edits");
    const row = target.querySelector<HTMLButtonElement>('[data-verb-id="run-pane.edit-diff"]')!;
    expect(row.textContent).toContain("src/app.ts");
    row.click();
    await tick();
    expect(opened).toEqual([
      {
        title: "src/app.ts — what changed",
        component: DiffSheet,
        // No `fileState`: that word is the custody tree's MEASURED state,
        // and this row holds the CALL's status — a different vocabulary
        // that must not dress the sheet's absence sentences.
        props: { projectPath: expect.any(String), file: "src/app.ts" },
      },
    ]);
    await unmount(app);
    target.remove();
  });

  test("with NO shell (a bare harness mount) the edit row is an honest fact, not a dead button", async () => {
    appendToolCall({
      id: "edit-2",
      name: "edit",
      input: { path: "src/dead.ts", old_string: "a", new_string: "b" },
      output: null,
      status: "done",
      startedAt: Date.now() - 100,
    });
    const { container } = render(RunPane, {});
    await openSection(container, "run-sec-edits");
    expect(container.querySelector('[data-verb-id="run-pane.edit-diff"]')).toBeNull();
    expect(container.querySelector("#run-sec-edits")!.textContent).toContain("src/dead.ts");
  });

  test("the agents' rows stay FACT rows — no button where nothing is behind it", async () => {
    const { agents, upsertAgent, resetRunState } = await import("../../src/state/run-state.ts");
    resetRunState();
    upsertAgent({
      agentId: "a1",
      agentName: "a1",
      runId: "r1",
      taskId: "t1",
      attemptId: "att1",
      lifecycleState: "running",
      turnCount: 1,
      totalPromptTokens: 1,
      totalCompletionTokens: 1,
      totalTokens: 2,
      turns: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastError: null,
      compactionSummary: null,
      suspensionReason: null,
    });
    const { container } = render(RunPane, {});
    await openSection(container, "run-sec-agents");
    const body = container.querySelector("#run-sec-agents");
    // Inspect the actual expanded rows: no button pretends to have a destination.
    expect(body).not.toBeNull();
    expect(body!.querySelector("button")).toBeNull();
    // The registry is a record keyed by agent id — the count is its values.
    expect(Object.values(agents.get()).length).toBe(1);
  });
});

describe("a captured range's label is its way back to the band", () => {
  test("the capture row's click asks the band to plant the head at the stretch's start", async () => {
    // Seed through the PRODUCTION door: the record's own read, served by
    // the mocked Broker, exactly as the body's mount-ask would find it.
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({
      flags: [
        {
          id: "flag-1",
          kind: "range",
          t0: 1_726_000_000_000,
          t1: 1_726_000_030_000,
          label: "the relay flap",
          recordedAt: "2026-09-04T00:00:00Z",
        },
      ],
      serverSideFiring: false,
    });
    currentChatId.set(null);
    await refreshCapturedRanges();
    const { container } = render(ArmMenuBody, {});
    await openSection(container, "arm-sec-captured");
    const go = container.querySelector<HTMLButtonElement>('[data-verb-id="arm-menu.capture-go"]')!;
    expect(go.textContent).toContain("the relay flap");
    go.click();
    await tick();
    expect(pendingBandGo.get()).toBe(1_726_000_000_000);
  });

  test("a capture with no instant is an honest fact row, never a dead button", async () => {
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({
      flags: [
        {
          id: "flag-2",
          kind: "range",
          label: "a stretch with no window",
          recordedAt: "2026-09-04T00:00:00Z",
        },
      ],
      serverSideFiring: false,
    });
    currentChatId.set(null);
    await refreshCapturedRanges();
    const { container } = render(ArmMenuBody, {});
    await openSection(container, "arm-sec-captured");
    expect(container.querySelector('[data-verb-id="arm-menu.capture-go"]')).toBeNull();
    expect(container.textContent).toContain("a stretch with no window");
    // The SHARE verb follows the same honesty: an unaddressed capture has
    // no derivation to dock, so no share button pretends otherwise.
    expect(container.querySelector('[data-verb-id="arm-menu.capture-share"]')).toBeNull();
  });

  test("the capture row's share verb docks the finding through the admission door, naming the capture's own address", async () => {
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({
      flags: [
        {
          id: "flag-3",
          kind: "range",
          t0: 1_726_000_100_000,
          t1: 1_726_000_200_000,
          label: "the shared stretch",
          recordedAt: "2026-09-04T00:00:00Z",
        },
      ],
      serverSideFiring: false,
    });
    resetAdmission();
    currentChatId.set(null);
    try {
      await refreshCapturedRanges();
      const { container } = render(ArmMenuBody, {});
      await openSection(container, "arm-sec-captured");
      const share = container.querySelector<HTMLButtonElement>('[data-verb-id="arm-menu.capture-share"]')!;
      expect(share.textContent).toContain("Share");
      share.click();
      await tick();
      const docked = deskLine.get();
      expect(docked).not.toBeNull();
      expect(docked!.finding.findingKind).toBe("arm-capture");
      expect(docked!.finding.sentence).toContain("capture shared: the shared stretch");
      expect(docked!.finding.derivation.steps[0]!.sourceId).toBe("arm.flags/capture flag-3");
      // The share is a NOTE, not a navigation: the band seam is untouched
      // (the finding's own verb carries the way there, like the row's go).
      expect(pendingBandGo.get()).toBeNull();
    } finally {
      resetAdmission();
    }
  });
});

// ── THE PALETTE + THE FIRED ROW'S VERBS + THE CUSTOM ENTRY ──────────────────
//
// The arm body's new surfaces: the palette renders FROM the vocabulary (the
// insert chips), the custom entry's refusal surfaces verbatim, the scope
// radios travel on the wire, and the fired row carries its go + re-arm.

describe("the palette — derived from the record's own vocabulary", () => {
  test("every vocabulary field renders an insert chip; a click inserts it into the custom entry", async () => {
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
    currentChatId.set(null);
    await refreshCapturedRanges();
    const { container } = render(ArmMenuBody, {});
    await openSection(container, "arm-sec-palette");
    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-verb-id="arm-palette.field"]'),
    ];
    // The vocabulary's own field set, not a hand list: the equality arm
    // lives in arm-palette.test.ts; here the SURFACE must offer at least
    // every field the vocabulary declares.
    const offered = new Set(chips.map((c) => c.textContent?.trim()));
    for (const f of armVocabularyFields()) {
      expect(offered.has(f.field), `the palette must render ${f.path}`).toBe(true);
    }
    // Inserting a field writes the custom entry.
    const entry = container.querySelector<HTMLInputElement>('input[name="arm-custom-expression"]')!;
    chips[0]!.click();
    await tick();
    expect(entry.value).toContain(chips[0]!.textContent!.trim());
    // An operator chip inserts its token the same way.
    const op = container.querySelector<HTMLButtonElement>('[data-verb-id="arm-palette.op"]')!;
    op.click();
    await tick();
    expect(entry.value).toContain(op.textContent!.trim());
  });

  test("the honest-absence section renders the record's stated limits, each with its way out", async () => {
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
    currentChatId.set(null);
    await refreshCapturedRanges();
    const { container } = render(ArmMenuBody, {});
    await tick();
    // Collapsed by default (deny-by-default) — the body is not in the DOM.
    expect(container.querySelector('[data-disclosure="arm-sec-not-on-record"] .disc-body')).toBeNull();
    const grip = container.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.arm-sec-not-on-record"]')!;
    grip.click();
    await tick();
    const body = container.querySelector('[data-disclosure="arm-sec-not-on-record"] .disc-body')!;
    // Each stated limit, with its way out, in the sentence-case copy.
    // WHO EVALUATES: the record states `serverSideFiring: false` (the mock
    // above), so the surface says the server fires nothing — storage alone
    // ("stores armed predicates, not firings") would let a reader conclude the
    // server fires but does not record it.
    expect(body.textContent).toContain("This browser evaluates watches over the live stream; the server fires none.");
    expect(body.textContent).toContain("The record stores armed predicates, not firings.");
    expect(body.textContent).toContain("the firing's mark and finding return to its instant");
    expect(body.textContent).toContain("Another browser can re-arm a recorded predicate.");
    expect(body.textContent).toContain("Capture names are fixed.");
    expect(body.textContent).toContain("To rename one, clear it and capture the same range again.");
    expect(body.textContent).toContain("File-path matches stay in this browser.");
    expect(body.textContent).toContain("A custom expression over event.description can match an exact description on the record.");
    // THE FIRED STATE'S CROSS-TAB TRUTH (UIE-087b): the r74 limit text
    // ("fired history lives in this browser") was falsified by drive 18 —
    // the whole-blob adoption carries firedAtMs, so the second tab converges
    // to "fired" immediately. The surface must tell the implemented truth:
    // the fired state never reaches the RECORD, and it DOES travel between
    // this browser's tabs.
    expect(body.textContent).toContain("Fired state syncs between this browser's tabs");
  });
});

describe("the custom entry — the server's refusal surfaces verbatim", () => {
  test("arming a garbage expression is refused with the record's own sentence, and nothing is armed", async () => {
    const actionMock = vi.mocked(brokerAction);
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
    actionMock.mockRejectedValue(
      new ClientError(
        "invalid_arm_predicate",
        "arm predicate does not parse: unexpected end of expression",
        428,
      ),
    );
    currentChatId.set("inspector-chat");
    armedTriggers.set([]);
    const { container } = render(ArmMenuBody, {});
    await openSection(container, "arm-sec-palette");
    const entry = container.querySelector<HTMLInputElement>('input[name="arm-custom-expression"]')!;
    await entry.focus();
    entry.value = "tool.name == (";
    entry.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
    container.querySelector<HTMLButtonElement>('#arm-sec-palette [data-action="arm.flags/set"]')!.click();
    await tick();
    await tick();
    // The note carries the server's sentence VERBATIM — not swallowed, not
    // paraphrased, and never armed.
    const note = container.querySelector('[role="status"]')!;
    expect(note.textContent).toContain("arm predicate does not parse: unexpected end of expression");
    expect(armedTriggers.get()).toHaveLength(0);
  });
});

describe("the scope choice travels on the wire", () => {
  test("defaulting to this chat; 'all my chats' arms with no chatId", async () => {
    const actionMock = vi.mocked(brokerAction);
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
    actionMock.mockResolvedValue({ id: "a1", kind: "trigger", recordedAt: "2026-09-04T00:00:00Z" });
    currentChatId.set("chat-9");
    const { container } = render(ArmMenuBody, {});
    await tick();
    // The default is this chat — the reader armed from a conversation.
    const chatRadio = container.querySelector<HTMLInputElement>('input[name="arm-scope"][value="chat"]')!;
    expect(chatRadio.checked).toBe(true);
    // Flip to all my chats; the arm carries NO chatId.
    const allRadio = container.querySelector<HTMLInputElement>('input[name="arm-scope"][value="all"]')!;
    allRadio.click();
    await tick();
    // The first arm verb (the check-fails quick row). LAST-call asserted, so
    // an earlier test's chatId-less call cannot make this pass vacuously.
    const armButtons = container.querySelectorAll<HTMLButtonElement>('[data-action="arm.flags/set"]');
    armButtons[0]!.click();
    await tick();
    await tick();
    expect(actionMock).toHaveBeenLastCalledWith(
      "arm.flags",
      "set",
      expect.not.objectContaining({ chatId: expect.anything() }),
      expect.anything(),
    );
  });
});

describe("the fired row carries its verbs — go through the band seam, re-arm explicit", () => {
  test("a fired row's go plants the band at the firing instant; re-arm re-cocks the row", async () => {
    const readMock = vi.mocked(brokerRead);
    readMock.mockResolvedValue({ flags: [], serverSideFiring: false });
    currentChatId.set(null);
    armedTriggers.set([
      Object.freeze({
        id: "arm-9",
        kind: "tool-errors",
        param: null,
        predicate: null,
        scope: "chat",
        armedAtMs: 1,
        firedAtMs: 1_726_000_000_000,
        storage: "local",
      }),
    ]);
    const { container } = render(ArmMenuBody, {});
    await openSection(container, "arm-sec-cocked");
    const go = container.querySelector<HTMLButtonElement>('[data-verb-id="arm-menu.fired-go"]')!;
    go.click();
    await tick();
    expect(pendingBandGo.get()).toBe(1_726_000_000_000);
    consumeBandGoRequest();
    const reArm = container.querySelector<HTMLButtonElement>('[data-verb-id="arm-menu.re-arm"]')!;
    reArm.click();
    await tick();
    expect(armedTriggers.get()[0]!.firedAtMs).toBeNull();
    // Re-cocked: the verbs leave with the fired state.
    expect(container.querySelector('[data-verb-id="arm-menu.re-arm"]')).toBeNull();
  });
});
