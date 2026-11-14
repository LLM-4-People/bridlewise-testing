/** The public entry closes native transport before loading the product graph. */
import { selectPersistenceNamespace } from "../state/persistence.ts";
import { closeClientNetwork } from "../data/network-access.ts";
import { REPLAY_NETWORK_REASON } from "./replay.ts";

selectPersistenceNamespace("public-fixture-v2");
closeClientNetwork(REPLAY_NETWORK_REASON);

const target = document.getElementById("demo");
if (target === null) throw new Error("The public replay has no mount target");

void Promise.all([import("svelte"), import("./Demo.svelte"), import("virtual:bridlewise-public-replay")])
  .then(([{ mount }, { default: Demo }, { default: record, workspaceHref, homeHref }]) => {
    target.replaceChildren();
    return mount(Demo, { target, props: { record, workspaceHref, homeHref, embedded: new URLSearchParams(location.search).get("view") === "embedded" } });
  })
  .catch((error: unknown) => {
    target.textContent = `The published replay could not open. ${error instanceof Error ? error.message : String(error)}`;
    target.setAttribute("role", "alert");
  });
