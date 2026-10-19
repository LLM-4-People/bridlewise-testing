<script lang="ts">
  /**
   * A room with ONE surface nested inside it — the shape Custody has (a
   * difference opened beside its file list) with none of Custody's data.
   *
   * It integrates exactly the way a real room does: `OutletProps`, and the
   * nested surface declares itself to the shell with `pushDismiss` while it
   * is open. That is the whole registration — no key listener of its own —
   * so tests/cockpit/shell-escape-depth.test.ts is measuring the shell's
   * ladder and not a fixture's private handling of Esc.
   */
  import type { OutletProps } from "../../../src/cockpit/shell/contract.ts";

  let { shell }: OutletProps = $props();

  let open = $state(false);

  $effect(() => {
    if (!open) return;
    return shell.pushDismiss({
      label: "the difference",
      dismiss: () => {
        open = false;
      },
    });
  });
</script>

<button data-testid="open-nested" onclick={() => (open = true)}>see</button>
{#if open}
  <div data-testid="nested">the difference</div>
{/if}
