// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import Demo from "../../src/demo/Demo.svelte";
import { CODING_EXAMPLE, publicFixture } from "../../src/demo/fixture.ts";
import { replayBeats } from "../../src/demo/projection.ts";
import { PUBLIC_REPLAY_LIMITS, REPLAY_NOTICE, validatePublicReplay, type PublicReplay } from "../../src/demo/replay.ts";
import { beatIdFor, projectRecordedTranscript } from "../../src/cockpit/flow/ingest.ts";
import { createJourneyProjection, initialJourney, journeyView, transitionJourney, type JourneyState } from "../../src/demo/journey.ts";
import { activateLog, appendBeat, beatById, beatCount, displayedLogId, dropLog, windowSlice } from "../../src/cockpit/flow/log.ts";
import * as beatRequests from "../../src/cockpit/flow/beat-request.ts";
import { cockpitTheme, setLocalPref, THEME_ID } from "../../src/cockpit/settings/local-prefs.ts";
import { activateWorkspace, activeWorkspaceId, closeWorkspace, openWorkspace } from "../../src/state/workspaces.ts";
import { FLOW_VIEW_DEFAULT, flowViewForActive, noteFlowView } from "../../src/cockpit/flow/flow-view.ts";
import { consumeBeatRequest } from "../../src/cockpit/flow/beat-request.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import { setTools, toolManifest } from "../../src/state/tools.ts";
import type { WebToolEntry } from "../../shared/types.ts";
import { LayoutFreeResizeObserver } from "../helpers/resize-observer.ts";
import { editorToolEntries, normalizeToolInputSchema } from "../../server/tools/tool-manifest-data.ts";
import { createBuiltInToolManifestEntries } from "../../engine/src/tools/built-in-tool-manifest.ts";
import { createWriteSetDeniedFeedback, feedbackToStructured } from "../../engine/src/editor/edit-feedback.ts";
import { projectToolPresentation, toolPresentationByName } from "../../shared/tool-presentation.ts";
import { parseUnifiedDiff } from "../../src/cockpit/render/diff.ts";

const source = { repository: "Example-Org/source", repositoryUrl: "https://github.com/Example-Org/source", commit: "a".repeat(40), dirty: false, builtAt: "2026-11-13T00:00:00Z" };
// Expected parser input; production generates its patch through the existing Git owner.
const SAMPLE_PATCH = [
  "diff --git a/first.mjs b/first.mjs", "--- a/first.mjs", "+++ b/first.mjs",
  "@@ -1,3 +1,3 @@", " export function first(items) {",
  "-  return items[1];", "+  return items[0];", " }", "",
].join("\n");
const fixtureTools = [...editorToolEntries(), ...createBuiltInToolManifestEntries().filter((entry) => entry.outputShape === "command" && entry.capabilities.includes("execute"))].map(normalizeToolInputSchema).map(projectToolPresentation);
const fixture = () => publicFixture(source, { tools: fixtureTools, patch: SAMPLE_PATCH, refusal: { success: false, path: "package.json", feedback: feedbackToStructured(createWriteSetDeniedFeedback("package.json", CODING_EXAMPLE.path)) } }, null);
let savedTools: readonly WebToolEntry[];
beforeEach(() => { savedTools = toolManifest.get(); setTools([]); vi.stubGlobal("ResizeObserver", LayoutFreeResizeObserver); });
afterEach(() => { cleanup(); setTools(savedTools); consumeBeatRequest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });
const recordedMessageBeatId = (id: string) => beatIdFor({ id });
async function openAdvanced(container: HTMLElement): Promise<void> {
  const details = container.querySelector<HTMLDetailsElement>("details.advanced")!;
  details.open = true;
  await fireEvent(details, new Event("toggle"));
  await tick();
  await waitFor(() => expect(container.querySelector('[role="listbox"]')).not.toBeNull());
}

