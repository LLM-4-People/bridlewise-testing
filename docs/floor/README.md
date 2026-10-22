---
published: false
---

# Floor content integration notes

These pages are the floor part of the one Pages site, which is built from `docs/` on `main`. The site root is the product home, the contributor hub is `/contribute/`, and this folder adds `/floor/`.

This README is integration notes, not a site page. `published: false` keeps it out of the Jekyll output if it sits in the source tree.

## Files

| File | Permalink | Purpose |
|---|---|---|
| `index.md` | `/` | Product home, the site's front door |
| `contribute.md` | `/contribute/` | Contributor hub |
| `floor/index.md` | `/floor/` | Floor landing page |
| `floor/help.md` | `/floor/help/` | Contribution lanes and review checklist |
| `floor/roadmap.md` | `/floor/roadmap/` | The roadmap, rendered from the roadmap feed at publish, and the dated snapshot |
| `floor/promotion.md` | `/floor/promotion/` | Projection and gate contract |
| `floor/atlas.md` | `/floor/atlas/` | Generated test atlas and filter UI |
| `floor/evidence.md` | `/floor/evidence/` | Rerunnable checks and non-proofs |
| `floor/status.md` | `/floor/status/` | Generated status console and fallback |
| `floor/README.md` | none | This file |

All published pages use `layout: default`, `title`, `description`, and `permalink`. They use `relative_url` for site links. Do not hardcode `baseurl` or the repository name.

## Site build

`node scripts/build-site.mjs` (the steps are `scripts/floor/site.mjs`; the publish plan and link map are `scripts/floor/site-pages.mjs`) builds the site from this repository alone:

1. `source --out .site --baseurl <base> [--versions <dir>]`: copy `docs/` (every Markdown file is a page unless `published: false`; its URL is its `permalink` or its pretty path, and two pages for one URL refuse the build), rewrite each page's relative links (a published page or a served asset becomes its site URL; any other repository path becomes its GitHub URL; a link naming nothing refuses the build), give each plain Markdown page a front matter and wrap its body as raw text, write the redirect pages for older URLs (`/product/`, `/roadmap/`, the trackers' former `/floor/trackers/` home and each page's `.md` spelling), list the released versions at `/v/`, write the floor data (`floor/data/atlas.json` and an offline `status.json`), and refuse any page that names a path the build does not produce. A link into the versions folder in any form is refused: pages link the versions page through `site.versions_url`. The committed source is never edited: GitHub resolves the relative links against the repository.
2. Refresh the live status online (`node scripts/build-floor-data.mjs --root . --out .site/floor/data`, through the forge client), then Jekyll builds `.site` into `_site`.
3. `finish --site _site --baseurl <base> [--versions <dir>]`: merge each release's pre-built documentation snapshot at `/v/<version>/`, then crawl every internal link of the whole output and run the design coverage over the pages this build rendered.

A release snapshot is built at release time with `source --baseurl <base>/v/<version> --release <version>` (whole, floor data included), then Jekyll, and attached to the release; the Pages build only merges it.

### The deploy order, and its one override

A deploy publishes only a commit that is the live site's commit or descends from it (`scripts/floor/deploy-order.mjs`, run in the deploy queue). An ancestor of the live commit is skipped as superseded. A relation the check cannot establish is refused with a typed code: `site_deploy_history_rewritten` (GitHub no longer holds the live commit, as after the history rewrite of runbook P6), `site_deploy_diverged`, or `site_deploy_published_unknown` (no recent deployment published a site). The one way out is recorded: dispatch the Docs site workflow from `main` with `supersede_published` set to the exact commit the refusal names (or `unknown`). That run waits for the `pages-override` environment's reviewer, and its record holds who asked, for which commit, and why it was refused. An override naming any other commit is refused (`site_deploy_override_mismatch`). Use `layout: default`, `title`, `description`, and `permalink` on hand-written pages and `relative_url` for site links; do not hardcode `baseurl` or the repository name. One layout, one design layer: do not add a separate layout or token system.

## Generated data

The pages expect two static files, both generated at build or publication time. They are build targets, not existing artifacts:

- `floor/data/atlas.json`
- `floor/data/status.json`

Write them into the Jekyll source before the build, not into `_site` after it. Do not hand-edit either file; regenerate it from its source. The generators must produce deterministic, public, redacted JSON. No token, local path, host name, database key, private fixture name, or unreviewed hold text may enter either file.

The roadmap page's body (`floor/roadmap.md`, between its `GENERATED AT PUBLISH` markers), `/floor/roadmap/print/`, `/floor/roadmap/feed.xml` and `/floor/roadmap/data/roadmap.json` are written into the Jekyll source after the floor data: `engine/scripts/tooling/roadmap-feed.ts` computes the feed (the one roadmap model) and `engine/scripts/roadmap/cli.ts build` renders it. The committed page keeps only its shell and the dated snapshot.

