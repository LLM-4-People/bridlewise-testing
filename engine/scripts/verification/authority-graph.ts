/**
 * Public authority-graph façade. Internal modules are deliberately not public
 * API: callers receive one stable compiler entry point and the canonical
 * contracts/constructors only.
 */
export { analyzeAuthorityGraph } from "./authority/lock-compiler.ts";
export * from "./authority/contracts.ts";
