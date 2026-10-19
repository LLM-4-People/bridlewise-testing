<script lang="ts">
  /**
   * A room stand-in that COUNTS ITS OWN MOUNTS.
   *
   * Keep-alive is only real if the room's component is not re-created on
   * reopen, and the only way to observe that from outside is to have the
   * component itself say how many times it has been constructed. A test that
   * merely checked for a DOM node would pass against a host that unmounted and
   * re-mounted an identical-looking subtree — which is exactly the defect.
   *
   * It also holds a piece of LOCAL state (`typed`), which is what a real room
   * loses on a cold reopen: the switch's expansion set, the settings filter,
   * an open sheet. If keep-alive works, the value survives close/open.
   */
  import { onMount } from "svelte";
  import type { OutletProps } from "../../../src/cockpit/shell/contract.ts";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { shell }: OutletProps = $props();
  void shell;

  type Probe = { mounts: number; destroys: number };
  const probe = ((globalThis as unknown as { __keepAliveProbe?: Probe }).__keepAliveProbe ??= {
    mounts: 0,
    destroys: 0,
  });

  let typed = $state("");

  onMount(() => {
    probe.mounts += 1;
    return () => {
      probe.destroys += 1;
    };
  });
</script>

<input class="probe-field" data-testid="probe-field" bind:value={typed} />
<span data-testid="probe-echo">{typed}</span>
