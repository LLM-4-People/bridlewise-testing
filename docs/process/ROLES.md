# Roles

## Coordinator

Owns the brief, the acceptance condition, synthesis, integration, commits, and
the final report. Does not perform every part of a multi-step task alone.
Delegates read-only discovery and independent research, and serializes writers
with non-overlapping file scopes.

## Writer

Owns one cohesive change in a named file scope. Reproduces the baseline,
implements the change, updates every consumer, and runs the focused checks.
Reports the exact commands and results. Does not silently widen the scope.

## Reviewer

Reads the complete diff and the evidence. Checks the failure mechanism, the
owner of each fact, the consumer updates, the regression coverage, and the
public boundary. A reviewer who finds an unverified claim sends it back.

## Release owner

Runs the promotion gate at the exact commit, waits for in-flight checks,
records the receipt, and publishes only when the receipt passes. Keeps the
developer preview warning and the supported-version statement current.
