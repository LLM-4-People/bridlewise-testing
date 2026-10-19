import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * DRY-8 regression: workflow files used raw `writeFileSync(<path>,...)` to
 * write result artifacts, which is not crash-safe (a crash mid-write leaves a
 * corrupt partial file). The fix routed every path write through
 * `atomicWriteFile` (write-temp-then-rename). This test mechanically scans
 * every `src/workflow/*.ts` file and fails if any `writeFileSync` call writes
 * to a PATH string. The only legitimate `writeFileSync` use is writing to an
 * already-open file descriptor (e.g. an `O_CREAT|O_EXCL` lock file), which is
 * atomic by construction and is not a path write.
 */

function listWorkflowTsFiles(): string[] {
  const dir = join(process.cwd(), "src", "workflow");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

function extractWriteFileSyncCalls(src: string): string[] {
  // Match writeFileSync(... ) up to the closing paren, capturing the first arg.
  const calls: string[] = [];
  const re = /\bwriteFileSync\s*\(/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(src.slice(start, i - 1));
  }
  return calls;
}

test("atomic-write-consistency: every src/workflow/*.ts writeFileSync call writes to an fd, never a path", () => {
  const files = listWorkflowTsFiles();
  assert.ok(files.length > 0, "expected workflow source files to exist");
  const offenders: string[] = [];
  for (const file of files) {
    const rel = file.replace(process.cwd() + "/", "");
    const src = readFileSync(file, "utf8");
    const calls = extractWriteFileSyncCalls(src);
    for (const call of calls) {
      const firstArg = call.split(",")[0]!.trim();
      // An fd write is `writeFileSync(fd, content)` where fd is a numeric
      // variable (e.g. `fd`). A path write is `writeFileSync(absolutePath,...)`
      // or `writeFileSync(somePathStringLiteral,...)`. We allow only the fd form.
      const isFdWrite = /^fd\b/u.test(firstArg);
      if (!isFdWrite) {
        offenders.push(`${rel}: writeFileSync(${call.split(",")[0]!.trim()}, ...)`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `All workflow writes must go through atomicWriteFile (write-temp-then-rename). ` +
      `writeFileSync(<path>) is forbidden; only writeFileSync(<fd>, ...) is allowed. Offenders:\n` +
      offenders.join("\n"),
  );
});

test("atomic-write-consistency: workflow files that write artifacts import atomicWriteFile", () => {
  const files = listWorkflowTsFiles();
  const writers = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    // Files that perform any durable artifact write should import atomicWriteFile,
    // unless they only write to an fd (lock files) or do no writes at all.
    return /atomicWriteFile|writeFileSync/u.test(src);
  });
  for (const file of writers) {
    const src = readFileSync(file, "utf8");
    const rel = file.replace(process.cwd() + "/", "");
    // If the file writes a path via atomicWriteFile, it must import it.
    if (/atomicWriteFile\(/u.test(src)) {
      assert.ok(
        /import\s+\{[^}]*\batomicWriteFile\b[^}]*\}\s+from/u.test(src) ||
          /import\s+atomicWriteFile\b/u.test(src),
        `${rel} calls atomicWriteFile() so it must import it`,
      );
    }
  }
});

test("atomic-write-consistency: test-result-collector writes via atomicWriteFile, not writeFileSync(path)", () => {
  const src = readFileSync(join(process.cwd(), "src", "workflow", "test-result-collector.ts"), "utf8");
  // The collector's writeTestResultCollection is the historically-buggy call site.
  // It must NOT contain a path write via writeFileSync.
  const pathWrite = /writeFileSync\s*\(\s*(?:absolutePath|filePath|path|join\s*\()/u;
  assert.equal(
    pathWrite.test(src),
    false,
    "test-result-collector.ts must not write artifact paths via writeFileSync (use atomicWriteFile)",
  );
});

test("atomic-write-consistency: resource-lock writes no lock file itself — the one file lock publishes it (wf-del2-design D1)", () => {
  // It used to hand-write its record to an O_CREAT|O_EXCL fd: a second lock
  // implementation beside the file lock. Now the one exclusive writer
  // publishes every lock record (src/filesystem/file-lock.ts).
  const src = readFileSync(join(process.cwd(), "src", "workflow", "resource-lock.ts"), "utf8");
  assert.deepEqual(extractWriteFileSyncCalls(src), [], "resource-lock.ts writes a file itself");
  assert.equal(/O_CREAT|O_EXCL|openSync/u.test(src), false, "resource-lock.ts creates a lock file itself");
  assert.match(src, /from "\.\.\/filesystem\/file-lock\.ts"/u, "resource-lock.ts does not take its lock through the one file lock");
});
