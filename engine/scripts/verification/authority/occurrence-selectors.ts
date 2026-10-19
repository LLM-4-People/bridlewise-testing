import type { AuthorityOccurrence } from "./contracts.ts";
import { compareTuple } from "./shared.ts";
import { utf8ByteOffset } from "../../../src/text/utf8-offsets.ts";
import { astNode, type AstNode, type ModuleFacts } from "./typescript-adapter.ts";

/** Stable selector over UTF-8 bytes, independent of UTF-16 parser offsets. */
export function selectorForNode(module: ModuleFacts, node: AstNode, fallback: string): string {
  const occurrence = `@${utf8ByteOffset(module.source.source, Number(node.start ?? -1))}:` +
    `${utf8ByteOffset(module.source.source, Number(node.end ?? -1))}`;
  let current: AstNode | undefined = node;
  while (current) {
    if (current.type === "VariableDeclarator") {
      const id = astNode(current.id);
      if (id?.type === "Identifier") return namedSelector(module, String(id.name), "local", occurrence);
    }
    if (current.type === "TSTypeAliasDeclaration" || current.type === "TSInterfaceDeclaration") {
      const id = astNode(current.id);
      if (id?.type === "Identifier") return namedSelector(module, String(id.name), "type", occurrence);
    }
    current = module.parents.get(current);
  }
  return `${fallback}${occurrence}`;
}

export function compareAuthorityOccurrences(left: AuthorityOccurrence, right: AuthorityOccurrence): number {
  return compareTuple(
    [left.authorityId, left.path, left.selector, left.occurrenceKind, left.role, left.semanticFingerprint],
    [right.authorityId, right.path, right.selector, right.occurrenceKind, right.role, right.semanticFingerprint],
  );
}

export function deduplicateOccurrences(occurrences: readonly AuthorityOccurrence[]): AuthorityOccurrence[] {
  const entries = new Map<string, AuthorityOccurrence>();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([
      occurrence.authorityId, occurrence.path, occurrence.selector, occurrence.occurrenceKind,
      occurrence.role, occurrence.semanticFingerprint,
    ]);
    entries.set(key, occurrence);
  }
  return [...entries.values()];
}

function namedSelector(module: ModuleFacts, localName: string, fallback: string, occurrence: string): string {
  const exported = [...module.exports].find(([, local]) => local === localName)?.[0];
  return `${exported ? "export" : fallback}:${exported ?? localName}${occurrence}`;
}
