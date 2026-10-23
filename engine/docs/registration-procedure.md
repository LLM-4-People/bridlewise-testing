# Registration Procedure (read-once authority)

How to register a new module + tests + hash bindings in the bridlewise. This
is the single read-once authority; agents read it once and follow it.

## 1. Add a `moduleContract({...})` entry

For EACH new `src/*.ts` file, hand-add a `moduleContract({...})` entry to
`src/architecture-manifest.ts` (use the shape of a recent comparable module).
`harness register --write` only fixes drift on EXISTING entries; new files
need a hand-added entry. Put placeholder `publicApi`/`dependencies` and let
`harness register --write` fix them.

Minimal shape:

```ts
moduleContract({
  id: "<kebab-case-id>", path: "src/<path>.ts", realm: "shared" | "runtime" | "builder",
  layer: "trusted-kernel" | "domain" | "ports" | "application" | "infrastructure" | "interface" | "verification",
  owner: "<team>", publicApi: { exportCount: 0, namesSha256: "<placeholder>" },
  dependencies: [],
}),
```

After hand-adding the entry, run `harness register --write` (step 2) so the
registrar recomputes `exportCount` and `namesSha256` from the actual exports
and replaces the `<placeholder>` with the real 64-hex SHA-256. The registrar's
write path only matches entries whose `namesSha256` is a 64-hex string, so a
literal `"<placeholder>"` is NOT auto-replaced — the registrar recomputes the
hash, prints a drift report, and the author copies the computed value into the
manifest by hand (or replaces `"<placeholder>"` with the computed 64-hex value
before re-running, which lets the registrar's write path update it). Either way,
end with a 64-hex `namesSha256` that the registrar verifies.

## 2. Run `harness sync`

`harness sync` (or `node src/cli.ts harness sync`) runs three phases in order:

1. `register --write` — fix module drift on existing entries (fills
   `publicApi.exportCount`, `namesSha256`, `dependencies` from the actual
   exports/imports).
2. `regenerate` — auto-add disposition entries for new `test/**/*.test.ts`
   files, repair stale hash bindings, regenerate the test inventory
   (`traceability/s1-test-inventory.json`).
3. `check --skip-typecheck` — verify all gates pass.

If `harness register --write` could not fix a `<placeholder>` entry (its regex
looks for a 64-hex hash, not the literal string `<placeholder>`), the drift
report still computes the correct value. Read the drift report, copy the
computed `namesSha256` into the manifest by hand, then re-run `harness sync`.
Iterate until `harness check` reports `0 unregistered, 0 drifted`.

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

## 8. Test files do NOT get `moduleContract` entries

The manifest's `sourceRoots` are `["scripts/", "src/", "verification/"]`. The
`test/**/*.test.ts` files get dispositions in
`traceability/test-surface-dispositions.json` via `harness regenerate`, not
`moduleContract` entries. The `test/prevention/*.test.ts` files consumed by
the D3 prevention suite follow the same rule.

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
