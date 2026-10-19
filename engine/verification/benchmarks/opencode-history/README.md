# Historical OpenCode exact-scope synthetic qualification

This directory contains a research-only Node/TypeScript boundary for SEC-001.
It accepts only an explicit synthetic manifest and exact file IDs. It performs
no directory enumeration, recursive search, shell expansion, fallback-tool
selection, or subprocess launch.

Sandbox/root spellings must use exact canonical absolute syntax. Allowlist
segments use a deterministic ASCII-only name policy and reject dot/dotdot,
duplicate separators, trailing ambiguity, Unicode, and confusable spellings.
The root-runner request is duplicate-key checked and has a closed field set.

The boundary deliberately cannot claim real-history readiness. Its receipt
always reports `realHistoryReady: false` and `sec001Open: true`. A separate,
independently reviewed privileged runner must establish the read-only mount,
namespace, network, OS-identity, anonymous-FD, and transcript controls before
any fresh real-history run could be considered.

`scope-guard.ts` reuses the canonical SHA-256, JSON duplicate-key, and device
boundary functions from `src/`. `isolation-plan.ts` describes the missing OS
boundary from caller declarations; it reports zero measured capabilities,
unverified isolation, and not-ready. It never treats declarations or plan text
as evidence. `root-runner.ts` is kept
separate from agent/runtime composition and receives control data through an
anonymous preopened descriptor, never argv or environment.

Node path-based opens do not bind the ancestor chain. Successful synthetic
receipts explicitly report that descriptor-relative ancestor binding and stable
parent verification are false. Closing that gap requires independently reviewed
kernel enforcement; this verification code does not claim otherwise.
