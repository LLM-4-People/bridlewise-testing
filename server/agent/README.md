# Agent domain

The agent domain owns delegated work: the agent types the harness can run, the
state of agents in flight, and the restriction sets that bound what a delegated
agent may touch. The main thread delegates; it never lets a sub-agent exceed
its recorded restrictions.

## What each file does

- `agent-runtime-bridge.ts` — the single owner of web-run agent delegation.
- `agents-bridge.ts` — the server-side adapter to the canonical agent state
  store, exposing which agents exist and their status.
- `agent-types-bridge.ts` — exposes the canonical agent type registry so the
  UI can list and select them.
- `agent-restrictions.ts` — the single owner of the per-delegation restriction
  sets a sub-agent runs under.

## Where it lives

The folder lives at `server/agent/`.
