// @vitest-environment jsdom
/**
 * THE TOOL SERVER LIST IN THE SETTINGS ROOM — the door UIE-060 was filed
 * against: the "Connected tool servers" category served four call-behavior
 * knobs while offering NO way to add, list, edit or remove an MCP SERVER
 * (the only way was hand-editing the config file). This file pins the
 * section that closes the gap, at its contract:
 *
 *   - the list renders the servers the served list carries (the projection
 *     arm: kill the projection and the category's promise reds);
 *   - add posts the registration through the real save wrapper, and the
 *     list repaints from the server's own read-back;
 *   - credential values are never rendered — the list speaks names and
 *     hasToken only, and the edit form's credential fields open BLANK
 *     (blank keeps the saved one);
 *   - a NEW credential name with a blank value refuses in the form's own
 *     words, before any wrapper is called;
 *   - test drives the real probe wrapper and renders the endpoint's own
 *     sentence — an unreachable server is named as "did not answer",
 *     never as a crash;
 *   - remove is a two-press verb driving the real delete wrapper;
 *   - the room mounts the section INSIDE the "Connected tool servers"
 *     category, so the rail jump lands on servers and call knobs as one
 *     area;
 *   - the row-status FACE follows the WIRE: a write verb's completion
 *     re-reads the list, a read that lands on the registry's unmeasured
 *     snapshot (the hot rebuild a write kicked, or a runtime that has not
 *     started) is followed at the settle cadence until a row is measured,
 *     the in-flight row renders the connecting word (never "not
 *     connected" for a server the client itself asked to connect), a
 *     hidden room is quiet (the follow stops with the room), the follow
 *     is bounded by a wall clock, and a room re-visit re-reads so the
 *     hide/show cycle never serves a cached face for a live-served fact.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

vi.mock("../../src/client.ts", () => ({
  // The room arm renders the WHOLE room, so the provider section's wrappers
  // must answer too — an empty catalog is the honest no-providers state.
  getModels: vi.fn(async () => ({
    providers: [],
    defaultProvider: null,
    defaultModel: null,
    setupRequired: false,
    setupRemedy: "",
  })),
  saveModelPrefs: vi.fn(async () => ({})),
  deleteModelProvider: vi.fn(async () => ({})),
  testModelProvider: vi.fn(async () => ({ ok: true, elapsedMs: 1 })),
  listMcpServers: vi.fn(async () => SERVERS_TWO),
  saveMcpServer: vi.fn(async () => SERVERS_TWO[0]!),
  deleteMcpServer: vi.fn(async () => undefined),
  testMcpServer: vi.fn(async () => ({
    ok: false,
    failureKind: "no-answer",
    detail: "the command did not start: no such file",
    elapsedMs: 42,
  })),
}));

import {
  deleteMcpServer,
  listMcpServers,
  saveMcpServer,
  testMcpServer,
  type McpServerView,
} from "../../src/client.ts";
import { bindShellVisibility, setVisibleRoom } from "../../src/cockpit/shell/room-visibility.ts";
import { MCP_SETTLE_FOLLOW_MAX_MS, MCP_SETTLE_FOLLOW_POLL_MS } from "../../src/cockpit/settings/settings-config.ts";
import McpServersSection from "../../src/cockpit/settings/McpServersSection.svelte";

/** One configured server exactly as the wire serves it — typed against the
 * shared view so a fixture that drifts from the wire contract is a compile
 * error, and so the sequenced-wire arms can build derived answers from it. */
const SERVER_ONE: McpServerView = {
  id: "local-fixture",
  transport: "stdio",
  enabled: true,
  command: "node",
  args: ["fake-mcp-server.mjs"],
  readPaths: [],
  url: null,
  subprotocol: null,
  envNames: ["API_TOKEN"],
  headerNames: [],
  auth: { type: "api-key", header: null, envName: "API_TOKEN", hasToken: true },
  retry: null,
  timeoutMs: null,
  protocolVersion: "2025-11-25",
  status: "stopped",
  toolCount: 0,
  callCount: 0,
  errorCount: 0,
  lastError: null,
  lastErrorCode: null,
  confinement: null,
  confinementReason: null,
};

