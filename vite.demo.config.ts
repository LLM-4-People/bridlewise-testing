/** The public replay reuses the app's build owner, with its own document entry. */
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
// @ts-expect-error -- the existing runtime CSS parser has no declaration package.
import * as csstree from "css-tree";
import { BUILD_CONFIG } from "./vite.config.ts";
import { escapeHtml } from "./shared/markup.ts";
import { SITE_FONT_PATH, sitePolicies } from "./shared/site-page.ts";
import { vendoredFaces } from "./scripts/vendor-fonts.ts";
import { sha256 } from "./engine/src/kernel/integrity.ts";
import type { PublicReplay } from "./src/demo/replay.ts";

const VIRTUAL_REPLAY = "virtual:bridlewise-public-replay";
const RESOLVED_REPLAY = `\0${VIRTUAL_REPLAY}`;

/** Project existing token SVG bytes into local files without changing their geometry or policy. */
function publicStylesheet(source: string, base: string): Readonly<{ source: string; marks: ReadonlyMap<string, string> }> {
  const tree = csstree.parse(source, { parseCustomProperty: true });
  const marks = new Map<string, string>();
  let changed = false;
  csstree.walk(tree, (node: { type: string; value?: unknown }) => {
    if (node.type !== "Url" || typeof node.value !== "string" || !node.value.startsWith("data:")) return;
    const prefix = /^data:image\/svg\+xml(?:;charset=utf-8)?,/iu.exec(node.value)?.[0];
    if (prefix === undefined) throw new TypeError("The public replay stylesheet contains an unsupported embedded asset");
    const svg = decodeURIComponent(node.value.slice(prefix.length));
    const file = `assets/marks/${sha256(svg)}.svg`;
    marks.set(file, svg);
    node.value = `${base}${file}`;
    changed = true;
  });
  return { source: changed ? csstree.generate(tree) : source, marks };
}

export function demoBuildConfig(options: Readonly<{ root: string; out: string; baseurl: string; record: PublicReplay; workspaceHref: string; homeHref: string }>): UserConfig {
  const base = `${options.baseurl.replace(/\/+$/u, "")}/`;
  const replayModule = { default: options.record, workspaceHref: options.workspaceHref, homeHref: options.homeHref } satisfies typeof import("virtual:bridlewise-public-replay");
  const data: Plugin = {
    name: "bridlewise-public-replay",
    enforce: "post",
    resolveId(id) { return id === VIRTUAL_REPLAY ? RESOLVED_REPLAY : undefined; },
    load(id) { return id === RESOLVED_REPLAY ? Object.entries(replayModule).map(([name, value]) => name === "default" ? `export default ${JSON.stringify(value)};` : `export const ${name} = ${JSON.stringify(value)};`).join("\n") : undefined; },
    generateBundle(_options, bundle) {
      // The production token owner carries SVG masks as data URLs. Publish
      // their exact bytes as same-path assets, so the public site's existing
      // image policy needs no data: exception and there is no copied geometry.
      const emitted = new Set<string>();
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
        const source = typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
        const projected = publicStylesheet(source, base);
        for (const [fileName, svg] of projected.marks) {
          if (emitted.has(fileName)) continue;
          this.emitFile({ type: "asset", fileName, source: svg });
          emitted.add(fileName);
        }
        asset.source = projected.source;
      }
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const policies = sitePolicies(options.baseurl, { connections: "none" });
        return html.replace(/(<meta charset="utf-8">)/u, `$1\n${policies.map((policy) => `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">`).join("\n")}`);
      },
    },
  };
  return mergeConfig({ ...BUILD_CONFIG, plugins: [] }, {
    configFile: false,
    root: resolve(options.root, "src/demo"),
    base,
    // The replay has no installed worker. The product's worker-digest plugin
    // is therefore omitted with the normal app entry, rather than publishing
    // an unrelated worker that could claim the documentation origin.
    plugins: [svelte({ configFile: false }), data],
    publicDir: false,
    resolve: { alias: vendoredFaces().flatMap((face) => face.files).map((file) => ({ find: file, replacement: resolve(options.root, "public", file.replace(/^\//u, "")) })) },
    build: {
      outDir: options.out,
      emptyOutDir: false,
      sourcemap: false,
      assetsInlineLimit: 0,
      manifest: "module-manifest.json",
      // Jekyll omits a path segment beginning with an underscore or dot.
      // Prefix every JS entry and shared/deferred chunk, including virtual modules.
      rolldownOptions: { output: { entryFileNames: "assets/module-[name]-[hash].js", chunkFileNames: "assets/module-[name]-[hash].js", assetFileNames: (asset: Readonly<{ names: readonly string[]; source: string | Uint8Array }>) => {
        if (asset.names.some((name) => /\.(?:woff2?|ttf|otf)$/u.test(name))) return `${SITE_FONT_PATH}/[name][extname]`;
        if (asset.names.some((name) => name.endsWith(".css"))) {
          const source = typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
          // Bundle hashes otherwise describe the CSS before generateBundle.
          // Bind the public filename to the actual projected bytes instead.
          return `assets/[name]-${sha256(publicStylesheet(source, base).source)}[extname]`;
        }
        return "assets/[name]-[hash][extname]";
      } } },
    },
  });
}
