<script lang="ts">
  /** TEST FIXTURE — a trivial desk-line occupant (shell-composer-seam). */
  let { label = "line" }: { label?: string } = $props();
</script>

<span data-testid="fixture-line">{label}</span>
