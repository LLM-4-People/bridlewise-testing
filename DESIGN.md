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
ink-4 fail AA on paper). The site build parses every stylesheet it hands
Jekyll and refuses one that is not this system (`scripts/floor/site-style.mjs`):
every colour, duration and face is a token `var()` with no fallback, the
themes and tokens are declared only in the owner, nothing is imported or
fetched from elsewhere, and the sheets are plain CSS.
`tests/public/site-design-system.test.mjs` proves each refusal and holds the
text to 4.5:1 in both themes.

Figures are generated, never drawn by hand (`shared/figures.ts`). A figure for
a README is a light/dark SVG pair in concrete token colours behind a
`<picture>`, with its facts repeated as a sentence beside it. The decision
index's status bar is one: it is written with the index, from the same
records. A figure on the site is declared as data (`docs/_data/figures/`) and
drawn inline with `fig-*` classes, so it follows the theme switch. Parts are
labelled directly with their counts, and a hatched part is hatched, so
identity is never carried by colour alone.