const SERVERS_TWO: readonly McpServerView[] = [
  SERVER_ONE,
  {
    ...SERVER_ONE,
    id: "remote-wiki",
    transport: "http",
    command: null,
    args: [],
    url: "https://mcp.example.com/mcp",
    envNames: [],
    headerNames: ["X-Secret"],
    auth: { type: "bearer", header: null, envName: null, hasToken: true },
    status: "connected",
    toolCount: 3,
  },
];

beforeEach(() => {
  vi.mocked(listMcpServers).mockClear();
  vi.mocked(saveMcpServer).mockReset().mockResolvedValue(SERVER_ONE);
  vi.mocked(deleteMcpServer).mockClear();
  vi.mocked(testMcpServer).mockClear();
  // The default wire answer, re-armed per test so an arm that sequences the
  // wire (mockImplementation over a local rows variable) never leaks into
  // the next one.
  vi.mocked(listMcpServers).mockImplementation(async () => SERVERS_TWO);
});
afterEach(() => {
  cleanup();
});

function field(container: HTMLElement, name: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(el, name).not.toBeNull();
  return el!;
}

describe("the servers list", () => {
  test("renders the registered servers — the category's missing half", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-mcp-server]'),
        "the 'Connected tool servers' category must list the registered servers — its knobs adjust calls to servers that could not be added from the room",
      ).toHaveLength(2);
    });
    const row = container.querySelector('[data-mcp-server="remote-wiki"]')!;
    expect(row.textContent).toContain("https://mcp.example.com/mcp");
    expect(row.textContent).toContain("connected");
    expect(container.querySelector('[data-mcp-server="local-fixture"]')!.textContent).toContain("node fake-mcp-server.mjs");
  });

  test("the served credential NAMES stand in — no credential value field exists on a row", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    const creds = container.querySelector('[data-field="mcp-server-credentials"]')!;
    expect(creds.textContent?.replace(/\s+/g, " ")).toContain("1 environment variable : values never shown");
    expect(container.textContent).not.toContain("sentinel");
  });

  test("a failed row shows its typed code with the code's own guidance, and a local server's confinement state", async () => {
    vi.mocked(listMcpServers).mockImplementation(async () => [
      { ...SERVER_ONE, status: "error", lastError: "The read path /home/u/.ssh overlaps /home/u/.ssh, which holds secrets.", lastErrorCode: "mcp_spawn_refused", confinement: "refused", confinementReason: "read_path_refused" },
      { ...SERVER_ONE, id: "free-fixture", status: "connected", confinement: "unconfined", confinementReason: "Self-protection is turned off in the harness settings" },
      { ...SERVERS_TWO[1]!, confinement: "remote" },
    ]);
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"] [data-field="mcp-server-last-error-code"]')).not.toBeNull();
    });
    const failed = container.querySelector('[data-mcp-server="local-fixture"]')!;
    expect(failed.querySelector('[data-field="mcp-server-last-error-code"]')!.textContent).toBe("mcp_spawn_refused");
    expect(failed.querySelector('[data-field="mcp-server-last-error"]')!.textContent).toContain("The sandbox did not start it");
    expect(failed.querySelector('[data-field="mcp-server-confinement"]')!.textContent).toContain("read_path_refused");
    expect(container.querySelector('[data-mcp-server="free-fixture"] [data-field="mcp-server-confinement"]')!.textContent).toContain("UNCONFINED");
    expect(container.querySelector('[data-mcp-server="remote-wiki"] [data-field="mcp-server-confinement"]'), "a remote server has no local process to confine").toBeNull();
  });

  test("an empty list states the honest empty, not a missing door", async () => {
    vi.mocked(listMcpServers).mockResolvedValueOnce([]);
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-field="mcp-server-empty"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-field="mcp-server-empty"]')!.textContent).toContain(
      "no tool servers configured yet",
    );
    // The ADD door exists even with nothing listed.
    expect(container.querySelector('[data-verb-id="mcp.server/add"]')).not.toBeNull();
  });
});

