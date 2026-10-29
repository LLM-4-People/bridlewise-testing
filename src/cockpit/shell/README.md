# Shell

The cockpit shell: the HORIZON, DESK, ROOMS, and SCOPE grammar — the keyboard chords, routing contract, tab strip, and the seams through which rooms and views are summoned.

## What each file does

- `Brand.svelte` — the brand mark for account and registration surfaces, drawn inline from `brand-mark.ts` in the live theme's tokens.
- `brand-mark.ts` — the one brand-mark geometry (rein, record lines, beam), shared with the icon generator `scripts/generate-pwa-icons.mjs`.

- `annunciator-data.ts` — THE ANNUNCIATOR FEED — what lights the HORIZON.
- `chords.ts` — THE chord formatter — the one owner of on-screen chord spelling.
- `config.ts` — Cockpit shell config — the single home for the shell's tunables.
- `contract.ts` — The shell contract — the only seam between shell and rooms.
- `flow-anchor.ts` — HOLDING THE READER'S PLACE WHEN THE SHELL CHANGES HEIGHT.
- `keyboard.ts` — The complete keyboard grammar.
- `mouse-paths.ts` — GESTURE PATHS — the other kind of mouse path.
- `open-intent.ts` — WHAT THE SWITCH IS BEING ASKED FOR — one bit, owned in one place.
- `outlets.ts` — Outlet discovery — the file-convention seam.
- `right-menu.ts` — The single workspace inspector and its group metadata.
- `room-chords.ts` — ROOM-LOCAL CHORDS — the second keyboard registry.
- `room-visibility.ts` — WHAT IS ON SCREEN — the shell's one answer.
- `room-warm.ts` — WARMING — turning "about to open" into "is open".
- `routing.ts` — THE KEY-ROUTING CONTRACT — who owns a chord.
- `sw-update.ts` — NEW VERSION OF THE COCKPIT — and the running page is told.
- `tab-fit.ts` — WHICH TABS FIT — the arithmetic, kept out of the component.
- `verb-marks.ts` — THE CONTROL MARKS — ok, cancel, add, remove, recycle, restore. One table; recycle/restore pictures live on the token recipe.
- `view-request.ts` — SHELL VIEW, ASKED FOR FROM OUTSIDE THE SHELL.
- `workspace-view.ts` — PER-WORKSPACE SHELL VIEW — what each tab was looking at.
- `ChordGrip.svelte` — THE GRIP — the one mouse-path primitive.
- `ConnectionBlock.svelte` — THE CONNECTION BLOCK — what the cockpit does when disconnected.
- `ContextMenu.svelte` — One entry in a row's context menu.
- `Desk.svelte` — DESK — where all acting happens.
- `GrammarHint.svelte` — The grammar hint — the honesty surface for the keyboard grammar.
- `Disclosure.svelte` — THE DISCLOSURE — the collapsible-section primitive (the right menu's sections).
- `Horizon.svelte` — HORIZON — the only top chrome.
- `NewTabButton.svelte` — THE `+` — one control, two homes.
- `Popover.svelte` — THE POPOVER — the one raised-surface primitive.
- `RightMenuHost.svelte` — THE RIGHT-MENU HOST — the flow's ONE inspector column, two groups (run, arm).
- `RoomHost.svelte` — ROOMS host — full-screen surfaces summoned by key.
- `ScopeHost.svelte` — SCOPE host — the inspector.
- `SideRail.svelte` — THE SIDE RAIL — the flow's right edge; the ONE icon button that opens the single right menu.
- `Splitter.svelte` — SPLITTER — the one draggable hairline between two regions.
- `UpdateChip.svelte` — THE UPDATE CHIP — a running page's one honest sentence.
- `WorkspaceStrip.svelte` — THE TAB STRIP — several projects open at once.

## Where it lives

The folder lives at `src/cockpit/shell/`.

## Extending the workspace inspector

Declare a section address in `shared/routes.ts::INSPECTOR_SECTIONS`: its group, context, plain label and supported action/search words. The body consumes that declaration directly in `Disclosure`; the finder, server validation and `control_interface` discovery derive from it, including sections that have never mounted. Keep action words truthful: stop/cancel does not advertise a resumable pause.

Add the section body to its existing domain component (`RunPane` or `ArmMenuBody`), using the shared `Disclosure` and existing broker/client action owner. Its controls retain `data-action` or `data-verb-id` and meaningful titles. Disclosure provides remembered open state, programmatic opening, focus and scroll landing. Gate capability content by its actual context; project state remains available without a conversation. On-demand reads start from `onOpenChange`, including restored manual choices; closing a body must stop its polling.

For a new group, declare its label, description, optional keyboard chord, context, default and live summary at `right-menu.ts::RIGHT_MENU_GROUPS`, then provide its lazy component loader at `outlets.ts::inspectorBodies`. The exhaustive loader type prevents a group without a body. The generic host derives tabs and summary subscriptions and caches loaded modules. Discovery never mounts hidden bodies. Persist unsaved bounded form input and manual paging through `workspace-view`, so changing tabs does not discard work.

External navigation uses `control_interface` with `action: list_inspector`, or `action: inspect`, `mode: open|close|toggle`, and an optional group or section address. Server and client reject unknown or contradictory addresses. The shared shell request opens the same menu through its normal navigation owner; unavailable context is explained in the inspector. New sections require no host or server action-enum edit.
