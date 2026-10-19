# Security policy

> [!WARNING]
> Bridlewise is an experimental developer preview. It is not security-audited, not production-ready, and must not be used with sensitive, proprietary, regulated, or production codebases. This repository is a development floor, not a hardened product.

## Supported versions

There are no supported production versions. `main` is the only public development branch, and every snapshot is a preview.

## Reporting a vulnerability

Do **not** open a public issue with exploit details, credentials, or private data.

Use GitHub's **private vulnerability reporting** on the product repository:

<https://github.com/LLM-4-People/bridlewise/security/advisories/new>

Include the affected revision, a minimal reproduction, the impact, and any suggested fix. If the report concerns the development floor only, say so and link the file or test.

There is no incident-response team and no disclosure SLA. Reports are handled on a best-effort basis.

## What the design attempts

- Loopback API binding and a `Host` check.
- HttpOnly sessions, a CSRF header on unsafe methods, scrypt password hashes, and hashed session tokens.
- AES-256-GCM field encryption at rest, with keys outside the checkout.
- Redaction at the model-egress choke point and before user display.
- A governed tool surface with typed refusals.
- Landlock confinement for spawned commands and stdio MCP servers on Linux.
- An append-only, hash-chained timeline.

## What it does not provide

- An audit, penetration test, or formal threat-model review.
- Multi-tenant hardening or a production deployment model.
- Network confinement.
- Complete secret/PII detection.
- A guarantee that every destructive action is reversible.
- Support or an SLA.

## Secrets and private data

- Never commit provider keys, database keys, `.env` files, tokens, private keys, or local databases.
- Keep the database key home outside both repositories.
- Redact logs, absolute paths, project names, and personal data before opening an issue.
- If a credential was exposed, revoke and rotate it first; rewriting history does not undo exposure.

## Scope

The public snapshot was rebuilt from sanitized trees. It deliberately excludes the private development history, internal evidence, trackers, and frozen records. Vulnerabilities in the unpublished private history are still worth reporting privately if they affect the public code.

## Safety expectation

Use a disposable copy. Assume data loss is possible. Inspect the run record before trusting an outcome. Do not point the harness at a codebase you cannot afford to lose or disclose.