describe("add a tool server", () => {
  test("the form posts the registration through the real save wrapper; the list repaints from the read-back", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add"]')!);
    await fireEvent.input(field(container, "server-name"), { target: { value: "adder" } });
    await fireEvent.input(field(container, "server-command"), { target: { value: "npx" } });
    const enabled = container.querySelector<HTMLButtonElement>('[name="server-enabled"]')!;
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(enabled);
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(saveMcpServer).not.toHaveBeenCalled();
    await fireEvent.input(field(container, "server-args"), {
      target: { value: "-y\n@modelcontextprotocol/server-memory" },
    });
    await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add-env"]')!);
    const envRows = container.querySelectorAll('[data-field="server-env-rows"] [data-pair-row]');
    await fireEvent.input(envRows[0]!.querySelector<HTMLInputElement>(".p-name")!, { target: { value: "API_KEY" } });
    await fireEvent.input(envRows[0]!.querySelector<HTMLInputElement>(".p-value")!, {
      target: { value: "typed-once-never-shown" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        id: "adder",
        enabled: false,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
        env: { API_KEY: "typed-once-never-shown" },
      }));
    });
    // The typed credential never renders anywhere.
    expect(container.textContent).not.toContain("typed-once-never-shown");
  });

  test("a stdio server with no command is a form error, never a write", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-verb-id="mcp.server/add"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add"]')!);
    await fireEvent.input(field(container, "server-name"), { target: { value: "nameless-command" } });
    await fireEvent.submit(container.querySelector("form")!);
    expect(container.querySelector('[data-field="mcp-server-form-note"]')!.textContent).toContain(
      "a local server needs the command that starts it",
    );
    expect(saveMcpServer).not.toHaveBeenCalled();
  });

  test("a NEW credential name with a blank value refuses in the form's own words", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-verb-id="mcp.server/add"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add"]')!);
    await fireEvent.input(field(container, "server-name"), { target: { value: "blank-env" } });
    await fireEvent.input(field(container, "server-command"), { target: { value: "echo" } });
    await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add-env"]')!);
    const envRows = container.querySelectorAll('[data-field="server-env-rows"] [data-pair-row]');
    await fireEvent.input(envRows[0]!.querySelector<HTMLInputElement>(".p-name")!, { target: { value: "BRAND_NEW" } });
    await fireEvent.submit(container.querySelector("form")!);
    expect(container.querySelector('[data-field="mcp-server-form-note"]')!.textContent).toContain(
      'the environment variable "BRAND_NEW" needs a value',
    );
    expect(saveMcpServer).not.toHaveBeenCalled();
  });
});

describe("edit a tool server", () => {
  test("credential fields open BLANK and keep the saved value; only the names are prefilled", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/edit"]')!);
    const envRows = container.querySelectorAll('[data-field="server-env-rows"] [data-pair-row]');
    expect(envRows).toHaveLength(1);
    expect(envRows[0]!.querySelector<HTMLInputElement>(".p-name")!.value).toBe("API_TOKEN");
    expect(envRows[0]!.querySelector<HTMLInputElement>(".p-value")!.value).toBe("");
    expect(field(container, "server-auth-token").value).toBe("");
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({
        id: "local-fixture",
        transport: "stdio",
        command: "node",
        env: { API_TOKEN: "" },
        auth: { type: "api-key", token: "", envName: "API_TOKEN" },
      }));
    });
  });

  test("switching to a remote transport posts the url and drops the stdio fields", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/edit"]')!);
    await fireEvent.change(field(container, "server-transport"), { target: { value: "http" } });
    await fireEvent.input(field(container, "server-url"), { target: { value: "https://moved.example.com/mcp" } });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      const sent = vi.mocked(saveMcpServer).mock.calls[0]![0] as Record<string, unknown>;
      expect(sent["url"]).toBe("https://moved.example.com/mcp");
      expect("command" in sent).toBe(false);
      expect("args" in sent).toBe(false);
    });
  });
});

describe("test and remove a tool server", () => {
  test("test renders the server's own failure sentence, named by its class", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/test"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="mcp-server-note"]')!.textContent).toContain(
        "the server did not answer: the command did not start: no such file",
      );
    });
    expect(testMcpServer).toHaveBeenCalledWith("local-fixture");
  });

  test("test renders the answered shape with the tool names it offered", async () => {
    vi.mocked(testMcpServer).mockResolvedValueOnce({
      ok: true,
      toolNames: ["ping", "echo"],
      elapsedMs: 37,
    });
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/test"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="mcp-server-note"]')!.textContent).toContain(
        "answers: 2 tools listed in 37ms: ping, echo",
      );
    });
  });

  test("remove needs two presses and drives the real wrapper", async () => {
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    const btn = container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/delete"]')!;
    await fireEvent.click(btn);
    expect(deleteMcpServer).not.toHaveBeenCalled();
    expect(btn.textContent).toContain("press again to confirm");
    await fireEvent.click(btn);
    await waitFor(() => {
      expect(deleteMcpServer).toHaveBeenCalledWith("local-fixture");
    });
  });
});

