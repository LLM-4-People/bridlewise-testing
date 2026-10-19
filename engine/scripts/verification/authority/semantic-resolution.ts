import { canonicalDomainHash } from "../../../src/kernel/integrity.ts";
import type { AuthorityRegistry, AuthorityRoute } from "./contracts.ts";
import { staticString } from "./literal-semantics.ts";
import {
  isZodStrictObjectCall,
  zodShape,
  type Shape,
} from "./shape-semantics.ts";
import type { AstNode, ModuleFacts } from "./typescript-adapter.ts";

export type ResolvedAuthority = Readonly<{
  route: AuthorityRoute;
  value: string | Shape;
  semanticFingerprint: string;
  ownerNode: AstNode;
}>;

export function resolveAuthorities(
  registry: AuthorityRegistry,
  modules: ReadonlyMap<string, ModuleFacts>,
  violations: string[],
): ReadonlyMap<string, ResolvedAuthority> {
  const resolved = new Map<string, ResolvedAuthority>();
  for (const route of registry.authorities) {
    const module = modules.get(route.owner.path);
    if (!module) {
      violations.push(`authority_owner_source_missing:${route.id}`);
      continue;
    }
    const localName = module.exports.get(route.owner.exportName);
    if (!localName) {
      violations.push(`authority_owner_export_missing:${route.id}`);
      continue;
    }
    let value: string | Shape | undefined;
    let ownerNode: AstNode | undefined;
    if (route.kind === "literal") {
      const initializer = module.constants.get(localName);
      ownerNode = initializer;
      value = initializer ? staticString(initializer, module.constants, new Set()) : undefined;
    } else {
      const initializer = module.constants.get(localName);
      if (initializer && isZodStrictObjectCall(initializer, module)) {
        ownerNode = initializer;
        value = zodShape(initializer, module, new Set());
      }
    }
    if (value === undefined || ownerNode === undefined) {
      violations.push(`authority_owner_unsupported:${route.id}`);
      continue;
    }
    const semanticFingerprint = canonicalDomainHash(
      route.kind === "literal" ? "authority-graph/literal/v1" : "authority-graph/shape/v1",
      value,
    );
    resolved.set(route.id, { route, value, semanticFingerprint, ownerNode });
  }
  return resolved;
}
