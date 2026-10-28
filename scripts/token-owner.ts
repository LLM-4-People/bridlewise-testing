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
import { readTokenOwner, type TokenOwner } from "../shared/token-reader.ts";

export const TOKENS_PATH = resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "cockpit", "tokens.css");

/** The owner's themes, each by the selector of its block (and of the document root it applies to). */
export const TOKEN_THEMES = Object.freeze({ carbon: ":root", logbook: ':root[data-cockpit-theme="light"]' } as const);
export type TokenTheme = keyof typeof TOKEN_THEMES;

/**
 * The value `theme` gives each of `names`: its own block's, else Carbon's; one
 * space per run of white space. Read through the one token reader
 * (`shared/token-reader.ts`), which parses the owner whole; this file keeps
 * the Node tools' interface and its typed refusals.
 */
export function tokenValues(theme: TokenTheme, names: readonly string[], css: string = readFileSync(TOKENS_PATH, "utf8")): Readonly<Record<string, string>> {
  let owner: TokenOwner;
  try {
    owner = readTokenOwner(css);
  } catch (error) {
    throw new HarnessError(`the token owner cannot be read: ${error instanceof Error ? error.message : String(error)}`, "token_owner_block_missing");
  }
  if (owner.base.size === 0) throw new HarnessError(`the token owner has no ${TOKEN_THEMES.carbon} block`, "token_owner_block_missing");
  if (theme === "logbook" && owner.logbook.size === 0) throw new HarnessError(`the token owner has no ${TOKEN_THEMES.logbook} block`, "token_owner_block_missing");
  const own = theme === "carbon" ? owner.base : owner.logbook;
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!/^--[a-z0-9-]+$/u.test(name)) throw new HarnessError(`${name} is not a custom property name`, "token_owner_token_invalid");
    const value = (own.get(name) ?? owner.base.get(name))?.replace(/\s+/gu, " ").trim();
    if (value === undefined || value.length === 0) throw new HarnessError(`${name} is not declared by the token owner's ${TOKEN_THEMES[theme]} (or ${TOKEN_THEMES.carbon}) block`, "token_owner_token_missing");
    values[name] = value;
  }
  return Object.freeze(values);
}
