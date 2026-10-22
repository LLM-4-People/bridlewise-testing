---
id: NO-OVER-ENGINEER
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# Don't over-engineer; novelty is not a goal

A clever design costs more to build, to test and to keep working than a
simple one, and it is only worth that cost when a measurement shows it is
needed. Ideas are judged by how well they fit the project, not by whether
anyone has done them before.

The user, 2026-10-10: "dont over engineer things", and "the goal is not
simply to build something that is not built elsewhere, that is a cool stunt,
but good ideas even when built elsewhere are great if it fits our rules,
visions and goals".

- Prefer the smallest design that meets the requirement reliably. A simpler
  exact mechanism (for example deduplication keyed by the whole tree id) beats
  a clever fine-grained one (per-file read tracing) unless a measurement
  proves the clever one is needed.
- Judge ideas by fit and value, never by novelty.

How it is enforced: by design review. It is a working rule with no
mechanical guard.
