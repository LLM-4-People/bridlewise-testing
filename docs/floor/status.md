---
layout: default
page_class: floor
title: "Floor status"
description: "The last generated snapshot of the Bridlewise development floor, its promotion state, and its public CI runs. Missing data is unknown, not green."
permalink: /floor/status/
---

# Floor status

This page shows the last generated snapshot of the floor and its promotion pair. The snapshot is generated at build or publication time. It does not stream, poll GitHub from your browser, hold a token, or guarantee that it is newer than the source.

<div class="callout-warning" role="note">
<p>A status page is not an audit. Bridlewise is an experimental developer preview, not production-ready and not safe for sensitive code. An unknown or stale field is not a pass.</p>
</div>

**Generated data.** This page loads `status.json`, generated from the tracked floor and public GitHub state at build time. The generator, page script, and fallback states are part of this repository. Until a valid snapshot is deployed, the page shows its unavailable state. The page never invents a run, a commit, or a green result.

## Read the snapshot

<div class="floor-status" data-floor-status data-status-src="{{ '/floor/data/status.json' | relative_url }}" data-status-build-time="{{ site.time | date_to_xmlschema }}" aria-label="Floor status snapshot" aria-busy="true" role="region">
  <div class="callout" data-status-state="loading" role="status">
    <p><strong>Reading the last generated status snapshot.</strong> Fields appear only after the file parses. A blank field during loading is not a result. If this message remains, the page script did not run; read the <a href="{{ '/floor/data/status.json' | relative_url }}">raw JSON</a> or use the evidence commands.</p>
  </div>

  <div class="callout warning" data-status-state="error" role="alert" hidden>
    <p><strong>Status unavailable.</strong> The page could not read or validate the generated snapshot. There is no current status to report. This is not a green state. Check the deployment and run the <a href="{{ '/floor/evidence/' | relative_url }}">evidence commands</a>.</p>
  </div>

  <div class="callout" data-status-state="empty" role="status" hidden>
    <p><strong>The status snapshot is empty.</strong> The file parsed but carries no source, promotion, or CI fields. Treat every field as unknown.</p>
  </div>

  <div data-status-state="ready" hidden>
    <div class="callout warning" data-status-fallback role="status" hidden></div>
    <div class="callout" data-status-stale role="status" hidden>
      <p><strong>This snapshot is stale.</strong> It predates the deployed page beyond the build window. Treat every field as historical, not current.</p>
    </div>

    <p><a href="{{ '/floor/data/status.json' | relative_url }}">Raw snapshot JSON</a>.</p>

    <dl class="status-grid">
      <div>
        <dt>Snapshot generated</dt>
        <dd data-status-generated>unknown</dd>
      </div>
      <div>
        <dt>Source commit</dt>
        <dd data-status-source>unknown</dd>
      </div>
      <div>
        <dt>Product commit</dt>
        <dd data-status-product>unknown</dd>
      </div>
      <div>
        <dt>Promotion state</dt>
        <dd data-status-promotion-state>unknown</dd>
      </div>
      <div>
        <dt>Promotion reason</dt>
        <dd data-status-promotion-code>unknown</dd>
      </div>
      <div>
        <dt>Pending source commits</dt>
        <dd data-status-pending>unknown</dd>
      </div>
      <div>
        <dt>Hold</dt>
        <dd data-status-hold>unknown</dd>
      </div>
    </dl>

    <h3>Gate results</h3>
    <p data-status-checks-empty hidden>No gate results are present in this snapshot. This is unknown, not passed.</p>
    <div class="floor-table-wrap"><table class="status-table">
      <caption class="sr-only">Promotion gate results in this snapshot</caption>
      <thead>
        <tr>
          <th scope="col">Gate</th>
          <th scope="col">Status</th>
          <th scope="col">Duration</th>
        </tr>
      </thead>
      <tbody data-status-checks></tbody>
    </table></div>

    <h3>Public CI</h3>
    <p>Last API check: <span data-status-github-checked>unknown</span>. The commit cell links to the public run. A conclusion is GitHub's result for that run, not a floor result.</p>
    <p data-status-ci-empty hidden>No CI data is present in this snapshot. This is unknown, not passed.</p>
    <div class="floor-table-wrap"><table class="status-table">
      <caption class="sr-only">Latest public CI runs in this snapshot</caption>
      <thead>
        <tr>
          <th scope="col">Repository</th>
          <th scope="col">Workflow</th>
          <th scope="col">Conclusion</th>
          <th scope="col">Commit</th>
        </tr>
      </thead>
      <tbody data-status-runs></tbody>
    </table></div>
  </div>

  <noscript>
    <div class="callout warning">
      <p><strong>The status page needs JavaScript.</strong> The generated JSON is available at <a href="{{ '/floor/data/status.json' | relative_url }}"><code>{{ '/floor/data/status.json' | relative_url }}</code></a>. The <a href="{{ '/floor/evidence/' | relative_url }}">evidence commands</a> do not depend on it.</p>
    </div>
  </noscript>
</div>

## Fields

The snapshot is a versioned JSON document. The page accepts `bridlewise-floor-status/v1` and rejects an unknown schema instead of guessing. The public snapshot carries no local paths, host names, tokens, or environment values.

