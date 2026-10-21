// @vitest-environment jsdom
/**
 * THE EDITOR'S VIEWS — what each one shows, and what it says when it has
 * nothing to show.
 *
 * THE USER'S REPORT that opened this file: "file editor is not working great,
 * selecting a md file, switching to text then back to md makes the editor
 * unresponsive, html do not generate, things like that". The room had never
 * been opened in a browser when it was built; this file is the mechanical half
 * of opening it.
 *
 * Every case here was REPRODUCED IN CHROME FIRST and is pinned here so it
 * cannot come back. The theme running through all of them is the one the room
 * already states about itself and did not keep in its rendered views:
 *
 *     AN EMPTY BOX IS NEVER ACCEPTABLE WHERE A REASON IS AVAILABLE.
 *
 * ── WHY A MOUNT-LEVEL TEST AND NOT A SOURCE SCAN ──────────────────────────
 *
 * The defect that produced "html do not generate" is invisible to both of this
 * project's typecheck scripts. `tsc --noEmit` does not read Svelte templates,
 * and `svelte-check` is not installed, so a REQUIRED prop that a mount does not
 * pass is a runtime `TypeError` and nothing else — which is exactly what
 * happened: `ArtifactFrame` requires `frameKey`, the pane passed none, and
 * `frameKey.length` threw inside the frame's watch effect on every mount. The
 * frame's error owner was therefore never told which window belonged to this
 * frame, so a page that threw could not report it and rendered as a blank
 * rectangle with nothing on this side able to explain it.
 *
 * So §A does not read the source for the string `frameKey`. It mounts the pane,
 * takes the frame's real `contentWindow`, and asks the channel whether a report
 * from it is ACCEPTED. That is the property the user needs; the prop is merely
 * how it is currently obtained.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import FilePane from "../../src/cockpit/editor/FilePane.svelte";
import FileTree from "../../src/cockpit/editor/FileTree.svelte";
import {
  artifactErrors,
  CHANNEL,
} from "../../src/cockpit/render/artifact-errors.ts";
import type { FileProbe } from "../../src/cockpit/editor/file-kind.ts";
import {
  externalReferences,
  isEditable,
  isPartialRead,
  notEditableSentence,
  partialReadSentence,
  sealedFrameSentence,
  tooLargeToEditSentence,
} from "../../src/cockpit/editor/file-kind.ts";
import EditorRoom from "../../src/cockpit/rooms/EditorRoom.svelte";
import { forgetEditorBufferForTests } from "../../src/cockpit/editor/buffer.ts";
import {
  fileAbsenceReason,
  loadDir,
  probePath,
  readMedia,
  readText,
  setEditorReaders,
  type ProbeLoad,
  type TextLoad,
} from "../../src/cockpit/editor/feed.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { absenceReason } from "../../src/data/absence.ts";
import { ClientError } from "../../src/data/errors.ts";
import { resetProjects, selectProject, setProjects } from "../../src/state/projects.ts";
import type { DirLoad, TreeRow } from "../../src/cockpit/editor/tree.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const ROOT = "/proj";

function probeOf(over: Partial<FileProbe> = {}): FileProbe {
  return {
    abs: `${ROOT}/index.html`,
    relativePath: "index.html",
    kind: "file",
    size: 120,
    text: true,
    binaryReason: null,
    mediaType: null,
    language: "html",
    maxReadBytes: 1 << 20,
    maxEditBytes: 10 << 20,
    ...over,
  };
}

function textOf(content: string, over: Partial<Extract<TextLoad, { kind: "read" }>> = {}): TextLoad {
  return {
    kind: "read",
    path: `${ROOT}/index.html`,
    relativePath: "index.html",
    content,
    size: content.length,
    lineCount: content.split("\n").length,
    language: "html",
    truncated: false,
    ...over,
  };
}

/** Mount the pane over one file, in one view. Only the props that vary are
 * named; the rest are the room's own resting values. */
