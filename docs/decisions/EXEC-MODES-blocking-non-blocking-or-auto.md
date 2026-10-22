---
id: EXEC-MODES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: MODES
---
# Everything is blocking, non-blocking or auto

Some work should make an agent wait for its result, and some should run in
the background while the agent continues. Which one is right depends on the
task, so it is a setting on everything the harness runs, and in `auto` the
agent decides per call.

The user, 2026-10-10: "whatever is ran by the harness can either be blocking
or non-blocking, this applies to everything and should be a configurable,
where in auto agents can chose".

- Everything the harness runs (tools, sub-tools, delegation, sandbox runs,
  automatic checks, approvals) has an execution mode: `blocking`,
  `non-blocking` or `auto` (the agent chooses per call). It is set per level
  (global, project, agent profile, tool, sub-tool) with stated precedence.
  Non-blocking results are pushed, never polled.
- Tools contain sub-tools, and every control (enable, breakers, permissions,
  budgets, settings, signals) applies at both levels.
- Tools and sub-tools are defined declaratively: one definition from which the
  model schema, docs, gate and tests are generated, so creating or improving a
  tool is easy; MCP tools join the built-in set or are shown separately by a
  setting alone.
- Agents start with specific goals, permissions, access, tools, budgets,
  models and trajectories (agent profiles); a child never exceeds its parent.

What is missing: not built yet. Background agents exist
(`engine/src/agents/agent-type-background.ts`), but there is no execution
mode setting across everything the harness runs.
