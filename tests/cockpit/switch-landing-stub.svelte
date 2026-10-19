<script lang="ts">
  /**
   * Static Switch stand-in for the jsdom boot-owner. The real Switch
   * keep-alive I/O would mutate after reveal; this stub has no I/O so the
   * stillness window can still prove one-reveal, while loadRoom("switch")
   * returning a component proves the landing assignment is in the frame.
   */
  import type { OutletProps } from "../../src/cockpit/shell/contract.ts";
  let { shell: _shell }: OutletProps = $props();
</script>

<div data-landing="switch">project room</div>
