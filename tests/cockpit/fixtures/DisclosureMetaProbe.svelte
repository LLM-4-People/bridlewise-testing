<script lang="ts">
  /**
   * Probe: a disclosure whose meta slot carries a verb — the always-visible
   * adjacent control the accordion pattern expects beside the header.
   */
  import Disclosure from "../../../src/cockpit/shell/Disclosure.svelte";
</script>

<Disclosure id="sec-meta" label="progress">
  {#snippet meta()}
    <button type="button">stop this run</button>
  {/snippet}
  <p>the body</p>
</Disclosure>
