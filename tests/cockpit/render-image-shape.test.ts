// @vitest-environment jsdom
/**
 * IMAGE OUTPUT — a screenshot-returning tool's payload renders as
 * the picture it is, and everything that merely RESEMBLES one does not.
 *
 * The rule is the same honesty rule the whole classifier lives by: the image
 * shape is claimed only on evidence about the recorded VALUE — a full-string
 * data: URI, a magic-numbered base64 body, or an explicit image record with
 * an allowlisted media type — never from the tool's name. The negative cases
 * are the point: an SVG (a document, not a bitmap), prose containing a data
 * URI, a short magic-shaped token and a command's stdout must all stay in
 * their honest shapes.
 *
 * The budget arm is deny-by-default made structural: past IMAGE_MAX_BYTES the
 * classifier returns `src: null`, so the renderer CANNOT paint the refused
 * payload, and the surface states the refusal through the response grammar
 * with both numbers named.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mount, unmount } from "svelte";
import { flushSync } from "svelte";

import { classifyOutput, imageViewOf } from "../../src/cockpit/render/shapes.ts";
import { IMAGE_MAX_BYTES } from "../../src/cockpit/render/render-config.ts";
import ToolOutput from "../../src/cockpit/render/ToolOutput.svelte";

/** A real 1×1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_URI = `data:image/png;base64,${PNG_B64}`;

/** A bare base64 body long enough to clear the bare-payload floor, opening
 * with the PNG signature. Content past the magic is irrelevant to the probe —
 * the claim rests on the signature plus all-base64 characters. */
const BARE_PNG_B64 = "iVBORw0KGgo" + "A".repeat(157);

describe("imageViewOf — evidence about the value, never the name", () => {
  test("a full-string raster data: URI is an image, with exact decoded bytes", () => {
    const view = imageViewOf(PNG_URI);
    expect(view).not.toBeNull();
    expect(view!.mediaType).toBe("image/png");
    expect(view!.src).toBe(PNG_URI);
    // Exact arithmetic: 100 base64 chars with two padding chars = 73 bytes.
    expect(view!.bytes).toBe(Math.floor((PNG_B64.length * 3) / 4) - 2);
  });

  test("an SVG data: URI is refused — a document is not a bitmap", () => {
    const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
    expect(imageViewOf(svg)).toBeNull();
  });

  test("prose that merely CONTAINS a data URI stays prose", () => {
    expect(imageViewOf(`the screenshot is ${PNG_URI} — inline`)).toBeNull();
  });

  test("a bare base64 body with a raster magic number is an image", () => {
    const view = imageViewOf(BARE_PNG_B64);
    expect(view).not.toBeNull();
    expect(view!.mediaType).toBe("image/png");
    expect(view!.src).toBe(`data:image/png;base64,${BARE_PNG_B64}`);
  });

  test("a short magic-shaped token is NOT claimed (the bare-payload floor)", () => {
    expect(imageViewOf("iVBORw0KGgoAAAA")).toBeNull();
  });

  test("a base64-looking paragraph without a magic number is not an image", () => {
    expect(imageViewOf("QQ==".repeat(64))).toBeNull();
  });

  test("the explicit nested image record (source.media_type + data) is an image", () => {
    const view = imageViewOf({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" },
    });
    expect(view).not.toBeNull();
    expect(view!.mediaType).toBe("image/jpeg");
    expect(view!.src).toBe("data:image/jpeg;base64,/9j/AAAA");
  });

  test("the flat image record (mediaType + base64) is an image", () => {
    const view = imageViewOf({ kind: "image", mediaType: "image/webp", base64: "UklGRgAA" });
    expect(view).not.toBeNull();
    expect(view!.mediaType).toBe("image/webp");
  });

  test("an image record with a non-allowlisted media type is refused", () => {
    expect(
      imageViewOf({ type: "image", source: { media_type: "image/svg+xml", data: "AAAA" } }),
    ).toBeNull();
  });

  test("an image record whose data is not base64 is refused", () => {
    expect(imageViewOf({ type: "image", mediaType: "image/png", data: "<not base64!>" })).toBeNull();
  });

  test("past the byte budget the view survives but its src does not", () => {
    // 4 base64 chars = 3 bytes, so this decodes past the 10 MB budget.
    const hugeBody = "iVBORw0KGgo" + "A".repeat(Math.ceil((IMAGE_MAX_BYTES / 3) * 4));
    const view = imageViewOf(hugeBody);
    expect(view).not.toBeNull();
    expect(view!.src).toBeNull();
    expect(view!.bytes).toBeGreaterThan(IMAGE_MAX_BYTES);
  });
});

describe("classifyOutput — where the image shape sits among the others", () => {
  test("a screenshot tool's data URI classifies as image", () => {
    const s = classifyOutput({}, PNG_URI);
    expect(s.kind).toBe("image");
  });

  test("image evidence outranks the file-reader name — the value IS an image", () => {
    const s = classifyOutput({ path: "shot.png" }, PNG_URI, "file");
    expect(s.kind).toBe("image");
  });

  test("a command's stdout is NEVER re-interpreted, even as a lone data URI", () => {
    expect(classifyOutput({ command: "cat" }, PNG_URI, "command").kind).toBe("command");
  });

  test("an explicit image record classifies as image; a plain object stays json", () => {
    expect(
      classifyOutput({}, { type: "image", mediaType: "image/png", data: PNG_B64 }).kind,
    ).toBe("image");
    expect(classifyOutput({}, { took: "screenshot" }).kind).toBe("json");
  });
});

describe("ToolOutput — the rendered contract", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  function render(output: unknown): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(ToolOutput, {
      target: host,
      props: { name: "take_screenshot", input: {}, output, maxLines: 16 },
    });
    flushSync();
    return host;
  }

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  test("a within-budget image renders as a bounded <img> carrying the payload", () => {
    const el = render(PNG_URI);
    const img = el.querySelector("img.shot");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(PNG_URI);
    // The alt names what it is — never an empty alt on content.
    expect(img!.getAttribute("alt")).toContain("image/png");
  });

  test("an over-budget image renders NO img and states the refusal through the grammar", () => {
    const hugeBody = "iVBORw0KGgo" + "A".repeat(Math.ceil((IMAGE_MAX_BYTES / 3) * 4));
    const el = render(hugeBody);
    expect(el.querySelector("img")).toBeNull();
    const answer = el.querySelector('[data-answer="refused"]');
    expect(answer).not.toBeNull();
    // The sentence names both numbers — the payload's and the budget's.
    expect(answer!.textContent).toContain("budget");
    expect(answer!.textContent).toMatch(/MB/);
  });
});
