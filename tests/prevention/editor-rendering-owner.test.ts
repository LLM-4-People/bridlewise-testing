// @vitest-environment node
/**
 * Prevention test: HTML-preview CSP single ownership.
 *
 * What survives of the old editor-rendering owner: the CSP+srcdoc security
 * policy has ONE owner. The old EditorPanel/FileTreeNode classes (A–L)
 * died with the old tree — the cockpit editor room carries its own owners
 * in tests/cockpit/editor-render-owner.test.ts. What must NOT come back is
 * a second copy of the content-security policy: a component that
 * re-declares the CSP meta (instead of importing CSP_META /
 * sandboxedSrcdoc) is a scattered-helper bypass, and the policy would
 * drift between consumers.
 *
 * The scan walks ALL of `src/` (dynamic discovery — a new component is
 * auto-covered), so a re-declared CSP anywhere in the client tree fails,
 * not only in the directory the old owner happened to live in.
 *
 * Mutation-verified: pasting the CSP meta string into a second component
 * makes the scan fail; removing an exported half from either owner makes
 * the split-owner test fail.
 */
import { describe, test, expect } from "vitest";
import { read, sourceFiles, stripCommentsOnly } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const SRC_ROOT = "src";
const HTML_PREVIEW = modulePath("html-preview.ts");

const SRC_FILES = sourceFiles(SRC_ROOT);

describe("Frontend editor rendering owner", () => {
  describe("M. HTML-preview CSP is single-owner (CSP_META only in html-preview.ts)", () => {
    test("the CSP meta string is defined ONLY in cockpit/render/html-preview.ts", () => {
      // The CSP meta content (connect-src 'none') is the critical
      // data-exfiltration block. A component that re-declares it (instead
      // of importing CSP_META / sandboxedSrcdoc) is a scattered-helper
      // bypass — the security policy could drift between consumers.
      const cspFingerprint = "connect-src 'none'";
      const violators = SRC_FILES.filter((p) => {
        if (p === HTML_PREVIEW) return false;
        // Scan stripped code (comments/strings removed) so a doc comment
        // mentioning CSP does not trigger. NOTE: the CSP meta is itself a
        // string literal — stripCommentsAndStringsFor empties string
        // interiors, so a real `const CSP_META = '...connect-src...'`
        // becomes `const CSP_META = ` (the fingerprint is inside the
        // stripped string). So scan the RAW source for the fingerprint but
        // exclude comments by stripping comments only.
        const raw = read(p);
        // Quick reject: if the fingerprint isn't even in the raw source,
        // no need to check further.
        if (!raw.includes(cspFingerprint)) return false;
        // Strip line + block comments (keep strings) so a comment
        // describing the CSP does not trigger.
        const noComments = stripCommentsOnly(raw);
        return noComments.includes(cspFingerprint);
      });
      expect(
        violators,
        `non-html-preview files containing the CSP meta string: ${violators.join(", ")}`,
      ).toEqual([]);
    });

    test("the split owners export their halves: CSP composer in the renderer, token hardener in contracts", () => {
      // The html-preview split: the CSP composer lives with its rendering
      // consumers; rejectSameOrigin lives in contracts where the config
      // reader (src/state/web-ui-config.ts) can take it without pulling a
      // rendering module into its graph.
      const src = read(HTML_PREVIEW);
      expect(src, "must export CSP_META").toMatch(/export\s+const\s+CSP_META/);
      expect(src, "must export sandboxedSrcdoc").toMatch(
        /export\s+function\s+sandboxedSrcdoc/,
      );
      const contractsHalf = read("shared/html-preview.ts");
      expect(contractsHalf, "must export rejectSameOrigin").toMatch(
        /export\s+function\s+rejectSameOrigin/,
      );
    });
  });
});
