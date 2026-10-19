<script lang="ts">
  /**
   * FLOW DEV HARNESS — standalone mount for dev verification ONLY (the
   * shell integrates via the outlet convention; this page exists so the
   * flow, desk internals, grammars and bead can be exercised and profiled
   * without the shell). Served at /cockpit-dev.html by the vite dev server.
   *
   * Two modes:
   *   synthetic — N clearly-labeled synthetic beats straight into the log
   *               (ingestion off) for virtualizer/scroll profiling;
   *   live      — real auth + real project/chat + real runs through the
   *               surviving data layer (client.ts → stores → ingest).
   */
  import {
    checkAuthStatus,
    listProjects,
    listChats,
    loadChatHistory,
    getUiSchema,
    listChatAutoChecks,
    scopeAutoChecks,
  } from "../../../client.ts";
  import { projects, selectProject, currentProject } from "../../../state/projects.ts";
  import { chatChanges, chatsSnapshot, selectChat, currentChatId } from "../../../state/chats.ts";
  import { isStreaming } from "../../../state/chat-messages.ts";
  import { appendBeat, batch, clearLog, beatCount, logVersion } from "../log.ts";
  import { resetIngest } from "../ingest.ts";
  import { grammarMenuFor, routeComposerSubmission } from "../composer-router.ts";
  import { syntheticBeats } from "./synthetic.ts";
  import Flow from "../Flow.svelte";
  import DeskGauge from "../../desk/Gauge.svelte";
  import type { ShellApi } from "../../shell/contract.ts";

  let mode = $state<"idle" | "synthetic" | "live">("idle");
  let authed = $state(false);
  let statusLine = $state("");
  let composerValue = $state("");
  let keystrokeEchoMs = $state<number | null>(null);

  const projectList = $derived($projects);
  const chatList = $derived.by(() => { void $chatChanges; return chatsSnapshot(); });

  // A minimal ShellApi so the flow's shell path is exercised standalone.
  const fakeShell: ShellApi = {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: (req) => {
      statusLine = `scope: ${req.title}`;
    },
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: (t) => {
      statusLine = t;
    },
    composerText: () => composerValue,
    onComposerSubmit: () => () => {},
    prefillComposer: (text) => {
      composerValue = text;
    },
    clearComposer: (sent) => {
      // The same exact-snapshot semantics the real shell implements — the
      // dev harness renders the real Flow, so its box must honor the same
      // contract or the harness silently diverges from the product.
      composerValue =
        composerValue === sent
          ? ""
          : composerValue.startsWith(sent)
            ? composerValue.slice(sent.length)
            : composerValue;
    },
    restoreComposerText: (text) => {
      composerValue = text + composerValue;
    },
    // The harness renders its own menu from the same grammarMenuFor —
    // no per-keystroke fan-out needed here.
    onComposerChange: () => () => {},
    // The harness keeps its own desk row; the flow's docked line renders
    // in the shell only.
    setDeskLine: () => {},
  };

  async function boot(): Promise<void> {
    const status = await checkAuthStatus();
    authed = status.authenticated;
    if (authed) await loadPlaces();
  }
  void boot();

  async function loadPlaces(): Promise<void> {
    await Promise.all([listProjects(), getUiSchema().catch(() => null)]);
  }

  async function openChat(projectId: string, chatId: string): Promise<void> {
    resetIngest();
    clearLog();
    selectProject(projectId);
    selectChat(chatId);
    await loadChatHistory(chatId);
    scopeAutoChecks(projectId, chatId);
    await listChatAutoChecks(chatId).catch(() => null);
    mode = "live";
    statusLine = `live: chat ${chatId} loaded (${beatCount()} beats after ingest)`;
  }

  async function pickProject(projectId: string): Promise<void> {
    selectProject(projectId);
    await listChats(projectId);
  }

  function loadSynthetic(n: number): void {
    resetIngest();
    clearLog();
    const beats = syntheticBeats(n);
    const t0 = performance.now();
    batch(() => {
      for (const b of beats) appendBeat(b);
    });
    const ms = performance.now() - t0;
    mode = "synthetic";
    statusLine = `synthetic: ${n.toLocaleString()} beats appended in ${ms.toFixed(1)}ms (log v${logVersion.get()})`;
  }

  // ── Composer (harness-local; the shell owns the real one) ────────────────

  function onComposerInput(): void {
    // Keystroke → paint budget (<16ms): measure the echo of THIS keystroke.
    const t0 = performance.now();
    requestAnimationFrame(() => {
      keystrokeEchoMs = performance.now() - t0;
    });
  }

  // The SAME live-menu derivation the shell path uses (composer-router).
  const grammarMenu = $derived(grammarMenuFor(composerValue));

  async function submit(): Promise<void> {
    const text = composerValue;
    composerValue = "";
    const outcome = await routeComposerSubmission(text, {
      projectId: $currentProject?.id ?? null,
      chatId: $currentChatId,
      projectPath: $currentProject?.path ?? null,
    });
    if (outcome.message.length > 0) statusLine = `${outcome.kind}: ${outcome.message}`;
    else statusLine = outcome.kind;
  }

  function prefill(text: string): void {
    composerValue = text;
  }
