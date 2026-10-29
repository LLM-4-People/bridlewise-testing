# Bridlewise cockpit design

Bridlewise is a coding workspace for operating real conversations, tools and
configuration. The design must make the current truth, available action and
result immediately clear. The September 2026 redesign brief supersedes the
former mouse-first, 24px, rare-color and micro-label direction. Beauty,
expressive color, playful finite feedback and comfortable interaction belong
together with precision and honest state.

Production constants and shared control recipes live in
`src/cockpit/tokens.css`. Existing behavioral owners remain authoritative;
there is no parallel form store, action registry or visual-variant system.
The complete family/consumer ledger is
`research/adaptive-workspace-menu/action-surface-map.md`. Its open population
must remain explicit: a shared recipe reaching a consumer is not proof that
that consumer's composition has been redesigned and tested.

## Interaction proposition

An editable fact opens in place. Keep its name, scope and explanation once.
Join the value and its commit along one open surface, with the terminal action
flush to the field region. Keep the confirmed value and result directly below.
Avoid a box containing another input box and another action card.

A draft remains a draft until confirmed. A pending write owns its target;
continued typing must survive reconciliation. A refused value remains editable.
For numeric bounds, derive a concise correction from the declared domain and
retain the original refusal details. Unknown transport outcomes never imply a
rollback. Non-immediate timing stays beside the value and commit; defaults and
secondary effect detail may use disclosure.

Search brings matching settings into the active surface. Provider forms remain
mounted to preserve drafts while their hidden group leaves the focus/pointer
surface. Choosing their category restores the group. Category navigation and
search remain available at compact widths without a separate settings page.

Connection forms use open labeled fields and related groups. Required name,
address and model entries remain directly available. Optional per-model limits
use native disclosure with summaries of their current values; collapsing never
clears input. Model choice, writes and key handling use the existing owners.

Binary controls use the shared graphical switch beside their visible subject.
Thumb position conveys state without repeated On/Off, Included or Enabled
labels; stable accessible names and checked state preserve nonvisual meaning.
Exceptions, pending work, refusal and material timing remain explicit. Binary
controls must not resemble draggable scales. Native choice/select behavior, keyboard
operation, exact numeric entry, optional scrubbing, copy, and disclosure remain
real capabilities. A channel's name opens its items; a tool's name opens its
canonical description and actual auto-trip threshold. No hover-only essential operation.

Projects use one toolbar New menu with an explicit destination and access to
new-project creation. Context menus retain secondary actions without repeated
visible delete/add buttons. Wide project context sits beside measured
conversation rows; compact groups preserve exact names and wrap metadata.
Sorting is deliberate and search states its loaded-conversation population.
Columns, measured heights, keyboard rows and virtualization share one model.

## Shape, color and typography

Carbon remains the dark ground and Logbook the light ground. Use shared color
roles: accent for a primary decision and focus, green for confirmed/included,
amber for muted/deferred/attention, red for refusal or failure. Text and semantic
shape accompany color. Fill may carry an action; hue is not reserved for live
telemetry. Avoid decorative gradients, nested cards and gratuitous symbols.

Shared controls use an open lower edge and a restrained raised corner. Primary
actions can join a field as a flush terminal face. Related controls use the same
rhythm without pretending that an icon, switch and numeric input are identical.
Use the existing vector mark family; preserve the actual brand mark.

Instrument cells use equal responsive tracks from the shared preferred minimum
width and fill compact space. Content determines height above the shared minimum. Values and real actions must remain visible at enlarged
text sizes; the earlier fixed-height specimen does not override that rule.

Sentence case, concise copy, familiar words. Preserve recorded/user text exactly.
Use sans text for labels and explanatory content; use monospace for values and
code where alignment helps. The editable term is prominent. Essential metadata
must remain legible and must not rely on faint ink. Visual constants remain in
the token owner rather than local literal restatements.

## Responsive and state validation

The shared target floor is 40 CSS pixels in both axes, rising to 44 for coarse
input. Pointer, coarse input,
keyboard and enlarged text are first-class. Break layouts by available space;
allow content to wrap and retain full exact-entry access. Never shrink a target
or hide a material consequence to fit a compact screenshot.

