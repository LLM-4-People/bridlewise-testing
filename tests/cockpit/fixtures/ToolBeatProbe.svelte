<script lang="ts">
  /**
   * TEST FIXTURE — drives ONE ToolBeat's beat prop over time.
   *
   * Same reason as TurnBeatProbe: testing-library's `rerender` remounts
   * under Svelte 5 runes, and a remount would hide a bug that lives in
   * instance state (the elapsed clock, the attempt spark skip).
   */
  import ToolBeat from "../../../src/cockpit/flow/ToolBeat.svelte";
  import type { Beat } from "../../../src/cockpit/flow/types.ts";

  let {
    initial,
    register,
  }: {
    initial: Beat;
    register: (set: (b: Beat) => void) => void;
  } = $props();

  let beat = $state<Beat>(initial);
  $effect(() => {
    register((b: Beat) => {
      beat = b;
    });
  });
</script>

<ToolBeat {beat} expanded={false} />