describe("public replay uses the recorded product projection", () => {
  test("the launcher shows the actual task, links to setup and jumps through canonical facts", async () => {
    const record = fixture();
    const view = render(Demo, { props: { record, workspaceHref: "../docs/quickstart/", homeHref: "../" } });
    await tick();
    expect(view.getByLabelText("Example task").textContent).toContain(CODING_EXAMPLE.before.trim());
    for (const link of view.getAllByRole("link", { name: "Use your own project" })) expect(link.getAttribute("href")).toBe("../docs/quickstart/");
    expect(view.container.querySelector(".brand")?.getAttribute("href")).toBe("../");
    expect(view.queryByRole("listbox")).toBeNull();
    const navigator = view.getByRole("navigation", { name: "Example journey" });
    expect(navigator.closest("details")).toBeNull();
    expect(within(navigator).getAllByRole("listitem")).toHaveLength(record.guide.steps.length);
    expect(within(navigator).getByRole("list").tagName).toBe("OL");
    expect(within(navigator).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(record.guide.steps.map((step, index) => String(index + 1) + " " + (step.label ?? step.title)));
    expect(view.getByRole("button", { name: "Start the example" }).compareDocumentPosition(navigator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(navigator.compareDocumentPosition(view.getByLabelText("Example task")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.queryByRole("heading", { name: "Start with this task." })).toBeNull();
    const step = within(navigator).getByRole("button", { name: "2 Change" });
    await fireEvent.click(step);
    const effect = replayBeats(record).find((beat) => beat.kind === "effect")!;
    expect(location.hash).toBe("#" + effect.id);
    expect(step.getAttribute("aria-current")).toBe("step");
    expect(view.getByLabelText("Selected record").textContent).toContain("return items[0]");
    await fireEvent.click(view.getByRole("button", { name: "Restart" }));
    expect(view.getByLabelText("Example task").textContent).toContain(CODING_EXAMPLE.before.trim());
  });

  test("recorded messages, actual effect and parentage use the production projection with explicit context", () => {
    const record = fixture();
    const beats = replayBeats(record);
    const expected = projectRecordedTranscript(record.messages, 0, { tools: toolPresentationByName(record.tools), effects: new Map(record.effects.map((effect) => [effect.messageId, effect.patch])) });
    expect(beats).toEqual(expected);
    expect(beats).toHaveLength(record.messages.length + 1);
    const edit = beats.find((beat) => beat.tool?.name === record.tools.find((tool) => tool.fileEffect)!.name && beat.tool.status === "done")!;
    const effect = beats.find((beat) => beat.kind === "effect")!;
    expect(effect.parentId).toBe(edit.id);
    expect(effect.effect).toMatchObject({ path: CODING_EXAMPLE.path, producedBy: edit.id, patch: SAMPLE_PATCH, added: 1, removed: 1 });
    expect(beats.every((beat) => beat.verbs.length === 0)).toBe(true);
    expect(beats.some((beat) => beat.tool?.status === "running" || beat.kind === "check-delta")).toBe(false);
  });
  test("the guided task opens its canonical diff and command without starting an API", async () => {
    const fetchSpy = vi.fn(), eventSourceSpy = vi.fn(), socketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy); vi.stubGlobal("EventSource", eventSourceSpy); vi.stubGlobal("WebSocket", socketSpy);
    const request = vi.spyOn(beatRequests, "requestBeatAction");
    const record = fixture();
    const view = render(Demo, { props: { record } });
    await tick();
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(record.title);
    expect(view.getByRole("note").textContent).toContain(REPLAY_NOTICE);
    await fireEvent.click(view.getByRole("button", { name: "Start the example" }));
    const original = windowSlice(0, beatCount());
    const effect = original.find((beat) => beat.kind === "effect")!;
    await fireEvent.click(view.getByRole("button", { name: "Next: Inspect the change" }));
    expect(location.hash).toBe("#" + effect.id);
    expect(view.container.querySelector(".story-record")?.textContent).toContain("return items[0]");
    expect(view.container.querySelector(".story-record")?.textContent).toContain("return items[1]");
    expect(request).not.toHaveBeenCalled();
    await openAdvanced(view.container);
    expect(view.getByRole("listbox", { name: "the run — causal block stream" })).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector('[data-beat-id="' + effect.id + '"]')?.getAttribute("aria-selected")).toBe("true"));
    const cause = view.container.querySelector<HTMLButtonElement>(".story-record .cause-link")!;
    await fireEvent.click(cause);
    expect(location.hash).toBe("#" + effect.parentId);
    expect(view.getByText("Step 2 of 5")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Next: Test the boundary" }));
    const attempt = view.container.querySelector<HTMLDetailsElement>(".story-record details.recorded-action")!;
    expect(attempt.open).toBe(false);
    const stepControls = view.getByRole("navigation", { name: "Example steps" });
    expect(within(stepControls).queryByRole("button", { name: /^Next:/u })).toBeNull();
    const utilities = within(stepControls).getByRole("group", { name: "Example navigation utilities" });
    expect(within(utilities).getAllByRole("button").map((button) => button.textContent)).toEqual(["Back", "Restart"]);
    const next = attempt.querySelector<HTMLButtonElement>("button.verb.primary")!;
    expect(next.textContent).toBe("Next: Read the check");
    expect(next.closest("details")).toBe(attempt);
    const result = attempt.querySelector(".beat-scope")!;
    expect(result.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Closed native details conceals this continuation in the browser. jsdom's
    // role helper does not model that presentation, so assert native containment/open state.
    const reveal = attempt.querySelector("summary")!;
    expect(reveal.textContent).toBe(record.guide.steps[2]!.actionLabel);
    await fireEvent.click(reveal);
    expect(attempt.open).toBe(true);
    expect(within(attempt).getByRole("button", { name: "Next: Read the check" })).toBe(next);
    expect(attempt.textContent).toContain("write_set_denied");
    await fireEvent.click(next);
    expect(view.container.querySelector(".story-record")?.textContent).toContain("Illustrative check output");
    expect(view.container.querySelector(".story-record")?.textContent).toContain("exit 0");
    await fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.container.querySelector<HTMLDetailsElement>(".story-record details.recorded-action")?.open).toBe(false);
    expect(windowSlice(0, beatCount()).every((beat, index) => beat === original[index])).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(eventSourceSpy).not.toHaveBeenCalled(); expect(socketSpy).not.toHaveBeenCalled();
  });
  test("a deep-linked recorded attempt starts closed and uses the same canonical result", async () => {
    const record = fixture();
    const refused = replayBeats(record).find((beat) => beat.tool?.refused === true)!;
    history.replaceState(null, "", "#" + refused.id);
    const view = render(Demo, { props: { record } });
    const attempt = view.container.querySelector<HTMLDetailsElement>(".story-record details.recorded-action")!;
    expect(attempt.open).toBe(false);
    const original = windowSlice(0, beatCount());
    expect(within(view.getByRole("navigation", { name: "Example steps" })).queryByRole("button", { name: /^Next:/u })).toBeNull();
    const next = attempt.querySelector<HTMLButtonElement>("button.verb.primary")!;
    expect(next.textContent).toBe("Next: Read the check");
    expect(next.closest("details")).toBe(attempt);
    await fireEvent.click(attempt.querySelector("summary")!);
    expect(attempt.open).toBe(true);
    expect(within(attempt).getByRole("button", { name: "Next: Read the check" })).toBe(next);
    expect(attempt.textContent).toContain("write_set_denied");
    expect(location.hash).toBe("#" + refused.id);
    expect(windowSlice(0, beatCount()).every((beat, index) => beat === original[index])).toBe(true);
    expect(view.getByRole("note").textContent).toBe(REPLAY_NOTICE);
    await fireEvent.click(within(view.getByRole("navigation", { name: "Example journey" })).getByRole("button", { name: "4 Checks" }));
    expect(location.hash).toBe("#" + recordedMessageBeatId(record.guide.steps[3]!.focusMessageId));
    expect(windowSlice(0, beatCount()).every((beat, index) => beat === original[index])).toBe(true);
  });

  test("a deep-linked effect shows recorded bytes and a dirty build does not claim exact source", async () => {
    const record = fixture();
    const effect = replayBeats(record).find((beat) => beat.kind === "effect")!;
    history.replaceState(null, "", "#" + effect.id);
    const view = render(Demo, { props: { record: { ...record, source: { ...source, dirty: true } } } });
    await tick();
    expect(view.container.querySelector(".beat-scope")?.textContent).toContain("return items[0]");
    expect(view.container.textContent).toContain("uncommitted preview changes");
    expect(view.container.textContent).toContain("No GitHub check observation");
  });
});

describe("the public fixture cannot silently become a private or live record", () => {
  test("rejects private metadata, live provenance, running tools and mismatched GitHub evidence", () => {
    const bad: readonly [PublicReplay, RegExp][] = [
      [{ ...fixture(), provenance: "real" } as unknown as PublicReplay, /declared public fixture/u],
      [{ ...fixture(), messages: [{ ...fixture().messages[0]!, responseHeaders: { authorization: "fixture-private" } }] } as unknown as PublicReplay, /unknown message metadata/u],
      [{ ...fixture(), source: { ...source, projectPath: "/private/project" } } as unknown as PublicReplay, /unknown source metadata/u],
      [{ ...fixture(), messages: fixture().messages.map((message) => message.toolCall === undefined ? message : { ...message, toolCall: { ...message.toolCall, status: "running" } }) }, /terminal recorded tool status/u],
      [{ ...fixture(), messages: [{ id: "missing-call", role: "tool", content: "", timestamp: 0 }] }, /needs its recorded tool call/u],
      [{ ...fixture(), github: { availability: "observed", sourceCommit: "b".repeat(40), observedAt: source.builtAt, checks: [] } }, /another source revision/u],
      [{ ...fixture(), github: { availability: "observed", sourceCommit: source.commit, observedAt: source.builtAt, checks: [{ title: "Foreign check", status: "pass", url: "https://foreign.invalid/check" }] } }, /outside its declared repository/u],
    ];
    for (const [record, message] of bad) {
      expect(() => validatePublicReplay(record)).toThrowError(TypeError);
      expect(() => validatePublicReplay(record)).toThrowError(message);
    }
  });

  test("refuses duplicate IDs and bounded inputs through the same validator", () => {
    const record = fixture();
    expect(() => validatePublicReplay({ ...record, messages: [record.messages[0]!, record.messages[0]!] })).toThrowError(/unique/u);
    expect(() => validatePublicReplay(record, { ...PUBLIC_REPLAY_LIMITS, messages: 1 })).toThrowError(RangeError);
    expect(() => validatePublicReplay(record, { ...PUBLIC_REPLAY_LIMITS, bytes: 1 })).toThrowError(RangeError);
  });
});

function journeyFixture() {
  const record = fixture();
  const first = record.messages[0]!;
  const rest = record.messages.slice(1);
  const grouped = validatePublicReplay({
    ...record,
    guide: {
      ...record.guide,
      steps: [
        { title: "Set the task", explanation: "Inspect the example request.", messageIds: [first.id], focusMessageId: first.id },
        { title: "Inspect the result", explanation: "Follow the recorded result and boundary.", messageIds: rest.map((message) => message.id), focusMessageId: rest[0]!.id },
      ],
    },
  });
  const beats = replayBeats(grouped);
  return { record: grouped, beats, projection: createJourneyProjection(grouped, beats, recordedMessageBeatId) };
}

describe("public guide links resolve through canonical indexes", () => {
  test("message links and exact advanced addresses preserve the inspected message", () => {
    const { record, projection } = journeyFixture();
    const messageId = record.messages.at(-1)!.id;
    const beatId = recordedMessageBeatId(messageId);
    expect(initialJourney(`#message=${encodeURIComponent(messageId)}`, projection)).toEqual({ phase: "active", selectedBeatId: beatId });
    expect(initialJourney(`#${encodeURIComponent(beatId)}`, projection)).toEqual({ phase: "active", selectedBeatId: beatId });
    for (const hash of ["", "#message=absent", "#absent", "#message=%E0%A4%A", "#%E0%A4%A"]) {
      expect(initialJourney(hash, projection)).toEqual({ phase: "ready" });
    }
  });
});

describe("the guided replay owns one exact canonical selection", () => {
  test("Start, Next, completion, Back and Restart preserve the declared boundaries", () => {
    const { projection } = journeyFixture();
    let state: JourneyState = { phase: "ready" };
    expect(journeyView(state, projection)).toMatchObject({ stepNumber: 0, stepCount: 2, canStart: true, canBack: false, canNext: false });
    expect(transitionJourney(state, { type: "next" }, projection)).toBe(state);
    expect(transitionJourney(state, { type: "back" }, projection)).toBe(state);
    state = transitionJourney(state, { type: "start" }, projection);
    expect(state).toEqual({ phase: "active", selectedBeatId: projection.focusBeatIds[0] });
    expect(transitionJourney(state, { type: "back" }, projection)).toEqual({ phase: "ready" });
    state = transitionJourney(state, { type: "next" }, projection);
    expect(journeyView(state, projection)).toMatchObject({ stageIndex: 1, stepNumber: 2, finishing: true });
    state = transitionJourney(state, { type: "next" }, projection);
    expect(state.phase).toBe("complete");
    expect(transitionJourney(state, { type: "next" }, projection)).toBe(state);
    const last = state;
    state = transitionJourney(state, { type: "back" }, projection);
    expect(state).toEqual({ phase: "active", selectedBeatId: last.phase === "complete" ? last.selectedBeatId : "unreachable" });
    expect(transitionJourney(state, { type: "restart" }, projection)).toEqual({ phase: "ready" });
  });

  test("inspection preserves the exact message within a grouped stage", () => {
    const { record, projection } = journeyFixture();
    const inspected = recordedMessageBeatId(record.messages.at(-1)!.id);
    const state = transitionJourney({ phase: "ready" }, { type: "select", beatId: inspected }, projection);
    expect(state).toEqual({ phase: "active", selectedBeatId: inspected });
    expect(journeyView(state, projection)).toMatchObject({ selectedBeatId: inspected, stageIndex: 1 });
    const complete = transitionJourney(state, { type: "next" }, projection);
    expect(complete).toEqual({ phase: "complete", selectedBeatId: inspected });
    expect(transitionJourney(complete, { type: "select", beatId: inspected }, projection)).toBe(complete);
    expect(transitionJourney(complete, { type: "back" }, projection)).toEqual(state);
  });

  test("generated facts use canonical parentage, regardless of their address spelling", () => {
    const { record, beats } = journeyFixture();
    const producing = beats.find((beat) => beat.kind === "tool")!;
    const effect: Beat = {
      id: "derived-address-with-no-format-assumption", kind: "effect", parentId: producing.id,
      turnIndex: producing.turnIndex, at: producing.at, abnormal: false, bleed: true, verbs: [],
      effect: { path: "public-example.txt", producedBy: producing.id },
    };
    const projection = createJourneyProjection(record, [...beats, effect], recordedMessageBeatId);
    const state = transitionJourney({ phase: "ready" }, { type: "select", beatId: effect.id }, projection);
    expect(journeyView(state, projection)).toMatchObject({ selectedBeatId: effect.id, stageIndex: 1 });
    expect(transitionJourney(state, { type: "next" }, projection)).toEqual({ phase: "complete", selectedBeatId: effect.id });
    expect(() => createJourneyProjection(record, [...beats, { ...effect, parentId: "absent-parent" }], recordedMessageBeatId)).toThrowError(RangeError);
    expect(() => createJourneyProjection(record, [...beats, { ...effect, parentId: "absent-parent" }], recordedMessageBeatId)).toThrowError(/no covered source message/u);
  });

  test("unknown selections and impossible completion refuse with specific types", () => {
    const { projection } = journeyFixture();
    expect(() => transitionJourney({ phase: "ready" }, { type: "select", beatId: "not-a-fact" }, projection)).toThrowError(RangeError);
    expect(() => transitionJourney({ phase: "ready" }, { type: "select", beatId: "not-a-fact" }, projection)).toThrowError(/outside this public guide/u);
    expect(() => journeyView({ phase: "active", selectedBeatId: "not-a-fact" }, projection)).toThrowError(RangeError);
    expect(() => journeyView({ phase: "active", selectedBeatId: "not-a-fact" }, projection)).toThrowError(/outside this public guide/u);
    expect(() => journeyView({ phase: "complete", selectedBeatId: projection.focusBeatIds[0]! }, projection)).toThrowError(RangeError);
    expect(() => journeyView({ phase: "complete", selectedBeatId: projection.focusBeatIds[0]! }, projection)).toThrowError(/must select its final stage/u);
    expect(() => transitionJourney({ phase: "unknown" } as unknown as JourneyState, { type: "restart" }, projection)).toThrowError(TypeError);
    expect(() => transitionJourney({ phase: "unknown" } as unknown as JourneyState, { type: "restart" }, projection)).toThrowError(/Unknown journey phase/u);
  });
});


describe("guide admission and lifecycle", () => {
  test("v1 is rejected explicitly and v2 requires bounded, total, exact guide references", () => {
    const record = fixture(), step = record.guide.steps[0]!;
    const invalid: readonly [PublicReplay, RegExp][] = [
      [{ ...record, schemaVersion: "bridlewise-public-fixture/v1" } as unknown as PublicReplay, /declared public fixture/u],
      [{ ...record, guide: undefined } as unknown as PublicReplay, /v2 public fixture needs/u],
      [{ ...record, guide: { ...record.guide, privateContext: "sentinel" } } as unknown as PublicReplay, /unknown guide metadata/u],
      [{ ...record, guide: { ...record.guide, steps: [{ ...step, focusMessageId: "absent" }, ...record.guide.steps.slice(1)] } }, /guide focus/u],
      [{ ...record, guide: { ...record.guide, steps: [{ ...step, messageIds: [...step.messageIds, step.messageIds[0]!] }, ...record.guide.steps.slice(1)] } }, /exactly once/u],
      [{ ...record, guide: { ...record.guide, steps: record.guide.steps.slice(1) } }, /cover every/u],
    ];
    for (const [value, message] of invalid) { expect(() => validatePublicReplay(value)).toThrowError(TypeError); expect(() => validatePublicReplay(value)).toThrowError(message); }
    expect(() => validatePublicReplay({ ...record, guide: { ...record.guide, steps: [] } })).toThrowError(RangeError);
    expect(() => validatePublicReplay({ ...record, guide: { ...record.guide, steps: [] } })).toThrowError(/step population/u);
  });

  test.each(["label", "actionLabel"] as const)("optional guide %s stays bounded text, with no private action metadata", (field) => {
    const record = fixture(), step = record.guide.steps[0]!;
    for (const value of ["", " ", null, [], 1, "x".repeat(PUBLIC_REPLAY_LIMITS.textCharacters + 1)]) {
      const invalid = { ...record, guide: { ...record.guide, steps: [{ ...step, [field]: value }, ...record.guide.steps.slice(1)] } } as unknown as PublicReplay;
      expect(() => validatePublicReplay(invalid)).toThrowError(TypeError);
      expect(() => validatePublicReplay(invalid)).toThrowError(/guide step (?:action )?label must be bounded text/u);
    }
    const privateAction = { ...record, guide: { ...record.guide, steps: [{ ...step, execute: "private-action" }, ...record.guide.steps.slice(1)] } } as unknown as PublicReplay;
    expect(() => validatePublicReplay(privateAction)).toThrowError(/unknown guide step metadata/u);
  });

  test("compact guide labels are distinct from full titles and remain the navigator's source", async () => {
    const record = fixture();
    expect(record.guide.steps.map((step) => step.label)).toEqual(["Goal", "Change", "Boundary", "Checks", "Review"]);
    const changed = validatePublicReplay({ ...record, guide: { ...record.guide, steps: [{ ...record.guide.steps[0]!, label: "Request" }, ...record.guide.steps.slice(1)] } });
    const view = render(Demo, { props: { record: changed } });
    const navigator = view.getByRole("navigation", { name: "Example journey" });
    await fireEvent.click(within(navigator).getByRole("button", { name: "1 Request" }));
    expect(view.getByRole("heading", { name: changed.guide.steps[0]!.title })).toBeTruthy();
    expect(location.hash).toBe("#" + recordedMessageBeatId(changed.guide.steps[0]!.focusMessageId));
  });

  test("Restart and completion navigate a stable log and retain the visible fixture boundary", async () => {
    const record = fixture();
    const view = render(Demo, { props: { record, embedded: true } });
    const original = windowSlice(0, beatCount());
    await fireEvent.click(view.getByRole("button", { name: "Start the example" }));
    for (let index = 1; index < record.guide.steps.length; index += 1) {
      const attempt = view.container.querySelector<HTMLDetailsElement>("details.recorded-action");
      if (attempt !== null && !attempt.open) await fireEvent.click(attempt.querySelector("summary")!);
      await fireEvent.click(view.getByRole("button", { name: /^Next:/u }));
    }
    await fireEvent.click(view.getByRole("button", { name: "Finish the example" }));
    expect(view.getByText("Example complete")).toBeTruthy();
    expect(view.getByRole("note").textContent).toContain(REPLAY_NOTICE);
    expect(view.container.textContent).toContain("Your own project needs a connected workspace");
    await fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(view.getByText("Step 5 of 5")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Restart" }));
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    expect(location.hash).toBe("");
    expect(windowSlice(0, beatCount()).every((beat, index) => beat === original[index])).toBe(true);
    expect(beatCount()).toBe(original.length);
  });

  test("explicit public tools and a dedicated replay log preserve an unrelated colliding manifest and effect", () => {
    const previous = displayedLogId();
    activateLog("unrelated-replay-control");
    const expectedEffect = replayBeats(fixture()).find((beat) => beat.kind === "effect")!;
    const colliding: Beat = { ...expectedEffect, effect: { path: "private-other.txt", producedBy: "private-other" } };
    appendBeat(colliding);
    const writer: WebToolEntry = { id: "private-reader", name: fixtureTools.find((tool) => tool.fileEffect)!.name, description: "private description", label: "PRIVATE LABEL", capabilities: ["read"], bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 }, inputSchema: {}, adapterId: "private", category: "built-in", kind: "filesystem" };
    const originalTools = [writer];
    setTools(originalTools);
    const view = render(Demo, { props: { record: fixture() } });
    expect(beatById(expectedEffect.id)?.effect?.path).toBe(CODING_EXAMPLE.path);
    expect(toolManifest.get()).toBe(originalTools);
    expect(view.container.textContent).not.toContain("PRIVATE LABEL");
    view.unmount();
    expect(displayedLogId()).toBe("unrelated-replay-control");
    expect(beatById(colliding.id)).toBe(colliding);
    expect(toolManifest.get()).toBe(originalTools);
    activateLog(previous); dropLog("unrelated-replay-control");
  });
});

describe("embedded presentation keeps the same journey and capability", () => {
  test("clearing a hash while the full Flow is absent cannot consume a stale reveal on opening", async () => {
    const view = render(Demo, { props: { record: fixture() } });
    await fireEvent.click(view.getByRole("button", { name: "Start the example" }));
    await fireEvent.click(view.getByRole("button", { name: "Next: Inspect the change" }));
    history.replaceState(null, "", "#unknown");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    await openAdvanced(view.container);
    await tick();
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    expect(consumeBeatRequest()).toBeNull();
  });

  test("an authenticated parent presentation message changes the existing theme without restarting", async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("data-demo-presentation", "declared-test-channel");
    document.body.append(frame);
    const parent = frame.contentWindow!;
    vi.spyOn(window, "parent", "get").mockReturnValue(parent);
    vi.spyOn(window, "frameElement", "get").mockReturnValue(frame);
    const post = vi.spyOn(parent, "postMessage");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return new DOMRect(0, 0, 640, this.classList.contains("public-replay") ? 520 : 40); });
    setLocalPref(THEME_ID, "carbon");
    const view = render(Demo, { props: { record: fixture(), embedded: true } });
    try {
      await tick();
      expect(post).toHaveBeenCalledWith({ channel: "declared-test-channel", height: 520 }, location.origin);
      await fireEvent.click(view.getByRole("button", { name: "Start the example" }));
      const selected = location.hash;
      const deliver = (data: unknown, origin = location.origin, source: Window = parent) => window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
      deliver({ channel: "declared-test-channel", theme: "logbook" }, "https://foreign.invalid");
      deliver({ channel: "other-channel", theme: "logbook" });
      deliver({ channel: "declared-test-channel", theme: "logbook", api: "planted" });
      deliver({ channel: "declared-test-channel", theme: "logbook" }, location.origin, window);
      expect(cockpitTheme.get()).toBe("carbon");
      deliver({ channel: "declared-test-channel", theme: "logbook" });
      await tick();
      expect(cockpitTheme.get()).toBe("logbook");
      const writes = vi.spyOn(Storage.prototype, "setItem");
      deliver({ channel: "declared-test-channel", theme: "logbook" });
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      expect(document.documentElement.getAttribute("data-cockpit-theme")).toBe("light");
      expect(location.hash).toBe(selected);
      expect(view.getByText("Step 1 of 5")).toBeTruthy();
      for (const link of view.container.querySelectorAll<HTMLAnchorElement>(".evidence a")) { expect(link.target).toBe("_blank"); expect(link.rel).toContain("noopener"); }
    } finally { view.unmount(); frame.remove(); }
  });

  test("offline floor evidence remains explicitly unobserved", async () => {
    const record = fixture();
    const view = render(Demo, { props: { record: { ...record, github: { availability: "unavailable", sourceCommit: source.commit, attemptedAt: source.builtAt, reason: "offline" } } } });
    await tick();
    expect(view.container.textContent).toContain("GitHub checks were not observed for this build (offline)");
    expect(view.container.querySelector(".check-list")).toBeNull();
    expect(view.container.querySelector(".evidence")?.textContent).not.toMatch(/Observed [0-9]/u);
  });
});

