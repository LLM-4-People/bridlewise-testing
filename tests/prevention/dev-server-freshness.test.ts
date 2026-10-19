// @vitest-environment node
/**
 * The dev-server freshness preflight's pure half, driven over fixtures.
 *
 * The live half (`/proc` and `.git` reads) is thin by design; everything that
 * DECIDES is here. The wiring half — that both Playwright doors actually take
 * this preflight — is asserted by the one-instrument-lock guard in the engine
 * suite, whose charter is the shared door body's duties.
 *
 * The search before creation: no test names the dev servers' age anywhere —
 * the one-instrument-lock tests cover WHO runs, this file covers WHAT they
 * run against. New file, no neighbour displaced.
 */
import { describe, expect, test } from "vitest";

import { devServerFreshnessRefusal, devServerPorts } from "../setup/dev-server-freshness.ts";
import { parseListeningSockets, parseStatLine, STAT_FIELD } from "../../engine/src/process/process-facts.ts";

describe("parseListeningSockets", () => {
  const TCP_DOCUMENT = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7654321 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:1436 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 7654322 1 0000000000000000 100 0 0 10 0",
    "   2: 0100007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 7654323 1 0000000000000000 100 0 0 10 0",
    "",
  ].join("\n");

  test("a LISTEN row yields its inode and port; an established row does not", () => {
    // 0x1435 is 5173 (LISTEN), 0x1436 is 5174 (ESTABLISHED), 0x0035 is 53 (LISTEN).
    const found = parseListeningSockets(TCP_DOCUMENT);
    expect([...found.entries()]).toEqual([["7654321", 5173], ["7654323", 53]]);
  });

  test("an empty document and a header-only document both yield nothing", () => {
    expect(parseListeningSockets("").size).toBe(0);
    expect(parseListeningSockets("  sl  local_address rem_address   st\n").size).toBe(0);
  });
});

describe("the start time through the one stat parser", () => {
  test("the start time survives a comm with spaces and parentheses", () => {
    const stat = "1234 (node: /usr/bin/vite (dev)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21\n";
    expect(Number(parseStatLine(stat)?.[STAT_FIELD.starttime - 3])).toBe(987654);
  });

  test("garbage has no fields, never a zero or a guess", () => {
    expect(parseStatLine("no parens here")).toBeUndefined();
  });
});

describe("devServerFreshnessRefusal", () => {
  test("a server older than the last HEAD change is refused, naming port, pid and both clocks", () => {
    const refusal = devServerFreshnessRefusal(
      [{ port: 5173, pid: 4242, startedAtMs: 1_000_000 }],
      2_000_000,
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("port 5173");
    expect(refusal).toContain("pid 4242");
    expect(refusal).toContain(new Date(2_000_000).toISOString());
  });

  test("a server younger than the last HEAD change, and no server at all, are both green", () => {
    expect(
      devServerFreshnessRefusal([{ port: 5173, pid: 4242, startedAtMs: 3_000_000 }], 2_000_000),
    ).toBeNull();
    expect(devServerFreshnessRefusal([], 2_000_000)).toBeNull();
  });

  test("every stale listener is named, not just the first", () => {
    const refusal = devServerFreshnessRefusal(
      [
        { port: 5173, pid: 1, startedAtMs: 10 },
        { port: 5174, pid: 2, startedAtMs: 20 },
      ],
      1_000_000,
    );
    expect(refusal).toContain("port 5173");
    expect(refusal).toContain("port 5174");
  });
});

describe("devServerPorts", () => {
  test("the API port follows HARNESS_WEB_PORT, and a malformed override falls back rather than judging nothing", () => {
    expect(devServerPorts({} as NodeJS.ProcessEnv)).toEqual({ vite: 5173, api: 5174 });
    expect(devServerPorts({ HARNESS_WEB_PORT: "5999" } as NodeJS.ProcessEnv).api).toBe(5999);
    expect(devServerPorts({ HARNESS_WEB_PORT: "not-a-port" } as NodeJS.ProcessEnv).api).toBe(5174);
  });
});
