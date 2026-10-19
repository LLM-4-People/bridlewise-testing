<script lang="ts">
  /**
   * TEST FIXTURE — a minimal flow outlet that hands its ShellApi to the
   * test (the shell object is not exported; outlets are the one seam that
   * receives it). Used by shell-composer-seam.test.ts only.
   */
  import type { ShellApi } from "../../../src/cockpit/shell/contract.ts";

  let { shell }: { shell: ShellApi } = $props();

  (globalThis as unknown as { __seamShell?: ShellApi }).__seamShell = shell;
</script>

<div data-testid="seam-probe"></div>
