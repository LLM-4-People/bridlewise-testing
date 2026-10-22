// @vitest-environment node
/**
 * THE COCKPIT CAPTURE'S PURE HALF — the sequence, the masks, the manifest and
 * the GIF encoder of `scripts/capture/` (the runner `cockpit.ts` drives a real
 * app and browser and is proved by running it; see docs/shipping.md).
 *
 * What would go wrong without these:
 * - a run capture without the "fixture replay" label (a fixture replay
 *   passing as a real model run), or a run view captured before the run;
 * - a mask rule that eats configuration ("30 ms", "4096 tokens") and so
 *   publishes a capture that hides what the product really shows, or one
 *   that misses a volatile value and so breaks determinism silently;
 * - a demo path under a home folder, publishing the host user name;
 * - a manifest that quietly lists fewer images than the plan;
 * - a GIF that does not decode back to its frames.
 */
import { describe, expect, test } from "vitest";
import { deflateSync } from "node:zlib";

import {
  badgeText,
  buildManifest,
  canonicalJson,
  DEFAULT_DEMO_ROOT,
  FIXTURE_REPLAY_LABEL,
  hostLeaks,
  maskedLabels,
  maskText,
  planInputs,
  plannedCaptures,
  recipeHash,
  REGION_MASKS,
  SEQUENCE,
  STATE_ACTIONS,
  TEXT_MASKS,
  THEMES,
  unmaskedValues,
  VIEW_ACTIONS,
  VIEWPORT_IDS,
  VOLATILE_SIGNALS,
  type CapturedImage,
  type ShotStage,
} from "../../scripts/capture/cockpit-plan.ts";
import { decodePngRgb, encodeGif, type RgbFrame } from "../../scripts/capture/gif.ts";

const shots = SEQUENCE.filter((stage): stage is ShotStage => stage.kind === "shot");
const indexOfState = (action: string): number => SEQUENCE.findIndex((stage) => stage.kind !== "shot" && stage.action === action);