describe("the face follows the wire", () => {
  /** The row's status element, by server id. */
  function statusEl(container: HTMLElement, id: string): HTMLSpanElement {
    const el = container.querySelector<HTMLSpanElement>(`[data-mcp-server="${id}"] [data-field="mcp-server-status"]`);
    expect(el, `the status face of "${id}"`).not.toBeNull();
    return el!;
  }

  /** The row's status WORD, exactly — the word IS the contract, and
   * "connected" is a substring of "not connected", so a containment
   * assertion over the status word is blind to the exact lie this suite
   * exists to catch. */
  function statusWord(container: HTMLElement, id: string): string {
    return (statusEl(container, id).textContent ?? "").trim();
  }

  test("a just-added server's row goes honest in-flight then follows the wire to the settled state — no reload", async () => {
    vi.useFakeTimers();
    try {
      // The wire's answers, sequenced like the real door: the mount read is
      // measured (a published registry), the write kicks the hot rebuild, the
      // read right after the save lands on the rebuild's unmeasured snapshot
      // (every row "stopped"), and the registry publishes a moment later.
      let rows: readonly McpServerView[] = SERVERS_TWO;
      vi.mocked(listMcpServers).mockImplementation(async () => rows);
      const { container } = render(McpServersSection);
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector('[data-mcp-server="remote-wiki"]')).not.toBeNull();

      const inFlight: readonly McpServerView[] = [
        { ...SERVER_ONE },
        { ...SERVERS_TWO[1]!, status: "stopped", toolCount: 0 },
        { ...SERVER_ONE, id: "adder", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      ];
      rows = inFlight;
      await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add"]')!);
      await fireEvent.input(field(container, "server-name"), { target: { value: "adder" } });
      await fireEvent.input(field(container, "server-command"), { target: { value: "npx" } });
      await fireEvent.input(field(container, "server-args"), {
        target: { value: "-y\n@modelcontextprotocol/server-memory" },
      });
      await fireEvent.submit(container.querySelector("form")!);
      await vi.advanceTimersByTimeAsync(0);

      // The in-flight face: the wire says "stopped" (no published
      // measurement) and the client itself kicked the rebuild that will
      // measure it — the word is the connecting one, never "not connected",
      // for the added row AND for the row the rebuild re-establishes.
      expect(statusEl(container, "adder").getAttribute("data-status")).toBe("stopped");
      expect(statusWord(container, "adder")).toBe("connecting…");
      expect(statusWord(container, "remote-wiki")).toBe("connecting…");

      // The registry publishes; the follow's next read adopts the settled
      // answer with no reload.
      rows = [
        { ...SERVER_ONE, status: "connected", toolCount: 1 },
        SERVERS_TWO[1]!,
        { ...SERVER_ONE, id: "adder", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], status: "connected", toolCount: 1 },
      ];
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS);
      expect(statusEl(container, "adder").getAttribute("data-status")).toBe("connected");
      expect(statusWord(container, "adder"), "the face ends at the wire's settled answer — never frozen at the in-flight word").toBe("connected");

      // The settle ended the follow — no eternal reader behind the face.
      const readsAfterSettle = vi.mocked(listMcpServers).mock.calls.length;
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS * 3);
      expect(vi.mocked(listMcpServers).mock.calls.length).toBe(readsAfterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the probe's own verdict renders beside a face that follows the wire", async () => {
    vi.mocked(testMcpServer).mockResolvedValueOnce({
      ok: true,
      toolNames: ["drive25-probe"],
      elapsedMs: 29,
    });
    // The mount answer holds local-fixture unmeasured; the wire moves to the
    // settled state while the probe runs.
    let rows: readonly McpServerView[] = SERVERS_TWO;
    vi.mocked(listMcpServers).mockImplementation(async () => rows);
    const { container } = render(McpServersSection);
    await waitFor(() => {
      expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
    });
    expect(statusWord(container, "local-fixture")).toBe("not connected");

    rows = [{ ...SERVER_ONE, status: "connected", toolCount: 1 }, SERVERS_TWO[1]!];
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/test"]')!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="mcp-server-note"]')!.textContent).toContain(
        "answers: 1 tool listed in 29ms: drive25-probe",
      );
    });
    await waitFor(() => {
      expect(
        statusWord(container, "local-fixture"),
        "the face follows the wire after the probe — a passing verdict beside a stale face is the contradiction the finding names",
      ).toBe("connected");
    });
  });

  test("a room re-visit re-reads — the hide/show cycle never serves a cached face", async () => {
    const unbind = bindShellVisibility();
    try {
      let rows: readonly McpServerView[] = SERVERS_TWO;
      vi.mocked(listMcpServers).mockImplementation(async () => rows);
      const { container } = render(McpServersSection);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Hidden at mount: nothing is read for nobody.
      expect(listMcpServers).not.toHaveBeenCalled();

      setVisibleRoom("settings");
      await waitFor(() => {
        expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull();
      });
      expect(statusWord(container, "local-fixture")).toBe("not connected");

      // The wire moves while the room is hidden; the re-visit must re-read.
      setVisibleRoom(null);
      rows = [{ ...SERVER_ONE, status: "connected", toolCount: 1 }, SERVERS_TWO[1]!];
      setVisibleRoom("settings");
      await waitFor(() => {
        expect(
          statusWord(container, "local-fixture"),
          "a re-visit re-reads the live-served fact — the settings room is kept alive, so the reveal is the revalidation moment",
        ).toBe("connected");
      });
      expect(vi.mocked(listMcpServers).mock.calls.length).toBe(2);
    } finally {
      unbind();
    }
  });

  test("hiding the room stops the follow — quiet when hidden, resumed when shown", async () => {
    vi.useFakeTimers();
    const unbind = bindShellVisibility();
    try {
      // One enabled row the wire never measures: the follow arms on the
      // reveal and would tick forever if nothing stopped it.
      const unmeasured: readonly McpServerView[] = [SERVER_ONE];
      vi.mocked(listMcpServers).mockImplementation(async () => unmeasured);
      const { container } = render(McpServersSection);
      expect(listMcpServers).not.toHaveBeenCalled();

      setVisibleRoom("settings");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(listMcpServers).mock.calls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS);
      expect(vi.mocked(listMcpServers).mock.calls.length).toBe(2);

      setVisibleRoom(null);
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS * 3);
      expect(
        vi.mocked(listMcpServers).mock.calls.length,
        "a hidden room is quiet — the follow stops with the room it belongs to",
      ).toBe(2);

      setVisibleRoom("settings");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(listMcpServers).mock.calls.length, "the re-show re-reads").toBe(3);
    } finally {
      unbind();
      vi.useRealTimers();
    }
  });

  test("a wire that never settles stops reading at the wall-clock bound and leaves the wire's own word standing", async () => {
    vi.useFakeTimers();
    try {
      const unmeasured: readonly McpServerView[] = [SERVER_ONE];
      vi.mocked(listMcpServers).mockImplementation(async () => unmeasured);
      const { container } = render(McpServersSection);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS);
      expect(statusWord(container, "local-fixture")).toBe("connecting…");

      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_MAX_MS + MCP_SETTLE_FOLLOW_POLL_MS * 2);
      const readsAtTheBound = vi.mocked(listMcpServers).mock.calls.length;
      expect(readsAtTheBound).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(MCP_SETTLE_FOLLOW_POLL_MS * 3);
      expect(
        vi.mocked(listMcpServers).mock.calls.length,
        "past the bound the reads are over — never an eternal reader",
      ).toBe(readsAtTheBound);
      expect(
        statusWord(container, "local-fixture"),
        "the wire's own word stands once the follow ends — nothing is fabricated",
      ).toBe("not connected");
      expect(statusEl(container, "local-fixture").getAttribute("data-status")).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the room mount", () => {
  // The rail jump to "Connected tool servers" must land on the SERVERS and
  // the call knobs as one area — the section rides INSIDE the category, not
  // beside the room. A served schema that declares the mcp module with one
  // knob is the honest minimum for that proof.
  test("the section renders inside the 'Connected tool servers' category", async () => {
    const { resetSettingsFeed, setSettingsReaders } = await import("../../src/cockpit/settings/settings-feed.ts");
    const { resetUiSchema, setUiSchema, setUiSchemaValues } = await import("../../src/state/schema-store.ts");
    const { clearCache } = await import("../../src/data/broker.ts");
    const SettingsRoom = (await import("../../src/cockpit/rooms/SettingsRoom.svelte")).default;
    const shell = {
      revealAt: () => 0,
      openRoom: () => {},
      closeRoom: () => {},
      openScope: () => {},
      closeScope: () => {},
      setAnnunciators: () => {},
      setMonitors: () => {},
      claimKey: () => () => {},
      pushDismiss: () => () => {},
      hint: () => {},
      composerText: () => "",
      onComposerSubmit: () => () => {},
      prefillComposer: () => {},
      restoreComposerText: () => {},
      clearComposer: () => {},
      onComposerChange: () => () => {},
      setDeskLine: () => {},
    };
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 0,
    });
    const schema = {
      version: "bridlewise-ui-schema/v2",
      modules: [],
      menus: [],
      panels: [],
      widgets: [],
      settings: [{
        id: "mcp.timeout",
        label: "Time limit per server call",
        description: "A call to a connected tool server is abandoned after this many milliseconds.",
        type: "number",
        default: 30000,
        min: 100,
        max: 600000,
        unit: "milliseconds",
        customizationId: "mcp.timeout",
        module: "mcp",
        effect: "immediate",
        order: 0,
      }],
      actions: [],
      signals: [],
      exposureModules: [{
        id: "mcp",
        title: "Connected tool servers",
        purpose: "How the assistant talks to external tool servers (MCP): how many times a failed call is retried, how long it waits between tries, and how long one call may take.",
      }],
      blockActions: {},
    } as never;
    try {
      clearCache();
      resetSettingsFeed();
      resetUiSchema();
      setUiSchema(schema);
      setUiSchemaValues({ signals: [], customizations: [{ id: "mcp.timeout", value: 30000 }] } as never);
      setSettingsReaders({
        schema: async () => setUiSchema(schema),
        values: async () => setUiSchemaValues({ signals: [], customizations: [{ id: "mcp.timeout", value: 30000 }] } as never),
      });
      const { container } = render(SettingsRoom, { shell });
      await waitFor(() => {
        expect(
          container.querySelector('[data-category="mcp"] [data-field="mcp-servers"]'),
          "the servers list must render INSIDE the 'Connected tool servers' category — the rail jump lands on the servers and the call knobs as one area",
        ).not.toBeNull();
      });
      expect(container.querySelector('[data-category="mcp"]')!.textContent).toContain("local-fixture");
    } finally {
      vi.unstubAllGlobals();
      clearCache();
      resetSettingsFeed();
      resetUiSchema();
    }
  });
});

