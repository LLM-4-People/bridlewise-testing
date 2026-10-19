// EXP391 — Worker thread entry point.
//
// CPU-bound tools run inside a `worker_threads` Worker to escape Node's
// single-threaded event loop. The worker receives { id, name, args } and
// returns { id, ok, result, error, durationMs }.
//
// CPU-bound tools (run here, in the worker):
//   - count_functions — @babel/parser parse + AST walk
//   - ast_query       — query the call graph / import graph / function info
//   - quality_check   — run the quality pack on a file (parse + checks)
//   - duplicate_scan  — find duplicate bodies in a file (parse + walk)
//
// I/O-bound tools (stay in the main thread):
//   - grep, read_file, list_files (async fs/spawn)
//   - search, memory_retrieve, awareness (in-memory index lookups)
//   - edit (atomic write — single-threaded for correctness)
//
// The split: I/O on the main thread (event loop), CPU on N workers
// (real parallelism). This breaks Amdahl's ceiling — the CPU fraction
// becomes parallel.

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

// Babel parser is dynamically imported once per worker (cached by V8).
let babelParse = null;
async function getBabel() {
  if (babelParse) return babelParse;
  babelParse = (await import("@babel/parser")).parse;
  return babelParse;
}

// The worker's root for file reads (passed in workerData).
const ROOT = workerData?.root ?? process.cwd();

function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

// BigInt-safe JSON.stringify replacer. Babel's AST can contain BigIntLiteral
// nodes whose `value` is a JS BigInt (JSON.stringify throws on BigInt by
// default). Used wherever we serialize AST fragments for size metrics.
function bigIntSafe(_k, v) {
  return typeof v === "bigint" ? String(v) + "n" : v;
}

async function readAndParse(p, presetContent) {
  // If presetContent is provided, skip the disk read entirely (the main
  // thread pre-read the file in parallel via libuv and passed the content
  // in the postMessage payload). This makes the worker pure-CPU.
  let content;
  if (presetContent !== undefined && presetContent !== null) {
    content = presetContent;
  } else {
    const abs = resolvePath(p);
    content = await readFile(abs, "utf8");
  }
  const parse = await getBabel();
  // Babel's codebase uses advanced decorators (accessor keyword), class
  // properties, JSX, TypeScript. Use the full plugin list + errorRecovery
  // to handle the long tail of experimental syntax.
  const plugins = [
    ["typescript", { dts: p.endsWith(".d.ts") }],
    "jsx",
    "decorators-legacy",
    "decoratorAutoAccessors",
    "classProperties",
    "classPrivateProperties",
    "classPrivateMethods",
    "exportDefaultFrom",
    "exportNamespaceFrom",
    "dynamicImport",
    "numericSeparator",
    "optionalChaining",
    "nullishCoalescingOperator",
    "asyncGenerators",
    "objectRestSpread",
    "topLevelAwait",
    "explicitResourceManagement",
  ];
  const ast = parse(content, { sourceType: "module", plugins, errorRecovery: true });
  return { content, ast };
}

// Tool: count_functions — parse + AST walk (CPU-bound).
// Accepts optional args.content to skip the disk read (preset mode).
async function toolCountFunctions(args) {
  const t0 = performance.now();
  const { content, ast } = await readAndParse(args.path, args.content);
  let count = 0, arrows = 0, classes = 0, imports = 0;
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") count++;
    else if (n.type === "ArrowFunctionExpression") arrows++;
    else if (n.type === "ClassDeclaration" || n.type === "ClassExpression") classes++;
    else if (n.type === "ImportDeclaration") imports++;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  return {
    path: args.path,
    functions: count,
    arrows,
    classes,
    imports,
    lines: content.split("\n").length,
    durationMs: performance.now() - t0,
  };
}