describe("A. the fixed sequence", () => {
  test("every stage names a known action, and shot ids are unique and ascending", () => {
    for (const stage of SEQUENCE) {
      if (stage.kind === "shot") expect(VIEW_ACTIONS).toContain(stage.action);
      else expect(STATE_ACTIONS).toContain(stage.action);
    }
    const ids = shots.map((shot) => shot.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.toSorted());
  });

  test("the story runs account → project → provider → fixture run → rooms", () => {
    const order = ["signUp", "signIn", "createProject", "saveProvider", "fixtureRun", "dirtyWorkingTree"].map(indexOfState);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("every view of the run comes after the run and wears the fixture label; no other view does", () => {
    const run = indexOfState("fixtureRun");
    const runViews = new Set(["openRunConversation", "expandToolOutput", "openContextAndTools"]);
    SEQUENCE.forEach((stage, index) => {
      if (stage.kind !== "shot") return;
      expect(stage.fixtureRun).toBe(runViews.has(stage.action));
      if (stage.fixtureRun) expect(index).toBeGreaterThan(run);
    });
    expect(badgeText(true, false)).toContain(FIXTURE_REPLAY_LABEL);
    expect(badgeText(false, true)).not.toContain(FIXTURE_REPLAY_LABEL);
    expect(badgeText(false, false)).toBeNull();
  });

  test("the planned images cover both themes for every shot and viewport, with unique names", () => {
    const planned = plannedCaptures();
    const expected = shots.reduce((sum, shot) => sum + shot.viewports.length * THEMES.length, 0);
    expect(planned).toHaveLength(expected);
    expect(new Set(planned.map((capture) => capture.file)).size).toBe(expected);
    for (const viewport of VIEWPORT_IDS) for (const theme of THEMES) expect(planned.some((c) => c.theme === theme && c.viewport === viewport)).toBe(true);
    expect(planned[0]?.file).toBe("00-create-account-carbon-desktop.png");
  });
});

describe("B. the masks", () => {
  // Values the server stamps or measures live: each is masked by a label.
  const volatile: readonly [string, string][] = [
    ["showing 18:03:35 → 18:03:37", "showing [time] → [time]"],
    ["asOf 18:01", "asOf [time]"],
    ["7m ago", "[age]"],
    ["ttft 11ms", "[ttft]"],
    ["937.5 tok/s", "[tok/s]"],
    ["11,919 / 32,768 tok", "[tokens]"],
    ["↑450", "[tokens]"],
    ["↓120 tok", "[tokens]"],
    ["done 44ms", "done [duration]"],
    ["2s of the record", "[span]"],
    ["263 events", "[events]"],
    ["483 updates/s", "[rate]"],
    ["2 measured points, 18:09 to 18:10", "[points], [time] to [time]"],
    ["run run-a73b28c9-7311-477c-9b9a-0d18245ccaed", "run [run id]"],
    ["created 2026-10-21T22:02:31.458Z", "created [date]"],
  ];
  test.each(volatile)("%s is masked as %s", (input, output) => {
    const masked = maskText(input);
    expect(masked.text).toBe(output);
    expect(unmaskedValues(masked.text)).toEqual([]);
  });

  // Configuration and content: never masked (a mask here would hide what the product shows).
  const stable = [
    "30 ms",
    "How much recent material is kept, in tokens. 4,096 tokens",
    "Each mode (CPU, memory, I/O, event loop, process) is reported",
    "0.85 fraction",
    "50 entries",
    "src/tides.ts 586 bytes 12 lines",
    "c9fe2cb Add the request boundary +12 −0",
    "Context used 36%",
  ];
  test.each(stable)("%s is left as it is", (input) => {
    expect(maskText(input).text).toBe(input);
    expect(unmaskedValues(input)).toEqual([]);
  });

  test("the moving instrument readings are masked as regions", () => {
    const selector = REGION_MASKS.find((mask) => mask.id === "instrument-reading")!.selector;
    for (const id of VOLATILE_SIGNALS) expect(selector).toContain(`.cell[data-signal="${id}"] .readout`);
    expect(selector).not.toContain("signalCount");
  });

  test("a label is a word, so a masked page never re-matches a rule", () => {
    for (const mask of TEXT_MASKS) expect(mask.label).toMatch(/^[a-z/ ]+$/u);
    expect(maskedLabels("[time] x [time] [tokens] [bracketed]")).toEqual({ time: 2, tokens: 1 });
  });

  test("a home path or the host user name is a leak; the default demo path is neither", () => {
    expect(hostLeaks("files in /home/alice/.cache/x", "alice")).toEqual(["/home/alice", 'user name "alice"']);
    expect(hostLeaks("/Users/bob/project", "carol")).toEqual(["/Users/bob"]);
    expect(hostLeaks(`files in “Tidewater” ${DEFAULT_DEMO_ROOT}/tidewater`, "alice")).toEqual([]);
  });
});

describe("C. the recipe hash and the manifest", () => {
  const image = (file: string): CapturedImage => ({
    file, sha256: "0".repeat(64), bytes: 1, theme: "carbon", viewport: "desktop", stage: file.slice(0, 2), fixtureReplay: false, masked: {}, textSha256: "1".repeat(64),
  });
  const base = { commit: "a".repeat(40), recipeHash: "r", chromium: "149", playwright: "1.61.1", fonts: { vendored: false, note: "n" }, animation: null };

  test("canonical JSON ignores key order; the recipe hash follows every script byte and every input", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const scripts = { "scripts/capture/a.ts": "x", "scripts/capture/b.ts": "y" };
    expect(recipeHash(scripts)).toBe(recipeHash({ "scripts/capture/b.ts": "y", "scripts/capture/a.ts": "x" }));
    expect(recipeHash({ ...scripts, "scripts/capture/b.ts": "y " })).not.toBe(recipeHash(scripts));
    expect(recipeHash(scripts, { ...(planInputs() as object), fixedInstant: "2030-01-01T00:00:00.000Z" })).not.toBe(recipeHash(scripts));
  });

  test("the manifest holds exactly the planned images, in plan order", () => {
    const files = plannedCaptures().map((capture) => capture.file);
    const manifest = buildManifest({ ...base, images: files.toReversed().map(image) });
    expect(manifest.images.map((i) => i.file)).toEqual(files);
    expect(manifest.clock.server).toMatch(/masked/u);
  });

  test("a missing, unplanned or duplicated image, or a short commit id, is refused by name", () => {
    const files = plannedCaptures().map((capture) => capture.file);
    expect(() => buildManifest({ ...base, images: files.slice(1).map(image) })).toThrowError(/capture_set_mismatch: missing \[00-create-account-carbon-desktop.png\]/u);
    expect(() => buildManifest({ ...base, images: [...files, "99-x.png"].map(image) })).toThrowError(/unplanned \[99-x.png\]/u);
    expect(() => buildManifest({ ...base, images: [...files, files[0]!].map(image) })).toThrowError(/1 duplicate/u);
    expect(() => buildManifest({ ...base, commit: "abc1234", images: files.map(image) })).toThrowError(/capture_commit_invalid/u);
  });
});

/** A minimal GIF reader (global palette, LZW, frame rectangles, transparency): the encoder's output must read back as its input. */
function decodeGif(gif: Uint8Array): { width: number; height: number; frames: Uint8Array[] } {
  const width = gif[6]! | (gif[7]! << 8);
  const height = gif[8]! | (gif[9]! << 8);
  const palette = gif.subarray(13, 13 + 256 * 3);
  let at = 13 + 256 * 3;
  const canvas = new Uint8Array(width * height * 3);
  const frames: Uint8Array[] = [];
  let transparent = -1;
  while (gif[at] !== 0x3b) {
    if (gif[at] === 0x21) {
      if (gif[at + 1] === 0xf9) transparent = gif[at + 3]! & 1 ? gif[at + 6]! : -1;
      at += 2;
      while (gif[at] !== 0) at += gif[at]! + 1;
      at += 1;
      continue;
    }
    const x0 = gif[at + 1]! | (gif[at + 2]! << 8);
    const y0 = gif[at + 3]! | (gif[at + 4]! << 8);
    const w = gif[at + 5]! | (gif[at + 6]! << 8);
    const h = gif[at + 7]! | (gif[at + 8]! << 8);
    at += 10;
    const minCode = gif[at++]!;
    const data: number[] = [];
    while (gif[at] !== 0) { data.push(...gif.subarray(at + 1, at + 1 + gif[at]!)); at += gif[at]! + 1; }
    at += 1;
    const clear = 1 << minCode;
    let size = minCode + 1;
    let dict: number[][] = [];
    const reset = (): void => { dict = Array.from({ length: clear + 2 }, (_, i) => [i]); size = minCode + 1; };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
      if (code === clear) { reset(); prev = null; continue; }
      if (code === clear + 1) break;
      const entry: number[] = code < dict.length ? dict[code]! : [...prev!, prev![0]!];
      out.push(...entry);
      if (prev !== null) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    out.forEach((index, p) => {
      if (index === transparent) return;
      const c = ((y0 + Math.floor(p / w)) * width + x0 + (p % w)) * 3;
      canvas.set(palette.subarray(index * 3, index * 3 + 3), c);
    });
    expect(out).toHaveLength(w * h);
    frames.push(canvas.slice());
  }
  return { width, height, frames };
}

describe("D. PNG frames → palette GIF", () => {
  const frame = (width: number, height: number, paint: (x: number, y: number) => [number, number, number]): RgbFrame => {
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(paint(x, y), (y * width + x) * 3);
    return { width, height, rgb };
  };

  test("an 8-bit RGB PNG decodes through every row filter", () => {
    const source = frame(5, 5, (x, y) => [x * 40, y * 50, (x * y * 9) % 256]);
    const rows: number[] = [];
    for (let y = 0; y < 5; y++) {
      const filter = y % 5; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
      rows.push(filter);
      for (let x = 0; x < 15; x++) {
        const raw = source.rgb[y * 15 + x]!;
        const a = x >= 3 ? source.rgb[y * 15 + x - 3]! : 0;
        const b = y > 0 ? source.rgb[(y - 1) * 15 + x]! : 0;
        const c = x >= 3 && y > 0 ? source.rgb[(y - 1) * 15 + x - 3]! : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
        rows.push((raw - predicted) & 0xff);
      }
    }
    const chunk = (type: string, data: Uint8Array): Buffer => {
      const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(5, 0); ihdr.writeUInt32BE(5, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Uint8Array.from(rows))), chunk("IEND", new Uint8Array())]);
    expect(decodePngRgb(png)).toEqual(source);
    ihdr[9] = 6;
    expect(() => decodePngRgb(Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr)]))).toThrowError(/png_unsupported/u);
  });

  test("a flat-colour animation reads back exactly, frame by frame, and only the change is stored", () => {
    const colours: [number, number, number][] = [[16, 18, 24], [240, 240, 232], [96, 160, 255], [80, 200, 120]];
    const a = frame(40, 20, (x) => colours[x < 20 ? 0 : 1]!);
    const b = frame(40, 20, (x, y) => (x >= 4 && x < 8 && y >= 4 && y < 8 ? colours[2]! : colours[x < 20 ? 0 : 1]!));
    const c = frame(40, 20, (x, y) => (y >= 10 ? colours[3]! : colours[x < 20 ? 0 : 1]!));
    const gif = encodeGif([a, b, c], 12, 200);
    expect(Buffer.from(gif.subarray(0, 6)).toString()).toBe("GIF89a");
    expect(gif.at(-1)).toBe(0x3b);
    const read = decodeGif(gif);
    expect(read.width).toBe(40);
    expect(read.frames.map((f, i) => Buffer.from(f).equals(Buffer.from([a, b, c][i]!.rgb)))).toEqual([true, true, true]);
    expect(encodeGif([a, b, c], 12, 200)).toEqual(gif);
    expect(() => encodeGif([], 10)).toThrowError(/gif_no_frames/u);
  });
});
