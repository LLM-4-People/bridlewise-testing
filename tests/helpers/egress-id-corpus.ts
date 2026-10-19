/**
 * The settings ids whose own egress is at risk — the shared oracle for the
 * wire-level redaction arms.
 *
 * The egress walk masks a string leaf the value-intrinsic layer reads as a
 * credential; a settings id is a `module.name` token the registry minted,
 * and one was measured being masked on both served wires (its Save then
 * posted `[REDACTED:credential]` back and 404'd against the server's own
 * registry). The arms that guard this need ONE question answered the same
 * way everywhere: of the ids a schema wire actually served, which ones
 * would the RAW detector corrupt — found per id against the detector's own
 * unguarded judgement, never listed by hand. A registration whose
 * camelCase name trips the heuristic tomorrow joins the returned corpus
 * the day it lands, with no edit at the call sites.
 */
import { redactContent } from "../../server/llm/redaction.ts";
import { getCustomization } from "../../server/kernel/canonical.ts";

/**
 * The registry-backed settings ids served on a `/api/schema/ui` body whose
 * raw detector output differs from the input — the rows the authorship
 * exemption exists for. Callers pass the PARSED body of the wire they are
 * guarding, so the corpus is anchored to what the browser actually
 * received, not to the in-process registry.
 */
export function servedSettingsIdsTheRawDetectorWouldCorrupt(
  schemaBody: unknown,
): readonly string[] {
  const settings = (schemaBody as { settings?: { id: string }[] }).settings ?? [];
  return settings
    .map((s) => s.id)
    .filter((id) => getCustomization(id) !== undefined)
    .filter((id) => redactContent(id) !== id);
}