### Atlas schema

```json
{
  "schemaVersion": "bridlewise-floor-atlas/v1",
  "generatedAt": "2026-10-19T00:00:00Z",
  "source": {
    "repository": "LLM-4-People/bridlewise",
    "commit": "<sha>",
    "inventoryHash": "<sha256>",
    "dispositionHash": "<sha256>"
  },
  "counts": {
    "testSources": 518,
    "testNames": 10491,
    "guards": 236,
    "decisions": 134
  },
  "tests": [
    {
      "path": "tests/unit/example.test.ts",
      "category": "web-unit",
      "disposition": "canonical-node-test",
      "testCount": 12,
      "blocksFullRepositoryClaim": false,
      "sourceHash": "<sha256>"
    }
  ],
  "guards": [
    {
      "name": "Example guard",
      "path": "tests/prevention/example.test.ts",
      "failureClass": "what class of failure this protects",
      "plant": "what is reintroduced",
      "drivenBehavior": "what the test drives",
      "livenessCheck": "how the test proves it sees the plant",
      "complete": true
    }
  ],
  "decisions": [
    {
      "id": "UR-12",
      "title": "The product branch changes only through the promotion door",
      "path": "docs/decisions/UR-12-master-changes-only-through-the-promotion-door.md",
      "group": "user-rules",
      "status": "in-force",
      "implementation": "standing",
      "route": null
    }
  ]
}
```

- One `tests` row is one test surface file, not one test name. `testCount` is the number of bound test names; `counts.testNames` is their sum. The counts above are examples from one snapshot, not constants.
- Derive `category` from the canonical path: `tests/unit` (`web-unit`), `tests/prevention` (`prevention`), `tests/cockpit` (`cockpit`), `tests/performance` (`performance`), `tests/` (`e2e`), `engine/test` (`engine-domain`), `engine/live` (`live`), `bench` (`benchmark`), `engine/guardian/tests` (`guardian`).
- Read dispositions from `engine/traceability/test-surface-dispositions.json`. Map an unrecognized value to `unknown`; never drop it.
- Read guards from the test header in `tests/prevention/*.test.ts`. If a field is absent, set `complete` to `false`; do not infer it from the test body.
- Read decisions from `docs/decisions/*.md` front matter. Exclude the generated `README.md`. Keep `status`, `implementation`, and optional `route`.
- The page filters on the fields above. It does not derive categories at runtime.
- Validate conservation: `counts.testSources` equals `tests.length`, `counts.testNames` equals the sum of `testCount`, `counts.guards` equals `guards.length`, and `counts.decisions` equals `decisions.length`. A mismatch is an invalid snapshot, not a partial table.

### Status schema

```json
{
  "schemaVersion": "bridlewise-floor-status/v1",
  "generatedAt": "2026-10-19T00:00:00Z",
  "source": {
    "repository": "LLM-4-People/bridlewise",
    "ref": "refs/heads/main",
    "commit": "<sha>",
    "committedAt": "2026-10-19T00:00:00Z"
  },
  "product": {
    "repository": "LLM-4-People/bridlewise",
    "ref": "refs/heads/product",
    "commit": "<sha>",
    "committedAt": "2026-10-19T00:00:00Z"
  },
  "promotion": {
    "profile": "main-to-product",
    "state": "idle",
    "pending": {
      "commits": 0,
      "oldestPendingAgeHours": null
    },
    "hold": null,
    "lastRun": {
      "at": "2026-10-19T00:00:00Z",
      "phase": "publish",
      "code": "promotion_published",
      "class": "ok",
      "durationMs": 12345
    }
  },
  "checks": [
    {
      "id": "web-typecheck",
      "label": "Web typecheck",
      "status": "pass",
      "durationMs": 1234
    }
  ],
  "github": {
    "available": true,
    "checkedAt": "2026-10-19T00:00:00Z",
    "reason": null,
    "runs": [
      {
        "repository": "LLM-4-People/bridlewise",
        "workflow": "ci.yml",
        "runId": 123,
        "status": "completed",
        "conclusion": "success",
        "headSha": "<sha>",
        "url": "https://github.com/<owner>/<name>/actions/runs/123"
      }
    ]
  }
}
```