describe("public observation timestamps are typed before parsing", () => {
  test("numeric and array observation times cannot be coerced into valid evidence", () => {
    const record = fixture();
    for (const value of [1234, ["2026-01-01"]]) {
      const unavailable = { ...record, github: { availability: "unavailable", sourceCommit: source.commit, attemptedAt: value, reason: "offline" } } as unknown as PublicReplay;
      expect(() => validatePublicReplay(unavailable)).toThrowError(TypeError);
      expect(() => validatePublicReplay(unavailable)).toThrowError(/attempt time and reason/u);
      const observed = { ...record, github: { availability: "observed", sourceCommit: source.commit, observedAt: value, checks: [] } } as unknown as PublicReplay;
      expect(() => validatePublicReplay(observed)).toThrowError(TypeError);
      expect(() => validatePublicReplay(observed)).toThrowError(/no observation time/u);
    }
  });
});

test("restored full-record focus does not start or restart the guide", async () => {
  const previous = flowViewForActive() ?? FLOW_VIEW_DEFAULT;
  const readId = beatIdFor({ id: "example-edit" });
  noteFlowView({ scrollTop: 0, focusedId: readId, expanded: {}, follow: false });
  const view = render(Demo, { props: { record: fixture() } });
  try {
    await openAdvanced(view.container);
    await tick();
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    expect(location.hash).toBe("");
    const row = view.container.querySelector<HTMLElement>('[data-beat-id="b-example-edit"]')!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    await fireEvent.click(row);
    await waitFor(() => expect(location.hash).toBe("#b-example-edit"));
    expect(view.getByText("Step 2 of 5")).toBeTruthy();
    await fireEvent.click(view.getByRole("button", { name: "Restart" }));
    const details = view.container.querySelector<HTMLDetailsElement>("details.advanced")!;
    details.open = false; await fireEvent(details, new Event("toggle")); await tick();
    noteFlowView({ scrollTop: 0, focusedId: readId, expanded: {}, follow: false });
    await openAdvanced(view.container); await tick();
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    expect(location.hash).toBe("");
  } finally { view.unmount(); noteFlowView(previous); }
});

