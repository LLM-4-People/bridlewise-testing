# Engine agent notes

The engine is the domain half of Bridlewise. It owns the editor, intelligence,
memory, privacy, safety, timeline, workflow, MCP, and quality contracts.

## Read first

- [Repository agent briefing](../AGENTS.md)
- [Agent process](../docs/process/AGENTS.md)
- [Workflow](../docs/process/WORKFLOW.md)
- [Test map](../docs/testing.md)

## Rules

- Keep domain logic independent of transport, persistence, UI, and process
  lifecycle. Adapters translate at the boundary.
- Validate at the trust boundary. A parser or protocol adapter must refuse
  malformed input explicitly.
- Use the engine's existing owner for a fact, default, or limit. Do not add a
  second copy in the web tree.
- Engine tests run from the engine package; the
  [evidence bar](../docs/process/AGENTS.md#evidence) owns what a focused or
  full run must prove.
- The engine is part of an experimental developer preview. Do not describe it
  as production ready.
