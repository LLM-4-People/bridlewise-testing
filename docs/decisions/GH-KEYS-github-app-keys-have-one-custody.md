---
id: GH-KEYS
date: 2026-10-22
by: coordinator
group: github
status: in-force
implementation: partial
route: P1.2
acted_in: [engine/src/workflow/forge/app-registry.ts, engine/src/workflow/forge/app-keys.ts, engine/src/workflow/forge/credentials.ts]
---
# GitHub App private keys have one custody: the key home, or a protected environment

Each GitHub App that acts for Bridlewise ([GH-B](GH-B-agents-act-through-least-privilege-apps.md))
has a private key. Each key lives in exactly one place, and that place depends
on where the App acts:

- **Apps that act on the host** (the agent and the verifier): the private key
  lives in the KEY HOME (`engine/src/filesystem/self-protection/key-home.ts`).
  It is read only through the one credential module,
  `engine/src/workflow/forge/app-keys.ts`, which signs the App's token
  request and never hands the key out. The setup runbook calls this custody
  "the broker".
- **The door and the publisher**: the private key exists only as an
  environment secret of its protected environment (`door`, `publish`), which
  only `main`'s workflows reach. After setup, it is never on the host. The
  setup holds a freshly converted key in the key home only until the key is
  pushed into its environment. Then the record keeps the App's identity and
  the push time and drops the key. A failed push leaves the key held for the
  next run, never in any other place.

`app-registry.ts` declares each App's custody (`host` or `environment`).
`credentials.ts` mints installation tokens from that custody alone.

## Why

- **One custody owner.** A key read through two paths is two policies, and
  the weaker one is the real one. The key home is already where every harness
  key lives, and `app-keys.ts` is the one module that touches an App key, so
  a new consumer cannot read a key any other way
  ([UR-01](UR-01-dry-kiss-yagni-one-owner.md), [UR-16](UR-16-one-thing-for-everything.md)).
- **No key in any record** ([D-09](D-09-credentials-never-in-repository-records.md)).
  A key never goes into a tracked file, a manifest, a page, a log, a report
  or an issue. The Apps page sends a converted key straight to its custody,
  and only the App's identity (id, slug, client id) is ever shown or written
  elsewhere.
- **Environment gating.** The door and the publisher hold the most power:
  the required check, the product branch, releases and the projection. A key
  kept only in a protected environment can be used only by a reviewed
  workflow on `main`, under the environment's own rules, and never by a
  process on a development machine. A host that is compromised later still
  cannot act as the door or the publisher.

## What is live (checked 2026-10-22, not asserted)

- `app-registry.ts`, `app-keys.ts` and `credentials.ts` are on `main` (#52).
  They declare each App's custody, keep host keys in the key home and mint
  tokens from them.
- The held-key push into the `door` and `publish` environments (the Apps
  page, `harness forge apps create`) lands with P1.2's pull request (#96).
  Until it does, no door or publisher key exists anywhere: none of the Apps
  has been created yet.
