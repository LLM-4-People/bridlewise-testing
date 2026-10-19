# SEC-001 — Runbook search escaped the authorized historical scope

- Status: `open-blocking`
- Severity: `confidentiality-control-failure`
- Owner: `historical-research-safety`
- Affected surfaces: `builder`, `runtime-policy-target`
- Run disposition: `confidentiality-tainted`
- First recorded: `2026-07-12`, `America/Toronto`

## Finding

A runbook sub-agent issued a broad read-only search that unintentionally traversed
an excluded historical-review packet subtree. Existing packet content was emitted
into that tool transcript. This record intentionally contains no packet content,
excerpt, identifier, or derived finding.

No conversation database was opened. No source data was mutated, copied into the
repository, uploaded, or reused in implementation or analysis. Those facts limit
the incident but do not reverse the transcript exposure.

## Consequence

The affected run is confidentiality-tainted. It cannot support a readiness,
no-access, isolation, or clean-room claim. Real-history access and any dependent
conversation-study acceptance remain blocked.

## Root cause

The read-only runbook did not have an unavoidable deny-by-default launcher/search
boundary that required an exact admitted root and rejected every sibling,
parent, scratch, packet, quarantine, and implicit-current-directory traversal.
Read-only intent did not constrain discovery scope.

## Removal condition

This finding may be marked `verified-removed` only after all of the following are
governed and independently replayed without accessing real history:

1. A path-scoped launcher/search wrapper accepts only an exact manifest-bound
   research root and bounded query plan.
2. Broad, parent, sibling, scratch, packet, quarantine, symlink, environment,
   implicit-CWD, shell-expansion, fallback-tool, and delegated-agent traversal
   attempts fail before tool launch.
3. Tool stdout/stderr and transcript admission are bounded, classified, and
   fail closed on scope disagreement.
4. At least three materially different synthetic negative-test repetitions and
   an independent review pass.
5. A fresh run—not this tainted run—establishes the applicable readiness and
   isolation evidence.

## Permanent regression and evidence policy

- Regression: `historical-research-path-scope-and-transcript-containment-x3`
- Removal verification: `independent-synthetic-launcher-search-negative-suite`
- Deadline: `before-any-real-history-access-or-conversation-study-readiness-claim`
- Evidence must contain only synthetic fixtures and control metadata. It must
  never reproduce or summarize the exposed packet content.
