#!/usr/bin/env node
/**
 * Check relative Markdown links without a network request.
 *
 * Absolute site URLs and http(s) links are the Pages deployment's concern,
 * with one exception this gate owns: a process document that hand-writes an
 * absolute GitHub URL to another process document bypasses the relative link
 * resolution every other rule uses (the three standing decisions once did:
 * they were labelled ROLES.md / WORKFLOW.md / AGENTS.md and all pointed at the
 * product repository's `CONTRIBUTING.md`). The classifier is
 * `scripts/repository-links.ts`, shared with the briefing liveness test.
 *
 * The gate catches the common, local failures: a repository-relative link to a
 * file that no longer exists, a `#fragment` that no heading in its target owns,
 * and that absolute process-document URL. The fragment rule uses the heading
 * slugs a Markdown renderer derives, so a link to
 * `MERGE-GUIDE.md#no-such-section` is refused instead of passing on the file's
 * existence alone. Run it from the repository root.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { absoluteProcessDocLinkReason } from "./repository-links.ts";

const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * The anchor a Markdown renderer derives from a heading (GitHub's slug rule:
 * lowercase, inline formatting removed, punctuation dropped, each whitespace
 * character replaced by one hyphen). The one derivation this checker uses.
 */
export function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~]/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    // GitHub replaces each whitespace character with one hyphen; a removed
    // em dash therefore leaves the two hyphens its surrounding spaces made.
    .replace(/\s/gu, "-");
}

/** Every `#anchor` the Markdown headings in `markdown` declare. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match === null) continue;
    const slug = slugifyHeading(match[1]);
    if (slug.length === 0) continue;
    // A repeated heading gets GitHub's `-1`, `-2`, … suffix.
    const count = seen.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  }
  return anchors;
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Every missing file or heading anchor in `files` (repository-relative to
 * `root`). `files` defaults to the tracked Markdown population; a caller may
 * pass an explicit list (the planted-link test does).
 */
export function checkDocsLinks({ root = process.cwd(), files } = {}) {
  const documents = files ?? execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const anchorCache = new Map();
  const anchorsOf = (absolute) => {
    let anchors = anchorCache.get(absolute);
    if (anchors === undefined) {
      anchors = headingAnchors(readFileSync(absolute, "utf8"));
      anchorCache.set(absolute, anchors);
    }
    return anchors;
  };
  const missing = [];
  for (const file of documents) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1];
      const absoluteReason = absoluteProcessDocLinkReason(file, target);
      if (absoluteReason !== undefined) {
        missing.push(`${file}: ${absoluteReason}`);
        continue;
      }
      if (["http://", "https://", "mailto:", "/", "{"].some((prefix) => target.startsWith(prefix))) continue;
      if (target.startsWith("#")) {
        const anchor = decodeFragment(target.slice(1));
        if (anchor.length > 0 && !anchorsOf(resolve(root, file)).has(anchor)) {
          missing.push(`${file}: ${target} (no heading in ${file} has that anchor)`);
        }
        continue;
      }
      const hash = target.indexOf("#");
      const fragment = hash === -1 ? "" : decodeFragment(target.slice(hash + 1));
      const path = (hash === -1 ? target : target.slice(0, hash)).split("?")[0];
      if (path.length === 0) continue;
      const absolute = resolve(dirname(resolve(root, file)), path);
      if (!existsSync(absolute)) {
        missing.push(`${file}: ${target} (missing target)`);
        continue;
      }
      if (fragment.length > 0 && path.endsWith(".md") && !anchorsOf(absolute).has(fragment)) {
        missing.push(`${file}: ${target} (no heading in ${path} has that anchor)`);
      }
    }
  }
  return { files: documents, missing };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { files, missing } = checkDocsLinks();
  if (missing.length === 0) {
    console.log(`docs links: clean (${files.length} Markdown files)`);
    process.exit(0);
  }
  console.error(`docs links: ${missing.length} missing target(s)`);
  for (const entry of missing) console.error(`  ${entry}`);
  process.exit(1);
}