describe("MCP form completion and probe ownership", () => {
  test.each([
    ["server-command", "later-command"], ["server-args", "later\narguments"],
    ["server-env-name", "LATER_KEY"], ["server-env-value", "later-secret"],
    ["server-auth-token", "later-token"], ["server-auth-header", "X-Later"],
    ["server-auth-env", "LATER_AUTH"], ["server-retry-count", "4"],
    ["server-retry-backoff", "800"], ["server-timeout", "15000"],
  ])("an older save retains newer %s input and focus", async (name, value) => {
    let release!: () => void;
    vi.mocked(saveMcpServer).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(SERVER_ONE); }));
    const {container} = render(McpServersSection);
    await waitFor(() => expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull());
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/edit"]')!);
    const form = container.querySelector('form')!;
    await fireEvent.submit(form);
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    const input = field(container, name);
    input.focus();
    await fireEvent.input(input, {target:{value}});
    release();
    await waitFor(() => expect(!form.isConnected || container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy') === 'false').toBe(true));
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe(value);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-field="mcp-server-form-note"]')?.textContent).toBe(`Saved ${SERVER_ONE.id}. Newer changes are unsaved.`);
  });

  test("an older save cannot close the subsequently opened different server", async () => {
    let release!: () => void;
    vi.mocked(saveMcpServer).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(SERVER_ONE); }));
    const {container} = render(McpServersSection);
    await waitFor(() => expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull());
    await fireEvent.click(container.querySelector('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/edit"]')!);
    await fireEvent.submit(container.querySelector('form')!);
    await fireEvent.click(container.querySelector('[data-mcp-server="remote-wiki"] [data-verb-id="mcp.server/edit"]')!);
    const input = field(container, 'server-url');
    await fireEvent.input(input, {target:{value:'https://mcp.example.com/later'}});
    input.focus();
    release();
    await Promise.resolve();
    await waitFor(() => expect(input.isConnected).toBe(true));
    expect(input.value).toBe('https://mcp.example.com/later');
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-field="mcp-server-form-note"]')).toBeNull();
  });

  test("repeat Test activation excludes work per server while keeping focus", async () => {
    let release!: () => void;
    vi.mocked(testMcpServer).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ok:false,failureKind:'no-answer',detail:'held server answer',elapsedMs:7} as never); }));
    const {container} = render(McpServersSection);
    await waitFor(() => expect(container.querySelector('[data-mcp-server="local-fixture"]')).not.toBeNull());
    const button = container.querySelector<HTMLButtonElement>('[data-mcp-server="local-fixture"] [data-verb-id="mcp.server/test"]')!;
    button.focus();
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(testMcpServer).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    await fireEvent.click(container.querySelector('[data-mcp-server="remote-wiki"] [data-verb-id="mcp.server/test"]')!);
    expect(testMcpServer).toHaveBeenCalledTimes(2);
    release();
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('false'));
    expect(container.querySelector('[data-mcp-server="local-fixture"] [data-field="mcp-server-note"]')?.textContent).toContain('held server answer');
  });
});