- Generate `promotion` in a checkout that has the profile's source and target refs. The public Pages build may not have them and has no write access. Do not run the promoter on the Pages runner. If the block cannot be read, omit it or emit `"state": "unknown"`; never emit `idle` as a default. `unknown` is a valid state value.
- `checks` is the snapshot's required workflow runs and alert queues, not every test in the floor. Use `pass`, `fail`, `unknown`, or `not-run`. Unknown is not pass.
- `github.runs` is the latest run per workflow. Keep `conclusion` null while running or when it cannot be read.
- Redact the promotion `preflight`, work-root paths, target-checkout paths, environment values, and any hold reason not written for publication. A public reason such as `rate-limit` is enough for `github.reason`.
- On API failure, write `available: false`, a short `reason`, and only the runs actually read. Do not write a synthetic success and do not fail the build into a page that looks current.
- If the whole document cannot be generated, do not publish an empty file. Let the page show its error state.

## DOM contract

The pages expose hooks; the script owns state, filtering, and formatting.

Atlas:

- Root: `[data-floor-atlas]` with `[data-atlas-src]` and `[data-atlas-build-time]` (the Jekyll build time, for the stale check).
- State nodes: `[data-atlas-state="loading|error|empty|ready"]`.
- Other nodes: `[data-atlas-generated]`, `[data-atlas-source]`, `[data-atlas-counts]`, `[data-atlas-stale]`, `[data-atlas-no-matches]`, `[data-atlas-count]`, `[data-atlas-rows]`.
- Controls: `[data-atlas-search]`, `[data-atlas-kind]`, `[data-atlas-category]`, `[data-atlas-disposition]`, `[data-atlas-guard-state]`, `[data-atlas-decision-state]`, `[data-atlas-reset]`.

Status:

- Root: `[data-floor-status]` with `[data-status-src]` and `[data-status-build-time]` (the Jekyll build time, for the stale check).
- State nodes: `[data-status-state="loading|error|empty|ready"]`.
- Other nodes: `[data-status-fallback]`, `[data-status-stale]`, `[data-status-generated]`, `[data-status-source]`, `[data-status-product]`, `[data-status-promotion-state]`, `[data-status-promotion-code]`, `[data-status-pending]`, `[data-status-hold]`, `[data-status-checks]`, `[data-status-checks-empty]`, `[data-status-github-checked]`, `[data-status-runs]`, `[data-status-ci-empty]`.

Behavior:

- Toggle `hidden` and `aria-busy`. Do not render placeholder rows while loading.
- On fetch or parse failure, show the error state. A fetch must have a timeout; a stalled request must not leave the loading state forever.
- Validate `schemaVersion`. An unknown schema is an error, not a best-effort render.
- If any atlas entry fails validation, withhold the whole table. A partial table makes an incomplete snapshot look authoritative.
- Render a missing field as `unknown`, never as zero, `success`, or `idle`.
- Use `textContent` or safe DOM construction. Do not write generated strings into `innerHTML`.
- Accept only `https:` links from generated data.
- Filters combine with AND. Search is case-insensitive across id, title, path, group, and state. Category and disposition apply to test rows, guard state to guard rows, and decision state to decision rows. The count reports matches out of the snapshot total.
- Render every matching row and state the filtered total. If the table caps rows, provide visible pagination; do not silently truncate. One row is a test surface entry, not a test name, so the row count stays bounded by the file inventory.
- If `github.available` is false, show the fallback banner and render CI as unknown. Do not hide the promotion fields that were read.
- If `generatedAt` predates the deployed page beyond the build window, show the stale warning. The snapshot is history, not current state.

## Verification

1. Build with the same Jekyll source the Pages workflow uses. Do not add a Gemfile only for these pages.
2. Visit `/`, `/contribute/`, `/v/`, `/floor/`, `/floor/help/`, `/floor/roadmap/`, `/floor/promotion/`, `/floor/atlas/`, `/floor/evidence/`, and `/floor/status/`.
3. Test the atlas with valid data, no data, no filter matches, invalid JSON, a missing file, and an unknown schema.
4. Test status with `github.available: true`, `false`, missing `promotion`, a stale `generatedAt`, and a missing file.
5. Use keyboard only. Check focus, labels, `aria-live` counts, and the no-JavaScript fallback.
6. Run `npm run docs:links` after `git add`; it reads tracked Markdown files and skips root-relative, absolute, and Liquid links. Manually check the rendered `relative_url` links or crawl the site.
7. Confirm that no generated JSON contains a token, local path, host name, private fixture path, or unreviewed hold text.

## Claims to preserve

- Bridlewise is an experimental developer preview; the floor is its development repository. Neither is production-ready or safe for sensitive code.
- The atlas is an inventory, not a result. A disposition is not a pass.
- The status page is a generated snapshot, not a live monitor. Unknown is not green.
- The promotion contract describes a projection and deterministic gates, not a security audit.
- A release checksum is not a signature; an attestation is not correctness.
- The full corpus and the private evidence are not published.
