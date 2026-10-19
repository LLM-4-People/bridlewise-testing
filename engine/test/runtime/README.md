# runtime

The `engine/test/runtime/` folder of the development surface.

## What each file does

- `admitted-node-runtime.test.ts` — the `admitted-node-runtime.test` module.
- `agent-tools.test.ts` — the `agent-tools.test` module.
- `cli-debug.test.ts` — a bootstrapped CLI process hears a real sweep's audit event (an unconfigured one does not); every engine entry point (the main guard, derived by scanning) runs `bootstrapProcess({ role })` first (and so do the top-level programs: the commit guard, the farm child, the long-task unit), bar the declared exceptions.
- `cli-help.test.ts` — the `cli-help.test` module.
- `extension-tools.test.ts` — the `extension-tools.test` module.
- `git-tools.test.ts` — the `git-tools.test` module.
- `integration.test.ts` — the `integration.test` module.
- `intelligence-tools.test.ts` — the `intelligence-tools.test` module.
- `interactive-session-intent-recording.test.ts` — the `interactive-session-intent-recording.test` module.
- `interactive-session-recording-failures.test.ts` — the `interactive-session-recording-failures.test` module.
- `interactive-session.test.ts` — the `interactive-session.test` module.
- `makora-smoke.test.ts` — the `makora-smoke.test` module.
- `orchestrator-tools.test.ts` — the `orchestrator-tools.test` module.
- `privacy-read-file.test.ts` — the `privacy-read-file.test` module.
- `provider-adapter-contract.test.ts` — the `provider-adapter-contract.test` module.
- `provider-adapter-redaction.test.ts` — the `provider-adapter-redaction.test` module.
- `provider-adapter-saferead.test.ts` — the `provider-adapter-saferead.test` module.
- `provider-adapter-security.test.ts` — the `provider-adapter-security.test` module.
- `provider-adapter.test.ts` — the `provider-adapter.test` module.
- `quality-tools.test.ts` — the `quality-tools.test` module.
- `runtime-config.test.ts` — the `runtime-config.test` module.
- `responses-execution.test.ts` — native terminal authority, governed action batches, lossless real-wire replay, cancellation, retained partial results, and final refusal projection for CLI and agents.
- `sse-parser.test.ts` — the `sse-parser.test` module.
- `tool-args.test.ts` — the `tool-args.test` module.
- `tool-choice-config.test.ts` — the `tool-choice-config.test` module.
- `tool-registry-contract.test.ts` — the `tool-registry-contract.test` module.
- `tool-registry.test.ts` — the `tool-registry.test` module.

## Where it lives and what consumes it

The folder lives at `engine/test/runtime/`.
