/**
 * THE RENDERED JUDGEMENT'S FORCED STATES, against a page that changes while
 * they are forced (scripts/rendered/judge.ts `forceEveryElement`,
 * `releaseForcedStates`).
 *
 * The judge reads the page's tree and forces :hover, :active and :focus on
 * its elements through CDP. A live page removes and adds nodes meanwhile: the
 * cockpit's Lens callout did, and the whole view was refused with "Could not
 * find node with given id". The CDP session here is a stand-in that serves the
 * tree as the browser does, so the page's timing is chosen, not raced:
 * - node ids are bound by a read of the tree, and the same ids answer a later
 *   query;
 * - reading the tree again issues new ids and DISCARDS every state forced
 *   through the old ones;
 * - a node that is gone answers that exact error.
 */
import { describe, expect, test } from "vitest";

import { forceEveryElement, releaseForcedStates, type CdpSend } from "../../scripts/rendered/judge.ts";

const GONE = "Could not find node with given id";

/** A page of `initial` elements under <html>, served over a stand-in CDP session. */
function livePage(initial: readonly string[]) {
  let elements = [...initial];
  const forced = new Map<string, readonly string[]>();
  let ids = new Map<number, string>();
  let documentId = -1;
  let nextNode = 100;
  let reads = 0;
  const hooks: { afterSnapshot?: (() => void) | undefined; failWith?: string } = {};
  const idOf = (name: string): number => {
    for (const [id, bound] of ids) if (bound === name) return id;
    const id = nextNode++;
    ids.set(id, name);
    return id;
  };
  const present = (name: string | undefined): name is string => name !== undefined && (name === "html" || elements.includes(name));
  const send: CdpSend = async (method, params) => {
    await Promise.resolve();
    if (method === "DOM.getDocument") {
      reads += 1;
      ids = new Map();
      forced.clear();
      documentId = nextNode++;
      const element = (name: string, children: unknown[] = []): unknown => ({ nodeId: idOf(name), backendNodeId: 0, nodeType: 1, nodeName: name.toUpperCase(), localName: name, attributes: [], children });
      const root = { nodeId: documentId, backendNodeId: 0, nodeType: 9, nodeName: "#document", children: [element("html", elements.map((name) => element(name)))] };
      const after = hooks.afterSnapshot;
      hooks.afterSnapshot = undefined;
      after?.();
      return { root };
    }
    if (method === "DOM.querySelectorAll") {
      const { nodeId, selector } = params as { nodeId: number; selector: string };
      if (nodeId !== documentId) throw new Error(`Protocol error (DOM.querySelectorAll): ${GONE}`);
      return { nodeIds: selector === "*" ? ["html", ...elements].map(idOf) : [] };
    }
    if (method === "CSS.forcePseudoState") {
      const { nodeId, forcedPseudoClasses } = params as { nodeId: number; forcedPseudoClasses: readonly string[] };
      if (hooks.failWith !== undefined) throw new Error(hooks.failWith);
      const name = ids.get(nodeId);
      if (!present(name)) throw new Error(`Protocol error (CSS.forcePseudoState): ${GONE}`);
      if (forcedPseudoClasses.length === 0) forced.delete(name);
      else forced.set(name, forcedPseudoClasses);
      return {};
    }
    throw new Error(`the stand-in serves no ${method}`);
  };
  return {
    send,
    forced,
    hooks,
    reads: (): number => reads,
    remove: (name: string): void => { elements = elements.filter((e) => e !== name); forced.delete(name); },
    add: (name: string): void => { elements.push(name); },
  };
}

describe("rendered forced states", () => {
  test("a node the page removes between the snapshot and the force is gone, and every other element is forced", async () => {
    const page = livePage(["p1", "p2", "p3"]);
    page.hooks.afterSnapshot = () => page.remove("p2");
    await forceEveryElement(page.send, "cockpit");
    expect([...page.forced.keys()].sort()).toEqual(["html", "p1", "p3"]);
    expect(page.forced.get("p1")).toEqual(["hover", "active", "focus-within"]);
  });

  test("an element the page adds while the states are forced is forced from a fresh snapshot", async () => {
    const page = livePage(["p1", "p2"]);
    page.hooks.afterSnapshot = () => page.add("p4");
    await forceEveryElement(page.send, "cockpit");
    expect([...page.forced.keys()].sort()).toEqual(["html", "p1", "p2", "p4"]);
  });

  test("the pass reads the tree once, so no state it forced is discarded by a second read", async () => {
    const page = livePage(["p1", "p2"]);
    page.hooks.afterSnapshot = () => page.add("p4");
    await forceEveryElement(page.send, "cockpit");
    expect(page.reads()).toBe(1);
    expect(page.forced.size).toBe(4);
  });

  test("any other CDP error is refused, never taken for a node that is gone", async () => {
    const page = livePage(["p1"]);
    page.hooks.failWith = "Protocol error (CSS.forcePseudoState): Target closed";
    await expect(forceEveryElement(page.send, "cockpit")).rejects.toThrow(/Target closed/u);
  });

  test("the release clears every element still forced, and one the page removed meanwhile is gone with its state", async () => {
    const page = livePage(["p1", "p2", "p3"]);
    const forced = await forceEveryElement(page.send, "cockpit");
    page.remove("p2");
    await releaseForcedStates(page.send, forced);
    expect([...page.forced.keys()]).toEqual([]);
  });
});