function mountPane(opts: {
  probe: FileProbe;
  text: TextLoad;
  mode: "rendered" | "source" | "edit";
  relativePath?: string;
}) {
  const probeLoad: ProbeLoad = { kind: "measured", probe: opts.probe };
  return render(FilePane, {
    props: {
      relativePath: opts.relativePath ?? opts.probe.relativePath,
      probeLoad,
      textLoad: opts.text,
      mediaLoad: null,
      mode: opts.mode,
      draft: null,
      dirty: false,
      restored: false,
      saving: false,
      arm: null,
      confirmedLargeRead: false,
      onmode: () => undefined,
      onopenanyway: () => undefined,
      ondraft: () => undefined,
      onsave: () => undefined,
      onrevert: () => undefined,
      onarmdelete: () => undefined,
      oncanceldelete: () => undefined,
      onconfirmdelete: () => undefined,
      onreread: () => undefined,
    },
  });
}

/** A well-formed report on the one accepted channel. */
function report() {
  return {
    ch: CHANNEL,
    v: 1,
    kind: "error",
    name: "TypeError",
    message: "Cannot read properties of null (reading 'x')",
    line: 8,
    column: 3,
  };
}

const SELF_CONTAINED = [
  "<!doctype html>",
  "<html><head><style>body{color:red}</style></head>",
  "<body><h1>hello</h1><script>document.title='x'</script></body></html>",
].join("\n");

afterEach(() => {
  cleanup();
  artifactErrors.forget(`editor:${ROOT}/index.html`);
});

// ── A. THE PAGE FRAME IS WATCHED ─────────────────────────────────────────

describe("A. a previewed page can report that it broke", () => {
  test("a report from the mounted frame's own window is ACCEPTED", () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(SELF_CONTAINED),
      mode: "rendered",
    });
    const frame = container.querySelector("iframe") as HTMLIFrameElement | null;
    expect(frame, "the page view must mount a frame").not.toBeNull();

    // THE ASSERTION. `unknown-source` is what an unwatched frame produces, and
    // it is what this room shipped: the watch effect threw before it ran, so
    // the channel had never been told this window belonged to a frame.
    const verdict = artifactErrors.deliver(frame!.contentWindow, report());
    expect(
      verdict,
      "an unwatched frame cannot report anything, so a page that dies renders as a blank box with no reason",
    ).toBe("accepted");
  });

  test("the failure then appears over the frame, in the artifact's own words", async () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(SELF_CONTAINED),
      mode: "rendered",
    });
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    artifactErrors.deliver(frame.contentWindow, report());
    await Promise.resolve();
    const strip = container.querySelector('[data-artifact="runtime-error"]');
    expect(strip, "the reason must be legible where the blank box was").not.toBeNull();
    expect(strip!.textContent ?? "").toContain("Cannot read properties of null");
  });

  test("the frame is still mounted at all — the throw did not take the view with it", () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(SELF_CONTAINED),
      mode: "rendered",
    });
    expect(container.querySelector('[data-field="artifact-frame"]')).not.toBeNull();
  });
});

// ── B. THE STRUCTURAL COMPANION ──────────────────────────────────────────

/**
 * Every `<ArtifactFrame …>` mount in the cockpit, with whether it names
 * `frameKey`. Pure, so the mutation below drives it directly.
 *
 * It exists BESIDE §A rather than instead of it: §A proves the property for
 * the one mount that had the defect, and this proves no second mount can be
 * added without it — which is the part a behavioural test of one component
 * cannot reach, and the part `tsc` does not check because it does not read
 * templates.
 */
export function artifactMounts(src: string): { names: boolean }[] {
  const out: { names: boolean }[] = [];
  for (const m of src.matchAll(/<ArtifactFrame\b([\s\S]*?)\/?>/g)) {
    out.push({ names: /\bframeKey\s*=/.test(m[1] ?? "") });
  }
  return out;
}

