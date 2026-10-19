<script lang="ts">
  /**
   * Probe: a disclosure whose `defaultOpen` prop is fed by a live $state
   * flag the test can flip AFTER mount — the shape the capture-at-mount
   * arm needs (rows arriving while the menu is open must not reorganize a
   * section the reader is reading).
   */
  import Disclosure from "../../../src/cockpit/shell/Disclosure.svelte";

  let present = $state(false);
  let callbacks = 0;

  export function flip(): void {
    present = !present;
  }
  export function readCallbacks(): number { return callbacks; }
  function changed(): void { void present; callbacks += 1; }
</script>

<Disclosure id="sec-mount" label="agents" defaultOpen={present} onOpenChange={changed}>
  <p>the body</p>
</Disclosure>
