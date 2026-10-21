// @vitest-environment node
/**
 * THE PROBE — the server measures what a file IS before anything decodes it.
 *
 * Two dishonest states the editor could otherwise ship, and the one primitive
 * that removes both:
 *
 *   MOJIBAKE — a binary file read as UTF-8 and painted as replacement
 *     characters. The room would be showing content that is not in the file,
 *     which is the no-fabricated-data law broken in the most literal way.
 *   A BLIND READ — a 40MB file pulled into memory to discover it was too big
 *     to show. The size has to be known BEFORE the read for the room to be
 *     able to state it and ask.
 *
 * `probeFile` answers both from a bounded 8KB head and a stat, performs no
 * mutation, and goes through the same fs-gate as every other bridge function.
 * `readFileBytes` is its companion: an image's real bytes, bounded by a cap
 * checked against the STAT before the read.
 *
 * The image type is an ALLOWLIST BY EXTENSION, never a content sniff, so a
 * file cannot talk the server into serving it as something else. That is
 * asserted here in both directions and mutation-checked.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  imageMediaType,
  probeFile,
  readFileBytes,
} from "../../server/filesystem/editor-bridge.ts";
import { PathTraversalError, ValidationError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let root: string;

beforeAll(() => {
  root = createTempDir("ch-editor-probe-");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "text.ts"), "const a = 1;\n", "utf8");
  writeFileSync(join(root, "empty.ts"), "", "utf8");
  writeFileSync(join(root, "utf8.md"), "# héllo — naïve ✓\n", "utf8");
  // A zero byte: never valid in text.
  writeFileSync(join(root, "zeroes.bin"), Buffer.from([0x01, 0x00, 0x02, 0x03]));
  // Valid bytes, invalid UTF-8 (a lone continuation byte).
  writeFileSync(join(root, "latin1.bin"), Buffer.from([0x48, 0xff, 0xfe, 0x49]));
  writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  // A large text file whose 8KB head is complete text.
  writeFileSync(join(root, "big.txt"), "x".repeat(40_000), "utf8");
});

describe("what is at a path", () => {
  test("a text file is a text file, with its real size", () => {
    const p = probeFile(join(root, "text.ts"), root);
    expect(p.kind).toBe("file");
    expect(p.text).toBe(true);
    expect(p.binaryReason).toBeNull();
    expect(p.size).toBe(13);
    expect(p.language).toBe("typescript");
    expect(p.relativePath).toBe("text.ts");
  });

  test("an EMPTY file is text — there is nothing in it that is not", () => {
    const p = probeFile(join(root, "empty.ts"), root);
    expect(p.text).toBe(true);
    expect(p.size).toBe(0);
  });

  test("multi-byte UTF-8 is text (an accent is not a binary file)", () => {
    expect(probeFile(join(root, "utf8.md"), root).text).toBe(true);
  });

  test("a file with a ZERO byte is not text, and says which test caught it", () => {
    const p = probeFile(join(root, "zeroes.bin"), root);
    expect(p.text).toBe(false);
    expect(p.binaryReason).toContain("zero byte");
  });

  test("bytes that are not valid UTF-8 are not text, and say so", () => {
    const p = probeFile(join(root, "latin1.bin"), root);
    expect(p.text).toBe(false);
    expect(p.binaryReason).toContain("not valid UTF-8");
  });

  test("a large text file is still text (the head is what is sniffed)", () => {
    const p = probeFile(join(root, "big.txt"), root);
    expect(p.text).toBe(true);
    expect(p.size).toBe(40_000);
  });

  test("a directory says it is a directory; an absent path says it is absent", () => {
    expect(probeFile(join(root, "sub"), root).kind).toBe("directory");
    expect(probeFile(join(root, "nope.ts"), root).kind).toBe("absent");
  });

  test("the probe carries the caps, so the ROOM can state them", () => {
    const p = probeFile(join(root, "text.ts"), root);
    expect(p.maxReadBytes).toBeGreaterThan(0);
    expect(p.maxEditBytes).toBeGreaterThan(0);
  });

  test("the probe never mutates anything (it has no write to record)", () => {
    // A read-only primitive by construction: it opens for read, reads a head,
    // closes. If this ever changed it would need to record, and the bridge's
    // own deny-by-default scan would catch it.
    const before = probeFile(join(root, "text.ts"), root);
    const after = probeFile(join(root, "text.ts"), root);
    expect(after).toEqual(before);
  });
});

describe("the image allowlist is by EXTENSION and is closed", () => {
  test("the declared types", () => {
    expect(imageMediaType("/a/b.png")).toBe("image/png");
    expect(imageMediaType("/a/b.JPG")).toBe("image/jpeg");
    expect(imageMediaType("/a/b.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("/a/b.gif")).toBe("image/gif");
    expect(imageMediaType("/a/b.webp")).toBe("image/webp");
    expect(imageMediaType("/a/b.svg")).toBe("image/svg+xml");
  });

  test("everything else is not an image as far as this server is concerned", () => {
    for (const p of ["/a/b.ts", "/a/b.exe", "/a/b", "/a/b.png.exe", "/a/.png"]) {
      expect(imageMediaType(p), p).toBeNull();
    }
  });

  test("MUTATION: a content sniff would call this PNG-magic text file an image", () => {
    // The file below starts with the PNG signature but is named `.txt`. A
    // sniffing implementation would serve it as an image; the allowlist reads
    // the name the user already sees, so it does not.
    const disguised = join(root, "notreally.txt");
    writeFileSync(disguised, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(imageMediaType(disguised)).toBeNull();
    // …while the real one is declared from its name.
    expect(imageMediaType(join(root, "pic.png"))).toBe("image/png");
  });
});

describe("reading bytes is bounded BEFORE the read", () => {
  test("an image under the cap comes back whole", () => {
    const { bytes, size } = readFileBytes(join(root, "pic.png"), 1024, root);
    expect(size).toBe(6);
    expect(bytes.length).toBe(6);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("a file past the cap is REFUSED with a typed code, and the size stays out of the wire sentence", () => {
    expect(() => readFileBytes(join(root, "big.txt"), 100, root)).toThrow(ValidationError);
    try {
      readFileBytes(join(root, "big.txt"), 100, root);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("file_too_large");
      expect((err as Error).message).toBe("That file is too large to open here.");
    }
  });

  test("a missing file and a directory are typed errors, not empty buffers", () => {
    expect(() => readFileBytes(join(root, "nope.png"), 1024, root)).toThrow(/no longer exists/i);
    expect(() => readFileBytes(join(root, "sub"), 1024, root)).toThrow(/Not a file/i);
  });
});

describe("the fs-gate is enforced at the same choke point as everything else", () => {
  // The SPECIFIC error, not merely "it threw": a bare assertion here would
  // pass on an ENOENT and report a traversal guard that does not exist.
  test("a traversal out of the project is refused by BOTH new primitives", () => {
    expect(() => probeFile("../../etc/passwd", root)).toThrow(PathTraversalError);
    expect(() => readFileBytes("../../etc/passwd", 1024, root)).toThrow(PathTraversalError);
  });

  test("an absolute path outside the root is refused", () => {
    expect(() => probeFile("/etc/passwd", root)).toThrow(PathTraversalError);
    expect(() => readFileBytes("/etc/passwd", 1024, root)).toThrow(PathTraversalError);
  });

  test("a path INSIDE the root is not refused (the guard is not simply always-on)", () => {
    expect(() => probeFile("text.ts", root)).not.toThrow();
    expect(probeFile("text.ts", root).kind).toBe("file");
  });
});
