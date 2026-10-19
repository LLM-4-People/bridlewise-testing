<script lang="ts">
  /**
   * TEST FIXTURE — drives ONE TurnBeat's beat prop over time.
   *
   * The thinking fold's whole contract is about a TRANSITION (open while the
   * model thinks, folded the instant the answer begins) and about a preference
   * SURVIVING that transition. Testing-library's `rerender` remounts under
   * Svelte 5 runes, and a remount is exactly what would hide a bug where the
   * fold state lived in the component instead of in the module map — so the
   * test has to hand successive beats to the SAME instance, which is what the
   * real flow does (`replaceBeat` → a new beat object into the same keyed row).
   */
  import TurnBeat from "../../../src/cockpit/flow/TurnBeat.svelte";
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

<TurnBeat {beat} />
