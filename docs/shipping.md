---
layout: default
title: Shipping and releases
description: What the build produces, how to verify it, and what a preview release contains.
permalink: /shipping/
---

# Shipping and releases

> [!WARNING]
> Every release is a developer preview. Do not deploy it for a team, expose it beyond loopback, or point it at a sensitive codebase.

## Build outputs

| Output | Command | Path | Purpose |
|---|---|---|---|
| Cockpit | `npm run build` | `dist/client/` | Static SPA bundle |
| Engine bundle | `npm --prefix engine run build:bundle` | `engine/dist/bundle.js` | Guardian payload and engine entry |
| Guardian | `make -C engine/guardian all` | `engine/guardian/build/harness-landlock-guardian` | Linux Landlock confinement |
| Process supervisor | `make -C engine/guardian test_process_supervisor` | `engine/guardian/build/` | Long-task supervision |

The build output is not committed. The source archive is the release artifact; `engine/dist/bundle.js` and `dist/client` are attached separately so they can be verified without a rebuild.

## Verify before shipping

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
npm run typecheck
npm --prefix engine run typecheck
npm run check:secrets
npm run test:public
npm run build
npm --prefix engine run build:bundle
make -C engine/guardian all
make -C engine/guardian test
```

Or:

```bash
make check
make build
make guardian
```

Tagging `v*` is a release marker, not a workflow trigger: no workflow runs
this gate for you. Run the gate above at the tagged commit, then publish the
release with:

- `bridlewise-<tag>-source.tar.gz` — the tracked source tree;
- `bridlewise-<tag>-cockpit.tar.gz` — the built static cockpit;
- `bridlewise-<tag>-engine-bundle.js` — the esbuild bundle;
- `SHA256SUMS` — checksums for all assets.

A release is not a production endorsement. The notes must repeat the developer-preview warning.

## Cockpit captures

The release screenshots and the GIF of a run come from one command, never
from a hand-driven browser:

```bash
make -C engine/guardian all                # the copy needs the confinement binary
npx playwright install chromium ffmpeg     # Playwright's Chromium and its ffmpeg
npm run capture:cockpit                    # node --experimental-strip-types scripts/capture/cockpit.ts
```

It writes `.bridlewise/capture/<commit>/` (ignored: raw images never enter
git): one PNG per view, theme and viewport, `fixture-run.webm`,
`fixture-run.gif`, `text/` (each capture's visible text) and `manifest.json`.
`--out <dir>` writes elsewhere; `--demo-root <dir>` moves the demo repository.
Ports 5173 and 5174 must be free: the capture starts its own app and refuses
(`ports_busy`) rather than touch a server it did not start.

What a run guarantees:

- **The captured commit, isolated.** The app runs from `git archive HEAD` in a
  scratch folder, with every byte of state (XDG homes, keys, evidence, both
  databases) inside it, started and stopped through `scripts/sd.mjs` in that
  copy. The scratch folder and the demo repository are removed afterwards.
- **No model is called.** `HARNESS_WEB_LLM_FIXTURES=1` streams the product's
  fixture events; the saved provider is a placeholder (`fixture.invalid`).
  Every capture of the run, and the GIF, carries the label "fixture replay —
  no model was called".
- **Nothing volatile is published as if it were measured.** The browser clock
  is fixed; the server's clock is not (it has no fixed-clock variable), so the
  values it stamps (times, ages, dates, run ids) and the run's throughput
  figures (ttft, tok/s, token counts, durations, event counts) and the four
  instrument readings that move while the harness runs are replaced by a
  bracketed label such as `[time]`, and the capture says so. A value that
  still changes under the camera fails the run: each view is shot twice a
  second apart and must be byte-identical (a failing view leaves its later
  shot in `unstill/`, and no manifest is written).
- **No host identity.** The demo repository lives under
  `/tmp/bridlewise-capture`; a capture whose text (what is visible inside the
  image) holds a home path or the host user name fails the run.
- **A record of what was made.** `manifest.json` names the commit, the recipe
  hash (the capture scripts plus every plan input), the Chromium and
  Playwright versions, and each image's sha256 and masked labels.

What it does not guarantee: the same bytes on another host while the IBM Plex
fonts are not vendored (`public/fonts/` absent: text renders in the host's
fallback font, and the manifest says so), and a byte-identical GIF (a video's
frame timing is not deterministic; the PNGs are the comparable output). The
sequence, masks and manifest are unit-tested in
`tests/unit/capture-cockpit-plan.test.ts`.

## Install from a checkout

```bash
npm ci
npm --prefix engine ci
chmod 600 engine/bridlewise.config.json
node scripts/sd.mjs start
```

Open <http://127.0.0.1:5173/>. Create the first account; it owns the local harness. Add a provider in Settings before starting a chat run.

## Link the CLI

```bash
npm link
bridlewise --help
bridlewise preflight
```

The launcher runs the TypeScript CLI with Node 24's type stripping. There is no separate CLI build.

## What is not shipped

- The private development history and tags.
- The private evidence corpus, frozen records, and internal trackers.
- The full test corpus and its 4.1 GB fixture root.
- A hosted demo or a production reverse proxy.
- Provider credentials, database keys, or local state.

## Rollback

A preview release can be removed by deleting the GitHub release and tag. Local state is separate: take a verified backup of the database and its key material before upgrading, and never commit either.

```bash
# Stop the server first.
npm run db-backup -- backup --db .bridlewise/web.db --to /path/to/private/backup
# Restore keeps the database it replaces as <database>.pre-restore.
npm run db-backup -- restore --from /path/to/private/backup --db .bridlewise/web.db
```

The bundle holds the database copy and the key material that opens it, proved to open together before the folder is named; [the CLI reference](cli.md#db-backupts) states the verification and the limits (the timeline ledger and the pre-migration copies are not in it).