test("workspace restoration cancels an input notification that has not flushed", async () => {
  const originalId = activeWorkspaceId.get()!;
  const previous = flowViewForActive() ?? FLOW_VIEW_DEFAULT;
  const other = openWorkspace();
  noteFlowView({ scrollTop: 0, focusedId: beatIdFor({ id: "example-plan" }), expanded: {}, follow: false });
  activateWorkspace(originalId);
  noteFlowView(FLOW_VIEW_DEFAULT);
  const view = render(Demo, { props: { record: fixture() } });
  try {
    await openAdvanced(view.container);
    const row = view.container.querySelector<HTMLElement>('[data-beat-id="b-example-edit"]')!;
    // One browser task: select, then restore a different workspace before effects flush.
    row.click();
    activateWorkspace(other.id);
    await tick();
    expect(view.getByRole("button", { name: "Start the example" })).toBeTruthy();
    expect(location.hash).toBe("");
    expect(view.container.querySelector('[data-beat-id="b-example-plan"]')?.getAttribute("aria-selected")).toBe("true");
  } finally { view.unmount(); activateWorkspace(originalId); closeWorkspace(other.id); noteFlowView(previous); }
});


describe("recorded coding fact admission", () => {
  test("private descriptors, unknown calls and detached patches cannot enter the fixture", () => {
    const record = fixture(), effect = record.effects[0]!;
    const invalid: readonly [PublicReplay, RegExp][] = [
      [{ ...record, tools: [{ ...record.tools[0]!, adapterId: "/private/adapter" }, ...record.tools.slice(1)] } as unknown as PublicReplay, /unknown tool presentation/u],
      [{ ...record, tools: [...record.tools, record.tools[0]!] }, /unique/u],
      [{ ...record, tools: record.tools.slice(1) }, /admitted presentation/u],
      [{ ...record, effects: [effect, effect] }, /unique message/u],
      [{ ...record, effects: [{ ...effect, messageId: "example-refused" }] }, /successful file-writing/u],
      [{ ...record, effects: [{ ...effect, patch: SAMPLE_PATCH.replaceAll("first.mjs", "other.mjs") }] }, /exactly its producing/u],
      [{ ...record, effects: [] }, /own patch fact/u],
      [{ ...record, effects: [{ ...effect, privatePath: "/private" }] } as unknown as PublicReplay, /unknown recorded effect/u],
    ];
    for (const [value, message] of invalid) expect(() => validatePublicReplay(value)).toThrowError(message);
    expect(parseUnifiedDiff(effect.patch).files[0]?.path).toBe(CODING_EXAMPLE.path);
  });

  test("effect focus is resolved from actual canonical parentage with no address spelling assumption", () => {
    const record = fixture(), beats = replayBeats(record);
    const effect = beats.find((beat) => beat.kind === "effect")!;
    const renamed = { ...effect, id: "effect-with-no-derived-spelling" };
    const projected = beats.map((beat) => beat === effect ? renamed : beat);
    const projection = createJourneyProjection(record, projected, recordedMessageBeatId);
    expect(projection.focusBeatIds[1]).toBe(renamed.id);
    expect(() => createJourneyProjection(record, beats.filter((beat) => beat !== effect), recordedMessageBeatId)).toThrowError(/one actual projected fact/u);
    expect(() => createJourneyProjection(record, [...beats, renamed], recordedMessageBeatId)).toThrowError(/one actual projected fact/u);
  });
});
