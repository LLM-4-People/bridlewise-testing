---
layout: default
page_class: home
title: "Build, test, and extend Bridlewise"
description: "The Bridlewise contributor hub: how to help, how to build on the harness, and the milestones ahead."
permalink: /contribute/
---

<section class="hero">
  <p class="eyebrow">Development floor <span class="dot" aria-hidden="true"></span> Contributor hub <span class="dot" aria-hidden="true"></span> AGPL-3.0</p>
  <h1>Build the harness.<br><span class="beam-text">Break it honestly.</span></h1>
  <p class="lede">Bridlewise is built in the open, in one repository. Next to the product it carries the tests, prevention guards, benchmarks, decision records, and verification machinery. This page is where contributors start.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/floor/help/' | relative_url }}">Find a way to help</a>
    <a class="button" href="{{ '/floor/roadmap/' | relative_url }}">Read the roadmap</a>
    <a class="button" href="{{ site.repository_url }}">Open the repository</a>
  </div>
  <p class="hero-note">Node 24 · Linux first · public gate green · full suite incomplete · not production-ready</p>
</section>

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. It is not production-ready, and it is not safe for sensitive, proprietary, regulated, or production code. The floor records verification work about Bridlewise. It does not turn Bridlewise into a supported product.</p>
</div>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">One repository</p>
    <h2>The product and its floor live together.</h2>
    <p class="section-lede">One repository, one site, one set of checks. The product is a projection of the same tree, never a second copy.</p>
  </div>
  <div class="prose">
    <table>
      <thead>
        <tr><th>Part</th><th>What it is for</th><th>Start here</th></tr>
      </thead>
      <tbody>
        <tr><td><strong><code>main</code></strong></td><td>The source: the product code, its tests, guards, benchmarks, decisions, and evidence records. Every change lands here through a pull request.</td><td><a href="{{ site.repository_url }}">Repository</a> · <a href="{{ '/floor/help/' | relative_url }}">How to help</a></td></tr>
        <tr><td><strong><code>product</code></strong></td><td>The shipped tree, projected from <code>main</code> after each land. Releases are tagged on it.</td><td><a href="{{ site.repository_url }}/releases">Releases</a> · <a href="{{ '/quickstart/' | relative_url }}">Quickstart</a></td></tr>
        <tr><td><strong>This site</strong></td><td>The product documentation and the floor pages, built from <code>docs/</code> on <code>main</code>. Each release keeps its own documentation.</td><td><a href="{{ '/' | relative_url }}">Product home</a> · <a href="{{ site.versions_url }}">Versions</a></td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Three ways in</p>
    <h2>Contribute. Build. Verify.</h2>
    <p class="section-lede">Pick the path that matches the work you want to do. Each one starts with a public command, not a promise.</p>
  </div>
  <div class="feature-grid">
    <article class="feature">
      <p class="feature-kicker">01 · Contribute</p>
      <h3>Make the floor stronger</h3>
      <p>Reproduce a failure, add a prevention guard, improve a benchmark, fix a flaky test, or make the docs match the command output. The issue labels name the evidence needed.</p>
      <p><a href="{{ '/floor/help/' | relative_url }}">How to help</a> · <a href="{{ site.repository_url }}/blob/main/CONTRIBUTING.md">Contributing</a> · <a href="{{ site.repository_url }}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22">Good first issues</a> · <a href="{{ site.repository_url }}/blob/main/docs/trackers/TASKS.md">Task board</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">02 · Build</p>
      <h3>Extend the harness</h3>
      <p>Add a governed tool, a block, a provider, an MCP server, a quality check, or an embedding. The extension points and typed refusals are part of the shipped tree.</p>
      <p><a href="{{ '/extending/' | relative_url }}">Building on the harness</a> · <a href="{{ '/architecture/' | relative_url }}">Architecture</a> · <a href="{{ '/cli/' | relative_url }}">CLI</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">03 · Verify</p>
      <h3>Check the claim</h3>
      <p>Run the public gate, inspect the test atlas, read the status snapshot, or rerun an evidence command. A green badge is a pointer, not a proof.</p>
      <p><a href="{{ '/floor/evidence/' | relative_url }}">Evidence commands</a> · <a href="{{ '/floor/status/' | relative_url }}">Status</a> · <a href="{{ '/floor/atlas/' | relative_url }}">Atlas</a></p>
    </article>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">How to help</p>
    <h2>Useful work, with a visible finish line.</h2>
    <p class="section-lede">The roadmap is grouped by outcome, not by a wish list. These are the lanes where a contribution can move a milestone.</p>
  </div>
  <div class="feature-grid">
    <article class="feature">
      <p class="feature-kicker">Reproduce</p>
      <h3>Turn a report into a failing test</h3>
      <p>Capture the exact command, the typed error, the run id, and the smallest disposable fixture. Redact secrets and private code. A reproduction is the start of the fix.</p>
      <p><a href="{{ site.repository_url }}/issues?q=is%3Aissue+is%3Aopen+label%3Aneeds-evidence">Issues needing evidence</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Prevent</p>
      <h3>Add a guard that would have caught it</h3>
      <p>A prevention guard states the class, the plant, the driven behavior, and the liveness check. It must fail on the old behavior and pass on the fix.</p>
      <p><a href="{{ '/testing/' | relative_url }}">Testing guide</a> · <a href="{{ site.repository_url }}/issues?q=is%3Aissue+is%3Aopen+label%3Atesting">Testing issues</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Make it reproducible</p>
      <h3>Shard, fetch, and merge the floor</h3>
      <p>The full suite is too slow for one host and too dependent on external fixtures. Help build the shard contract, the corpus manifest, and the single merged receipt.</p>
      <p><a href="{{ '/floor/roadmap/' | relative_url }}">Milestone M1</a> · <a href="{{ '/testing/' | relative_url }}">Full-suite prerequisites</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Build</p>
      <h3>Extend a real boundary</h3>
      <p>Provider conformance, MCP transport, platform path handling, quality packs, and embedding contracts are all open work. Add the test at the layer that owns the behavior.</p>
      <p><a href="{{ '/extending/' | relative_url }}">Extension points</a> · <a href="{{ '/architecture/' | relative_url }}">Architecture</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Document</p>
      <h3>Make the record match the code</h3>
      <p>Commands, config keys, routes, and user-visible behavior change. The docs and the release evidence must change with them. A broken example is a bug.</p>
      <p><a href="{{ site.repository_url }}/issues?q=is%3Aissue+is%3Aopen+label%3Adocumentation">Documentation issues</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Review</p>
      <h3>Read for the failure mode</h3>
      <p>Review the owner, the trust boundary, the failure path, and the evidence. A passing run is necessary, not sufficient. Report vulnerabilities privately.</p>
      <p><a href="{{ '/floor/help/' | relative_url }}">Review checklist</a> · <a href="{{ site.repository_url }}/blob/main/SECURITY.md">Security policy</a></p>
    </article>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Roadmap</p>
    <h2>A milestone is a state of evidence.</h2>
    <p class="section-lede">No dates. Each milestone names what must be true before the next one can be claimed. The <a href="{{ '/floor/roadmap/' | relative_url }}">full roadmap</a> carries the workstreams and exit criteria.</p>
  </div>
  <div class="prose">
    <table>
      <thead>
        <tr><th>Milestone</th><th>State</th><th>What must be true</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>M0 · Public floor online</strong></td><td>Done</td><td>The public repository, Pages, the public gate, failure reporting, promotion, and a prerelease are live.</td></tr>
        <tr><td><strong>M1 · Reproducible, sharded floor</strong></td><td>Active</td><td>A documented full-suite workflow runs on shards, merges into one receipt, and every canonical test file runs once.</td></tr>
        <tr><td><strong>M2 · Admission evidence</strong></td><td>Next</td><td>Readiness is reported per capability, with the evidence and remedy attached. A single boolean is not enough.</td></tr>
        <tr><td><strong>M3 · Product hardening</strong></td><td>Next</td><td>Backup and restore are one verified flow; provider coverage, portability, scale, and accessibility still need tested failure paths.</td></tr>
        <tr><td><strong>M4 · Sustainable contribution</strong></td><td>Active</td><td>A new contributor can go from clone to a merged test or docs change using only public instructions.</td></tr>
      </tbody>
    </table>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Build on the harness</p>
    <h2>The extension points are contracts.</h2>
    <p class="section-lede">The engine is not a closed chat loop. It exposes governed seams, and each seam has a refusal path when it is not configured.</p>
  </div>
  <div class="prose">
    <ul>
      <li><strong>Tools and blocks.</strong> One registry, one executor, typed pre-dispatch checks, and explicit blockers. Add the manifest and the executor together.</li>
      <li><strong>Providers.</strong> The Responses path is primary. A Chat Completions adapter is supported where the protocol matches. No universal compatibility claim.</li>
      <li><strong>MCP.</strong> Stdio, Streamable HTTP, and WebSocket transports, with Landlock confinement for stdio where the host exposes it.</li>
      <li><strong>Quality and language packs.</strong> Typed checks that report findings and deltas, not silent pass states.</li>
      <li><strong>Embedding.</strong> The engine barrel is public. The server and cockpit stay separate from domain logic.</li>
    </ul>
    <p>Read <a href="{{ '/extending/' | relative_url }}">Building on the harness</a> for the contracts, then add the test at the layer that owns the behavior. The <a href="{{ '/testing/' | relative_url }}">testing guide</a> explains where each test belongs.</p>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">First ten minutes</p>
    <h2>Run the public gate before you change anything.</h2>
  </div>
  <div class="prose">
    <pre><code>git clone {{ site.repository_url }}.git
cd bridlewise
npm ci
npm --prefix engine ci
npm run bootstrap:hooks
chmod 600 engine/bridlewise.config.json
npm run typecheck
npm --prefix engine run typecheck
npm run test:public</code></pre>
    <p>The public gate is the part that works on a fresh clone. The corpus-backed suites and the live provider suite have named prerequisites and are not silently skipped. Read <a href="{{ '/testing/' | relative_url }}">the testing guide</a> before claiming a full run.</p>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">What this site does not prove</p>
    <h2>Unknown is not green.</h2>
  </div>
  <div class="prose">
    <ul>
      <li><strong>A green public gate is not the full suite.</strong> It proves the configured public steps passed at one commit.</li>
      <li><strong>The full suite is not yet reproducible from a fresh clone.</strong> The external corpus, the performance report, Chromium, systemd, OpenSSL, and Landlock are separate prerequisites.</li>
      <li><strong>Counts move.</strong> The atlas and status snapshot are dated. Treat an old snapshot as history.</li>
      <li><strong>There is no security audit.</strong> No third-party review, penetration test, or certification exists.</li>
      <li><strong>The floor is not permission.</strong> Do not point the preview at a codebase you cannot lose.</li>
    </ul>
  </div>
</section>
