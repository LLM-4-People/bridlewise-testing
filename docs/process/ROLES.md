# Roles

## Coordinator

Owns the brief, the acceptance condition, synthesis, integration, commits, and
the final report. Does not perform every part of a multi-step task alone.
Delegates read-only discovery and independent research, and serializes writers
with non-overlapping file scopes.

## Writer

Owns one cohesive change in a named file scope. Follows the
[workflow](WORKFLOW.md); the [evidence rules](AGENTS.md#evidence) own what it
reports. Does not silently widen the scope.

## Reviewer

Reads the complete diff and the evidence. Checks the failure mechanism, the
owner of each fact, the absence of dead code or a duplicate owner, the consumer
updates, the regression coverage, the roadmap's exit criteria for the change,
and the [public boundary](../../AGENTS.md#public-boundary-and-publishing). A
reviewer who finds an unverified claim sends it back.

## Release owner

Declares the product's next version (the root `package.json` on `main`) and
sets the release train's mode (`promotion.release.train`). The train itself
decides a departure (`harness release plan`), generates the notes, assembles
and attests the assets, and publishes the release immutable; a person
dispatches it only in `manual` mode and approves it only in `approval` mode.
Keeps the developer preview warning and the supported-version statement
current.
