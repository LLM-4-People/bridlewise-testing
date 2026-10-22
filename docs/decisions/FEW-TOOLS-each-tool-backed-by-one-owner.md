---
id: FEW-TOOLS
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: TOOLS-FEW
---
# Few tools, each backed by one harness owner

A model handed dozens of overlapping tools picks the wrong one, and every tool
that re-implements harness logic (git, for example) is a second copy that
drifts. So the model gets a few excellent tools, and each one is a thin face
over one part of the harness.

The user, 2026-10-10: "i want few tools, but really good and novel ones…
tools like the git ones should use what we build in the harness instead of
exposing duplicate logica".

- The model gets a few tools. Each is a thin face over ONE harness owner, with
  its schema generated from that owner's manifest. A tool never re-implements
  logic the harness owns.
- Whatever the harness does mechanically (git, quality checks, status
  polling) is not a tool
  ([HARNESS-DRIVES](HARNESS-DRIVES-the-harness-drives-the-model-creates.md)).
- Every tool is easy for weak models, smart, adaptive, resilient, RELIABLE,
  agnostic, one source of truth, at the lowest choke point, and exposes as
  many signals, settings and functions as it can. Tools are also capable of
  really advanced work: a low floor and a high ceiling in the same tool.

What is missing: not built yet. The built-in tool set
(`engine/src/tools/built-in-tools.ts`) is still the large one, and its tools
are not yet generated from their owners' manifests.
