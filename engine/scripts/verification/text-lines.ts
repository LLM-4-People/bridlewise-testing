/**
 * THE ONE LINE DEFINITION OF THE TREE SCAN: a line ends at `\r\n`, at a lone
 * `\r` or at `\n`, whatever the file's size.
 *
 * The repository scan (`scripts/check-secrets.mjs`) reads a file in one of
 * three ways by size: whole, streamed, or a capped prefix. Each used to split
 * its own way: the whole read on `\r?\n` (a CR-only file arrived as ONE line,
 * so an anchored pattern missed what the streamed read of the same bytes
 * caught), and the capped prefix on `\n` alone (every CRLF line kept its
 * `\r`). Every path now feeds its text through this one splitter, in chunks
 * as it reads them; a `\r` that ends a chunk is held until the next chunk
 * says whether a `\n` follows it, so a chunk boundary never makes two lines
 * of one break.
 */

/** A break: CRLF first (one break, never two), then a lone CR or LF. */
const LINE_BREAK = /\r\n|\r|\n/u;

export type LineSplitter = Readonly<{
  /** Feeds the next chunk; returns the lines it completed, in order. */
  push: (chunk: string) => readonly string[];
  /** The text after the last break: the last line of a whole read, or the incomplete line of a cut one. */
  rest: () => string;
}>;

export function createLineSplitter(): LineSplitter {
  let carry = "";
  return Object.freeze({
    push(chunk: string): readonly string[] {
      const text = carry + chunk;
      // A trailing CR may be the first half of a CRLF the next chunk completes: hold it with the open line.
      const held = text.endsWith("\r") ? 1 : 0;
      const pieces = text.slice(0, text.length - held).split(LINE_BREAK);
      carry = pieces.pop()! + (held === 1 ? "\r" : "");
      return pieces;
    },
    rest(): string {
      // A held CR at the very end is a break of its own: the line before it is complete, and nothing follows.
      return carry.endsWith("\r") ? carry.slice(0, -1) : carry;
    },
  });
}

/** The lines of a whole text, under the one definition (a final break ends the last line; no empty line follows it). */
export function textLines(text: string): readonly string[] {
  const splitter = createLineSplitter();
  const lines = splitter.push(text);
  const last = splitter.rest();
  return last.length > 0 ? [...lines, last] : lines;
}