// Tool: ast_query — query the AST for function info, call graph, import graph.
// Accepts optional args.content to skip the disk read (preset mode).
async function toolAstQuery(args) {
  const t0 = performance.now();
  const { content, ast } = await readAndParse(args.path, args.content);
  const kind = args.kind ?? "function_info";
  const out = { path: args.path, kind };

  if (kind === "function_info") {
    // Collect function name, params, return type, line range.
    const fns = [];
    (function walk(n, parentFn = null) {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
        const name = n.id?.name ?? parentFn?.id?.name ?? "<anon>";
        const params = (n.params ?? []).map((p) => {
          if (p.type === "Identifier") return p.name;
          if (p.type === "AssignmentPattern") return p.left?.name ?? "<default>";
          if (p.type === "RestElement") return "..." + (p.argument?.name ?? "");
          return "<pattern>";
        });
        fns.push({
          name,
          params,
          async: !!n.async,
          generator: !!n.generator,
          start: n.loc?.start?.line,
          end: n.loc?.end?.line,
        });
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) for (const c of v) walk(c, n.type?.includes("Function") ? n : parentFn);
        else if (v && typeof v === "object" && typeof v.type === "string") walk(v, n.type?.includes("Function") ? n : parentFn);
      }
    })(ast);
    out.functions = fns.slice(0, 100); // cap at 100 to bound transfer size
    out.functionCount = fns.length;
  } else if (kind === "call_graph") {
    // Collect function->function calls (CalleeExpression).
    const edges = [];
    (function walk(n, fnName = null) {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
        fnName = n.id?.name ?? fnName ?? "<anon>";
      }
      if (n.type === "CallExpression") {
        const callee = n.callee;
        let calleeName = null;
        if (callee?.type === "Identifier") calleeName = callee.name;
        else if (callee?.type === "MemberExpression") {
          calleeName = (callee.object?.name ?? "<obj>") + "." + (callee.property?.name ?? "<prop>");
        }
        if (calleeName && fnName) edges.push({ caller: fnName, callee: calleeName });
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) for (const c of v) walk(c, fnName);
        else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fnName);
      }
    })(ast);
    out.edges = edges.slice(0, 200);
    out.edgeCount = edges.length;
  } else if (kind === "import_graph") {
    const imports = [];
    (function walk(n) {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "ImportDeclaration") {
        const specifiers = (n.specifiers ?? []).map((s) => {
          if (s.type === "ImportDefaultSpecifier") return { kind: "default", local: s.local?.name, imported: null };
          if (s.type === "ImportSpecifier") return { kind: "named", local: s.local?.name, imported: s.imported?.name };
          if (s.type === "ImportNamespaceSpecifier") return { kind: "namespace", local: s.local?.name, imported: null };
          return { kind: "unknown" };
        });
        imports.push({ source: n.source?.value, specifiers });
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) for (const c of v) walk(c);
        else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
      }
    })(ast);
    out.imports = imports;
  }
  out.durationMs = performance.now() - t0;
  return out;
}

// Tool: quality_check — parse + check (dead exports, unused imports, complexity, etc.).
// Accepts optional args.content to skip the disk read (preset mode).
async function toolQualityCheck(args) {
  const t0 = performance.now();
  const { content, ast } = await readAndParse(args.path, args.content);
  const lines = content.split("\n");
  const issues = [];

  // 1. Collect imports (which are used).
  const imports = new Map(); // local name -> source
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ImportDeclaration") {
      for (const s of n.specifiers ?? []) {
        if (s.local?.name) imports.set(s.local.name, n.source?.value ?? "?");
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);

  // 2. Collect exports (which are visible to other modules).
  const exports = new Set();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration?.id?.name) exports.add(n.declaration.id.name);
      for (const s of n.specifiers ?? []) if (s.exported?.name) exports.add(s.exported.name);
    }
    if (n.type === "ExportDefaultDeclaration") exports.add("default");
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);

  // 3. Find identifier usages (any Identifier not in an import declaration).
  const used = new Set();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Identifier" && n.name) used.add(n.name);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);

  // 4. Unused imports.
  for (const [local, src] of imports) {
    if (!used.has(local)) {
      issues.push({ kind: "unused-import", local, source: src });
    }
  }

  // 5. Dead exports (rough heuristic: not used anywhere in the same file).
  const declared = new Set();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && n.id?.name) declared.add(n.id.name);
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations ?? []) {
        if (d.id?.name) declared.add(d.id.name);
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  // Exported functions may be used externally — only flag if not in `used`.
  // (Conservative: don't flag exports — they're public API.)

  // 6. Complexity: count statements per function.
  let maxComplexity = 0;
  let mostComplexFn = null;
  (function walk(n, fn = null, depth = 0) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      fn = n.id?.name ?? "<anon>";
      depth = 0;
    }
    if (n.type === "IfStatement" || n.type === "ForStatement" || n.type === "ForInStatement" ||
        n.type === "ForOfStatement" || n.type === "WhileStatement" || n.type === "DoWhileStatement" ||
        n.type === "SwitchStatement" || n.type === "ConditionalExpression" || n.type === "LogicalExpression") {
      depth++;
      if (depth > maxComplexity) {
        maxComplexity = depth;
        mostComplexFn = fn;
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c, fn, depth);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fn, depth);
    }
  })(ast);

  // 7. TODO comments + empty catch.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/TODO|FIXME|XXX|HACK/.test(l)) issues.push({ kind: "todo-comment", line: i + 1, text: l.trim().slice(0, 80) });
  }
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CatchClause" && n.body?.body?.length === 0) {
      issues.push({ kind: "empty-catch", line: n.loc?.start?.line });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);

  return {
    path: args.path,
    lines: lines.length,
    imports: imports.size,
    exports: exports.size,
    unusedImports: issues.filter((i) => i.kind === "unused-import").length,
    todoComments: issues.filter((i) => i.kind === "todo-comment").length,
    emptyCatch: issues.filter((i) => i.kind === "empty-catch").length,
    maxComplexity,
    mostComplexFn,
    issues: issues.slice(0, 50), // cap
    durationMs: performance.now() - t0,
  };
}

