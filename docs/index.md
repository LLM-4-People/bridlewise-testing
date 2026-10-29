---
layout: default
# BEGIN GENERATED: the site's title and description, from docs/brand/messaging.json (harness sync)
title: "Bridlewise: Every claim comes with a receipt."
description: "Where Bridlewise, a free, local-first cockpit for AI coding runs, is built and verified. Every public claim links to the check that backs it, and a claim whose check fails is retracted automatically. Developer preview: not production-ready, not for sensitive code."
# END GENERATED: the site's title and description
permalink: /
page_class: home
---

<section class="hero landing-hero">
<div>
<!-- BEGIN GENERATED: the site's front door, from docs/brand/ (harness sync; engine/scripts/brand/cli.ts) -->
  <p class="eyebrow">Bridlewise <span class="dot" aria-hidden="true"></span> AGPL-3.0 <span class="dot" aria-hidden="true"></span> Developer preview</p>
  <h1>Every claim comes with a receipt.</h1>
  <p class="lede">Bridlewise is a free, open-source, local-first cockpit for AI coding runs. Every claim it makes about itself links to the check that backs it, and a claim whose check fails is struck out automatically.</p>
  <p class="lede">This repository is the development floor: the source of Bridlewise together with every test, prevention guard, benchmark and decision record. The product repository is projected from it.</p>
  <div class="actions">
    <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Start with a disposable copy</a>
    <a class="button" href="{{ '/floor/claims/' | relative_url }}">Check every claim</a>
    <a class="button" href="{{ '/floor/roadmap/' | relative_url }}">Read the roadmap</a>
    <a class="button" href="{{ site.repository_url }}">Read the source</a>
  </div>
  <p class="hero-note">Developer preview. Not production-ready, not audited, not for sensitive code.</p>
<!-- END GENERATED: the site's front door -->
</div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's certificate (scripts/floor/landing.ts) -->
<p class="fineprint">The claims are judged when the site is published, from the checks that ran on that commit; their count is written here then.</p>
<!-- END GENERATED AT PUBLISH: the landing's certificate -->
</section>

<section class="part" id="items" aria-labelledby="items-title">
  <span class="part-letter" aria-hidden="true">A<small>A of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part A</p>
    <h2 id="items-title">Items inspected</h2>
    <p class="part-lede">Every claim the project makes, the check bound to it, and the run that judged it. A claim holds only when every check bound to it passed on the published commit; one whose check is red, or did not run there, is struck out until it passes again.</p>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's ledger (scripts/floor/landing.ts) -->
<p>The claims are judged when the site is published. Their source is the claims register, <a href="{{ site.repository_url }}/blob/main/docs/brand/claims.json"><code>docs/brand/claims.json</code></a>.</p>
<!-- END GENERATED AT PUBLISH: the landing's ledger -->
<p class="part-more"><a href="{{ '/floor/claims/' | relative_url }}">Every claim, with the proof you can rerun</a></p>
</section>
<section class="part" id="refusal" aria-labelledby="refusal-title">
  <span class="part-letter" aria-hidden="true">B<small>B of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part B</p>
    <h2 id="refusal-title">A refusal, word for word</h2>
    <p class="part-lede">Call the harness with no subcommand and it refuses with a typed error that lists every verb it has. This is that answer, run when this page was built.</p>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's refusal (scripts/floor/landing.ts) -->
<p>The answer is quoted when the site is published, from the harness itself.</p>
<!-- END GENERATED AT PUBLISH: the landing's refusal -->
</section>
<section class="part" id="run" aria-labelledby="run-title">
  <span class="part-letter" aria-hidden="true">C<small>C of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part C</p>
    <h2 id="run-title">A run, beat by beat</h2>
    <p class="part-lede">Every run is recorded as the same eight beats, each caused by the one before. This one stops at the release gate.</p>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's run (scripts/floor/landing.ts) -->
