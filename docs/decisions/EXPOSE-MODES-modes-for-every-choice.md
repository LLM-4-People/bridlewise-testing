---
id: EXPOSE-MODES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: MODES
---
# Expose everything; modes for every choice

Hiding settings to make a tool look simple also takes power away from the
people who need it. So everything is exposed, every choice the harness or a
model makes is a setting with modes, and ease of use is added on top later
with presets, never by removing a setting.

The user, 2026-10-10: "be sure to expose as many configurables and signals as
possible, later on we will find ways to make it easy to use for a beginner,
but I dont want to be limited".

- Every behaviour that involves a choice is a setting with modes, typically
  `auto` (the model or the harness decides, and it is recorded), `manual`,
  and, where a person must agree, `approval`. Examples: plan mode,
  instruction files, rule capture, the agent model, blocking or non-blocking
  ([EXEC-MODES](EXEC-MODES-blocking-non-blocking-or-auto.md)).
- Never limit capability for beginners. Ease of use is layered on top later
  (presets, defaults), never by removing a setting or signal
  ([UR-05](UR-05-expose-settings-signals-actions.md)).
- Reliable features are ON by default. Proving reliability is a ship gate, not
  a user opt-in.
- Modes are a first-class, declarative and extensible system: more built-in
  modes, plus modes anyone can add, edit, maintain and improve, in the one
  definition registry beside tools, sub-tools and agent profiles.

What is missing: not built yet. There is no modes registry; the choices this
rule names are not yet settings with modes.
