/**
 * Published fixture transcripts use the product's message and beat contracts.
 * This is not an importer for private sessions: only the deliberately authored
 * fixture is published. Provider headers, context, credentials and database
 * addresses are outside this public projection.
 */
import type { ChatMessage, ToolCallView } from "../state/chat-messages.ts";
import type { ToolPresentation } from "../../shared/tool-presentation.ts";
import { toolPresentationByName } from "../../shared/tool-presentation.ts";
import { isToolOutputShape } from "../../engine/src/tools/tool-output-shape.ts";
import { effectPathOf, type BeatKind } from "../cockpit/flow/types.ts";
import { parseUnifiedDiff } from "../cockpit/render/diff.ts";

export const PUBLIC_REPLAY_SCHEMA = "bridlewise-public-fixture/v2";
export const REPLAY_NOTICE = "Interactive example. No model or tool is running.";
export const REPLAY_NETWORK_REASON = "This published fixture has no live API or execution capability.";

export type ReplayMessage = Pick<ChatMessage, "id" | "role" | "content" | "timestamp" | "toolCall" | "eventKind">;
export type ReplayCheck = Readonly<{ title: string; status: string; url: string | null }>;
export type ReplaySource = Readonly<{
  repository: string;
  repositoryUrl: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
}>;
export type ReplayGuide = Readonly<{
  purpose: string;
  outcome: string;
  steps: readonly Readonly<{
    title: string;
    /** Compact navigation text; the full title still explains the step. */
    label?: string;
    /** Native disclosure of an already recorded result; never an execution capability. */
    actionLabel?: string;
    explanation: string;
    messageIds: readonly string[];
    focusMessageId: string;
    focusKind?: Extract<BeatKind, "effect">;
  }>[];
}>;
export type ReplayGithub = Readonly<{ sourceCommit: string }> & (
  | Readonly<{ availability: "observed"; observedAt: string; checks: readonly ReplayCheck[] }>
  | Readonly<{ availability: "unavailable"; attemptedAt: string; reason: string }>
);
export type PublicReplay = Readonly<{
  schemaVersion: typeof PUBLIC_REPLAY_SCHEMA;
  provenance: "fixture";
  title: string;
  messages: readonly ReplayMessage[];
  tools: readonly ToolPresentation[];
  effects: readonly Readonly<{ messageId: string; patch: string }>[];
  guide: ReplayGuide;
  source: ReplaySource;
  github: ReplayGithub | null;
}>;

export type PublicReplayLimits = Readonly<{ messages: number; textCharacters: number; bytes: number }>;
export const PUBLIC_REPLAY_LIMITS: PublicReplayLimits = Object.freeze({ messages: 256, textCharacters: 262_144, bytes: 1_048_576 });
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(["id", "role", "content", "timestamp", "toolCall", "eventKind"] satisfies readonly (keyof ReplayMessage)[]);
const TOOL_FIELDS: ReadonlySet<string> = new Set(["id", "name", "input", "output", "status", "startedAt", "endedAt", "durationMs", "incompleteReason", "refused", "attemptCount"] satisfies readonly (keyof ToolCallView)[]);

export function isReplayMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: object, fields: readonly string[], description: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError(`Private or unknown ${description} cannot be published`);
}

