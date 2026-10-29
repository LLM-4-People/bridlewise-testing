/**
 * THE ONE MOUNT READER'S SELF-BIND RULE (src/filesystem/linux-path.ts,
 * decision TEST-CONFINEMENT-SELF-BIND): S1's mountpoint refusals ask
 * `readLinuxMountPoints`, which reports every mount EXCEPT a self-bind — a
 * directory bound onto its own path, same filesystem, same subtree, only its
 * flags changed (the test confinement's writable places). Anything that can
 * put different content at a path is still reported — a shadowed lower
 * directory, an overmounted parent, a parent that is not the filesystem it
 * shows (review of #634, B11/N11). Driven on planted mount tables.
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

test("without the mount it is mounted on in the table, a bind is not proven a self-bind and is reported", () => {
  const reported = mountPointsOf(parseMountInfo(line(500, 1, "8:48", "/srv/repo", "/srv/repo", "ext4", "/dev/sdd")));
  assert.equal(reported.has("/srv/repo"), true);
});

test("B11: the root filesystem's hidden directory bound where another filesystem (/home) covers the path is a content swap, reported", () => {
  const reported = mountPointsOf(parseMountInfo([
    line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
    line(30, 22, "8:1", "/", "/home", "ext4", "/dev/sda1"),
    line(600, 30, "8:48", "/home/u/repo", "/home/u/repo", "ext4", "/dev/sdd"),
  ].join("\n")));
  assert.equal(reported.has("/home/u/repo"), true);
});

test("N11: a lower directory a tmpfs shadows, and a parent a tmpfs is stacked over, make the bind a content swap, reported", () => {
  // (1) ext4 at /, a tmpfs at /srv, then ext4's /srv/repo bound at /srv/repo (mounted on the root, beneath the tmpfs).
  const shadowed = mountPointsOf(parseMountInfo([
    line(22, 1, "8:1", "/", "/", "ext4", "/dev/sda1"),
    line(30, 22, "0:40", "/", "/srv", "tmpfs", "tmpfs"),
    line(31, 22, "8:1", "/srv/repo", "/srv/repo", "ext4", "/dev/sda1"),
  ].join("\n")));
  assert.equal(shadowed.has("/srv/repo"), true, "a mount between the parent and the bind was ignored");
  // (2) 8:1 at /home, a tmpfs stacked on /home, then 8:1's /u/repo bound at /home/u/repo onto 8:1's mount.
  const overmounted = mountPointsOf(parseMountInfo([
    line(22, 1, "8:2", "/", "/", "ext4", "/dev/sda2"),
    line(30, 22, "8:1", "/", "/home", "ext4", "/dev/sda1"),
    line(40, 30, "0:41", "/", "/home", "tmpfs", "tmpfs"),
    line(41, 30, "8:1", "/u/repo", "/home/u/repo", "ext4", "/dev/sda1"),
  ].join("\n")));
  assert.equal(overmounted.has("/home/u/repo"), true, "a parent hidden by a stacked mount was taken as visible");
});

test("TEETH of each condition: another device, a parent that shows another directory, a bind beside (not beneath) its parent are each reported", () => {
  // The same source and type on another device: not the same filesystem.
  assert.equal(mountPointsOf(parseMountInfo([
    line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
    line(30, 22, "8:1", "/", "/home", "ext4", "/dev/sdx"),
    line(31, 30, "8:2", "/u/repo", "/home/u/repo", "ext4", "/dev/sdx"),
  ].join("\n"))).has("/home/u/repo"), true, "another device");
  // The parent is itself a bind showing /x: the path named /x/u/repo before, the mount shows /u/repo.
  assert.equal(mountPointsOf(parseMountInfo([
    line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
    line(30, 22, "8:48", "/x", "/home", "ext4", "/dev/sdd"),
    line(31, 30, "8:48", "/u/repo", "/home/u/repo", "ext4", "/dev/sdd"),
  ].join("\n"))).has("/home/u/repo"), true, "the parent's own directory was ignored");
  // ...while the same nesting showing /x/u/repo is content-neutral.
  assert.equal(mountPointsOf(parseMountInfo([
    line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
    line(30, 22, "8:48", "/x", "/home", "ext4", "/dev/sdd"),
    line(31, 30, "8:48", "/x/u/repo", "/home/u/repo", "ext4", "/dev/sdd"),
  ].join("\n"))).has("/home/u/repo"), false, "a self-bind beneath a bind");
  // A bind whose parent is mounted elsewhere (not an ancestor of it).
  assert.equal(mountPointsOf(parseMountInfo([
    line(22, 1, "8:48", "/", "/", "ext4", "/dev/sdd"),
    line(30, 22, "8:1", "/", "/home", "ext4", "/dev/sda1"),
    line(31, 30, "8:1", "/srv/repo", "/srv/repo", "ext4", "/dev/sda1"),
  ].join("\n"))).has("/srv/repo"), true, "a parent that does not cover the path");
});
