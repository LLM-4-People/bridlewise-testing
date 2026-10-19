/**
 * Compact representation: a 200–500 token block summarizing the
 * codebase, suitable to feed to the LLM at the START of every turn.
 *
 * The block is built from the awareness snapshot by selecting the
 * most-informative fields per signal (per EXP335's 163-token
 * finding: the LLM needs only the shape, not every detail).
 *
 * The block format is a compact, single-line-per-section text:
 *
 *   CODEBASE AWARENESS (computed <ISO time>, <fileCount> files, <fnCount> fns, <moduleCount> mods, <LOC> LOC):
 *   lang: <primary lang label> (X%); type: <level> (typedFileFrac=0.X, typedParamFrac=0.X)
 *   modules (top by PageRank): <name>(<pr>) ...5...
 *   trending: <name>(<commits>) ...5...
 *   complexity: mean=<X> median=<X> p95=<X> max=<X> hotspots=<X> [bucket: 1/2-5/6-10/11-15/16-25/26+]
 *   top-complex fns: <name>(c=X) ...5...
 *   clones: <families> families, <coverage>% coverage; top: <rep>(<members>) ...3...
 *   entropy: H=<X> bits, Rényi[0,0.5,1,2]=[...] ; tokens=<X>
 *   deps: <edges> edges, density=<X>, <X> circular, <X> missing
 *   health: todo=<X>, emptyCatch=<X>, magicN=<X>, deadExport=<X>
 *   quality: <X> issues/KLOC; top: <cat>=<X> ...
 *   drift: schema=<ver>, depDrift=<X> commits
 *   debt: total=<X> (Ebbinghaus); top: <file>(<X>)
 *   roles: <role>=<count> ...5...
 *   hotspots: topDep=<name>(<deg>) ...3...
 *   risk: <name>(c=X,n=X) ...5...
 *   recent: <file> ...5...
 */
import type { AwarenessSnapshot } from "./types.ts";

