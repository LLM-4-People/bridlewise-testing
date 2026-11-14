<script lang="ts">
  import { onMount, onDestroy, setContext, untrack } from "svelte";
  import { TOOL_PRESENTATION_CONTEXT, toolPresentationByName } from "../../shared/tool-presentation.ts";
  import BeatScope from "../cockpit/flow/BeatScope.svelte";
  import Brand from "../cockpit/shell/Brand.svelte";
  import { activateLog, appendBeat, batch, clearLog, displayedLogId, dropLog, withLog } from "../cockpit/flow/log.ts";
  import { beatIdFor } from "../cockpit/flow/ingest.ts";
  import { consumeBeatRequest, requestBeatAction } from "../cockpit/flow/beat-request.ts";
  import type { Beat } from "../cockpit/flow/types.ts";
  import { applyLocalPrefDefault, cockpitTheme, setLocalPref, THEME_ID } from "../cockpit/settings/local-prefs.ts";
  import { REPLAY_NOTICE, isReplayMapping, validatePublicReplay, type PublicReplay } from "./replay.ts";
  import { replayBeats } from "./projection.ts";
  import { createJourneyProjection, initialJourney, journeyView, transitionJourney, type JourneyAction } from "./journey.ts";
  import { becauseChanged, moves, type MovesParam } from "../cockpit/motion/motion.ts";
  import "../cockpit/tokens.css";

  let { record, embedded = false, workspaceHref, homeHref }: { record: PublicReplay; embedded?: boolean; workspaceHref?: string; homeHref?: string } = $props();
  const fixture = untrack(() => validatePublicReplay(record));
  untrack(() => applyLocalPrefDefault(THEME_ID, "logbook"));
  setContext(TOOL_PRESENTATION_CONTEXT, toolPresentationByName(fixture.tools));
  const previousLogId = displayedLogId();
  const replayLogId = `public-replay:${fixture.source.commit}`;
  const beats = withLog(replayLogId, () => {
    clearLog();
    const projected = replayBeats(fixture);
    batch(() => { for (const beat of projected) appendBeat(beat); });
    return projected;
  });
  activateLog(replayLogId);
  const byId = new Map(beats.map((beat) => [beat.id, beat]));
  const projection = createJourneyProjection(fixture, beats, (id) => beatIdFor({ id }));
  let journey = $state(initialJourney(typeof location === "undefined" ? "" : location.hash, projection));
  let advanced = $state(false);
  let fullRun = $state<Promise<typeof import("../cockpit/flow/Flow.svelte")> | null>(null);
  let presentationRoot: HTMLDivElement | undefined;
  let themeFailure = $state<string | null>(null);
  const view = $derived(journeyView(journey, projection));
  const selected = $derived(byId.get(view.selectedBeatId ?? projection.focusBeatIds[0]!)!);
  let lastSelected = untrack(() => selected.id);
  const recordArrival = $derived.by((): MovesParam => {
    const id = selected.id;
    if (id === lastSelected) return null;
    const previous = lastSelected;
    lastSelected = id;
    return { motion: "arrive", cause: becauseChanged("the selected example result", previous, id) };
  });
  const carbon = $derived($cockpitTheme === "carbon");
  const linkTarget = $derived(embedded ? "_blank" : undefined);
  const sourceUrl = `${fixture.source.repositoryUrl}/tree/${fixture.source.commit}`;

  onDestroy(() => {
    if (displayedLogId() === replayLogId) activateLog(previousLogId);
    dropLog(replayLogId);
  });

  function syncHash(): void {
    if (typeof history === "undefined") return;
    const id = journey.phase === "ready" ? null : journey.selectedBeatId;
    history.replaceState(null, "", id === null ? `${location.pathname}${location.search}` : `#${encodeURIComponent(id)}`);
  }
  function act(action: JourneyAction, reveal = true): void {
    const next = transitionJourney(journey, action, projection);
    if (next === journey) return;
    journey = next;
    syncHash();
    if (next.phase === "ready") consumeBeatRequest();
    else if (reveal && advanced) requestBeatAction(next.selectedBeatId, "reveal");
  }
  function focused(beat: Beat): void { act({ type: "select", beatId: beat.id }, false); }
  function selectBeat(id: string): void { act({ type: "select", beatId: id }); }
  function toggleTheme(): void {
    themeFailure = null;
    try { setLocalPref(THEME_ID, carbon ? "logbook" : "carbon"); }
    catch (error) { themeFailure = error instanceof Error ? error.message : String(error); }
  }

  $effect(() => {
    if (advanced) untrack(() => {
      fullRun ??= import("../cockpit/flow/Flow.svelte");
      const id = view.selectedBeatId;
      if (id !== null) requestBeatAction(id, "reveal");
    });
  });
  onMount(() => {
    const channel = embedded ? window.frameElement?.getAttribute("data-demo-presentation") : null;
    if (!channel || window.parent === window) return;
    const parentOrigin = location.origin;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== parentOrigin || !isReplayMapping(event.data)) return;
      const data = event.data;
      if (Object.keys(data).length !== 2 || data.channel !== channel || typeof data.theme !== "string") return;
      themeFailure = null;
      if (data.theme === cockpitTheme.get()) return;
      try { setLocalPref(THEME_ID, data.theme); }
      catch (error) { themeFailure = error instanceof Error ? error.message : String(error); }
    };
    let lastHeight = 0;
    const measure = () => {
      const height = Math.ceil(presentationRoot?.getBoundingClientRect().height ?? 0);
      if (Number.isFinite(height) && height > 0 && height !== lastHeight) {
        lastHeight = height;
        window.parent.postMessage({ channel, height }, parentOrigin);
      }
    };
    window.addEventListener("message", receive);
    const observer = new ResizeObserver(measure);
    if (presentationRoot !== undefined) observer.observe(presentationRoot);
    measure();
    return () => { window.removeEventListener("message", receive); observer.disconnect(); };
  });
  onMount(() => {
    const changed = () => {
      journey = initialJourney(location.hash, projection);
      if (journey.phase === "ready") consumeBeatRequest();
      else if (advanced) requestBeatAction(journey.selectedBeatId, "reveal");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  });
</script>

{#snippet selectedRecord()}
  <BeatScope beat={selected} projectPath={null} onfocusbeat={selectBeat} showRecordDetails={advanced} fillAvailable />
{/snippet}

{#snippet nextAction()}
  {#if view.canNext}
    <button class="verb primary" type="button" onclick={() => act({ type: "next" })}>{view.finishing ? "Finish the example" : `Next: ${view.nextTitle}`}</button>
  {:else if workspaceHref !== undefined}
    <a class="verb primary" href={workspaceHref} target={linkTarget} rel="noopener noreferrer">Use your own project</a>
  {/if}
{/snippet}

<div class="cockpit public-replay" class:embedded bind:this={presentationRoot}>
  {#if !embedded}
    <header class="replay-header">
      <a class="brand" href={homeHref ?? fixture.source.repositoryUrl}><Brand wordmark={true} /></a>
      {#if workspaceHref !== undefined}<a class="verb" href={workspaceHref}>Use your own project</a>{/if}
      <button class="verb" type="button" onclick={toggleTheme}>{carbon ? "Use light theme" : "Use dark theme"}</button>
    </header>
  {/if}
  {#if themeFailure !== null}<p class="theme-failure" role="alert">{themeFailure}</p>{/if}

  <main>
    <div class="goal">
      <h1>{fixture.title}</h1>
      <p class="fixture-notice" role="note">{REPLAY_NOTICE}</p>
      {#if journey.phase === "ready"}<p class="purpose">{fixture.guide.purpose}</p>{/if}
    </div>

    <section class="story" aria-label="Guided example">
      {#if journey.phase !== "ready"}
        <div class="story-heading" aria-live="polite" aria-atomic="true">
          <span class="progress">{journey.phase === "complete" ? "Example complete" : `Step ${view.stepNumber} of ${view.stepCount}`}</span>
          <h2>{journey.phase === "complete" ? "The change is ready to review." : view.step!.title}</h2>
          <p>{journey.phase === "complete" ? fixture.guide.outcome : view.step!.explanation}</p>
        </div>
      {/if}
      <nav class="story-navigation" aria-label="Example steps">
        {#if journey.phase === "ready"}
          <button class="verb primary" type="button" onclick={() => act({ type: "start" })}>Start the example</button>
          {#if workspaceHref !== undefined}<a class="verb" href={workspaceHref} target={linkTarget} rel="noopener noreferrer">Use your own project</a>{/if}
        {:else}
          {#if view.step?.actionLabel === undefined}{@render nextAction()}{/if}
          <div class="story-utilities" role="group" aria-label="Example navigation utilities">
            <button class="verb" type="button" onclick={() => act({ type: "back" })}>Back</button>
            <button class="verb" type="button" onclick={() => act({ type: "restart" })}>Restart</button>
          </div>
        {/if}
      </nav>
      <nav class="guide-path" aria-label="Example journey">
        <ol>
          {#each projection.steps as step, index}
            <li><button class="section-tab" type="button" aria-current={view.stageIndex === index ? "step" : undefined} onclick={() => selectBeat(projection.focusBeatIds[index]!)}><span class="step-number">{index + 1}</span> <span class="step-label">{step.label ?? step.title}</span></button></li>
          {/each}
        </ol>
      </nav>
      <div class="story-record" use:moves={recordArrival} aria-label={journey.phase === "ready" ? "Example task" : "Selected record"}>
        {#if view.step?.actionLabel !== undefined}
          {#key selected.id}
            <details class="recorded-action">
              <summary>{view.step.actionLabel}</summary>
              {@render selectedRecord()}
              <nav class="story-navigation" aria-label="Continue after the recorded attempt">{@render nextAction()}</nav>
            </details>
          {/key}
        {:else}
          {@render selectedRecord()}
        {/if}
      </div>
    </section>

    <details class="advanced" bind:open={advanced}>
      <summary>Advanced: explore the full run</summary>
      {#if advanced}
        <p>See every message, tool call and file change. Select an item to inspect it above, or follow its cause to see how it fits.</p>
        <div class="flow-surface">
          {#await fullRun}
            <p role="status">Opening the full run…</p>
          {:then component}
            {#if component !== null}<component.default shell={null} ingest={false} onFocus={focused} />{/if}
          {:catch error}
            <p role="alert">The full run could not open. Reload this page to try again. {error instanceof Error ? error.message : String(error)}</p>
          {/await}
        </div>
      {/if}
    </details>

    <details class="evidence">
      <summary>Source and GitHub checks</summary>
      <p>This interface was built from <a target={linkTarget} rel="noopener noreferrer" href={sourceUrl}>{fixture.source.repository}@{fixture.source.commit.slice(0, 8)}</a>{fixture.source.dirty ? " with uncommitted preview changes" : ""}. The example does not prove a check passed. <a target={linkTarget} rel="noopener noreferrer" href="public-replay.json">Inspect the published example data</a>.</p>
      {#if fixture.github === null}
        <p>No GitHub check observation is attached to this build. <a target={linkTarget} rel="noopener noreferrer" href={`${fixture.source.repositoryUrl}/actions`}>Open the repository's checks</a>.</p>
      {:else if fixture.github.availability === "unavailable"}
        <p>GitHub checks were not observed for this build ({fixture.github.reason}). Snapshot prepared <time datetime={fixture.github.attemptedAt}>{fixture.github.attemptedAt}</time>. <a target={linkTarget} rel="noopener noreferrer" href={fixture.source.repositoryUrl + "/actions"}>Open the repository's checks</a>.</p>
      {:else}
        <p>Observed <time datetime={fixture.github.observedAt}>{fixture.github.observedAt}</time> for the linked commit.</p>
        <ul class="check-list">
          {#each fixture.github.checks as check}
            <li><span>{#if check.url !== null}<a target={linkTarget} rel="noopener noreferrer" href={check.url}>{check.title}</a>{:else}{check.title}{/if}</span><span>{check.status}</span></li>
          {/each}
        </ul>
      {/if}
    </details>
  </main>
  {#if !embedded}<footer>Bring your own task to a connected workspace. {#if workspaceHref !== undefined}<a href={workspaceHref}>Set up your project and provider</a>.{/if}</footer>{/if}
</div>

<style>
  :global(html), :global(body) { height: auto; min-height: 100%; overflow: auto; }
  :global(body) { margin: 0; background: var(--ground-0); color: var(--ink-1); font: var(--f-prose-size) / var(--lh-readout) var(--face-sans); }
  :global(*) { box-sizing: border-box; }
  .public-replay { min-height: 100dvh; }
  .replay-header { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); padding: var(--sp-4) var(--page-gutter); border-bottom: var(--hairline-w) solid var(--line-2); }
  .brand { display: inline-flex; align-items: center; gap: var(--sp-2); margin-right: auto; color: var(--ink-1); text-decoration: none; }
  main { max-width: var(--page-max); margin: 0 auto; padding: var(--sp-7) var(--page-gutter) var(--sp-6); }
  .goal { max-width: var(--page-measure); margin-bottom: var(--sp-5); }
  h1 { margin: 0 0 var(--sp-3); font-size: var(--f-display-size); letter-spacing: var(--f-display-track); line-height: var(--f-heading-lh); text-wrap: balance; }
  h2 { margin: var(--sp-2) 0; font-size: var(--f-page-h3); font-weight: var(--f-heading-weight); line-height: var(--f-heading-lh); }
  p { margin: var(--sp-3) 0; max-width: var(--page-measure); }
  .fixture-notice, .progress { color: var(--ink-2); font-size: var(--f-ui-size); }
  .theme-failure { padding: var(--sp-3) var(--page-gutter); color: var(--alarm); }
  .story { border-top: var(--rule-w) solid var(--ink-1); padding: var(--sp-4) 0 0; }
  .story-heading { max-width: var(--page-measure); }
  .story-heading p { margin-bottom: 0; }
  .story-record { border-top: var(--hairline-w) solid var(--line-1); margin-top: var(--sp-4); padding: var(--sp-5) 0; min-width: 0; overflow-wrap: anywhere; }
  .story-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-4); }
  .story-utilities { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .advanced, .evidence { border-top: var(--hairline-w) solid var(--line-2); padding: var(--sp-3) 0; }
  .guide-path { margin-top: var(--sp-3); }
  summary { min-height: var(--hit-min); align-content: center; cursor: pointer; }
  .guide-path ol { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, max(var(--hit-min), var(--demo-step-min-inline))), 1fr)); gap: var(--sp-2); list-style: none; margin: 0; padding: 0; }
  .guide-path li { min-width: 0; }
  .guide-path .section-tab { width: 100%; flex-direction: column; gap: var(--sp-1); padding: var(--sp-1); text-align: center; white-space: normal; overflow-wrap: break-word; }
  .guide-path .step-label { max-width: 100%; }
  .guide-path [aria-current="step"] { color: var(--ink-1); background: var(--layer-select); }
  .step-number { font-variant-numeric: tabular-nums; }
  .flow-surface { height: 60dvh; min-height: calc(var(--hit-min) * 6); }
  a { color: var(--ink-1); text-underline-offset: var(--sp-1); }
  .check-list { list-style: none; margin: var(--sp-4) 0; padding: 0; }
  .check-list li { display: flex; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-2) 0; border-bottom: var(--hairline-w) solid var(--line-1); }
  footer { max-width: var(--page-max); margin: auto; color: var(--ink-2); padding: var(--sp-4) var(--page-gutter); }
  .embedded { min-height: 0; }
  .embedded main { padding: var(--sp-2) var(--sp-3); }
  .embedded h1 { margin-bottom: var(--sp-2); font-size: var(--f-page-h3); letter-spacing: var(--f-page-heading-track); }
  .embedded .fixture-notice { margin-block: var(--sp-2); }
  .embedded .goal { margin-bottom: var(--sp-2); }
  .embedded .story { padding-top: var(--sp-2); }
  .embedded .story-heading { margin-bottom: var(--sp-2); }
  .embedded .guide-path { margin-top: var(--sp-2); }
  .embedded .story-navigation { margin-top: var(--sp-2); }
  .embedded .purpose { display: none; }
  .embedded .story-record { padding-block: var(--sp-4); }
  .embedded .flow-surface { height: var(--demo-flow-h); }
  @media (min-width: 1000px) {
    .public-replay:not(.embedded) main { display: grid; grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.4fr); gap: 0 var(--sp-7); }
    .public-replay:not(.embedded) .goal { grid-column: 1; grid-row: 1 / span 3; }
    .public-replay:not(.embedded) .story, .public-replay:not(.embedded) .advanced, .public-replay:not(.embedded) .evidence { grid-column: 2; }
  }
  @media (max-width: 600px) {
    main { padding-top: var(--sp-5); }
    .replay-header { gap: var(--sp-2); }
    .story-navigation .primary { max-width: 100%; white-space: normal; text-align: left; }
    .flow-surface { height: 50dvh; }
  }
</style>
