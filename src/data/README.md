# Data

The client data layer: the single owners of the client's connection to the server, its I/O, its clock, and the honest vocabulary it uses when there is nothing to show.

## What each file does

- `absence.ts` — FAILURE → PLAIN WORDS. The single owner of "why is there nothing here".
- `asof.ts` — THE GLOBAL `asOf` — one owner for "which instant am I looking at".
- `broker.ts` — The Broker — the single place the client performs I/O.
- `connection.ts` — THE CONNECTION — one global state, one owner.
- `error-messages.ts` — Error message formatting — the client's human-text projection of errors.
- `errors.ts` — Client error classes — the typed errors the data layer throws.
- `ledger.ts` — The provenance LEDGER — what the Broker knows, kept where LENS can read it.
- `liveness-share.ts` — THE LIVENESS SHARE — one elected tab per browser context holds the liveness socket (Web Locks + BroadcastChannel); the others derive the same state from its broadcasts (UIE-044).

## Where it lives

The folder lives at `src/data/`.