<p>The run record's beats are drawn when the site is published.</p>
<!-- END GENERATED AT PUBLISH: the landing's run -->
<p class="part-more">This refusal is a documentation example, not a claim; the register in Part A lists what is claimed. <a href="{{ '/run/' | relative_url }}">Open the run record</a></p>
</section>
<section class="part" id="standing" aria-labelledby="standing-title">
  <span class="part-letter" aria-hidden="true">D<small>D of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part D</p>
    <h2 id="standing-title">Where it stands</h2>
    <p class="part-lede">A close counts as shipped only when linked evidence proves it, so the count starts at what is proven, including when that is zero.</p>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's roadmap (scripts/floor/landing.ts) -->
<p>The roadmap is counted when the site is published.</p>
<!-- END GENERATED AT PUBLISH: the landing's roadmap -->
<p class="part-more"><a href="{{ '/floor/roadmap/' | relative_url }}">Read the roadmap</a>: now, next and later, with no dates.</p>
</section>
<section class="part" id="readings" aria-labelledby="readings-title">
  <span class="part-letter" aria-hidden="true">E<small>E of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part E</p>
    <h2 id="readings-title">Test station readings</h2>
    <p class="part-lede">Every check the floor requires, read at the published commit, job by job. A claim bound to a check holds only when its run passed.</p>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's readings (scripts/floor/landing.ts) -->
<p>The checks are read when the site is published.</p>
<!-- END GENERATED AT PUBLISH: the landing's readings -->
<p class="part-more"><a href="{{ '/floor/status/' | relative_url }}">The floor's status</a></p>
</section>
<section class="part" id="built" aria-labelledby="built-title">
  <span class="part-letter" aria-hidden="true">F<small>F of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part F</p>
    <h2 id="built-title">Designed, and built</h2>
    <p class="part-lede">Every decision record says how far it is built. Most of what is designed is not built yet, and the count says so.</p>
  </div>
<figure class="system-figure" tabindex="0">
  {% include figures/decision-status.svg %}
  <figcaption>Counted from the records' front matter when this site was built.</figcaption>
</figure>
<p class="part-more"><a href="{{ '/decisions/' | relative_url }}">Every decision record</a></p>
</section>
<section class="part" id="name" aria-labelledby="name-title">
  <span class="part-letter" aria-hidden="true">G<small>G of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part G</p>
    <h2 id="name-title">Why the name</h2>
  </div>
<!-- BEGIN GENERATED AT PUBLISH: the landing's name (scripts/floor/landing.ts) -->
<p>The dictionary entry is written when the site is published.</p>
<!-- END GENERATED AT PUBLISH: the landing's name -->
</section>
<section class="part" id="cockpit" aria-labelledby="cockpit-title">
  <span class="part-letter" aria-hidden="true">H<small>H of H</small></span>
  <div class="part-head">
    <p class="part-eyebrow">Part H</p>
    <h2 id="cockpit-title">The cockpit</h2>
    <p class="part-lede">Not captured yet. Screens will come from the capture walk, each labelled a fixture replay.</p>
  </div>
<table class="ledger pending"><tbody><tr data-verdict="designed"><td class="no">◇</td><td>Cockpit screens from the capture walk</td><td class="bound">Capture walk<span class="evidence"><a href="{{ site.repository_url }}/blob/main/scripts/capture/cockpit.ts"><code>scripts/capture/cockpit.ts</code></a></span></td><td class="result">Pending</td></tr></tbody></table>
</section>
<nav class="doors" aria-label="Where to go next">
  <ul>
    <li><a href="{{ '/quickstart/' | relative_url }}"><b>Quickstart</b><span>Run it on a disposable copy</span></a></li>
    <li><a href="{{ '/contents/' | relative_url }}"><b>Documentation</b><span>Use it, understand it, check it</span></a></li>
    <li><a href="{{ '/floor/claims/' | relative_url }}"><b>Claims</b><span>Every claim and its run</span></a></li>
    <li><a href="{{ '/floor/roadmap/' | relative_url }}"><b>Roadmap</b><span>Now, next and later, judged</span></a></li>
    <li><a href="{{ '/decisions/' | relative_url }}"><b>Decisions</b><span>Every record, by how far it is built</span></a></li>
    <li><a href="{{ '/security/' | relative_url }}"><b>Security and limits</b><span>What is not proven</span></a></li>
  </ul>
</nav>