/** Refuse accidentally adding private transcript metadata to the public projection. */
export function validatePublicReplay(record: PublicReplay, limits: PublicReplayLimits = PUBLIC_REPLAY_LIMITS): PublicReplay {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new RangeError("Public fixture bounds must be positive safe integers");
  if (!isReplayMapping(record) || !isReplayMapping(record.source) || !Array.isArray(record.messages)) throw new TypeError("A public fixture needs source metadata and a message array");
  exactFields(record, ["schemaVersion", "provenance", "title", "messages", "tools", "effects", "guide", "source", "github"], "fixture metadata");
  exactFields(record.source, ["repository", "repositoryUrl", "commit", "dirty", "builtAt"], "source metadata");
  if (typeof record.title !== "string" || record.title.length === 0 || typeof record.source.repository !== "string" || typeof record.source.repositoryUrl !== "string" || typeof record.source.builtAt !== "string" || typeof record.source.dirty !== "boolean") throw new TypeError("The fixture title and source metadata are malformed");
  if (record.schemaVersion !== PUBLIC_REPLAY_SCHEMA || record.provenance !== "fixture") {
    throw new TypeError("Only a declared public fixture transcript is supported");
  }
  if (!/^[0-9a-f]{40}$/u.test(record.source.commit) || !Number.isFinite(Date.parse(record.source.builtAt))) {
    throw new TypeError("The replay needs its actual source revision and build time");
  }
  const repository = new URL(record.source.repositoryUrl);
  if (repository.protocol !== "https:" || repository.username !== "" || repository.password !== "" || repository.search !== "" || repository.hash !== "") {
    throw new TypeError("The repository address is not a public HTTPS coordinate");
  }
  if (record.messages.length === 0 || record.messages.length > limits.messages) throw new RangeError("The fixture message population is outside its bound");
  if (!Array.isArray(record.tools) || record.tools.length === 0 || record.tools.length > limits.messages) throw new RangeError("The public tool presentation population is outside its message bound");
  for (const tool of record.tools) {
    if (!isReplayMapping(tool)) throw new TypeError("A public tool presentation must be a mapping");
    exactFields(tool, ["name", "label", "outputShape", "fileEffect"], "tool presentation");
    if (typeof tool.name !== "string" || tool.name.trim().length === 0 || tool.name.length > limits.textCharacters || typeof tool.fileEffect !== "boolean") throw new TypeError("A public tool presentation needs a bounded name and file-effect classification");
    if (tool.label !== undefined && (typeof tool.label !== "string" || tool.label.trim().length === 0 || tool.label.length > limits.textCharacters)) throw new TypeError("A public tool label must be bounded text");
    if (tool.outputShape !== undefined && !isToolOutputShape(tool.outputShape)) throw new TypeError("A public tool output shape must use the canonical vocabulary");
  }
  const tools = toolPresentationByName(record.tools);
  const usedTools = new Set<string>();
  const ids = new Set<string>();
  let previous = -Infinity;
  for (const message of record.messages) {
    if (!isReplayMapping(message) || Object.keys(message).some((key) => !MESSAGE_FIELDS.has(key))) throw new TypeError("Private or unknown message metadata cannot be published");
    if (typeof message.id !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(message.id) || ids.has(message.id)) throw new TypeError("Fixture message IDs must be unique safe addresses");
    ids.add(message.id);
    if (typeof message.content !== "string" || message.content.length > limits.textCharacters) throw new RangeError("Fixture message text exceeds its bound");
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp < previous) throw new TypeError("Fixture timestamps must preserve transcript order");
    previous = message.timestamp;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool" && message.role !== "event" && message.role !== "error") throw new TypeError("Unknown transcript role");
    const tool = message.toolCall;
    if (message.role === "tool" && tool === undefined) throw new TypeError("A tool row needs its recorded tool call");
    if (tool !== undefined) {
      if (!isReplayMapping(tool) || Object.keys(tool).some((key) => !TOOL_FIELDS.has(key))) throw new TypeError("Unknown tool metadata cannot be published");
      if (message.role !== "tool" || typeof tool.name !== "string" || tool.name.length === 0 || !Number.isFinite(tool.startedAt)) throw new TypeError("A recorded tool call needs its tool row, name and timestamp");
      if (tool.status !== "done" && tool.status !== "error") throw new TypeError("A published fixture needs a terminal recorded tool status");
      if (!tools.has(tool.name)) throw new TypeError("Every public tool call needs its own admitted presentation");
      usedTools.add(tool.name);
    }
  }
  if (usedTools.size !== tools.size) throw new TypeError("Public tool presentation must contain exactly the tools the fixture uses");
  if (!Array.isArray(record.effects) || record.effects.length > limits.messages) throw new RangeError("The public effect population is outside its message bound");
  const messagesById = new Map(record.messages.map((message) => [message.id, message]));
  const recordedEffects = new Set<string>();
  for (const effect of record.effects) {
    if (!isReplayMapping(effect)) throw new TypeError("A recorded effect must be a mapping");
    exactFields(effect, ["messageId", "patch"], "recorded effect");
    if (typeof effect.messageId !== "string" || recordedEffects.has(effect.messageId)) throw new TypeError("Recorded effect references must be unique message addresses");
    const message = messagesById.get(effect.messageId);
    const tool = message?.toolCall;
    if (message?.role !== "tool" || tool === undefined || tool.status !== "done" || tool.refused === true || tools.get(tool.name)?.fileEffect !== true) throw new TypeError("A recorded effect must name a successful file-writing tool message");
    if (typeof effect.patch !== "string" || effect.patch.length === 0 || effect.patch.length > limits.textCharacters) throw new RangeError("A recorded patch needs bounded content");
    const path = effectPathOf(tool.input);
    if (path === null || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..") || /[\u0000-\u001f\u007f:]/u.test(path)) throw new TypeError("A public effect needs a project-relative public file path");
    const parsed = parseUnifiedDiff(effect.patch);
    if (parsed.empty || parsed.files.length !== 1 || parsed.files[0]?.path !== path) throw new TypeError("A recorded patch must describe exactly its producing tool's file");
    recordedEffects.add(effect.messageId);
  }
  for (const message of record.messages) {
    const tool = message.toolCall;
    if (tool?.status === "done" && tool.refused !== true && tools.get(tool.name)?.fileEffect === true && effectPathOf(tool.input) !== null && !recordedEffects.has(message.id)) throw new TypeError("Every successful recorded file edit needs its own patch fact");
  }
  const guide = record.guide;
  if (!isReplayMapping(guide) || !Array.isArray(guide.steps)) throw new TypeError("A v2 public fixture needs its authored guide");
  exactFields(guide, ["purpose", "outcome", "steps"], "guide metadata");
  const guideText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= limits.textCharacters;
  if (!guideText(guide.purpose) || !guideText(guide.outcome)) throw new TypeError("The public guide needs bounded purpose and outcome text");
  if (guide.steps.length === 0 || guide.steps.length > record.messages.length) throw new RangeError("The public guide step population is outside its message bound");
  const covered = new Set<string>();
  for (const step of guide.steps) {
    if (!isReplayMapping(step) || !Array.isArray(step.messageIds)) throw new TypeError("A guide step needs its message references");
    exactFields(step, ["title", "label", "actionLabel", "explanation", "messageIds", "focusMessageId", "focusKind"], "guide step metadata");
    if (!guideText(step.title) || !guideText(step.explanation)) throw new TypeError("A guide step needs bounded title and explanation text");
    if (step.label !== undefined && !guideText(step.label)) throw new TypeError("A guide step label must be bounded text");
    if (step.actionLabel !== undefined && !guideText(step.actionLabel)) throw new TypeError("A guide step action label must be bounded text");
    if (step.focusKind !== undefined && step.focusKind !== "effect") throw new TypeError("A public guide derived focus must name an effect");
    if (typeof step.focusMessageId !== "string" || step.messageIds.length === 0 || !step.messageIds.includes(step.focusMessageId)) throw new TypeError("A guide focus must belong to its nonempty step");
    if (step.focusKind === "effect" && !recordedEffects.has(step.focusMessageId)) throw new TypeError("A guide effect focus needs its producing message patch");
    for (const id of step.messageIds) {
      if (typeof id !== "string" || !ids.has(id) || covered.has(id)) throw new TypeError("Guide references must name each public message exactly once");
      covered.add(id);
    }
  }
  if (covered.size !== ids.size) throw new TypeError("The public guide must cover every published message");
  if (record.github !== null) {
    if (!isReplayMapping(record.github)) throw new TypeError("The GitHub observation is malformed");
    if (record.github.sourceCommit !== record.source.commit) throw new TypeError("GitHub evidence belongs to another source revision");
    if (record.github.availability === "unavailable") {
      exactFields(record.github, ["sourceCommit", "availability", "attemptedAt", "reason"], "unavailable GitHub metadata");
      if (typeof record.github.attemptedAt !== "string" || !Number.isFinite(Date.parse(record.github.attemptedAt)) || !guideText(record.github.reason)) throw new TypeError("Unavailable GitHub evidence needs its attempt time and reason");
    } else if (record.github.availability === "observed") {
      exactFields(record.github, ["sourceCommit", "availability", "observedAt", "checks"], "GitHub metadata");
      if (typeof record.github.observedAt !== "string" || !Number.isFinite(Date.parse(record.github.observedAt)) || !Array.isArray(record.github.checks)) throw new TypeError("GitHub evidence has no observation time or check array");
    for (const check of record.github.checks) {
      if (!isReplayMapping(check) || typeof check.title !== "string" || typeof check.status !== "string" || (check.url !== null && typeof check.url !== "string")) throw new TypeError("A GitHub check observation is malformed");
      exactFields(check, ["title", "status", "url"], "check metadata");
      if (check.url === null) continue;
      const url = new URL(check.url);
      if (url.origin !== repository.origin || !url.pathname.startsWith(`${repository.pathname.replace(/\/$/u, "")}/`) || url.username !== "" || url.password !== "") {
        throw new TypeError("A check links outside its declared repository");
      }
    }
    } else throw new TypeError("The GitHub observation availability is unknown");
  }
  if (new TextEncoder().encode(JSON.stringify(record)).length > limits.bytes) throw new RangeError("The public fixture exceeds its byte bound");
  return record;
}
