<script lang="ts">
  /**
   * TEST FIXTURE — drives StreamPulse's `tail` and `stage` props over time.
   *
   * The rail's whole contract is about CHANGE (the head advances once per
   * observed event, and not otherwise), so a test has to feed it a sequence
   * and observe between steps. Testing-library's `rerender` remounts rather
   * than updating in place under Svelte 5 runes, which loses the component's
   * arrival bookkeeping — exactly the state under test.
   *
   * This probe owns both values as `$state` instead and hands the test two
   * setters, so the SAME component instance sees successive values, which is
   * what the real flow does (the streamingTail atom and the wait-stage atom
   * updating in place).
   */
  import StreamPulse from "../../../src/cockpit/flow/StreamPulse.svelte";
  import type { ArrivalChannel } from "../../../src/cockpit/flow/turn-timing.ts";
  import type { WaitStage } from "../../../src/cockpit/flow/wait-stage.ts";

  let {
    register,
    registerStage = undefined,
    registerChannel = undefined,
    registerStartedAt = undefined,
  }: {
    /** Feeds the rail an OBSERVED CHARACTER COUNT — a string is accepted for
     *  the tests that think in text, and its length is what the rail sees. */
    register: (set: (t: string | number) => void) => void;
    registerStage?: ((set: (s: WaitStage) => void) => void) | undefined;
    registerChannel?: ((set: (c: ArrivalChannel | null) => void) => void) | undefined;
    registerStartedAt?: ((set: (at: number | null) => void) => void) | undefined;
  } = $props();

  let chars = $state(0);
  let stage = $state<WaitStage>("idle");
  let channel = $state<ArrivalChannel | null>(null);
  let startedAt = $state<number | null>(null);
  // Registered inside an effect so the callback props are read reactively
  // (a bare call in the component body captures only their initial values).
  $effect(() => {
    register((t: string | number) => {
      chars = typeof t === "string" ? t.length : t;
    });
    registerStage?.((s: WaitStage) => {
      stage = s;
    });
    registerChannel?.((c: ArrivalChannel | null) => {
      channel = c;
    });
    registerStartedAt?.((at: number | null) => {
      startedAt = at;
    });
  });
</script>

<StreamPulse {chars} {stage} {channel} {startedAt} />
