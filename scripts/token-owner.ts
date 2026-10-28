/**
 * THE TOKEN OWNER, READ — the one reader of what `src/cockpit/tokens.css`
 * declares, for the Node tools that must hold an output to it: the icon
 * generator (the mark's colours) and the rendered judgement (the face stacks
 * and the mark's colours a page must show, compared with what the page
 * renders, never with what the page itself declares).
 *
 * A theme is a block of the owner: Carbon is the first `:root` block, Logbook
 * the `:root[data-cockpit-theme="light"]` block, which overrides some tokens
 * and inherits the rest. A token the owner does not declare is refused by
 * name, never defaulted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../engine/src/kernel/errors.ts";

export const TOKENS_PATH = resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "cockpit", "tokens.css");

/** The owner's themes, each by the selector of its block (and of the document root it applies to). */
export const TOKEN_THEMES = Object.freeze({ carbon: ":root", logbook: ':root[data-cockpit-theme="light"]' } as const);
export type TokenTheme = keyof typeof TOKEN_THEMES;

/** The declarations of the FIRST block whose selector is exactly `selector` (comments removed). */
function block(css: string, selector: string): string | undefined {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) if (m[1]!.trim() === selector) return m[2];
  return undefined;
}

/** The value `theme` gives each of `names`: its own block's, else Carbon's; one space per run of white space. */
export function tokenValues(theme: TokenTheme, names: readonly string[], css: string = readFileSync(TOKENS_PATH, "utf8")): Readonly<Record<string, string>> {
  const carbon = block(css, TOKEN_THEMES.carbon);
  if (carbon === undefined) throw new HarnessError(`the token owner has no ${TOKEN_THEMES.carbon} block`, "token_owner_block_missing");
  const own = theme === "carbon" ? carbon : block(css, TOKEN_THEMES[theme]);
  if (own === undefined) throw new HarnessError(`the token owner has no ${TOKEN_THEMES[theme]} block`, "token_owner_block_missing");
  const valueIn = (declarations: string, name: string): string | undefined =>
    new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]*);`, "u").exec(declarations)?.[1]?.replace(/\s+/gu, " ").trim();
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!/^--[a-z0-9-]+$/u.test(name)) throw new HarnessError(`${name} is not a custom property name`, "token_owner_token_invalid");
    const value = valueIn(own, name) ?? valueIn(carbon, name);
    if (value === undefined || value.length === 0) throw new HarnessError(`${name} is not declared by the token owner's ${TOKEN_THEMES[theme]} (or ${TOKEN_THEMES.carbon}) block`, "token_owner_token_missing");
    values[name] = value;
  }
  return Object.freeze(values);
}