describe("MCP entity names are data, including inherited object names", () => {
  test.each(["constructor", "toString"])("%s gets its own reactive Test result", async id => {
    let release!: () => void;
    vi.mocked(testMcpServer).mockImplementationOnce(() => new Promise(resolve=>{release=()=>resolve({ok:false,failureKind:'no-answer',detail:'own MCP reply',elapsedMs:3} as never)}));
    vi.mocked(listMcpServers).mockResolvedValue([{...SERVER_ONE,id}]);
    const {container}=render(McpServersSection);
    await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());
    expect(container.querySelector('[data-field="mcp-server-note"]'), 'no inherited object value is a server verdict').toBeNull();
    const button=container.querySelector('[data-verb-id="mcp.server/test"]')!;
    await fireEvent.click(button);
    expect(container.querySelector('[data-field="mcp-server-note"]')?.textContent).toContain('asking the server');
    release();
    await waitFor(()=>expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(container.querySelector('[data-field="mcp-server-note"]')?.textContent).toContain('own MCP reply');
  });
});

describe('remote, choice and structural draft authority',()=>{
  test.each([
    ['server-url','wss://mcp.example.com/later'],['server-subprotocol','later-protocol'],
    ['server-header-name','X-Later'],['server-header-value','later-secret'],
  ])('an older remote save retains newer %s',async(name,value)=>{
    const server={...SERVERS_TWO[1]!,transport:'websocket' as const,url:'wss://mcp.example.com/mcp'};
    vi.mocked(listMcpServers).mockResolvedValue([server]);let release!:()=>void;
    vi.mocked(saveMcpServer).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(server)}));
    const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);
    const form=container.querySelector('form')!;await fireEvent.submit(form);const input=field(container,name);await fireEvent.input(input,{target:{value}});input.focus();release();
    await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy')==='false').toBe(true));expect(input.isConnected).toBe(true);expect(input.value).toBe(value);expect(document.activeElement).toBe(input);
  });
  test.each([['server-transport','http'],['server-auth-type','none']])('the native input/change sequence retains newer %s',async(name,value)=>{
    let release!:()=>void;vi.mocked(saveMcpServer).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(SERVER_ONE)}));const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);
    const form=container.querySelector('form')!;await fireEvent.submit(form);const select=container.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;await fireEvent.input(select,{target:{value}});await fireEvent.change(select,{target:{value}});select.focus();release();await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy')==='false').toBe(true));expect(select.isConnected).toBe(true);expect(select.value).toBe(value);expect(document.activeElement).toBe(select);
  });
  test.each(['add-env','remove-env','add-header','remove-header','draft-enabled'])('%s survives older success',async action=>{
    let release!:()=>void;vi.mocked(saveMcpServer).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(SERVERS_TWO[1]!)}));const remote={...SERVERS_TWO[1]!,envNames:['OLD']};vi.mocked(listMcpServers).mockResolvedValue([remote]);const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);
    const form=container.querySelector('form')!;await fireEvent.submit(form);await fireEvent.click(container.querySelector(`[data-verb-id="mcp.server/${action}"]`)!);const input=field(container,'server-url');input.focus();release();await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy')==='false').toBe(true));expect(form.isConnected).toBe(true);expect(document.activeElement).toBe(input);
    if(action==='draft-enabled')expect(container.querySelector('[name="server-enabled"]')?.getAttribute('aria-checked')).toBe('false');else expect(container.querySelectorAll(`[name="server-${action.endsWith('env')?'env':'header'}-name"]`)).toHaveLength(action.startsWith('add')?2:0);
  });
  test('an older completion cannot settle a reopened same-target pending request',async()=>{
    const releases:Array<()=>void>=[];vi.mocked(saveMcpServer).mockImplementation(()=>new Promise(resolve=>{releases.push(()=>resolve(SERVER_ONE))}));const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);await fireEvent.submit(container.querySelector('form')!);await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/cancel"]')!);await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);
    const form=container.querySelector('form')!,input=field(container,'server-command');await fireEvent.input(input,{target:{value:'later-opening'}});await fireEvent.submit(form);input.focus();releases[0]!();await new Promise(resolve=>setTimeout(resolve,0));expect(form.isConnected).toBe(true);expect(input.value).toBe('later-opening');expect(document.activeElement).toBe(input);expect(container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy')).toBe('true');expect(container.querySelector('[data-field="mcp-server-form-note"]')).toBeNull();releases[1]!();await waitFor(()=>expect(form.isConnected).toBe(false));
  });
  test('save invalidates an older Test verdict while exclusion lasts until actual completion',async()=>{
    let release!:()=>void;vi.mocked(testMcpServer).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({ok:false,failureKind:'no-answer',detail:'stale MCP result',elapsedMs:2} as never)}));const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());const row=container.querySelector('[data-mcp-server="local-fixture"]')!,button=row.querySelector('[data-verb-id="mcp.server/test"]')!;await fireEvent.click(button);await fireEvent.click(row.querySelector('[data-verb-id="mcp.server/edit"]')!);await fireEvent.submit(container.querySelector('form')!);await waitFor(()=>expect(container.querySelector('form')).toBeNull());await fireEvent.click(button);expect(testMcpServer).toHaveBeenCalledTimes(1);release();await waitFor(()=>expect(button.getAttribute('aria-busy')).toBe('false'));expect(row.textContent).not.toContain('stale MCP result');await fireEvent.click(button);expect(testMcpServer).toHaveBeenCalledTimes(2);
  });
});

