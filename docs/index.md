---
layout: default
# BEGIN GENERATED: the site's title and description, from docs/brand/messaging.json (harness sync)
title: "Bridlewise: Every claim comes with a receipt."
description: "Where Bridlewise, a free, local-first cockpit for AI coding runs, is built and verified. Every public claim links to the check that backs it, and a claim whose check fails is retracted automatically. Developer preview: not production-ready, not for sensitive code."
# END GENERATED: the site's title and description
page_class: home
---

<section class="hero hero-demo">
<!-- BEGIN GENERATED: the site's front door, from docs/brand/ (harness sync; engine/scripts/brand/cli.ts) -->
  <div class="hero-intro">
    <h1>Every claim comes with a receipt.</h1>
    <p class="lede">Bridlewise is a free, open-source, local-first cockpit for AI coding runs. Every claim it makes about itself links to the check that backs it, and a claim whose check fails is struck out automatically.</p>
    <div class="actions">
      <a class="button primary" href="{{ site.data.navigation.demo.href }}" data-site-source="{{ site.data.navigation.demo.sourceRef }}">Try the demo</a>
      <a class="button" href="quickstart.md">Use your own project</a>
    </div>
    <p class="hero-note">An interactive example. No account or installation.</p>
  </div>
<!-- END GENERATED: the site's front door -->

  <div class="hero-workspace">
    <iframe class="hero-demo-frame" src="{{ site.data.navigation.demo.href }}?view=embedded" data-site-source="{{ site.data.navigation.demo.sourceRef }}" title="Try the guided Bridlewise example" height="544" data-demo-presentation="bridlewise-presentation-v1" loading="eager"></iframe>
    <p class="hero-workspace-note">The real interface, with a published example. No model or tool is running.</p>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <h2>Keep going, your way.</h2>
    <p class="section-lede">Start with an example. Bring your own task when you are ready. The work and its evidence stay connected.</p>
  </div>
  <div class="home-paths">
    <article class="home-path">
      <h3>Work on your own project</h3>
      <div>
        <p>Run the workspace locally with your own provider and a disposable repository. The setup guide covers the first account, configuration and limits.</p>
        <p><a href="quickstart.md">Set up a workspace</a> <span aria-hidden="true">·</span> <a href="codespaces.md">Read the Codespaces setup</a></p>
      </div>
    </article>
    <article class="home-path">
      <h3>See the project in the open</h3>
      <div>
        <p>Pull requests hold the changes. Actions hold the checks. Issues and decision records explain what is still open.</p>
        <p><a href="{{ site.repository_url }}/pulls">Review pull requests</a> <span aria-hidden="true">·</span> <a href="{{ site.repository_url }}/actions">Inspect CI</a> <span aria-hidden="true">·</span> <a href="github.md">Explore the GitHub map</a></p>
      </div>
    </article>
    <article class="home-path">
      <h3>Check the evidence</h3>
      <div>
        <p>Each public claim links to its check. See the current result, read the original decision and follow the remaining work.</p>
        <p><a href="floor/claims.md">Check every claim</a> <span aria-hidden="true">·</span> <a href="floor/roadmap.md">Read the roadmap</a> <span aria-hidden="true">·</span> <a href="evidence.md">Inspect the evidence</a></p>
      </div>
    </article>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <h2>One workspace for the whole run.</h2>
    <p class="section-lede">Conversations, tools, file effects and findings share one causal record. Open the full demo to inspect a fact, follow its cause and explore the production interface.</p>
  </div>
  <figure class="screenshot">
    <img src="{{ '/assets/cockpit-flow.png' | relative_url }}" alt="The Bridlewise Flow connects conversation turns, tool calls and their effects in one record" loading="lazy">
    <figcaption>A recorded view of Flow. <a href="{{ site.data.navigation.demo.href }}" data-site-source="{{ site.data.navigation.demo.sourceRef }}">Try the current interface</a> or <a href="design.md">read the design</a>.</figcaption>
  </figure>
</section>

<section class="section">
  <div class="section-head">
    <h2>Know the limits before you run it.</h2>
  </div>
  <div class="callout warning">
    <p><strong>Use a disposable copy, with revocable credentials and your own backups.</strong> Bridlewise is a developer preview. The engine is pre-admission: <code>harnessReady</code> is <code>false</code>, and there has been no security audit. Expect breaking changes and data loss.</p>
    <p><a href="security-and-limits.md">Read the security model and limits</a> <span aria-hidden="true">·</span> <a href="known-issues.md">See known issues</a></p>
  </div>
</section>

<section class="section cta">
  <h2>Try it. Inspect it. Help shape it.</h2>
  <p>The example is ready to explore. The source, checks and unfinished work are public.</p>
  <div class="actions">
    <a class="button primary" href="{{ site.data.navigation.demo.href }}" data-site-source="{{ site.data.navigation.demo.sourceRef }}">Try the demo</a>
    <a class="button" href="contribute.md">Find a way to contribute</a>
    <a class="button" href="{{ site.repository_url }}">Read the source</a>
  </div>
</section>
