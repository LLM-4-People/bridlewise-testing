---
layout: default
permalink: /
page_class: home
---
{%- comment -%}
  THE LANDING. Every word and number below is read from the one messaging
  source and the claims register, judged at the commit this site is built
  from (site.data.brand, written by the site build). Nothing is typed here.
{%- endcomment -%}
{%- assign brand = site.data.brand -%}
{%- assign words = brand.messaging -%}
{%- assign shown = brand.claims | where_exp: "claim", "claim.example" | first -%}

<section class="landing-hero" aria-labelledby="promise">
  <div class="landing-promise">
    <h1 id="promise">{{ words.promise | escape }}</h1>
    <p class="lede">{{ words.summary | escape }}</p>
    <div class="actions">
      <a class="button primary" href="{{ '/quickstart/' | relative_url }}">Run it on a disposable copy</a>
      <a class="button" href="{{ '/floor/claims/' | relative_url }}">Read every receipt</a>
    </div>
  </div>
  {% include claims-receipt.html id="landing-receipt" %}
</section>

<section class="section" aria-labelledby="claims-title">
  <div class="section-head">
    <h2 id="claims-title">What we claim, and the check behind each</h2>
    <p class="section-lede">Each claim names the test or file a stranger can rerun. A claim whose check is red, or did not run on this commit, is struck out until it passes again. What is designed but not built, and what we do not claim, is listed too.</p>
  </div>
  {% include claims-ledger.html claims=brand.claims %}
</section>

{%- if shown %}
<section class="section landing-split" aria-labelledby="refusal-title">
  <div class="section-head">
    <h2 id="refusal-title">When it says no, it says why</h2>
    <p class="section-lede">A refusal is typed: it names the rule and what to do instead, and it never quietly does something else. The answer here is quoted from the code, and the claims register refuses a quote the code does not contain.</p>
  </div>
  <div class="refusal">
    <p class="refusal-call"><span class="refusal-who">The model asks</span><code>{{ shown.example.call | escape }}</code></p>
    <div class="refusal-answer">
      <span class="refusal-who">Bridlewise answers</span>
      <span class="refusal-code">{{ shown.example.code | escape }}</span>
      <p>{{ shown.example.message | escape }}</p>
      <a class="refusal-source" href="{{ shown.example.sourceUrl | escape }}">{{ shown.example.source | escape }}</a>
    </div>
  </div>
</section>
{%- endif %}

<section class="section landing-split" aria-labelledby="name-title">
  <div class="section-head">
    <h2 id="name-title">Why the name</h2>
    <p class="section-lede">{{ words.about.line | escape }}</p>
  </div>
  <div class="definition">
    <p class="definition-word">{{ words.about.word | escape }} <small>{{ words.about.partOfSpeech | escape }}</small></p>
    <p class="definition-sense">{{ words.about.definition | escape }}</p>
    <p class="definition-source"><a href="{{ words.about.sourceUrl | escape }}">{{ words.about.source | escape }}</a></p>
  </div>
</section>

<section class="section landing-doors" aria-labelledby="doors-title">
  <h2 id="doors-title">Where to look next</h2>
  <ul>
    <li><a href="{{ '/quickstart/' | relative_url }}">Quickstart</a><span>Run it on a copy you can lose: Node 24, a provider you can revoke.</span></li>
    <li><a href="{{ '/floor/roadmap/' | relative_url }}">Roadmap</a><span>What is done, what is next and why. No dates are promised.</span></li>
    <li><a href="{{ '/decisions/' | relative_url }}">Decision records</a><span>Every rule in force, and how far each is built.</span></li>
    <li><a href="{{ '/security/' | relative_url }}">Security and limits</a><span>What is protected, and what is not.</span></li>
    <li><a href="{{ site.repository_url }}">The source</a><span>{{ words.license | escape }}. Free, and yours to run.</span></li>
  </ul>
</section>
