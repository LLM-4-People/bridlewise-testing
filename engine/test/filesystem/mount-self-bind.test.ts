/**
 * THE ONE MOUNT READER'S SELF-BIND RULE (src/filesystem/linux-path.ts,
 * decision TEST-CONFINEMENT-SELF-BIND): S1's mountpoint refusals ask
 * `readLinuxMountPoints`, which reports every mount EXCEPT a self-bind — a
 * directory bound onto its own path, same filesystem, same subtree, only its
 * flags changed (the read-only test checkout). Anything that can put different
 * content at a path is still reported. Driven on planted mount tables.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mountPointsOf, parseMountInfo } from "../../src/filesystem/linux-path.ts";

/** One mountinfo line: `id parent major:minor root mountpoint options - fstype source superoptions`. */
function line(id: number, parent: number, device: string, root: string, point: string, fsType: string, source: string): string {
  return `${String(id)} ${String(parent)} ${device} ${root} ${point} rw,relatime - ${fsType} ${source} rw`;
}

const TABLE = [
  line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
  line(30, 22, "8:1", "/", "/home", "ext4", "/dev/sda1"),
  // A self-bind on the root filesystem, and one on a filesystem mounted below the root.
  line(500, 22, "8:48", "/srv/repo", "/srv/repo", "ext4", "/dev/sdd"),
  line(501, 30, "8:1", "/u/repo", "/home/u/repo", "ext4", "/dev/sda1"),
  // A self-bind NESTED under a self-bind (the test confinement's writable state folder): judged on its own, also neutral.
  line(502, 500, "8:48", "/srv/repo/.bridlewise", "/srv/repo/.bridlewise", "ext4", "/dev/sdd"),
  // ANOTHER subtree of the same filesystem bound onto a path: different content, reported.
  line(510, 22, "8:48", "/srv/other", "/srv/swapped", "ext4", "/dev/sdd"),
  line(511, 30, "8:1", "/u/repo", "/home/u/elsewhere", "ext4", "/dev/sda1"),
  // A foreign filesystem at a path, and one NESTED under a self-bind: reported.
  line(520, 22, "0:50", "/", "/srv/tmpfs", "tmpfs", "tmpfs"),
  line(521, 500, "0:51", "/", "/srv/repo/sub", "tmpfs", "tmpfs"),
  // Same device and root shape but another source or type: not proven the same filesystem, reported.
  line(530, 22, "8:48", "/srv/repo2", "/srv/repo2", "ext4", "/dev/other"),
  line(531, 22, "8:48", "/srv/repo3", "/srv/repo3", "xfs", "/dev/sdd"),
].join("\n");

test("a self-bind is not reported; another subtree, a foreign filesystem, a mount nested under a self-bind and a mismatched source or type are", () => {
  const reported = mountPointsOf(parseMountInfo(TABLE));
  for (const neutral of ["/srv/repo", "/home/u/repo", "/srv/repo/.bridlewise"]) assert.equal(reported.has(neutral), false, `${neutral} is a self-bind`);
  for (const mounted of ["/", "/home", "/srv/swapped", "/home/u/elsewhere", "/srv/tmpfs", "/srv/repo/sub", "/srv/repo2", "/srv/repo3"]) {
    assert.equal(reported.has(mounted), true, `${mounted} must still be reported`);
  }
});

test("a filesystem's own root mount is never a self-bind, wherever it is mounted", () => {
  const reported = mountPointsOf(parseMountInfo([line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"), line(40, 22, "8:48", "/", "/mnt/again", "ext4", "/dev/sdd")].join("\n")));
  assert.deepEqual([...reported].toSorted(), ["/", "/mnt/again"]);
});

test("without a visible mount of the filesystem's root, a bind is not proven a self-bind and is reported", () => {
  const reported = mountPointsOf(parseMountInfo(line(500, 1, "8:48", "/srv/repo", "/srv/repo", "ext4", "/dev/sdd")));
  assert.equal(reported.has("/srv/repo"), true);
});