describe("B. no ArtifactFrame may be mounted without the key its failures land on", () => {
  test("every mount in src/cockpit names frameKey", () => {
    const bad: string[] = [];
    let mounts = 0;
    for (const file of walk("src/cockpit")) {
      if (!file.endsWith(".svelte")) continue;
      const src = read(file);
      if (!src.includes("<ArtifactFrame")) continue;
      for (const m of artifactMounts(src)) {
        mounts += 1;
        if (!m.names) bad.push(relpath(file));
      }
    }
    expect(mounts, "the scanner must have found the mounts it is judging").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  test("MUTATION — a mount with no frameKey is caught", () => {
    const withKey = `<ArtifactFrame\n  frameKey={k}\n  view={v}\n/>`;
    const without = `<ArtifactFrame\n  view={v}\n/>`;
    expect(artifactMounts(withKey)).toEqual([{ names: true }]);
    expect(
      artifactMounts(without),
      "this is the exact shape the editor shipped",
    ).toEqual([{ names: false }]);
  });
});

// ── C. A PATCH THAT HOLDS NO CHANGE ──────────────────────────────────────

describe("C. `as a change` on a file with no change says so", () => {
  const notes = "some notes about a change\nnothing structured here\nline three\n";

  function mountPatch(content: string) {
    return mountPane({
      probe: probeOf({
        abs: `${ROOT}/notes.diff`,
        relativePath: "notes.diff",
        language: "diff",
        size: content.length,
      }),
      text: textOf(content, {
        path: `${ROOT}/notes.diff`,
        relativePath: "notes.diff",
        language: "diff",
      }),
      mode: "rendered",
      relativePath: "notes.diff",
    });
  }

  test("prose named .diff states the reason and shows its characters", () => {
    const { container } = mountPatch(notes);
    const text = container.textContent ?? "";
    expect(text).toContain("named as a patch but holds no change");
    // and the characters are still there, so the reader is not left with a
    // sentence instead of their file.
    expect(text).toContain("some notes about a change");
    // the empty-diff chrome is NOT drawn: `+0 −0` over an empty scroller is a
    // claim that a change was read.
    expect(container.querySelector(".diff")).toBeNull();
  });

  test("a real patch still renders as a change", () => {
    const patch = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = 3;",
      "",
    ].join("\n");
    const { container } = mountPatch(patch);
    expect(container.querySelector(".diff"), "a real diff must still render").not.toBeNull();
    expect(container.textContent ?? "").not.toContain("holds no change");
  });
});

// ── D. AN EMPTY FILE ─────────────────────────────────────────────────────

describe("D. a file with no bytes says it is empty", () => {
  for (const mode of ["rendered", "source"] as const) {
    test(`in the ${mode} view`, () => {
      const { container } = mountPane({
        probe: probeOf({ size: 0 }),
        text: textOf(""),
        mode,
      });
      expect(container.textContent ?? "").toContain("this file is empty");
    });
  }

  test("a file with bytes does not claim to be empty", () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(SELF_CONTAINED),
      mode: "source",
    });
    expect(container.textContent ?? "").not.toContain("this file is empty");
  });
});

// ── E. WHAT THE SEALED FRAME WILL NOT FETCH ──────────────────────────────