| Field | Type | Meaning | Unknown or empty behavior |
|---|---|---|---|
| `schemaVersion` | string | The document schema. The page accepts `bridlewise-floor-status/v1` only. | An unknown schema is an error state. |
| `generatedAt` | ISO 8601 string | When the snapshot was produced, not when you loaded the page. | Missing means the age is unknown; the page does not apply the stale check. |
| `source.repository` | string | The repository the snapshot read. | Missing means unknown. |
| `source.ref` | string | The source ref, `refs/heads/main`. | Missing means unknown. |
| `source.commit` | string or null | The source commit in the snapshot. | `null` means unknown, not current. |
| `source.committedAt` | ISO 8601 string or null | The source commit time. | `null` means unknown. |
| `product.repository` | string | The repository whose product branch the snapshot read (the same repository). | Missing means unknown. |
| `product.ref` | string | The product branch, `refs/heads/product`. | Missing means unknown. |
| `product.commit` | string or null | The product branch's tip in the snapshot. | `null` means unknown or no promotion yet, not current. |
| `product.committedAt` | ISO 8601 string or null | The product commit time. | `null` means unknown. |
| `promotion.profile` | string | The profile name that produced the state. | Missing means unknown. |
| `promotion.state` | enum | `ready`, `blocked`, or `unknown`. | An unrecognized value renders `unknown`. |
| `promotion.pending.commits` | integer or null | Source commits not yet on the target. | `null` means no target yet or unknown. |
| `promotion.pending.oldestPendingAgeHours` | number or null | Age of the oldest pending source commit. | `null` means none or unknown. |
| `promotion.hold` | object or null | `{ "at": ISO 8601, "reason": string }` when automatic promotion is paused. | `null` means no hold is recorded, not that a hold never happened. |
| `promotion.lastRun` | object or null | The last recorded promotion run, when one is available. | `null` means no run is recorded. The public snapshot does not invent one. |
| `promotion.lastRun.code` | string | A promotion code, when a run is recorded. | Missing means unknown. |
| `promotion.reason` | string | Why this public snapshot is not a release gate. | Missing means unknown. |
| `checks` | array | Gate results: `{ "id", "label", "status", "durationMs" }`. | An empty array means no gate results, not a pass. |
| `checks[].status` | enum | `pass`, `fail`, `unknown`, or `not-run`. | `unknown` and `not-run` are not passes. |
| `checks[].jobs` | array or null | For a workflow run at the source commit, each job of its latest attempt: `{ "name", "status", "conclusion", "url" }`, sorted by name. A claim is bound to the job that proves it. | `null` means no run at this commit, offline, or a failed read (`checks[].jobsNote` says which), never "no jobs". |
| `github.available` | boolean | True only when the generator received GitHub API data for every requested run. | Missing means unknown. Do not infer true from an empty `runs` array. |
| `github.checkedAt` | ISO 8601 string or null | The last API attempt. | `null` means the attempt time is unknown. |
| `github.reason` | string or null | A short public reason when `available` is false, for example `rate-limit`, `no-token`, `network`, or `api-error`. | `null` with `available: false` means the reason is unknown. |
| `github.runs` | array | Latest public runs: `{ "repository", "workflow", "runId", "status", "conclusion", "headSha", "url" }`. | An empty array means no runs were read, not that none exist. |
| `github.runs[].conclusion` | string or null | GitHub's conclusion for that run, such as `success`, `failure`, `cancelled`, or `skipped`. | `null` means running or unknown. |

Nested fields the table groups for space:

- `promotion.lastRun.at` is when the run was recorded. `phase` is the last phase it entered. `durationMs` is the sum of its measured phases.
- `checks[].id` is the command registry name. `label` is the display name. `durationMs` is the measured duration.
- `github.runs[].repository` and `workflow` name the source. `runId` is GitHub's numeric run id. `status` is GitHub's run status. `headSha` is the tested commit. `url` is the public run page.

## Promotion states

| State | Meaning |
|---|---|
| `ready` | Every required run in this snapshot passed at the recorded commit. It is not a release authorization. |
| `blocked` | At least one required run failed. Read the gate table and the public run. |
| `unknown` | A required run is missing, pending, or for a different commit, or the API could not be read. This is not a pass. |

The public snapshot does not authorize a release: a release is judged from its own attested evidence when it is cut. This page reports public evidence and gaps.

## The GitHub fallback

The generator fills `github` from the public GitHub API. The API can be rate-limited, unreachable, or unauthenticated at build time. The fallback is deliberate:

- `github.available` is `false`.
- `github.reason` names the public reason.
- `github.runs` is empty or carries only the runs that were actually read.
- Any run still shown under the fallback is the last one read, not a current success.
- The page shows a warning above the fields: "GitHub API unavailable at generation time: `<reason>`. CI state is unknown."
- The promotion and source fields still render if they were read. They are not replaced with guesses.
- No synthetic `success` run is written. No missing run is treated as passed.

If the status file itself cannot be read, the page shows its error state. If the file parses but a field is missing, that field renders `unknown`. If the file predates the deployed page beyond the build window, the page labels the snapshot as stale. A stale snapshot is history, not current status.

The generator runs where the promotion refs exist. If the public Pages build does not carry those refs, it cannot produce the promotion block. The page then reports `unknown`, not `idle`. The integration notes define the generation boundary.

## What the snapshot cannot tell you

- It is a point-in-time record. It does not prove the tree still matches the remote.
- A CI `success` is one workflow at one commit, not the full test floor.
- A promotion `ok` is one typed answer, not a security review.
- An empty field is unknown. It is never silently filled with a default.
- A page that loads is not a service that is up. There is no hosted Bridlewise service.

If the snapshot and a command disagree, the command wins. Use the [evidence commands]({{ '/floor/evidence/' | relative_url }}) for the claim you need to repeat.
