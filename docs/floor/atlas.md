---
layout: default
page_class: floor
title: "Test atlas"
description: "A generated map of Bridlewise test surface files, dispositions, prevention guards, and decision records. Existence is not a passing result."
permalink: /floor/atlas/
---

# Test atlas

The atlas is a map of what the floor recognizes. It lists test surface files and their dispositions, prevention guards and their declared scope, and decision records with their state. A row records existence and classification. It does not record a passing run.

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. The atlas is an inventory of verification work, not a coverage certificate and not a production guarantee.</p>
</div>

**Generated data.** This page loads `atlas.json`, generated from the tracked floor tree at build time. The generator, filter script, and table styles are part of this repository. The generated file is the only data source. It carries no private fixture names, local paths, or credentials. The page does not infer tests from filenames at runtime.

## Browse the atlas

<section class="atlas" data-floor-atlas data-atlas-src="{{ '/floor/data/atlas.json' | relative_url }}" data-atlas-build-time="{{ site.time | date_to_xmlschema }}" aria-label="Browse the atlas" aria-busy="true" role="region">
  <div class="callout" data-atlas-state="loading" role="status">
    <p><strong>Loading the atlas snapshot.</strong> Counts appear only after the file parses. A blank table during loading is not a result. If this message remains, the filter script did not run; read the <a href="{{ '/floor/data/atlas.json' | relative_url }}">raw JSON</a> or the source records.</p>
  </div>

  <div class="callout warning" data-atlas-state="error" role="alert" hidden>
    <p><strong>The atlas snapshot did not load.</strong> The page could not read or validate the generated file. Nothing on this page is a result. Check the <a href="{{ '/floor/status/' | relative_url }}">status snapshot</a> and the <a href="{{ '/floor/evidence/' | relative_url }}">evidence commands</a>. If the file is absent, the generator did not run or the deployment did not publish its output.</p>
  </div>

  <div class="callout" data-atlas-state="empty" role="status" hidden>
    <p><strong>The atlas has no entries.</strong> This is not evidence that the floor has no tests. The generated snapshot contains no records. Check the source commit and the generator before drawing any conclusion.</p>
  </div>

  <div data-atlas-state="ready" hidden>
    <p class="atlas-meta">Snapshot <time data-atlas-generated>unknown</time> from <code data-atlas-source>unknown</code>. <span data-atlas-counts>Counts unknown.</span> <a href="{{ '/floor/data/atlas.json' | relative_url }}">Raw JSON</a>.</p>

    <div class="atlas-controls">
      <p>
        <label for="atlas-search">Search</label>
        <input id="atlas-search" type="search" data-atlas-search placeholder="Name, path, id, or group" autocomplete="off" spellcheck="false">
      </p>
      <p>
        <label for="atlas-kind">Kind</label>
        <select id="atlas-kind" data-atlas-kind>
          <option value="">All kinds</option>
          <option value="test">Test surface</option>
          <option value="guard">Prevention guard</option>
          <option value="decision">Decision record</option>
        </select>
      </p>
      <p>
        <label for="atlas-category">Test category</label>
        <select id="atlas-category" data-atlas-category>
          <option value="">All categories</option>
          <option value="web-unit">Web unit and integration</option>
          <option value="prevention">Prevention</option>
          <option value="cockpit">Cockpit</option>
          <option value="performance">Performance</option>
          <option value="e2e">End to end</option>
          <option value="engine-domain">Engine domain</option>
          <option value="live">Live provider and MCP</option>
          <option value="benchmark">Benchmark</option>
          <option value="guardian">Guardian</option>
          <option value="public">Public smoke suite</option>
        </select>
      </p>
      <p>
        <label for="atlas-disposition">Test disposition</label>
        <select id="atlas-disposition" data-atlas-disposition>
          <option value="">All dispositions</option>
          <option value="canonical-node-test">Canonical node test</option>
          <option value="qualified-external-oracle">Qualified external oracle</option>
          <option value="pending-external-qualification">Pending external qualification</option>
          <option value="non-test-fixture">Non-test fixture</option>
          <option value="not-inventoried">Web surface, not in the engine inventory</option>
          <option value="unknown">Unknown</option>
        </select>
      </p>
      <p>
        <label for="atlas-guard-state">Guard state</label>
        <select id="atlas-guard-state" data-atlas-guard-state>
          <option value="">All guard states</option>
          <option value="complete">All four fields declared</option>
          <option value="incomplete">Incomplete header</option>
        </select>
      </p>
      <p>
        <label for="atlas-decision-state">Decision state</label>
        <select id="atlas-decision-state" data-atlas-decision-state>
          <option value="">All decision states</option>
          <option value="in-force">In force</option>
          <option value="superseded">Superseded</option>
          <option value="standing">Standing</option>
          <option value="pending">Pending</option>
          <option value="partial">Partial</option>
          <option value="done">Done</option>
        </select>
      </p>
      <p>
        <button type="button" data-atlas-reset>Clear filters</button>
      </p>
    </div>

    <p class="atlas-count" data-atlas-count aria-live="polite">No rows rendered yet.</p>

    <div class="callout" data-atlas-no-matches role="status" hidden>
      <p><strong>No entries match these filters.</strong> Clear one filter or the search text. The snapshot may still contain entries outside the current selection.</p>
    </div>

    <div class="floor-table-wrap"><table class="atlas-table">
      <caption class="sr-only">Atlas entries after filtering</caption>
      <thead>
        <tr>
          <th scope="col">Entry</th>
          <th scope="col">Kind</th>
          <th scope="col">Group</th>
          <th scope="col">State</th>
          <th scope="col">Evidence</th>
        </tr>
      </thead>
      <tbody data-atlas-rows></tbody>
    </table></div>

    <div class="callout" data-atlas-stale role="status" hidden>
      <p><strong>This snapshot is older than the page.</strong> Treat its counts as historical. The generated timestamp and source commit are shown with the snapshot.</p>
    </div>
  </div>

  <noscript>
    <div class="callout warning">
      <p><strong>The atlas needs JavaScript.</strong> The generated JSON is available at <a href="{{ '/floor/data/atlas.json' | relative_url }}"><code>{{ '/floor/data/atlas.json' | relative_url }}</code></a>. The test inventory, disposition manifest, guards, and decision records remain readable in the repository.</p>
    </div>
  </noscript>
