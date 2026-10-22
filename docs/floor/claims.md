---
layout: default
title: "Claims"
description: "Every claim Bridlewise makes about itself, judged against the checks that ran on the published commit, with what is designed but not built and what is not claimed."
permalink: /floor/claims/
page_class: floor
---
{%- assign brand = site.data.brand -%}

# Claims

<p class="lede">{{ brand.messaging.promise | escape }} Each claim below is judged against the checks that ran on the commit this page was built from. A claim whose check is red, or did not run there, is struck out until it passes again.</p>

{% include claims-receipt.html id="claims-receipt" %}

{% include claims-ledger.html claims=brand.claims %}
