/**
 * Dev harness entry — mounts the flow standalone (see DevHarness.svelte).
 * Served by cockpit-dev.html; never part of the product bundle.
 */
import { mount } from "svelte";

import "../../tokens.css";
import DevHarness from "./DevHarness.svelte";

mount(DevHarness, { target: document.getElementById("harness")! });