// Tool: duplicate_scan — find duplicate bodies within a file (CPU-bound).
// Accepts optional args.content to skip the disk read (preset mode).
async function toolDuplicateScan(args) {
  const t0 = performance.now();
  const { content, ast } = await readAndParse(args.path, args.content);
  const bodies = [];
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      const name = n.id?.name ?? "<anon>";
      // BigInt-safe: use the replacer so BigIntLiteral values don't throw.
      const bodyTokens = JSON.stringify(n.body?.body ?? n.body?.expressions ?? [], bigIntSafe).length;
      bodies.push({ name, bodyTokens, start: n.loc?.start?.line, end: n.loc?.end?.line });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
    }
  })(ast);
  // Find duplicates (same bodyTokens size — rough).
  const bySize = new Map();
  for (const b of bodies) {
    if (!bySize.has(b.bodyTokens)) bySize.set(b.bodyTokens, []);
    bySize.get(b.bodyTokens).push(b);
  }
  const duplicates = [...bySize.values()].filter((v) => v.length > 1 && v[0].bodyTokens > 50);
  return {
    path: args.path,
    functions: bodies.length,
    duplicateGroups: duplicates.length,
    duplicates: duplicates.slice(0, 20),
    durationMs: performance.now() - t0,
  };
}

// Tool: heavy_check — parse once, do ALL 4 checks. Heavier per call so
// worker overhead is amortized. Returns combined result.
// Accepts optional args.content to skip the disk read (preset mode).
async function toolHeavyCheck(args) {
  const t0 = performance.now();
  const { content, ast } = await readAndParse(args.path, args.content);
  const lines = content.split("\n");

  // count_functions
  let fns = 0, arrows = 0, classes = 0, imports = 0;
  // ast_query (function_info + call_graph + import_graph)
  const fnInfos = [];
  const edges = [];
  const importDecls = [];
  // quality_check
  const issues = [];
  const importLocals = new Map();
  const exports = new Set();
  const used = new Set();
  let maxComplexity = 0;
  let mostComplexFn = null;
  // duplicate_scan
  const bodies = [];

  (function walk(n, parentFn = null, fnName = null, depth = 0) {
    if (!n || typeof n.type !== "string") return;
    // count
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") fns++;
    else if (n.type === "ArrowFunctionExpression") arrows++;
    else if (n.type === "ClassDeclaration" || n.type === "ClassExpression") classes++;
    else if (n.type === "ImportDeclaration") imports++;
    // function info + call graph
    if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      const name = n.id?.name ?? parentFn?.id?.name ?? "<anon>";
      fnName = name;
      const params = (n.params ?? []).map((p) => {
        if (p.type === "Identifier") return p.name;
        if (p.type === "AssignmentPattern") return p.left?.name ?? "<default>";
        if (p.type === "RestElement") return "..." + (p.argument?.name ?? "");
        return "<pattern>";
      });
      fnInfos.push({ name, params, async: !!n.async, start: n.loc?.start?.line, end: n.loc?.end?.line });
      // BigInt-safe: use the replacer so BigIntLiteral values don't throw.
      const bodyTokens = JSON.stringify(n.body?.body ?? n.body?.expressions ?? [], bigIntSafe).length;
      bodies.push({ name, bodyTokens, start: n.loc?.start?.line, end: n.loc?.end?.line });
    }
    if (n.type === "CallExpression") {
      const callee = n.callee;
      let calleeName = null;
      if (callee?.type === "Identifier") calleeName = callee.name;
      else if (callee?.type === "MemberExpression") {
        calleeName = (callee.object?.name ?? "<obj>") + "." + (callee.property?.name ?? "<prop>");
      }
      if (calleeName && fnName) edges.push({ caller: fnName, callee: calleeName });
    }
    // imports + exports
    if (n.type === "ImportDeclaration") {
      for (const s of n.specifiers ?? []) {
        if (s.local?.name) importLocals.set(s.local.name, n.source?.value ?? "?");
      }
      const specifiers = (n.specifiers ?? []).map((s) => s.local?.name).filter(Boolean);
      importDecls.push({ source: n.source?.value, specifiers });
    }
    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration?.id?.name) exports.add(n.declaration.id.name);
      for (const s of n.specifiers ?? []) if (s.exported?.name) exports.add(s.exported.name);
    }
    if (n.type === "ExportDefaultDeclaration") exports.add("default");
    if (n.type === "Identifier" && n.name) used.add(n.name);
    // complexity
    if (n.type === "IfStatement" || n.type === "ForStatement" || n.type === "ForInStatement" ||
        n.type === "ForOfStatement" || n.type === "WhileStatement" || n.type === "DoWhileStatement" ||
        n.type === "SwitchStatement" || n.type === "ConditionalExpression" || n.type === "LogicalExpression") {
      depth++;
      if (depth > maxComplexity) { maxComplexity = depth; mostComplexFn = fnName; }
    }
    // duplicate bodies
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) walk(c, n.type?.includes("Function") ? n : parentFn, fnName, depth); }
      else if (v && typeof v === "object" && typeof v.type === "string") walk(v, n.type?.includes("Function") ? n : parentFn, fnName, depth);
    }
  })(ast);

  // unused imports
  for (const [local, src] of importLocals) {
    if (!used.has(local)) issues.push({ kind: "unused-import", local, source: src });
  }
  // TODO + empty catch
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/TODO|FIXME|XXX|HACK/.test(l)) issues.push({ kind: "todo-comment", line: i + 1, text: l.trim().slice(0, 80) });
  }
  (function findEmptyCatch(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CatchClause" && n.body?.body?.length === 0) {
      issues.push({ kind: "empty-catch", line: n.loc?.start?.line });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) findEmptyCatch(c);
      else if (v && typeof v === "object" && typeof v.type === "string") findEmptyCatch(v);
    }
  })(ast);

  // duplicates (same bodyTokens size, > 50 tokens)
  const bySize = new Map();
  for (const b of bodies) {
    if (!bySize.has(b.bodyTokens)) bySize.set(b.bodyTokens, []);
    bySize.get(b.bodyTokens).push(b);
  }
  const duplicateGroups = [...bySize.values()].filter((v) => v.length > 1 && v[0].bodyTokens > 50);

  return {
    path: args.path,
    lines: lines.length,
    functions: fns, arrows, classes, imports,
    functionInfos: fnInfos.slice(0, 50),
    functionInfoCount: fnInfos.length,
    callEdges: edges.slice(0, 100),
    callEdgeCount: edges.length,
    importDecls,
    exports: exports.size,
    unusedImports: issues.filter((i) => i.kind === "unused-import").length,
    todoComments: issues.filter((i) => i.kind === "todo-comment").length,
    emptyCatch: issues.filter((i) => i.kind === "empty-catch").length,
    maxComplexity,
    mostComplexFn,
    issues: issues.slice(0, 30),
    duplicateGroups: duplicateGroups.length,
    duplicates: duplicateGroups.slice(0, 10),
    durationMs: performance.now() - t0,
  };
}

