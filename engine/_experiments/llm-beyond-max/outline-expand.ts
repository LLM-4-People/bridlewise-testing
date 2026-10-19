/**
 * EXP410 — outline + expand.
 *
 * First ask the LLM for an OUTLINE (short, ≤1500 tokens). Then ask it to
 * expand each section of the outline (one LLM call per section, up to
 * maxTokensPerSection). The full output is the concatenation.
 *
 * Coherence: each section expansion carries the section heading + a brief
 * reminder of the document's goal. The outline guarantees the structure is
 * fixed before any expansion begins — the model can't drift mid-document.
 *
 * Reliability: each expansion is an independent call; if one fails, it can
 * be retried without re-running the others. The reduce (concatenation) is
 * deterministic.
 */

import type { BeyondMaxConfig } from "./config.ts";
import type { ChatMessage, ChatResult, LlmClient } from "./client.ts";

export type OutlineExpandEvent =
  | Readonly<{ type: "outline"; outline: string; sections: number }>
  | Readonly<{ type: "section_start"; index: number; heading: string }>
  | Readonly<{ type: "section_done"; index: number; tokens: number; elapsedMs: number; finish: string }>
  | Readonly<{ type: "done"; sections: number; totalTokens: number; totalMs: number }>;

export type OutlineExpandOutcome = Readonly<{
  content: string;
  outline: string;
  sections: readonly string[];
  sectionContents: readonly string[];
  totalTokens: number;
  elapsedMs: number;
}>;

export type OutlineExpandOptions = Readonly<{
  system?: string;
  /** Document topic / task description. */
  topic: string;
  /** Max sections (overrides config). */
  maxSections?: number;
  signal?: AbortSignal;
  onEvent?: (e: OutlineExpandEvent) => void;
}>;

export async function generateOutlineExpand(
  client: LlmClient,
  config: BeyondMaxConfig,
  opts: OutlineExpandOptions,
): Promise<OutlineExpandOutcome> {
  const t0 = Date.now();
  const maxSections = opts.maxSections ?? config.outlineExpand.maxSections;
  const perSection = config.outlineExpand.maxTokensPerSection;
  // The outline step uses a fixed, outline-friendly system prompt (the
  // user-provided system may say "Emit ONLY TypeScript" which would break
  // outline parsing — the model would emit code, not markdown headings).
  const OUTLINE_SYS = "You are a precise outline generator. Output ONLY markdown section headings in the form '## <short title>'. No body text, no code, no explanation, no numbering. Each heading on its own line.";
  // Step 1: outline.
  const outlineMessages: ChatMessage[] = [{ role: "system", content: OUTLINE_SYS }];
  outlineMessages.push({
    role: "user",
    content: `Create a precise outline for the following document. The outline must have between 4 and ${maxSections} sections. Each section heading is a single line in the form "## <short title>". Output ONLY the outline headings, nothing else (no body text, no description).\n\nDocument topic: ${opts.topic}`,
  });
  const outlineResult: ChatResult = await client.complete(outlineMessages, Math.min(config.api.maxOutputTokens, 1500), opts.signal);
  const outline = outlineResult.content;
  const sections = outline.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^#{1,4}\s/.test(l))
    .slice(0, maxSections);
  if (sections.length === 0) {
    throw new Error(`Outline generation produced no section headings: ${outline.slice(0, 200)}`);
  }
  opts.onEvent?.({ type: "outline", outline, sections: sections.length });
  // Step 2: expand each section.
  const sectionContents: string[] = [];
  let totalTokens = outlineResult.completionTokens;
  for (let i = 0; i < sections.length; i++) {
    if (opts.signal?.aborted) break;
    const heading = (sections[i] ?? "").replace(/^#{1,4}\s/, "");
    opts.onEvent?.({ type: "section_start", index: i, heading });
    const expandMessages: ChatMessage[] = [];
    if (opts.system) expandMessages.push({ role: "system", content: opts.system });
    expandMessages.push({
      role: "user",
      content: `You are writing ONE section of a long document about: "${opts.topic}". The section heading is "${heading}". Write the body of this section only. Do NOT repeat the heading. Do NOT write any other section. Be detailed and exhaustive. Aim for at least ${Math.max(200, perSection - 100)} tokens.`,
    });
    const r: ChatResult = await client.complete(expandMessages, perSection, opts.signal);
    totalTokens += r.completionTokens;
    sectionContents.push(r.content);
    opts.onEvent?.({ type: "section_done", index: i, tokens: r.completionTokens, elapsedMs: r.elapsedMs, finish: r.finishReason });
  }
  // Step 3: assemble (deterministic reduce).
  const content = sections.map((h, i) => `${h}\n\n${sectionContents[i] ?? ""}`).join("\n\n");
  const totalMs = Date.now() - t0;
  opts.onEvent?.({ type: "done", sections: sections.length, totalTokens, totalMs });
  return Object.freeze({
    content,
    outline,
    sections: Object.freeze(sections),
    sectionContents: Object.freeze(sectionContents),
    totalTokens,
    elapsedMs: totalMs,
  });
}
