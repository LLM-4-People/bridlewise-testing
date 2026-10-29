# Registration Procedure (read-once authority)

How to register a new module + tests + hash bindings in the bridlewise. This
is the single read-once authority; agents read it once and follow it.

## 1. Add the file; its module entry is derived

Every source file under the source roots (`scripts/`, `src/`,
`verification/`) is a module: the census is the tree itself
(`architectureManifestOf`, `src/architecture-manifest.ts`), and a module takes
its folder's default contract (`ARCHITECTURE_DIRECTORY_DEFAULTS`). Nothing
derived — export counts, name hashes, dependencies — is committed (#221), so
two branches adding different modules change only their own files.

Only a DECISION is committed, one line per module in
`src/architecture-modules.ts`, holding only what differs from the folder
default (an id, an owner, an execution boundary, ports, responsibilities):

```ts
{ path: "src/<path>.ts", id: "<kebab-case-id>", owner: "<team>" },
```

A new module that its folder's default classifies needs no line at all. A
module in a folder with no default is refused (`architecture_module_unclassified`)
until it gets a line or its folder a default.

## 2. Run `harness sync`

`harness sync` (or `node src/cli.ts harness sync`) runs, in order:

1. `register --write` — `harness register --write` marks detected entry points
   (composition roots) and removes decisions for modules that no longer
   exist; it never writes a derived value.
2. `regenerate` — refresh the generated values (hash bindings, the hooks, the
   inventories that are caches) and add an exception disposition for a
   recognizable test source outside the qualified patterns.
3. `check --skip-typecheck` — verify all gates pass (`harness check`).

## 3. Run `npm test`

Verify the new tests pass. The prevention suite (`test/prevention/*.test.ts`)
runs as part of the full suite.

## 4. Run `npm run typecheck`

Verify types. `harness check --skip-typecheck` skips this; you must run it
separately.

## 5. Add hash bindings for new `traceability/` artifacts

The hash binding registry (`src/workflow/hash-binding-registry.ts`) covers
every published artifact. Add a new `HashBinding` entry for any new
`traceability/` artifact. The `findRegex` must match exactly once (use the
lookbehind/lookahead style at line 114 of `hash-binding-registry.ts`):

```ts
{
  id: "<binding-id>",
  description: "<source> -> <target>",
  sourcePath: "<source-path>",
  targetPath: "<target-path>",
  targetKind: "typescript" | "json",
  hashMode: { kind: "file-sha256" } | { kind: "json-field", fieldName: "<field>" } | { kind: "file-binary-sha256" },
  findRegex: String.raw`(?<=<unique-context>)${SHA256_HEX}(?=<unique-context>)`,
}
```

## 6. Never hand-edit these generated files

- `traceability/s1-test-inventory.json` — `harness regenerate` does this atomically.
- The `testInventoryHash` pin in `src/root-policy.ts` — `harness regenerate` repairs it.

## 7. Binary files: use `file-binary-sha256`

For binary files (e.g. the guardian binary), use the `file-binary-sha256` hash
mode. `file-sha256` reads as UTF-8 and corrupts non-ASCII bytes — the Landlock
work caught this. `file-binary-sha256` reads raw bytes via `readFileSync` with
no encoding argument.

## 8. Test files are not modules; deleting one is a named decision

The `test/**/*.test.ts` files are the test surface, not modules. A qualified
Node test source is canonical by default and has NO record under
`traceability/test-surface-dispositions/`, which holds only the exceptions, one
record per decided source, each carrying the discovery-policy hash it was
decided under.

A deleted test is a decision the deleting commit names: one
`Test-deleted: <repository path>` trailer per test source the commit takes
off the surface (a rename too, every path of it), and none for a test it
keeps (`scripts/verification/test-deletions.ts`). The `commit-msg` hook
refuses a mismatch, and the required `commit-records` workflow refuses it
over a pull request's commits. A deleted test that had an exception entry is
also named to `harness sync --prune <path>`, which removes the entry.

## 9. Prevention-detector modules: one source of truth

The D3 detectors live in `src/quality-packs/prevention/` and are consumed by
BOTH the harness's own `test/prevention/*.test.ts` AND the model-facing
`src/quality-packs/typescript-pack.ts` (D4). No parallel authority. A fix to a
detector reaches both consumers in the same commit. The detector's scan scope
is a constant in the calling test (no hardcoded paths in detector logic); the
allowlist JSON files (`test/prevention/duplicate-bodies-allowlist.json`,
`test/prevention/duplicate-literals-allowlist.json`) are test fixtures
co-located with the tests and do NOT get hash bindings (adding a binding would
create a cycle: the test that loads the allowlist would also verify the
binding).
