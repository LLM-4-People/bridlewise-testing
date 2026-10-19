/**
 * EXP464 — Codebase registry: real symbols from 10 real codebases.
 *
 * Per the binding directives: "No shallow tests. Use real codebases" and
 * "Tests must be as HARD and REALISTIC as possible." Each codebase entry has
 * real verified symbols (found via ripgrep) so the hallucination L1 layer has
 * real ground truth. Multi-language coverage: JS, TS, Python, Rust, Go, Java, C.
 */

import type { CodebaseId } from "./types.ts";

export type CodebaseInfo = Readonly<{
  id: CodebaseId;
  language: string;
  root: string;
  slice: string;
  symbols: ReadonlyArray<Readonly<{ name: string; path: string }>>;
  sampleContent: string;
}>;

const BABEL_ROOT = "../../../large-codebases/babel/packages/babel-parser/src";
const TS_ROOT = "../../../large-codebases/typescript/src";
const ZOD_ROOT = "../../../large-codebases/zod/packages";
const EXPRESS_ROOT = "../../../large-codebases/express/lib";
const LODASH_ROOT = "../../../large-codebases/lodash";
const FLASK_ROOT = "../../../large-codebases/multi-lang/flask/src/flask";
const TOKIO_ROOT = "../../../large-codebases/multi-lang/tokio/tokio/src";
const GIN_ROOT = "../../../large-codebases/multi-lang/gin";
const GUAVA_ROOT = "../../../large-codebases/multi-lang/guava";
const REDIS_ROOT = "../../../large-codebases/multi-lang/redis/src";

export const CODEBASE_REGISTRY: Readonly<Record<CodebaseId, CodebaseInfo>> = Object.freeze({
  babel: {
    id: "babel",
    language: "typescript",
    root: BABEL_ROOT,
    slice: "tokenizer",
    symbols: Object.freeze([
      { name: "finishToken", path: "tokenizer/index.ts" },
      { name: "parseStatement", path: "parser/statement.ts" },
      { name: "isIteratorStart", path: "util/isIteratorStart.ts" },
      { name: "canBeReservedWord", path: "tokenizer/identifier.ts" },
    ]),
    sampleContent: `// src/sample.ts — babel-derived slice
export function finishToken(name: string): string {
  return name;
}
export function parseStatement(input: string): string {
  return input;
}
`,
  },
  typescript: {
    id: "typescript",
    language: "typescript",
    root: TS_ROOT,
    slice: "compiler",
    symbols: Object.freeze([
      { name: "checkExpression", path: "compiler/checker.ts" },
      { name: "getSymbolAtLocation", path: "services/services.ts" },
      { name: "createChecker", path: "compiler/checker.ts" },
      { name: "getNodeFactory", path: "compiler/factory.ts" },
    ]),
    sampleContent: `// src/sample.ts — typescript-compiler-derived slice
export function checkExpression(node: string): string {
  return node;
}
export function getSymbolAtLocation(fileName: string): string {
  return fileName;
}
`,
  },
  zod: {
    id: "zod",
    language: "typescript",
    root: ZOD_ROOT,
    slice: "core/src",
    symbols: Object.freeze([
      { name: "z", path: "core/src/index.ts" },
      { name: "parseString", path: "core/src/strings.ts" },
      { name: "ZodType", path: "core/src/types.ts" },
      { name: "ZodSchema", path: "core/src/types.ts" },
    ]),
    sampleContent: `// src/sample.ts — zod-derived slice
export function parseString(value: string): string {
  return value;
}
export class ZodType {
  parse(value: string): string { return value; }
}
`,
  },
  express: {
    id: "express",
    language: "javascript",
    root: EXPRESS_ROOT,
    slice: "utils",
    symbols: Object.freeze([
      { name: "normalizeType", path: "utils.js" },
      { name: "compileETag", path: "utils.js" },
      { name: "compileQueryParser", path: "utils.js" },
      { name: "contentDisposition", path: "utils.js" },
    ]),
    sampleContent: `// src/sample.js — express-derived slice
export function normalizeType(type) {
  return type;
}
export function compileETag(val) {
  return val;
}
`,
  },
  lodash: {
    id: "lodash",
    language: "javascript",
    root: LODASH_ROOT,
    slice: "lodash.js",
    symbols: Object.freeze([
      { name: "debounce", path: "lodash.js" },
      { name: "throttle", path: "lodash.js" },
      { name: "merge", path: "lodash.js" },
      { name: "cloneDeep", path: "lodash.js" },
    ]),
    sampleContent: `// src/sample.js — lodash-derived slice
export function debounce(func, wait) {
  return func;
}
export function throttle(func, wait) {
  return func;
}
`,
  },
  flask: {
    id: "flask",
    language: "python",
    root: FLASK_ROOT,
    slice: "app",
    symbols: Object.freeze([
      { name: "render_template", path: "templating.py" },
      { name: "run", path: "app.py" },
      { name: "route", path: "sansio/scaffold.py" },
      { name: "render_template_string", path: "templating.py" },
    ]),
    sampleContent: `# src/sample.py — flask-derived slice
def render_template(template_name, **context):
    return template_name
def run(host, port):
    return f"{host}:{port}"
`,
  },
  tokio: {
    id: "tokio",
    language: "rust",
    root: TOKIO_ROOT,
    slice: "task",
    symbols: Object.freeze([
      { name: "spawn", path: "task/join_set.rs" },
      { name: "block_on", path: "runtime/scheduler/multi_thread.rs" },
      { name: "sleep", path: "time/sleep.rs" },
      { name: "spawn_blocking", path: "task/join_set.rs" },
    ]),
    sampleContent: `// src/sample.rs — tokio-derived slice
pub fn spawn<F>(future: F) -> u64 { 0 }
pub fn block_on<F>(future: F) -> u64 { 0 }
`,
  },
  gin: {
    id: "gin",
    language: "go",
    root: GIN_ROOT,
    slice: "gin.go",
    symbols: Object.freeze([
      { name: "New", path: "gin.go" },
      { name: "Default", path: "gin.go" },
      { name: "Handler", path: "gin.go" },
      { name: "Last", path: "gin.go" },
    ]),
    sampleContent: `// src/sample.go — gin-derived slice
package gin
func New() *Engine { return nil }
func Default() *Engine { return nil }
`,
  },
  guava: {
    id: "guava",
    language: "java",
    root: GUAVA_ROOT,
    slice: "guava/src/com/google/common/collect",
    symbols: Object.freeze([
      { name: "newArrayList", path: "guava/src/com/google/common/collect/Lists.java" },
      { name: "filter", path: "guava/src/com/google/common/collect/Collections2.java" },
      { name: "transform", path: "guava/src/com/google/common/collect/Collections2.java" },
      { name: "immutableList", path: "guava/src/com/google/common/collect/ImmutableList.java" },
    ]),
    sampleContent: `// src/Sample.java — guava-derived slice
package com.google.common.collect;
import java.util.List;
public class Lists {
  public static List newArrayList() { return null; }
  public static List filter(List list) { return list; }
}
`,
  },
  redis: {
    id: "redis",
    language: "c",
    root: REDIS_ROOT,
    slice: "server.c",
    symbols: Object.freeze([
      { name: "serverLogRaw", path: "server.c" },
      { name: "isShutdownInitiated", path: "server.c" },
      { name: "nolocks_localtime", path: "server.c" },
      { name: "isCommandReusable", path: "server.c" },
    ]),
    sampleContent: `// src/sample.c — redis-derived slice
#include <time.h>
void serverLogRaw(int level, const char *msg) {}
int isShutdownInitiated(void) { return 0; }
`,
  },
});
