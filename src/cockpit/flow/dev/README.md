# Flow dev

The flow dev harness: a standalone mount of the flow for development verification, driven only by synthetic beats.

## What each file does

- `DevHarness.svelte` — FLOW DEV HARNESS — standalone mount for dev verification.
- `main.ts` — Dev harness entry — mounts the flow standalone.
- `synthetic.ts` — SYNTHETIC beats — dev-harness + perf-test fixture only.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `src/cockpit/flow/dev/`.

- `main.ts` is consumed by nothing yet.
- `synthetic.ts` is consumed by `src/cockpit/flow/dev/DevHarness.svelte`.

<!-- /consumers:generated -->
