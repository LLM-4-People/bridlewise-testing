/**
 * THE RENDERED JUDGEMENT'S FORCED STATES, against a page that changes while
 * they are forced (scripts/rendered/judge.ts `forceEveryElement`,
 * `releaseForcedStates`).
 *
 * The judge reads one snapshot of the page's tree and forces :hover, :active
 * and :focus on its elements through CDP. A live page removes and adds nodes
 * meanwhile: the cockpit's Lens callout did, and the whole view was refused
 * with "Could not find node with given id". The CDP session here is a stand-in
 * that serves the tree as the browser does (fresh node ids on every snapshot,
 * stable backend ids, that exact error for a node that is gone), so the
 * page's timing is chosen, not raced.
 */
import { describe, expect, test } from "vitest";

import { forceEveryElement, releaseForcedStates, type CdpSend } from "../../scripts/rendered/judge.ts";

/** A page of `initial` elements under <html>, served over a stand-in CDP session. */
function livePage(initial: readonly string[]) {
  let elements = [...initial];
  const backends = new Map<string, number>();
  const forced = new Map<string, readonly string[]>();
  let ids = new Map<number, string>();
  let nextNode = 100;
  const hooks: { afterSnapshot?: (() => void) | undefined; failWith?: string } = {};
  const backendOf = (name: string): number => {
    if (!backends.has(name)) backends.set(name, backends.size + 1);
    return backends.get(name)!;
  };
  const node = (name: string, children: unknown[] = []): unknown => {
    const nodeId = nextNode++;
    ids.set(nodeId, name);
    return { nodeId, backendNodeId: backendOf(name), nodeType: 1, nodeName: name.toUpperCase(), localName: name, attributes: [], children };
  };
  const send: CdpSend = async (method, params) => {
    await Promise.resolve();
    if (method === "DOM.getDocument") {
      ids = new Map();
      const root = { nodeId: nextNode++, backendNodeId: 0, nodeType: 9, nodeName: "#document", children: [node("html", elements.map((name) => node(name)))] };
      const after = hooks.afterSnapshot;
      hooks.afterSnapshot = undefined;
      after?.();
      return { root };
    }
    if (method === "CSS.forcePseudoState") {
      const { nodeId, forcedPseudoClasses } = params as { nodeId: number; forcedPseudoClasses: readonly string[] };
      if (hooks.failWith !== undefined) throw new Error(hooks.failWith);
      const name = ids.get(nodeId);
      if (name === undefined || (name !== "html" && !elements.includes(name))) throw new Error("Protocol error (CSS.forcePseudoState): Could not find node with given id");
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
