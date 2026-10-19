# COORD-002 — Implicit tool root created a repository write effect

- Status: **open blocking**
- Owner: `multi-agent-coordination`
- Affected surface: builder
- First recorded: 2026-07-14, America/Toronto

## Finding

An `apply_patch` call intended to create `/tmp/cas-measure.mjs` supplied a bare
repository-relative path and instead created `cas-measure.mjs` in the shared
worktree. The file was new, 11,833 bytes, with SHA-256
`f43d98b674b7df7d3059a2c12b1dc8e75fe8abebdcd63348f56d93261d753357`.
It was detected immediately through dual-path existence and candidate-status
checks and removed exactly with `apply_patch`.

Cleanup did not erase the incident. HEAD, the Git index and both candidate
status sentinels returned to their exact pre-effect identities. The canonical
record is
`traceability/evidence/verification/content-addressed-evidence/write-boundary-incident.json`.

## Root cause and permanent control

The write interface interpreted an implicit relative target against the active
workspace, while intent referred to a different root. The call had no explicit
workspace-root identity, closed logical path, active exact write set or
pre-effect rejection tying the requested target to the intended external root.

The content-store slice now requires a nonserializable observed root capability
and exact operation/path lease before each effect. This narrowly prevents the
same class inside that slice. It does not establish a universal tool gateway,
brokered hierarchical lease, root fencing, or automatic enforcement for every
repository-writing tool, so the coordination finding remains open.

## Removal condition

Install one universal pre-effect tool boundary that binds explicit workspace
root identity, canonical logical path, active hierarchical write-set lease and
fencing token for every repository mutation. Exercise repository/external-root
confusion, omitted/relative/absolute paths, symlink and alias roots, stale
leases, concurrent owners and default working-directory changes in at least
three repetitions, and independently replay the exact incident fixture.

- Regression: `explicit-root-exact-write-set-and-default-cwd-confusion-matrix-x3`
- Removal verification: `independent-universal-tool-root-fencing-and-incident-replay`
- Deadline: `before-universal-safe-write-effect-or-coordination-readiness-claim`