// Helper: pre-read a list of files in PARALLEL within the worker (libuv
// thread pool). Returns an array of contents (or null on error) in the same
// order. This pipelines I/O: all reads happen concurrently via libuv while
// the worker's event loop is free. If `presetContents` are provided (preset
// mode), they're returned as-is (no disk read).
async function preReadInWorker(paths, presetContents) {
  if (presetContents) return presetContents;
  return Promise.all(paths.map((p) => {
    const abs = resolvePath(p);
    return readFile(abs, "utf8").catch(() => null);
  }));
}

// Tool: batch_check — process N files in ONE worker call. Amortizes the
// postMessage overhead across N files. The main thread sends a list of
// file paths; the worker parses each and returns a list of results.
// This is the key to >4× speedup: instead of 500 postMessage round-trips,
// we do 500/N round-trips, each carrying N files.
// Accepts optional args.contents (array, same length as args.paths) to
// skip the disk read entirely (preset mode — main thread pre-reads in
// parallel via libuv, workers do pure-CPU parse).
// When no contents are provided, the worker pre-reads all files in PARALLEL
// (libuv thread pool) before parsing sequentially — this pipelines I/O so
// the worker's total time is max(I/O, CPU) instead of I/O + CPU.
async function toolBatchCheck(args) {
  const t0 = performance.now();
  const paths = args.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: "paths[] required", durationMs: 0 };
  }
  const fileContents = await preReadInWorker(paths, args.contents);
  const results = [];
  for (let i = 0; i < paths.length; i++) {
    try {
      const r = await toolHeavyCheck({ path: paths[i], content: fileContents[i] });
      results.push({ path: paths[i], ok: true, result: r });
    } catch (e) {
      results.push({ path: paths[i], ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}` });
    }
  }
  return { paths: paths.length, results, durationMs: performance.now() - t0 };
}

// Tool: batch_count — process N files in ONE worker call, return ONLY the
// counts (functions, lines, complexity). Minimal result → minimal postMessage
// overhead. This is the high-throughput variant of batch_check.
// Accepts optional args.contents (array, same length as args.paths) to
// skip the disk read entirely (preset mode — pure-CPU worker).
// When no contents are provided, the worker pre-reads all files in PARALLEL
// (libuv thread pool) before parsing sequentially — pipelines I/O so the
// worker's total time is max(I/O, CPU) instead of I/O + CPU.
async function toolBatchCount(args) {
  const t0 = performance.now();
  const paths = args.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: "paths[] required", durationMs: 0 };
  }
  const fileContents = await preReadInWorker(paths, args.contents);
  const counts = [];
  for (let i = 0; i < paths.length; i++) {
    try {
      const { content, ast } = await readAndParse(paths[i], fileContents[i]);
      let fns = 0, arrows = 0, classes = 0, imports = 0, maxCx = 0;
      (function walk(n, depth = 0) {
        if (!n || typeof n.type !== "string") return;
        if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") fns++;
        else if (n.type === "ArrowFunctionExpression") arrows++;
        else if (n.type === "ClassDeclaration" || n.type === "ClassExpression") classes++;
        else if (n.type === "ImportDeclaration") imports++;
        if (n.type === "IfStatement" || n.type === "ForStatement" || n.type === "WhileStatement" ||
            n.type === "SwitchStatement" || n.type === "ConditionalExpression") {
          depth++;
          if (depth > maxCx) maxCx = depth;
        }
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (Array.isArray(v)) for (const c of v) walk(c, depth);
          else if (v && typeof v === "object" && typeof v.type === "string") walk(v, depth);
        }
      })(ast);
      counts.push({ path: paths[i], ok: true, fns, arrows, classes, imports, lines: content.split("\n").length, maxCx });
    } catch (e) {
      counts.push({ path: paths[i], ok: false, error: (e?.message ?? String(e)).slice(0, 100) });
    }
  }
  return { paths: paths.length, counts, durationMs: performance.now() - t0 };
}

const CPU_HANDLERS = {
  count_functions: toolCountFunctions,
  ast_query: toolAstQuery,
  quality_check: toolQualityCheck,
  duplicate_scan: toolDuplicateScan,
  heavy_check: toolHeavyCheck,
  batch_check: toolBatchCheck,
  batch_count: toolBatchCount,
};

// Export the handlers so the MAIN THREAD can import and run them directly
// (for the single-threaded sequential baseline). When worker_threads are
// used, the CPU-bound work runs in parallel across N workers — the
// speedup over this main-thread baseline is the worker-thread benefit.
//
// NOTE: the parentPort message handler is NOT registered here. The
// worker entry point (worker-entry.mjs) owns the message protocol
// (including the `ready` handshake). Registering a second listener here
// would duplicate every reply and race with the entry point.
export {
  toolCountFunctions, toolAstQuery, toolQualityCheck, toolDuplicateScan,
  toolHeavyCheck, toolBatchCheck, toolBatchCount, CPU_HANDLERS,
};
export { bigIntSafe };
