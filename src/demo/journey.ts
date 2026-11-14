/** Pure navigation over the published guide and canonical projected record addresses. */
import type { Beat } from "../cockpit/flow/types.ts";
import type { PublicReplay } from "./replay.ts";

type GuideStep = PublicReplay["guide"]["steps"][number];
export type JourneyProjection = Readonly<{
  steps: readonly GuideStep[];
  focusBeatIds: readonly string[];
  stageByBeatId: ReadonlyMap<string, number>;
  messageToBeat: ReadonlyMap<string, string>;
}>;
export type JourneyState =
  | Readonly<{ phase: "ready" }>
  | Readonly<{ phase: "active"; selectedBeatId: string }>
  | Readonly<{ phase: "complete"; selectedBeatId: string }>;
export type JourneyAction =
  | Readonly<{ type: "start" | "next" | "back" | "restart" }>
  | Readonly<{ type: "select"; beatId: string }>;
export type JourneyView = Readonly<{
  selectedBeatId: string | null;
  step: GuideStep | null;
  stageIndex: number | null;
  stepNumber: number;
  stepCount: number;
  canStart: boolean;
  canBack: boolean;
  canNext: boolean;
  finishing: boolean;
  nextTitle: string | null;
}>;

/**
 * Compile once after the PublicReplay validator and canonical projection.
 * addressOf is the canonical ingest export supplied by the host. This pure
 * module does not import ingestion's store graph or repeat its ID formatting.
 */
export function createJourneyProjection(
  record: PublicReplay,
  beats: readonly Beat[],
  addressOf: (messageId: string) => string,
): JourneyProjection {
  if (record.guide.steps.length === 0) throw new RangeError("An empty guide has no journey");
  const byId = new Map<string, Beat>();
  for (const beat of beats) {
    if (byId.has(beat.id)) throw new RangeError("Projected facts must have unique addresses");
    byId.set(beat.id, beat);
  }
  const messageStage = new Map<string, number>();
  for (const [index, step] of record.guide.steps.entries()) {
    for (const messageId of step.messageIds) messageStage.set(messageId, index);
  }
  const directStage = new Map<string, number>();
  const messageToBeat = new Map<string, string>();
  for (const message of record.messages) {
    const beatId = addressOf(message.id);
    const stage = messageStage.get(message.id);
    if (!byId.has(beatId) || stage === undefined) {
      throw new RangeError("The admitted guide and projected messages do not match");
    }
    directStage.set(beatId, stage);
    messageToBeat.set(message.id, beatId);
  }
  const stageByBeatId = new Map<string, number>();
  for (const beat of beats) {
    const visited = new Set<string>();
    let cursor: Beat | undefined = beat;
    let stage: number | undefined;
    while (cursor !== undefined) {
      if (visited.has(cursor.id)) throw new RangeError("A projected fact has cyclic parentage");
      visited.add(cursor.id);
      stage = directStage.get(cursor.id);
      if (stage !== undefined) break;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (stage === undefined) throw new RangeError("A projected fact has no covered source message");
    stageByBeatId.set(beat.id, stage);
  }
  return Object.freeze({
    steps: record.guide.steps,
    focusBeatIds: Object.freeze(record.guide.steps.map((step) => {
      const messageBeatId = addressOf(step.focusMessageId);
      if (step.focusKind === undefined) return messageBeatId;
      const matches = beats.filter((beat) => beat.parentId === messageBeatId && beat.kind === step.focusKind);
      if (matches.length !== 1) throw new RangeError("A guide derived focus must resolve to one actual projected fact");
      return matches[0]!.id;
    })),
    stageByBeatId,
    messageToBeat,
  });
}

/** Public message links and existing exact beat links resolve through admitted indexes. */
export function initialJourney(hash: string, projection: JourneyProjection): JourneyState {
  const fragment = hash.replace(/^#/u, "");
  if (fragment.length === 0) return { phase: "ready" };
  let selectedBeatId: string | undefined;
  try {
    selectedBeatId = fragment.startsWith("message=")
      ? projection.messageToBeat.get(decodeURIComponent(fragment.slice("message=".length)))
      : decodeURIComponent(fragment);
  } catch {
    return { phase: "ready" };
  }
  return selectedBeatId !== undefined && projection.stageByBeatId.has(selectedBeatId)
    ? { phase: "active", selectedBeatId }
    : { phase: "ready" };
}

function stageOf(state: JourneyState, projection: JourneyProjection): number | null {
  if (state.phase === "ready") return null;
  if (state.phase !== "active" && state.phase !== "complete") throw new TypeError("Unknown journey phase");
  const index = projection.stageByBeatId.get(state.selectedBeatId);
  if (index === undefined) throw new RangeError("The selected fact is outside this public guide");
  if (state.phase === "complete" && index !== projection.steps.length - 1) {
    throw new RangeError("A complete journey must select its final stage");
  }
  return index;
}
function focusAt(index: number, projection: JourneyProjection): JourneyState {
  const selectedBeatId = projection.focusBeatIds[index];
  if (selectedBeatId === undefined) throw new RangeError("The journey has no focus at this stage");
  return { phase: "active", selectedBeatId };
}

export function transitionJourney(
  state: JourneyState,
  action: JourneyAction,
  projection: JourneyProjection,
): JourneyState {
  const index = stageOf(state, projection);
  switch (action.type) {
    case "restart": return state.phase === "ready" ? state : { phase: "ready" };
    case "start": return focusAt(0, projection);
    case "select": {
      if (!projection.stageByBeatId.has(action.beatId)) throw new RangeError("The selected fact is outside this public guide");
      // A notification of the already selected fact preserves completion.
      if (state.phase !== "ready" && state.selectedBeatId === action.beatId) return state;
      return { phase: "active", selectedBeatId: action.beatId };
    }
    case "next":
      if (state.phase !== "active" || index === null) return state;
      return index + 1 < projection.steps.length
        ? focusAt(index + 1, projection)
        : { phase: "complete", selectedBeatId: state.selectedBeatId };
    case "back":
      if (state.phase === "ready" || index === null) return state;
      if (state.phase === "complete") return { phase: "active", selectedBeatId: state.selectedBeatId };
      return index === 0 ? { phase: "ready" } : focusAt(index - 1, projection);
    default: throw new TypeError("Unknown journey action");
  }
}

export function journeyView(state: JourneyState, projection: JourneyProjection): JourneyView {
  const index = stageOf(state, projection);
  return {
    selectedBeatId: state.phase === "ready" ? null : state.selectedBeatId,
    step: index === null ? null : projection.steps[index]!,
    stageIndex: index,
    stepNumber: index === null ? 0 : index + 1,
    stepCount: projection.steps.length,
    canStart: state.phase === "ready",
    canBack: state.phase !== "ready",
    canNext: state.phase === "active",
    finishing: state.phase === "active" && index === projection.steps.length - 1,
    nextTitle: index === null ? null : (projection.steps[index + 1]?.title ?? null),
  };
}
