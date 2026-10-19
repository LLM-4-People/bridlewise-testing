#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static int openat2_call(int directory, const char *path,
                        unsigned long flags, unsigned long resolve) {
  struct open_how how = {
      .flags = flags,
      .mode = 0,
      .resolve = resolve,
  };
  return (int)syscall(SYS_openat2, directory, path, &how, sizeof(how));
}

static bool write_marker(const char *path, const char *value) {
  int descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (descriptor < 0) return false;
  size_t length = strlen(value);
  bool ok = write(descriptor, value, length) == (ssize_t)length &&
            fsync(descriptor) == 0;
  close(descriptor);
  return ok;
}

static char read_marker(int descriptor) {
  char value = 0;
  if (descriptor >= 0) {
    (void)read(descriptor, &value, 1);
    close(descriptor);
  }
  return value;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const char *root = argv[1];
  char base[4096], safe[4096], attacker[4096], safe_anchor[4096];
  char attacker_anchor[4096], intermediate_link[4096], final_link[4096];
  snprintf(base, sizeof(base), "%s/base", root);
  snprintf(safe, sizeof(safe), "%s/base/safe", root);
  snprintf(attacker, sizeof(attacker), "%s/attacker", root);
  snprintf(safe_anchor, sizeof(safe_anchor), "%s/base/safe/anchor", root);
  snprintf(attacker_anchor, sizeof(attacker_anchor), "%s/attacker/anchor", root);
  snprintf(intermediate_link, sizeof(intermediate_link), "%s/base/link", root);
  snprintf(final_link, sizeof(final_link), "%s/base/safe/final-link", root);
  mkdir(root, 0700);
  mkdir(base, 0700);
  mkdir(safe, 0700);
  mkdir(attacker, 0700);
  if (!write_marker(safe_anchor, "G") || !write_marker(attacker_anchor, "E")) {
    return 3;
  }
  if (symlink("../attacker", intermediate_link) != 0 ||
      symlink("anchor", final_link) != 0) {
    return 4;
  }

  char path_through_link[8192], path_final_link[8192];
  snprintf(path_through_link, sizeof(path_through_link), "%s/link/anchor", base);
  snprintf(path_final_link, sizeof(path_final_link), "%s/safe/final-link", base);
  errno = 0;
  int ordinary = open(path_through_link, O_RDONLY | O_NOFOLLOW);
  int ordinary_errno = errno;
  char ordinary_marker = read_marker(ordinary);

  errno = 0;
  int final = open(path_final_link, O_RDONLY | O_NOFOLLOW);
  int final_errno = errno;
  if (final >= 0) close(final);

  int base_fd = open(base, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  const unsigned long resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                                RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  errno = 0;
  int secure_good = base_fd < 0
                        ? -1
                        : openat2_call(base_fd, "safe/anchor",
                                       O_RDONLY | O_CLOEXEC, resolve);
  int secure_good_errno = errno;
  char secure_good_marker = read_marker(secure_good);
  errno = 0;
  int secure_link = base_fd < 0
                        ? -1
                        : openat2_call(base_fd, "link/anchor",
                                       O_RDONLY | O_CLOEXEC, resolve);
  int secure_link_errno = errno;
  if (secure_link >= 0) close(secure_link);
  if (base_fd >= 0) close(base_fd);

  struct stat anchor_stat;
  bool stat_ok = lstat(safe_anchor, &anchor_stat) == 0;
  printf(
      "{\"ordinaryNoFollowIntermediateOpened\":%s,"
      "\"ordinaryNoFollowIntermediateErrno\":%d,"
      "\"ordinaryReadAttackerMarker\":%s,"
      "\"ordinaryNoFollowFinalRejected\":%s,"
      "\"ordinaryNoFollowFinalErrno\":%d,"
      "\"openat2DirectSucceeded\":%s,\"openat2DirectErrno\":%d,"
      "\"openat2DirectReadGoodMarker\":%s,"
      "\"openat2IntermediateSymlinkRejected\":%s,"
      "\"openat2IntermediateSymlinkErrno\":%d,"
      "\"anchorRegular\":%s,\"anchorMode\":%u,"
      "\"anchorOwnerUid\":%u,\"anchorOwnerGid\":%u}\n",
      ordinary_marker != 0 ? "true" : "false", ordinary_errno,
      ordinary_marker == 'E' ? "true" : "false",
      final < 0 ? "true" : "false", final_errno,
      secure_good_marker != 0 ? "true" : "false", secure_good_errno,
      secure_good_marker == 'G' ? "true" : "false",
      secure_link < 0 ? "true" : "false", secure_link_errno,
      stat_ok && S_ISREG(anchor_stat.st_mode) ? "true" : "false",
      stat_ok ? (unsigned)(anchor_stat.st_mode & 07777U) : 0U,
      stat_ok ? (unsigned)anchor_stat.st_uid : 0U,
      stat_ok ? (unsigned)anchor_stat.st_gid : 0U);
  return 0;
}
