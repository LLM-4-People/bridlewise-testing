// @vitest-environment jsdom
/**
 * THE FOLDER PICKER — the component, live in jsdom against a stubbed
 * filesystem API.
 *
 * What must hold on screen, and the mutations each one refuses:
 *   - the opening view is the server's allowed roots, fetched once;
 *   - clicking (or Enter on) a folder navigates INTO it — the listing is
 *     re-anchored at that folder and its real children render;
 *   - the up-row walks back out, and at a parentless root the roots view
 *     returns;
 *   - a folder the server refuses (outside the allowed roots) is said in
 *     the refusal's own words and is never rendered as empty;
 *   - the inline "new folder" makes the folder on the server and STEPS
 *     INTO it — the created row comes from a re-read, never invented;
 *   - the confirm verb is disabled until the picker stands on a real,
 *     readable folder, and then hands THAT path to the caller.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import FolderPicker from "../../src/cockpit/rooms/FolderPicker.svelte";

// The wire the stub answers with — a small two-level tree:
//   /root          (a root; children: alpha, blocked)
//   /root/alpha    (children: deep)
//   /root/alpha/deep  (children: none)
//   /root/blocked  (list refused: outside the allowed roots)
const TREE: Record<string, { parent: string | null; names: string[] }> = {
  "/root": { parent: null, names: ["alpha", "blocked"] },
  "/root/alpha": { parent: "/root", names: ["deep"] },
  "/root/alpha/deep": { parent: "/root/alpha", names: [] },
};

let calls: { method: string; url: string; body?: unknown }[];

function stubFilesystem(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body !== null && init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

      if (url.includes("/api/filesystem/roots")) {
        return json({ roots: [{ label: "root", path: "/root" }] });
      }
      const listMatch = /\/api\/filesystem\/list\?path=(.*)$/.exec(url);
      if (listMatch !== null) {
        const path = decodeURIComponent(listMatch[1]!);
        if (path === "/root/blocked") {
          return json({ error: "path_outside_roots", message: "Path is outside the allowed browsing roots" }, 403);
        }
        const node = TREE[path];
        if (node === undefined) {
          return json({ error: "not_found", message: `Path not found: ${path}` }, 404);
        }
        return json({
          path,
          parent: node.parent,
          accessible: true,
          entries: node.names.map((name) => ({ name, path: `${path}/${name}`, accessible: true })),
        });
      }
      if (url.includes("/api/filesystem/mkdir") && method === "POST") {
        const body = calls[calls.length - 1]!.body as { parent: string; name: string };
        const path = `${body.parent}/${body.name}`;
        // The mkdir makes the folder REAL in the stub's tree.
        TREE[path] = { parent: body.parent, names: [] };
        const parentNode = TREE[body.parent];
        if (parentNode !== undefined && !parentNode.names.includes(body.name)) {
          parentNode.names.push(body.name);
        }
        return json({ ok: true, path, name: body.name }, 200);
      }
      return json({}, 200);
    }),
  );
}

beforeEach(() => {
  cleanup();
  stubFilesystem();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  // The stub's tree is module state; restore the made folders.
  for (const key of Object.keys(TREE)) {
    if (!["/root", "/root/alpha", "/root/alpha/deep"].includes(key)) delete TREE[key];
  }
  TREE["/root"]!.names = ["alpha", "blocked"];
  TREE["/root/alpha"]!.names = ["deep"];
});

function renderPicker(onselect: (path: string) => void = () => {}) {
  return render(FolderPicker, { onselect, oncancel: () => {}, subject: "the folder" });
}

describe("browsing", () => {
  test("the opening view is the server's allowed roots, fetched once", async () => {
    const { getByRole } = renderPicker();
    await waitFor(() => expect(getByRole("treeitem", { name: /root/ })).toBeTruthy());
    const rootsCalls = calls.filter((c) => c.url.includes("/api/filesystem/roots"));
    expect(rootsCalls).toHaveLength(1);
  });

  test("clicking a folder navigates INTO it and lists its real children", async () => {
    const { getByRole, findByRole, queryByRole } = renderPicker();
    const root = await findByRole("treeitem", { name: /root/ });
    await fireEvent.click(root);
    // The listing re-anchors: the root's own children render.
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    expect(getByRole("treeitem", { name: /blocked/ })).toBeTruthy();
    // The child of the child is NOT listed until asked for.
    expect(queryByRole("treeitem", { name: /deep/ })).toBeNull();
  });

  test("the up row walks back out", async () => {
    const { getByRole, findByRole, queryByRole, getByText } = renderPicker();
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    // The root is parentless in the stub — no up row at the top level.
    expect(queryByRole("button", { name: /up a folder/ })).toBeNull();
    // Step INTO alpha (whose parent is the root) — now the up row appears.
    await fireEvent.click(getByRole("treeitem", { name: /alpha/ }));
    await waitFor(() => expect(getByText("up a folder")).toBeTruthy());
    await fireEvent.click(getByText("up a folder"));
    // Back at the root's listing (its children are on screen again).
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    expect(queryByRole("treeitem", { name: /deep/ })).toBeNull();
  });

  test("a refused folder is said in the refusal's own words, never as empty", async () => {
    const { findByRole, getByText } = renderPicker();
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    const blocked = await findByRole("treeitem", { name: /blocked/ });
    await fireEvent.click(blocked);
    await waitFor(() =>
      expect(getByText(/outside the folders this server lets you browse/)).toBeTruthy(),
    );
  });
});

describe("the answer", () => {
  test("the checkmark is disabled until the picker stands on a real folder", async () => {
    const { getByRole, findByRole } = renderPicker();
    const confirm = getByRole("button", { name: "choose this folder" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });

  test("the header checkmark hands the standing-on path to the caller", async () => {
    let picked: string | null = null;
    const { getByRole, findByRole } = renderPicker((path) => (picked = path));
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    const confirm = getByRole("button", { name: /^choose \/root$/ }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    await fireEvent.click(confirm);
    expect(picked).toBe("/root");
  });

  test("a row checkmark chooses that folder without a second confirm", async () => {
    let picked: string | null = null;
    const { getByRole, findByRole } = renderPicker((path) => (picked = path));
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    await fireEvent.click(getByRole("button", { name: "choose alpha" }));
    expect(picked).toBe("/root/alpha");
  });

  test("clicking a child folder's name navigates; the checkmark is the choose", async () => {
    let picked: string | null = null;
    const { getByRole, findByRole } = renderPicker((path) => (picked = path));
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await fireEvent.click(await findByRole("treeitem", { name: /alpha/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /deep/ })).toBeTruthy());
    await fireEvent.click(getByRole("button", { name: /^choose \/root\/alpha$/ }));
    expect(picked).toBe("/root/alpha");
  });
});

describe("keyboard (APG tree grammar)", () => {
  test("ArrowDown walks the rows; Enter opens the focused folder", async () => {
    const { container, findByRole, getByRole } = renderPicker();
    await findByRole("treeitem", { name: /root/ });
    const tree = container.querySelector('[role="tree"]')!;
    await fireEvent.keyDown(tree, { key: "ArrowDown" });
    await fireEvent.keyDown(tree, { key: "Enter" });
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
  });

  test("ArrowRight expands a closed row; ArrowLeft collapses it", async () => {
    const { container, findByRole, getByRole, queryByRole } = renderPicker();
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    const tree = container.querySelector('[role="tree"]')!;
    // Focus the alpha row, then Right expands it in place.
    await fireEvent.keyDown(tree, { key: "ArrowDown" }); // first dir row
    await fireEvent.keyDown(tree, { key: "ArrowRight" });
    await waitFor(() => expect(getByRole("treeitem", { name: /deep/ })).toBeTruthy());
    await fireEvent.keyDown(tree, { key: "ArrowLeft" });
    await waitFor(() => expect(queryByRole("treeitem", { name: /deep/ })).toBeNull());
  });
});

describe("new folder", () => {
  test("making a folder creates it on the server and steps INTO it", async () => {
    let picked: string | null = null;
    const { getByRole, findByRole, getByLabelText, getByText } = renderPicker((p) => (picked = p));
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    await fireEvent.click(getByRole("button", { name: "New folder" }));
    await fireEvent.input(getByLabelText("new folder name"), { target: { value: "fresh" } });
    await fireEvent.click(getByRole("button", { name: "Add" }));
    // The picker stepped into the created folder: the checkmark's answer is it.
    await waitFor(() => {
      expect(getByRole("button", { name: /choose \/root\/fresh/ })).toBeTruthy();
    });
    const confirm = getByRole("button", { name: /choose \/root\/fresh/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await fireEvent.click(confirm);
    expect(picked).toBe("/root/fresh");
    // The folder really was made on the server.
    expect(calls.some((c) => c.url.includes("/api/filesystem/mkdir") && (c.body as { name: string }).name === "fresh")).toBe(true);
  });

  test("a bad folder name is refused before the server is asked", async () => {
    const { getByRole, findByRole, getByLabelText, getByText } = renderPicker();
    await fireEvent.click(await findByRole("treeitem", { name: /root/ }));
    await waitFor(() => expect(getByRole("treeitem", { name: /alpha/ })).toBeTruthy());
    await fireEvent.click(getByRole("button", { name: "New folder" }));
    await fireEvent.input(getByLabelText("new folder name"), { target: { value: "a/b" } });
    await fireEvent.click(getByRole("button", { name: "Add" }));
    await waitFor(() => expect(getByText(/cannot contain path separators/)).toBeTruthy());
    expect(calls.some((c) => c.url.includes("/api/filesystem/mkdir"))).toBe(false);
  });
});
