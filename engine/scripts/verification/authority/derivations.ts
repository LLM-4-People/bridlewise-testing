import type { AuthorityRegistry, AuthoritySource } from "./contracts.ts";
import { codePointCompare, exactPath, nonempty, sameOrdered } from "./shared.ts";

export function validateDerivationGraph(
  registry: AuthorityRegistry,
  sources: readonly AuthoritySource[],
  violations: string[],
): void {
  if (registry.generators.length === 0) {
    violations.push("authority_derivation_inventory_unavailable");
  }
  const authorityIds = new Set(registry.authorities.map((authority) => authority.id));
  const generatorIds = new Set<string>();
  const outputs = new Map<string, string>();
  const sourcePaths = new Set(sources.map((source) => source.path));
  const authorityPaths = new Set(registry.authorities.map((authority) => authority.owner.path));
  for (const generator of registry.generators) {
    if (!nonempty(generator.id) || !exactPath(generator.ownerPath) || generator.outputs.length === 0) {
      violations.push(`authority_generator_orphan:${String(generator.id)}`);
    }
    if (generatorIds.has(generator.id)) violations.push(`authority_generator_duplicate:${generator.id}`);
    generatorIds.add(generator.id);
    if (!sourcePaths.has(generator.ownerPath)) violations.push(`authority_generator_owner_missing:${generator.id}`);
    if (generator.authorityInputs.length === 0) violations.push(`authority_generator_input_missing:${generator.id}`);
    for (const field of [generator.authorityInputs, generator.dependsOn, generator.outputs]) {
      if (new Set(field).size !== field.length || !sameOrdered(field, [...field].toSorted(codePointCompare))) {
        violations.push(`authority_generator_noncanonical:${generator.id}`);
      }
    }
    for (const authorityId of generator.authorityInputs) {
      if (!authorityIds.has(authorityId)) {
        violations.push(`authority_generator_input_orphan:${generator.id}:${authorityId}`);
      }
    }
    for (const output of generator.outputs) {
      if (!exactPath(output)) violations.push(`authority_generator_output_invalid:${generator.id}`);
      if (!sourcePaths.has(output)) violations.push(`authority_generator_output_unproven:${generator.id}:${output}`);
      const previous = outputs.get(output);
      if (previous) violations.push(`authority_generator_writer_duplicate:${output}:${previous}:${generator.id}`);
      outputs.set(output, generator.id);
      if (authorityPaths.has(output)) violations.push(`authority_generator_back_edge:${generator.id}:${output}`);
    }
    // Registry v1 cannot bind an executed generator receipt, so accepting a
    // generator would be a false provenance claim.
    violations.push(`authority_generator_reproducibility_unproven:${generator.id}`);
  }
  for (const generator of registry.generators) {
    for (const dependency of generator.dependsOn) {
      if (!generatorIds.has(dependency)) {
        violations.push(`authority_generator_dependency_orphan:${generator.id}:${dependency}`);
      }
    }
  }
  const graph = new Map(registry.generators.map((generator) => [generator.id, generator.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      violations.push(`authority_generator_cycle:${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}