</script>

<div class="cockpit harness">
  <header class="bar">
    <span class="engraved">flow dev harness — not a product surface</span>
    <button onclick={() => loadSynthetic(5000)}>Synthetic 5k</button>
    <button onclick={() => loadSynthetic(500)}>Synthetic 500</button>
    {#if authed}
      {#each projectList as p (p.id)}
        <button onclick={() => void pickProject(p.id)}>{p.name}</button>
      {/each}
      {#each chatList as c (c.id)}
        <button onclick={() => void openChat(c.projectId, c.id)}>{c.title}</button>
      {/each}
    {/if}
    <span class="status">{statusLine}</span>
  </header>

  {#if !authed}
    <div class="login">
      <span class="engraved">no session — sign in on the main page first (the harness reuses the same-origin session; sign-in rendering stays with its one owner)</span>
      <button onclick={() => void boot()}>Re-check session</button>
    </div>
  {/if}

  <main class="flow-area">
    <Flow shell={fakeShell} {prefill} ingest={mode === "live"} />
  </main>

  <footer class="desk">
    {#if grammarMenu.length > 0}
      <ul class="menu">
        {#each grammarMenu as item (item.head)}
          <li><span class="head">{item.head}</span> <span class="detail">{item.detail}</span></li>
        {/each}
      </ul>
    {/if}
    <div class="desk-row">
      <span class="chip">{composerValue.startsWith("?") ? "ask" : composerValue.startsWith("/") ? "command" : "say"}</span>
      <input
        class="composer"
        name="composer"
        placeholder="message · ? ask · / command"
        bind:value={composerValue}
        oninput={onComposerInput}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <DeskGauge shell={fakeShell} />
      {#if keystrokeEchoMs !== null}
        <span class="echo" title="measured keystroke → next frame">{keystrokeEchoMs.toFixed(1)}ms</span>
      {/if}
      {#if $isStreaming}<span class="live">streaming</span>{/if}
    </div>
  </footer>
</div>

<style>
  .harness {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--ground-0);
    color: var(--ink-1);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-3);
    border-bottom: var(--hairline-w) solid var(--line-2);
    background: var(--ground-2);
    flex-wrap: wrap;
  }
  .status {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-2);
    margin-left: auto;
  }
  button {
    background: var(--ground-3);
    color: var(--ink-1);
    border: var(--hairline-w) solid var(--line-2);
    border-radius: var(--radius-1);
    font: inherit;
    font-size: var(--f-data-size);
    padding: var(--sp-0) var(--sp-2);
    cursor: pointer;
  }
  button:hover { background: var(--layer-hover); }
  .login {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    padding: var(--sp-3);
    border-bottom: var(--hairline-w) solid var(--line-1);
  }
  input {
    background: var(--ground-1);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    color: var(--ink-1);
    font: inherit;
    padding: var(--sp-1) var(--sp-2);
    caret-color: var(--beam);
  }
  .flow-area {
    flex: 1;
    min-height: 0;
  }
  .desk {
    border-top: var(--hairline-w) solid var(--line-2);
    background: var(--ground-2);
    padding: var(--sp-2) var(--sp-3);
  }
  .menu {
    list-style: none;
    margin: 0 0 var(--sp-1);
    padding: var(--sp-1) var(--sp-2);
    background: var(--ground-3);
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    max-height: var(--menu-max-h);
    overflow-y: auto;
  }
  .menu .head { color: var(--ink-1); }
  .menu .detail { color: var(--ink-3); }
  .desk-row {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  /* The grammar-echo chip is the owned chip recipe (tokens.css) plus a
   * hairline edge; the harness has no outcome to report, so the ink stays
   * the quiet fallback. */
  .chip {
    border: var(--hairline-w) solid var(--line-1);
    border-radius: var(--radius-1);
    padding: var(--sp-0) var(--sp-1);
  }
  .composer {
    flex: 1;
  }
  .echo, .live {
    font-family: var(--face-mono);
    font-size: var(--f-data-size);
    color: var(--ink-3);
  }
  .live { color: var(--beam); }
</style>
