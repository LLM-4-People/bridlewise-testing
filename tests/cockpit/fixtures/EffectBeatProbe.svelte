<script lang="ts">
  /**
   * TEST FIXTURE — renders ONE EffectBeat the way the flow does.
   *
   * Same reason as ToolBeatProbe: the flow's virtualizer re-reads the beat
   * from the log on every `logVersion` bump and hands the fresh value down
   * as a prop (log.ts keeps the beats themselves outside reactive state),
   * and testing-library's `rerender` remounts under Svelte 5 runes — a
   * remount would hide a bug that lives in the fetch→updateBeat→re-read
   * loop this probe exists to exercise. The probe subscribes to the
   * version counter and re-reads the beat by id, which is the production
   * contract for one row.
   */
  import EffectBeat from "../../../src/cockpit/flow/EffectBeat.svelte";
  import { beatById, logVersion } from "../../../src/cockpit/flow/log.ts";
  import type { Beat } from "../../../src/cockpit/flow/types.ts";

  let {
    initial,
    projectPath,
  }: {
    initial: Beat;
    projectPath: string;
  } = $props();

  const beat = $derived.by(() => {
    void $logVersion;
    return beatById(initial.id) ?? initial;
  });
</script>

<EffectBeat {beat} expanded={false} {projectPath} />
