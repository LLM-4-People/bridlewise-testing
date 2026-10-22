---
layout: default
floor_assets: true
page_class: home
title: "Build, test, and extend Bridlewise"
# BEGIN GENERATED: the site's description, from docs/brand/messaging.json (harness sync)
description: "Where Bridlewise, a free, local-first cockpit for AI coding runs, is built and verified. Every public claim links to the check that backs it, and a claim whose check fails is retracted automatically. Developer preview: not production-ready, not for sensitive code."
# END GENERATED: the site's description
permalink: /
---

<!-- BEGIN GENERATED: the site's front door, from docs/brand/ (harness sync; engine/scripts/brand/cli.ts) -->
<section class="hero">
  <p class="eyebrow">Bridlewise <span class="dot" aria-hidden="true"></span> AGPL-3.0 <span class="dot" aria-hidden="true"></span> Developer preview</p>
  <h1>Every claim comes with a receipt.</h1>
  <p class="lede">Bridlewise is a free, open-source, local-first cockpit for AI coding runs. Every claim it makes about itself links to the check that backs it, and a claim whose check fails is struck out automatically.</p>
  <p class="lede">This repository is the development floor: the source of Bridlewise together with every test, prevention guard, benchmark and decision record. The product repository is projected from it.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/floor/help/' | relative_url }}">Find a way to help</a>
    <a class="button" href="{{ '/floor/roadmap/' | relative_url }}">Read the roadmap</a>
    <a class="button" href="{{ '/floor/claims/' | relative_url }}">Check every claim</a>
    <a class="button" href="https://github.com/LLM-4-People/bridlewise-testing">Open the repository</a>
  </div>
  <p class="hero-note">Developer preview. Not production-ready, not audited, not for sensitive code.</p>
</section>
<!-- END GENERATED: the site's front door -->

<div class="callout-warning" role="note">
<p>Bridlewise is an experimental developer preview. It is not production-ready, and it is not safe for sensitive, proprietary, regulated, or production code. The floor records verification work about Bridlewise. It does not turn Bridlewise into a supported product.</p>
</div>

<section class="section">
  <div class="section-head">
    <p class="eyebrow">Start with the right site</p>
    <h2>This is the floor. The product lives next door.</h2>
    <p class="section-lede">The two repositories have different jobs, so they have different front doors.</p>
  </div>
  <div class="prose">
    <table>
      <thead>
        <tr><th>Site</th><th>What it is for</th><th>Start here</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>Product site</strong></td><td>What Bridlewise is, how to run it, what it refuses, and what it does not prove.</td><td><a href="https://llm-4-people.github.io/bridlewise/">Product home</a> · <a href="{{ '/quickstart/' | relative_url }}">Quickstart mirror</a></td></tr>
        <tr><td><strong>This floor</strong></td><td>How to test the harness, add prevention, reproduce evidence, review a change, and build on the extension points.</td><td><a href="{{ '/floor/help/' | relative_url }}">How to help</a> · <a href="{{ '/floor/roadmap/' | relative_url }}">Roadmap</a></td></tr>
      </tbody>
    </table>
    <p>The complete product documentation is mirrored on this site. The <a href="{{ '/product/' | relative_url }}">product documentation entry point</a> collects the reading paths. The floor pages are additive: they document the machinery behind the product.</p>
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
      <p><a href="{{ '/floor/help/' | relative_url }}">How to help</a> · <a href="https://github.com/LLM-4-People/bridlewise-testing/blob/main/CONTRIBUTING.md">Contributing</a> · <a href="https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22">Good first issues</a> · <a href="https://github.com/LLM-4-People/bridlewise-testing/blob/main/docs/trackers/TASKS.md">Task board</a></p>
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
      <p><a href="https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Aneeds-evidence">Issues needing evidence</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Prevent</p>
      <h3>Add a guard that would have caught it</h3>
      <p>A prevention guard states the class, the plant, the driven behavior, and the liveness check. It must fail on the old behavior and pass on the fix.</p>
      <p><a href="{{ '/testing/' | relative_url }}">Testing guide</a> · <a href="https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Atesting">Testing issues</a></p>
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
      <p><a href="https://github.com/LLM-4-People/bridlewise-testing/issues?q=is%3Aissue+is%3Aopen+label%3Adocumentation">Documentation issues</a></p>
    </article>
    <article class="feature">
      <p class="feature-kicker">Review</p>
      <h3>Read for the failure mode</h3>
      <p>Review the owner, the trust boundary, the failure path, and the evidence. A passing run is necessary, not sufficient. Report vulnerabilities privately.</p>
      <p><a href="{{ '/floor/help/' | relative_url }}">Review checklist</a> · <a href="https://github.com/LLM-4-People/bridlewise-testing/blob/main/SECURITY.md">Security policy</a></p>
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
        <tr><td><strong>M0 · Public floor online</strong></td><td>Done</td><td>Both repositories, Pages, the public gate, failure reporting, promotion, and a prerelease are live.</td></tr>
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
    <pre><code>git clone https://github.com/LLM-4-People/bridlewise-testing.git
cd bridlewise-testing
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