describe("E. a page that asks for files beside it is told they will not arrive", () => {
  const linked = [
    "<!doctype html>",
    '<html><head><link rel="stylesheet" href="/style.css"></head>',
    '<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
  ].join("\n");

  test("the references are read out of the page's own text", () => {
    expect(externalReferences(linked)).toEqual(["/style.css", "/src/main.ts"]);
  });

  test("inline-only addresses are not fetches and are not counted", () => {
    const inline =
      '<a href="#top">t</a><img src="data:image/png;base64,AA"><img src="blob:x"><a href="javascript:void 0">j</a>';
    expect(externalReferences(inline)).toEqual([]);
  });

  test("the same file named twice is one file", () => {
    expect(externalReferences('<img src="a.png"><img src="a.png">')).toEqual(["a.png"]);
  });

  test("MUTATION — a page with no references gets no sentence at all", () => {
    expect(sealedFrameSentence([])).toBe("");
    expect(externalReferences(SELF_CONTAINED)).toEqual([]);
  });

  test("the sentence states the COUNT and names the files", () => {
    const say = sealedFrameSentence(["/style.css", "/src/main.ts"]);
    expect(say).toContain("2 files");
    expect(say).toContain("/style.css");
    expect(say).toContain("/src/main.ts");
  });

  test("past three it names three and counts the rest — never a list without an end", () => {
    const say = sealedFrameSentence(["a", "b", "c", "d", "e"]);
    expect(say).toContain("5 files");
    expect(say).toContain("and 2 more");
    expect(say).not.toContain("d,");
  });

  test("the pane shows it above the frame", () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(linked),
      mode: "rendered",
    });
    const text = container.textContent ?? "";
    expect(text).toContain("the sealed frame fetches none of them");
    expect(text).toContain("/src/main.ts");
  });

  test("a self-contained page is not warned about a problem it does not have", () => {
    const { container } = mountPane({
      probe: probeOf(),
      text: textOf(SELF_CONTAINED),
      mode: "rendered",
    });
    expect(container.textContent ?? "").not.toContain("fetches none of them");
  });
});

// ── F. A FILE THIS ROOM CAN ONLY HOLD PART OF ────────────────────────────

describe("F. `edit` is not offered for a file that arrives in part", () => {
  // The server's two caps are independent numbers: 1 MiB read, 10 MiB write by
  // default. A file between them reads truncated and used to be offered `edit`.
  const partial = probeOf({
    abs: `${ROOT}/big.log`,
    relativePath: "big.log",
    language: "text",
    size: 4 << 20,
    maxReadBytes: 1 << 20,
    maxEditBytes: 10 << 20,
  });

  test("the probe alone says the read will be partial", () => {
    expect(isPartialRead(partial)).toBe(true);
    expect(isPartialRead(probeOf())).toBe(false);
  });

  test("so the room does not offer edit", () => {
    expect(isEditable(partial)).toBe(false);
  });

  test("MUTATION — without the partial-read term the room would offer it", () => {
    // The mutation is the PRIOR rule, stated directly: size against the write
    // cap alone. It answers "editable", which is the defect.
    const priorRule = partial.kind === "file" && partial.text && partial.size <= partial.maxEditBytes;
    expect(priorRule, "the old rule must disagree, or this guard proves nothing").toBe(true);
    expect(isEditable(partial)).toBe(false);
  });

  test("the sentence quotes the READ cap, not the write cap", () => {
    const say = notEditableSentence(partial);
    expect(say).toBe(partialReadSentence(partial));
    expect(say).toContain("1.0 MB");
    expect(say, "quoting the write cap here would be a true number about the wrong rule").not.toContain(
      "10.0 MB",
    );
  });

  test("a file past the WRITE cap still gets the write-cap sentence", () => {
    const huge = probeOf({ size: 20 << 20, maxReadBytes: 40 << 20, maxEditBytes: 10 << 20 });
    expect(notEditableSentence(huge)).toBe(tooLargeToEditSentence(huge));
  });

  test("an ordinary file is editable and gets no sentence", () => {
    expect(isEditable(probeOf())).toBe(true);
    expect(notEditableSentence(probeOf())).toBeNull();
  });

  test("the pane shows no edit control and states why", () => {
    const { container } = mountPane({
      probe: partial,
      text: textOf("first megabyte only\n", {
        path: `${ROOT}/big.log`,
        relativePath: "big.log",
        language: "text",
        size: 4 << 20,
        truncated: true,
      }),
      mode: "source",
      relativePath: "big.log",
    });
    expect(container.querySelector('[data-verb-id="editor.view-edit"]')).toBeNull();
    expect(container.textContent ?? "").toContain("FIRST PART");
  });
});

