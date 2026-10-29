import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gitOutput, localGitRepository } from "../../engine/src/git/git-door.ts";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".jekyll-cache",
  "_site",
  "node_modules",
]);

export function readText(file) {
  return readFileSync(file, "utf8");
}

export function readJson(file) {
  return JSON.parse(readText(file));
}

export function readJsonIf(file, fallback) {
  return existsSync(file) ? readJson(file) : fallback;
}

export function walkFiles(root, keep) {
  const out = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        const file = join(directory, entry.name);
        if (keep === undefined || keep(file)) out.push(file);
      }
    }
  };
  visit(root);
  return out;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

export function toPosix(value) {
  return value.split(sep).join("/");
}

export function relativePosix(root, file) {
  return toPosix(relative(root, file));
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function parseFrontMatter(text) {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { data: {}, body: text };
  const head = text.slice(4, end).split("\n");
  const data = {};
  for (const line of head) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "null" || value === "~") value = null;
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    data[match[1]] = value;
  }
  const bodyStart = text.indexOf("\n", end + 4);
  return { data, body: bodyStart < 0 ? "" : text.slice(bodyStart + 1) };
}

export function firstHeading(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1].trim() : fallback;
}

export function parseDossier(text) {
  const fields = {};
  const pattern = /^[ \t]*(?:\*[ \t]*)?GUARD (SUBJECT|OWNS|PLANT|DRIVEN|LIVENESS):\s*(.+)$/gm;
  for (const match of text.matchAll(pattern)) {
    fields[match[1].toLowerCase()] = match[2].trim();
  }
  return {
    subject: fields.subject ?? null,
    owns: fields.owns ?? null,
    plant: fields.plant ?? null,
    driven: fields.driven ?? null,
    liveness: fields.liveness ?? null,
    complete: Boolean(fields.subject && fields.plant && fields.driven && fields.liveness),
  };
}

export function repoInfo(root) {
  if (!root) return { commit: null, committedAt: null };
  try {
    const repository = localGitRepository(root);
    const commit = gitOutput(repository, ["rev-parse", "HEAD"], { environment: "inherited" }).stdout.toString("utf8").trim();
    const committedAt = gitOutput(repository, ["show", "-s", "--format=%cI", "HEAD"], { environment: "inherited" }).stdout.toString("utf8").trim();
    return { commit: commit || null, committedAt: committedAt || null };
  } catch {
    return { commit: null, committedAt: null };
  }
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
