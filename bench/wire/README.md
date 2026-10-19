# wire

The `bench/wire/` folder of the development surface.

## What each file does

- `client.ts` — wIRE CLIENT — the product as a browser reaches it, not as a test imports it.
- `load.ts` — wIRE LOAD SUITE — the product over the real network stack.
- `preload-lag.ts` — iN-SERVER-PROCESS PROBE — event-loop lag + memory, sampled from.
- `server.ts` — sERVER INSTANCE LIFECYCLE — start a real one, on its own port, over a.
- `sse-cap-probe.ts` — sSE CONNECTION-CAP MECHANISM CHECK — the half of the honest-refusal question that the wire cannot reach.

## Where it lives and what consumes it

The folder lives at `bench/wire/`.
