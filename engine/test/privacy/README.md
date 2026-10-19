# privacy

The `engine/test/privacy/` folder of the development surface.

## What each file does

- `declaration-runs.test.ts` — declaration scans stay stack-safe and linear on long runs.
- `declared-secret-floors.test.ts` — the `declared-secret-floors.test` module.
- `encrypted-field-projection.test.ts` — the field codec: authenticated ciphertext in operational text, and every value bound to its associated data (another row, owner or column refused).
- `evidence-handler.test.ts` — the `evidence-handler.test` module.
- `file-viewer.test.ts` — the `file-viewer.test` module.
- `held-set.test.ts` — the typed held set: labelled, frozen, merged; every escape form scrubbed; a held value split at any cut point still masked; through the real client, a shapeless key echoed in streamed tool-call arguments reaches no chunk (SECC-V-A3).
- `known-secret-scope.test.ts` — the process-wide known-secret registry holds the harness's own secrets only; request values are held per call; the masking floor cannot be switched off.
- `non-default-policy-matrix.test.ts` — the `non-default-policy-matrix.test` module.
- `privacy-config-fields.test.ts` — the `privacy-config-fields.test` module.
- `privacy-policy.test.ts` — the `privacy-policy.test` module.
- `redaction-engine.test.ts` — the `redaction-engine.test` module.
- `redaction-exhaustiveness.test.ts` — the `redaction-exhaustiveness.test` module.
- `secret-parts.test.ts` — the one write-only secret primitive: every common credential shape in a URL or an argument list concealed (plain parts shown); a keep mark kept only in its own place and for the same destination; the scalar rule.
- `secret-files.test.ts` — the secret-file owner: named secret files recognised (templates not); every value redacted and every key visible (env, JSON, YAML, INI, PEM, netrc); the file viewer applies it in every mode.

## Where it lives and what consumes it

The folder lives at `engine/test/privacy/`.