</section>

## What a row means

| Kind | Source | What the row means | What it does not mean |
|---|---|---|---|
| Test surface | `engine/traceability/s1-test-inventory.json`, `test-surface-dispositions.json`, and the web test tree | A file is recognized as a test surface entry and given one disposition. For engine inventory entries, the test count is the number of test names bound to that file. Web files outside that inventory are marked `not-inventoried`. | That the file ran, passed, or applies to your checkout |
| Prevention guard | `tests/prevention/` headers | A guard declares a failure class, a plant, the driven behavior, and a liveness check. | That the guard is live on the current build or that its plant still exists |
| Decision record | `docs/decisions/*.md` front matter | A rule or decision has an id, a group, a status, and an implementation state. Paths in `acted_in` cite where it was carried out. | That the implementation is correct, complete, or still in force |

## Test categories

| Category | Path | Runner |
|---|---|---|
| Web unit and integration | `tests/unit/` | Vitest |
| Prevention | `tests/prevention/` | Vitest |
| Cockpit | `tests/cockpit/` | Vitest with a browser setup |
| Performance | `tests/performance/` | Vitest |
| End to end | `tests/` | Playwright |
| Engine domain | `engine/test/` | `node:test` |
| Live provider and MCP | `engine/live/` | `node:test`, opt-in |
| Public smoke | `tests/public/` | `node:test` |
| Benchmark | `bench/` | Node harness |
| Guardian | `engine/guardian/tests/` | C and shell |

The category is assigned by the generator from the path and the test surface. The page does not guess it from a filename.

## Dispositions

| Disposition | Meaning | Limit |
|---|---|---|
| `canonical-node-test` | Qualified by the central Node test pattern and run by the inventory-derived runner | The runner may still need a corpus, a service, or a browser |
| `qualified-external-oracle` | A live provider or MCP test, run only with explicit consent and credentials | It is not part of the hermetic run |
| `pending-external-qualification` | Recognized but not yet qualified | It blocks a full-repository test claim |
| `non-test-fixture` | A recognized source that is not a test | It contributes no test count |
| `not-inventoried` | A web test file exists outside the engine inventory | It is listed for inspection and does not contribute an inventoried test count |
| `unknown` | The generator could not classify the entry | It is treated as blocking, never as a pass |

A missing disposition is not a default pass. The generator maps an unrecognized entry to `unknown` and the atlas marks it.

## Prevention guards

A prevention guard is a test that protects a class of regression. Its header states the class, the plant, the driven behavior, and the liveness check. The atlas shows those four fields as declared. If a header omits one, the row is marked incomplete. The generator does not reconstruct a missing field from the test body.

A guard's presence is not proof of liveness. The guard must fail when its plant is reintroduced and pass when it is removed. That check belongs in the run record, not in the inventory.

## Decision records

A decision record carries `id`, `date`, `by`, `group`, `status`, and `implementation`. `status` is `in-force` or `superseded`. `implementation` is `standing`, `pending`, `partial`, or `done`. A pending record names a route; a partial or done record names the paths where it was carried out. The generated `README.md` index is excluded from the atlas count.

The implementation state is maintained by the tracker checker. It is a claim about paths and work, not a runtime proof.

## Filters and states

- Search is case-insensitive and matches the entry id, title, name, path, group, and state.
- Kind restricts the table to tests, guards, or decisions.
- Test category and disposition apply only to test rows.
- Guard state selects guards with a complete or incomplete header.
- Decision state matches either the `status` or the `implementation` value.
- Filters combine with AND. The count reports matching entries out of the snapshot total. Clearing the filters restores the full set.
- The table is sorted by kind, then group, then entry. It renders every matching row and states the filtered total. If an implementation caps the table, it provides visible pagination rather than silently hiding rows.

The page has explicit states:

| State | What the visitor sees |
|---|---|
| Loading | A status line. No counts and no placeholder rows. |
| Ready | Filters, the count, and the table |
| No entries | The snapshot parsed but contains no records. This is not zero tests. |
| No matches | The snapshot has records but the current filters select none |
| Error | The file is missing, unreadable, invalid JSON, or an unsupported schema. The table is withheld. |
| Stale | The snapshot's `generatedAt` is older than the deployed page beyond the build window. A warning is shown; the rows remain visible. |

If any entry fails schema validation, the page withholds the whole table and shows the error. A partial table would make an incomplete snapshot look authoritative.

## What the atlas does not prove

- A test inventory entry is not a test result. The run record is elsewhere.
- A disposition describes how a file is qualified, not whether it passed on your commit.
- A pending qualification blocks a full claim. It does not disappear because the file exists.
- A prevention guard's row does not prove the guard is live.
- A decision marked `done` cites paths. It does not prove the behavior at runtime.
- Counts move with the tree. A snapshot is dated; a stale snapshot is history.

Use the [evidence commands]({{ '/floor/evidence/' | relative_url }}) to run the checks, and the [floor status]({{ '/floor/status/' | relative_url }}) to read the last generated snapshot.
