<script lang="ts">
  /**
   * TEST FIXTURE — a minimal desk-panel outlet. Used by
   * desk-open-close.test.ts to observe WHEN the open-desk outlet mounts
   * (the one-reveal law + the open/close gestures), without pulling the
   * real panel's block reads into the shell harness.
   */
  import type { ShellApi } from "../../../src/cockpit/shell/contract.ts";
  import { SHELL_CONTEXT_KEY } from "../../../src/cockpit/shell/contract.ts";
  import { getContext } from "svelte";

  let { shell = getContext<ShellApi>(SHELL_CONTEXT_KEY) }: { shell?: ShellApi } = $props();
  const mounted = $derived(shell !== null && shell !== undefined);
</script>

<div data-testid="desk-panel-probe" data-shell={mounted ? "yes" : "no"}>
  <input aria-label="Retained editor draft" />
  <button data-testid="desk-source-probe" onclick={() => shell.openScope({ title: "Context source" })}>Read source</button>
</div>