Check real content in dark/light, desktop/compact, coarse/keyboard, enlarged
text and reduced motion. Include dirty, pending, refused, saved, empty, disabled,
long values and optional detail. Measure actual hit centers and overflow.
The shared authority, request ownership, focus and dismissal contracts stay intact.

Motion is finite and event-bound through the existing motion owner. A confirmed
change can receive one brief arrival treatment; idle surfaces do no decorative
work. Honor reduced motion and keep feedback readable after movement ends.
No continuous sparks, polling for animation, or new runtime dependencies.

## Public surfaces

The Pages site, the README images, the social cards and the icons wear the
same system. They read `src/cockpit/tokens.css` through one reader,
`shared/token-reader.ts`, and never restate a value. The site loads a sheet
generated at build time: only the tokens its stylesheets read
(`scripts/floor/site-design.mjs`). The owner's "public page" block adds the few
measures a reading page needs: the page column, the prose measure, a fixed rem
reading ramp and the one fluid display size.

The public site leads in Logbook (paper); Carbon is the remembered alternative.
A page is a logbook page. A section starts on a hairline, and a ledger starts
on a heavy rule with dashed rules between its entries. A receipt is a white
slip with dotted leaders and a mono stamp. A refusal pairs the model's call
(the turn hue on its top edge) with the harness's answer (warn on its top edge,
never the fill). A claim's state is a word in its state ink. Kickers are
sentence case, never tracked capitals. Text is ink-1 or ink-2 only (ink-3 and
ink-4 fail AA on paper). A page computes only token values: the few mixed
inks a page needs (a link's underline, a button's hover, the
search scrim) are tokens in the owner's public-page block, never a mix in a
site sheet.

Three judges hold the site to this system, fastest first:
- the build parses every stylesheet and every layout, include and HTML page
  it hands Jekyll, and refuses what is not this system
  (`scripts/floor/site-style.mjs`): a colour, duration or face that is not a
  token `var()` (with no fallback), a theme or token declared outside the
  owner, a mix, anything imported or fetched from elsewhere, a Sass source,
  and a style or script written into markup;
- the browser enforces the boundary: every page renders through a layout
  (`default`, or `standalone` for a page with its own body) that carries two
  Content-Security-Policies first (`shared/site-page.ts` `sitePolicies`). The
  finish step refuses any served HTML file, in any case of `.html`, `.htm` or
  `.xhtml`, that does not carry them. The origin policy admits only the
  site's origin. The path policy admits only the site's base path on it,
  because the Pages origin is shared by every site of the organisation.
  Together, only files under this site's path load. There is no inline
  script or `<style>`, and the only style attributes are the Markdown table
  alignments, allowed by hash. Path scoping limits what loads, not what
  another site on the shared origin can reach by script; only a dedicated
  origin closes that;
- the rendered judge (`scripts/rendered/`) loads every built page in both
  themes and requires, in what the browser computed:
  - the policy, first and exactly once, with no violation of it;
  - no request leaving the origin;
  - the mark drawn from its geometry;
  - text only in the face stacks;
  - every colour and duration a token's value.

`tests/public/site-design-system.test.mjs` proves each static refusal and
holds the text to 4.5:1 in both themes, and `scripts/rendered/proof.ts`
proves each rendered row on planted breaks.

A reading page is three columns at full width: the documentation's own
navigation (the one navigation source's sections, the current page and its
parent marked), the page at its reading measure, and "On this page" (the
page's rendered second-level headings, shown from three sections up). Below
1360px the outline folds away, and below 1100px the navigation folds into the
header menu and the footer index. A decision record opens with its own front
matter as a header (record id, status, how far it is built, when and by whom
it was decided), and each section heading carries a link to itself.

Figures are generated, never drawn by hand (`shared/figures.ts`), and drawn
inline on the site with `fig-*` classes, so they follow the theme switch. A
figure declared as data lives in `docs/_data/figures/`; a figure that counts
records (the decision-status bar on the development floor) is counted and
drawn when the site is built, and never committed, because a committed count
is an aggregate every change to the records would rewrite (#527). A README
links to the site's figure instead of carrying one. Parts are labelled
directly with their counts, and a hatched part is hatched, so identity is
never carried by colour alone.