test('an add-name edit remains editable after its earlier name is saved',async()=>{
  let release!:()=>void;vi.mocked(saveMcpServer).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({...SERVER_ONE,id:'earlier'})}));const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-verb-id="mcp.server/add"]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/add"]')!);
  await fireEvent.input(field(container,'server-name'),{target:{value:'earlier'}});await fireEvent.input(field(container,'server-command'),{target:{value:'node'}});const form=container.querySelector('form')!;await fireEvent.submit(form);const input=field(container,'server-name');await fireEvent.input(input,{target:{value:'later'}});input.focus();release();await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="mcp.server/save"]')?.getAttribute('aria-busy')==='false').toBe(true));expect(input.isConnected).toBe(true);expect(input.value).toBe('later');expect(input.readOnly).toBe(false);expect(document.activeElement).toBe(input);
});

test.each([false,true])('refused MCP save retains the current draft and retry (newer edit: %s)',async newer=>{
  let refuse!:(error:Error)=>void;vi.mocked(saveMcpServer).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{refuse=reject}));const {container}=render(McpServersSection);await waitFor(()=>expect(container.querySelector('[data-mcp-server]')).not.toBeNull());await fireEvent.click(container.querySelector('[data-verb-id="mcp.server/edit"]')!);const form=container.querySelector('form')!,input=field(container,'server-command');await fireEvent.input(input,{target:{value:'earlier-command'}});await fireEvent.submit(form);if(newer)await fireEvent.input(input,{target:{value:'newer-command'}});input.focus();refuse(Error('recorded MCP refusal'));await waitFor(()=>expect(container.querySelector('[data-field="mcp-server-form-note"]')?.textContent).toBe('recorded MCP refusal'));expect(form.isConnected).toBe(true);expect(input.value).toBe(newer?'newer-command':'earlier-command');expect(document.activeElement).toBe(input);await fireEvent.submit(form);await waitFor(()=>expect(form.isConnected).toBe(false));expect(vi.mocked(saveMcpServer).mock.calls[1]![0].command).toBe(newer?'newer-command':'earlier-command');
});