// ── G. A FAILED FOLDER READ HAS A WAY OUT ────────────────────────────────

describe("G. a folder read that failed can be asked again", () => {
  function mountTree(rootLoad: DirLoad, rows: readonly TreeRow[] = []) {
    const asked: string[] = [];
    const r = render(FileTree, {
      props: {
        rows,
        rootLoad,
        selectedPath: null,
        draftPaths: new Set<string>(),
        focusRel: null,
        focusSeq: 0,
        draftKeyOf: (p: string) => p,
        onopenfile: () => undefined,
        ontogglefolder: () => undefined,
        onfocusrow: () => undefined,
        onreadagain: (dir: string) => asked.push(dir),
      },
    });
    return { ...r, asked };
  }

  test("the failure carries a verb, and the verb asks for the ROOT", () => {
    const { container, asked } = mountTree({ kind: "absent", reason: "the server did not answer" });
    expect(container.textContent ?? "").toContain("the server did not answer");
    const again = container.querySelector(
      '[data-verb-id="editor.read-again"]',
    ) as HTMLButtonElement | null;
    expect(
      again,
      "a room whose only read failed has no rows, no verb and no way back — rooms are kept alive, so reopening does not help either",
    ).not.toBeNull();
    again!.click();
    expect(asked).toEqual([""]);
  });

  test("a successful read carries no such verb", () => {
    const { container } = mountTree({ kind: "read", entries: [], truncated: false });
    expect(container.querySelector('[data-verb-id="editor.read-again"]')).toBeNull();
  });

  test("a FOLDER whose read failed carries its own verb, asking for that folder", () => {
    const entry = {
      name: "cockpit",
      path: "/proj/src/cockpit",
      relativePath: "src/cockpit",
      type: "directory" as const,
      size: 0,
      extension: null,
      lineCount: null,
    };
    const { container, asked } = mountTree({ kind: "read", entries: [entry], truncated: false }, [
      { entry, depth: 0, open: true, load: { kind: "absent", reason: "the server did not answer" } },
    ]);
    const again = container.querySelector(
      '[data-verb-id="editor.read-folder-again"]',
    ) as HTMLButtonElement | null;
    expect(again, "an opened folder that failed to read is the same dead end").not.toBeNull();
    again!.click();
    expect(asked).toEqual(["src/cockpit"]);
  });

  test("a folder still being read is not offered as a failure", () => {
    const { container } = mountTree({ kind: "reading" });
    expect(container.querySelector('[data-verb-id="editor.read-again"]')).toBeNull();
    expect(container.textContent ?? "").toContain("reading this project's folders");
  });
});

// ── H. WHY A FILE IS NOT THERE, SAID ABOUT A FILE ────────────────────────

describe("H. an absent file is explained in the vocabulary of files", () => {
  test("a 404 does not become a sentence about the event log", () => {
    const notFound = new ClientError("no_route", "no route", 404);
    // The shared owner's answer, which this room used to render verbatim as
    // `this file — no recorded history`. Seen in the browser.
    expect(absenceReason(notFound)).toBe("no recorded history");
    const said = fileAbsenceReason(notFound);
    expect(said).not.toBe("no recorded history");
    expect(said).toContain("path");
  });

  test("the server's own file codes are named", () => {
    expect(fileAbsenceReason({ code: "file_not_found" })).toContain("nothing at this path");
    expect(fileAbsenceReason({ code: "file_too_large" })).toContain("in one read");
  });

  test("everything else still falls through to the single shared owner", () => {
    const denied = new ClientError("forbidden", "nope", 403);
    expect(fileAbsenceReason(denied)).toBe(absenceReason(denied));
    expect(fileAbsenceReason(new Error("boom"))).toBe(absenceReason(new Error("boom")));
  });

  // A unit test of the sentence proves the sentence and NOT that any read uses
  // it. These four drive the real read functions with a failing door, which is
  // the only way the wiring itself is under test.
  test("every read the room makes answers in that vocabulary", async () => {
    const gone = new ClientError("no_route", "no route", 404);
    const fail = () => Promise.reject(gone);
    const prev = setEditorReaders({ tree: fail, probe: fail, read: fail, media: fail });
    try {
      const said = fileAbsenceReason(gone);
      expect(said).not.toBe("no recorded history");
      expect(await probePath("/proj/x.ts", "/proj")).toEqual({ kind: "absent", reason: said });
      expect(await readText("/proj/x.ts", "/proj")).toEqual({ kind: "absent", reason: said });
      expect(await readMedia("/proj/x.png", "/proj")).toEqual({ kind: "absent", reason: said });
      expect(await loadDir("/proj", "")).toEqual({ kind: "absent", reason: said });
    } finally {
      setEditorReaders(prev);
    }
  });
});