export function composeCompactBlock(s: AwarenessSnapshot, targetTokens: number): { text: string; tokens: number } {
  const lines: string[] = [];
  lines.push(`CODEBASE AWARENESS (computed ${s.computedAt}, ${s.fileCount} files, ${s.functionCount} fns, ${s.moduleCount} mods, ${s.totalLoc} LOC):`);
  const lang = s.languageMix[0];
  if (lang) lines.push(`lang: ${lang.label} (${pct(lang.fileCount, s.fileCount)}%); type: ${s.typeLevel?.level ?? "?"} (typedFileFrac=${s.typeLevel?.typedFileFraction ?? 0}, typedParamFrac=${s.typeLevel?.typedParameterFraction ?? 0})`);
  if (s.architecture) {
    const hubs = s.architecture.hubModules.slice(0, 5).map(m => `${shortName(m.name)}(${m.pagerank.toFixed(3)},in=${m.inDegree})`).join(", ");
    lines.push(`arch: ${s.architecture.type}, edges=${s.architecture.edgeCount}, density=${s.architecture.density}; hub: ${hubs}`);
  }
  if (s.trending && s.trending.topTrendingModules.length > 0) {
    const t = s.trending.topTrendingModules.slice(0, 5).map(m => `${shortName(m.name)}(${(m as { recentCommits?: number }).recentCommits ?? 0})`).join(", ");
    lines.push(`trending: ${t}`);
  }
  if (s.complexity) {
    const d = s.complexity;
    lines.push(`complexity: mean=${d.mean} median=${d.median} p95=${d.p95} max=${d.max} hot=${d.hotspotCount} [${d.distribution.join("/")}]`);
    if (d.topFunctions.length > 0) {
      const f = d.topFunctions.slice(0, 3).map(fn => `${shortFnName(fn.filePath)}:${fn.name}(c=${fn.complexity})`).join(", ");
      lines.push(`topComplex: ${f}`);
    }
  }
  if (s.clones) {
    const t = s.clones.topFamilies.slice(0, 3).map(f => `${shortFnName(f.representative)}(${f.members})`).join(", ");
    lines.push(`clones: ${s.clones.familyCount} fams, ${pct(s.clones.cloneCoverage, 1)}% coverage; top: ${t}`);
  }
  if (s.entropy) {
    const orders = s.entropy.renyiSpectrum.map(r => r.entropy).join(",");
    lines.push(`entropy: H=${s.entropy.shannon} bits, Rényi[${s.entropy.renyiSpectrum.map(r => r.order).join(",")}]=[${orders}]; tokens=${s.entropy.tokenCount}`);
  }
  if (s.dependencies) {
    lines.push(`deps: ${s.dependencies.graphDensity} density, ${s.dependencies.circularCount} circular, ${s.dependencies.missingSymbolCount} missing`);
  }
  if (s.health) {
    lines.push(`health: todo=${s.health.todoCount}, emptyCatch=${s.health.emptyCatchCount}, magicN=${s.health.magicNumberCount}, deadExp=${s.health.deadExportCount}`);
  }
  if (s.quality) {
    const t = s.quality.topCategories.slice(0, 3).map(c => `${c.category}=${c.count}`).join(", ");
    lines.push(`quality: ${s.quality.issuesPerKloc} issues/KLOC; top: ${t}`);
  }
  if (s.drift) {
    lines.push(`drift: schema=${s.drift.schemaVersion ?? "?"}, depDrift=${s.drift.dependencyDrift} commits`);
  }
  if (s.debt && s.debt.totalDebt > 0) {
    const t = s.debt.topDebts.slice(0, 3).map(d => `${shortFnName(d.filePath)}(${d.debt.toFixed(1)}d,${d.kind})`).join(", ");
    lines.push(`debt: total=${s.debt.totalDebt.toFixed(2)}; top: ${t}`);
  }
  if (s.moduleRoles) {
    const r = s.moduleRoles.roles.slice(0, 5).map(r => `${r.role}=${r.moduleCount}`).join(", ");
    lines.push(`roles: ${r}`);
  }
  if (s.hotspots) {
    const t = s.hotspots.topDependedOn.slice(0, 3).map(m => `${shortName(m.name)}(in=${m.inDegree})`).join(", ");
    lines.push(`hubDep: ${t}`);
  }
  if (s.risk && s.risk.topRisks.length > 0) {
    const r = s.risk.topRisks.slice(0, 5).map(r => `${shortFnName(r.filePath)}:${r.name}(c=${r.complexity},n=${r.callCount})`).join(", ");
    lines.push(`risk: ${r}`);
  }
  if (s.trending && s.trending.topRecentFiles.length > 0) {
    const r = s.trending.topRecentFiles.slice(0, 5).map(f => `${shortFnName(f.filePath)}`).join(", ");
    lines.push(`recent: ${r}`);
  }
  // Trim to target tokens. If we're over budget, drop the lower-priority lines.
  let text = lines.join("\n");
  let tokens = estimateTokens(text);
  if (tokens > targetTokens) {
    // Drop from the END (lowest-priority signals first).
    while (lines.length > 5 && tokens > targetTokens) {
      lines.splice(lines.length - 2, 1); // keep the last "recent:" line; drop second-to-last
      text = lines.join("\n");
      tokens = estimateTokens(text);
    }
  }
  return { text, tokens };
}

function estimateTokens(text: string): number {
  // GPT-style token estimate: chars / 4 (rounded up). Good enough for budget checks.
  return Math.ceil(text.length / 4);
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

function shortName(name: string): string {
  // Take the last 2 path segments if the name is a path.
  const parts = name.split("/");
  if (parts.length <= 2) return name;
  return parts.slice(-2).join("/");
}

function shortFnName(name: string): string {
  // Take the last 2 path segments + name.
  const parts = name.split("/");
  if (parts.length <= 2) return name;
  return parts.slice(-2).join("/");
}
