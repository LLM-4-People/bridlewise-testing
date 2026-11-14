/** Import-safe output vocabulary shared by manifest producers and renderers. */
export const TOOL_OUTPUT_SHAPES = ["file", "command", "search"] as const;
export type ToolOutputShape = typeof TOOL_OUTPUT_SHAPES[number];

export function isToolOutputShape(value: unknown): value is ToolOutputShape {
  return typeof value === "string" && (TOOL_OUTPUT_SHAPES as readonly string[]).includes(value);
}