// ── I. THE ROOM AFTER A WRITE ────────────────────────────────────────────

/**
 * The room, mounted over injected doors. Everything below the room is real —
 * the buffer, the save path, the pane, the tree — and only the four network
 * doors are replaced, so what is proven here is the room's own sequencing.
 */
function mountRoom(disk: Map<string, string>) {
  // The room measures its own width (`bind:clientWidth`) to decide whether the
  // two panes sit side by side; jsdom has no ResizeObserver and reports zero
  // width, so the room would render its NARROW arrangement — where the tree and
  // the pane take turns. A stub that reports the wide arrangement is what lets
  // these cases exercise the layout a reader on a desktop actually sees.
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // Installed through vitest, not by direct assignment: the file teardown
  // restores the environment it inherited, so the polyfill cannot outlive this
  // file in the suite's worker.
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);

  const root = "/proj";
  const projectId = "p1";
  setProjects([
    {
      id: projectId,
      name: "proj",
      path: root,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  selectProject(projectId);

  const wrote: string[] = [];
  const prev = setEditorReaders({
    tree: (_p: string, dir: string) =>
      Promise.resolve({
        root,
        entryCount: disk.size,
        entries: [...disk.keys()]
          .filter((rel) => !rel.includes("/") || dir.length > 0)
          .map((rel) => ({
            name: rel.split("/").pop(),
            path: `${root}/${rel}`,
            relativePath: rel,
            type: "file",
            size: (disk.get(rel) ?? "").length,
            extension: null,
            lineCount: null,
          })),
      }),
    probe: (path: string) => {
      const rel = path.slice(root.length + 1);
      const content = disk.get(rel);
      if (content === undefined) return Promise.reject(Object.assign(new Error("gone"), { code: "file_not_found" }));
      return Promise.resolve({
        abs: path,
        relativePath: rel,
        kind: "file",
        size: content.length,
        text: true,
        binaryReason: null,
        mediaType: null,
        language: "html",
        maxReadBytes: 1 << 20,
        maxEditBytes: 10 << 20,
      });
    },
    read: (path: string) => {
      const rel = path.slice(root.length + 1);
      const content = disk.get(rel) ?? "";
      return Promise.resolve({
        path,
        relativePath: rel,
        content,
        size: content.length,
        lineCount: content.split("\n").length,
        language: "html",
        truncated: false,
      });
    },
    write: (save: { apiPath: string; content: string }) => {
      disk.set(save.apiPath.slice(root.length + 1), save.content);
      wrote.push(save.apiPath);
      return Promise.resolve({ path: save.apiPath });
    },
    createFile: (path: string) => {
      disk.set(path, "");
      return Promise.resolve({ path: `${root}/${path}` });
    },
  });

  const shell = {
    revealAt: () => 0,
    openRoom: () => undefined,
    closeRoom: () => undefined,
    openScope: () => undefined,
    closeScope: () => undefined,
    setAnnunciators: () => undefined,
    setMonitors: () => undefined,
    claimKey: () => () => undefined,
    pushDismiss: () => () => undefined,
    hint: () => undefined,
  } as unknown as ShellApi;

  const r = render(EditorRoom, { props: { shell } });
  return { ...r, wrote, restore: () => setEditorReaders(prev) };
}

const settle = async (ms = 40) => {
  await new Promise((res) => setTimeout(res, ms));
};

describe("I. what the room shows after it writes", () => {
  afterEach(() => {
    forgetEditorBufferForTests();
    resetProjects();
    cleanup();
  });

  test("a saved file is READ BACK — the pane does not go on showing the old one", async () => {
    const disk = new Map<string, string>([["page.html", ""]]);
    const { container, wrote, restore } = mountRoom(disk);
    try {
      await settle(80);
      const row = [...container.querySelectorAll("button.row")].find(
        (b) => b.querySelector(".name")?.textContent === "page.html",
      ) as HTMLButtonElement;
      expect(row, "the injected tree must have produced a row").not.toBeUndefined();
      row.click();
      await settle(80);

      // An empty file, honestly stated.
      expect(container.textContent ?? "").toContain("this file is empty");

      (container.querySelector('[data-verb-id="editor.view-edit"]') as HTMLButtonElement).click();
      await settle();
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      ta.value = "<h1>written</h1>\n";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();

      (container.querySelector('[data-verb-id="editor.save"]') as HTMLButtonElement).click();
      await settle(120);

      expect(wrote, "the write must have gone through the one checked door").toEqual([
        "/proj/page.html",
      ]);
      expect(container.textContent ?? "").toContain("recorded as a file effect");

      // THE ASSERTION, MADE WHERE THE STALENESS IS VISIBLE. `edit` is drawn
      // from the BUFFER, which the save updated, so it shows the new text
      // either way — asserting from there proves nothing at all. The two
      // READING views and the header are drawn from `textLoad`, which is the
      // read taken when the file was opened, so this leaves the edit view
      // first and then looks.
      (container.querySelector('[data-verb-id="editor.view-source"]') as HTMLButtonElement).click();
      await settle(80);
      const text = container.textContent ?? "";
      expect(text, "the reading view must show the bytes that were just written").toContain(
        "<h1>written</h1>",
      );
      expect(text, "the pane must not still describe the file it replaced").not.toContain(
        "this file is empty",
      );
      // The header's numbers are the SERVER's, and they were measured before
      // the write. `17` is the length the injected disk now reports.
      expect(text, "the header must not go on quoting the size it read at open").not.toContain(
        "0 bytes",
      );
    } finally {
      restore();
    }
  });
});

// ── J. A VERB THAT REPORTS WHERE NOTHING IS ON SCREEN ────────────────────

describe("J. the room says what happened even with no file open", () => {
  afterEach(() => {
    forgetEditorBufferForTests();
    resetProjects();
    cleanup();
  });

  test("creating a file reports into the room, not into the unmounted pane", async () => {
    const disk = new Map<string, string>([["page.html", "x"]]);
    const { container, restore } = mountRoom(disk);
    try {
      await settle(80);
      // No file is open — which is the room's resting state, and exactly the
      // state `create` is normally used from. The pane renders one line and
      // nothing else in it, so a notice rendered THERE is a notice nobody sees.
      expect(container.querySelector('[data-verb-id="editor.view-source"]')).toBeNull();

      const name = container.querySelector("input.new-name") as HTMLInputElement;
      name.value = "made.html";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      (container.querySelector('[data-verb-id="editor.create"]') as HTMLButtonElement).click();
      await settle(120);

      const notice = container.querySelector(".room-notice");
      expect(notice, "a verb that reports nowhere reads as a verb that did nothing").not.toBeNull();
      expect(notice!.textContent ?? "").toContain("created made.html");
    } finally {
      restore();
    }
  });
});
