---
id: PARTIAL-FAILURE
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: TOOLS-FEW
---
# Partial failure in every tool

When a model's tool call is mostly right, making it resend everything wastes
tokens and invites new mistakes in the parts that were fine. So every tool
keeps what was right, repairs what it reliably can, and asks the model only
for what is still wrong.

The user's rule of 2026-10-10 (stated with
[HARNESS-DRIVES](HARNESS-DRIVES-the-harness-drives-the-model-creates.md)):
tools accept partial corrections and MERGE them; the model only resends what
is wrong.

- A tool accepts a partial correction and merges it with the accepted parts.
- A tool auto-repairs everything it reliably can, and every repair is logged.
- A tool asks the model for the minimum.
- It is a principle for all tools, not a setting of one gate.

What is missing: not built yet. The tool layer (`engine/src/tools/`) has no
shared partial-correction or merge mechanism; it is carried out with the
smaller tool set of [FEW-TOOLS](FEW-TOOLS-each-tool-backed-by-one-owner.md).
