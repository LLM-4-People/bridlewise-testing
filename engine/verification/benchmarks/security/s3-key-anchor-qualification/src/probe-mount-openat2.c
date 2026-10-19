#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/syscall.h>
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

static char read_marker(int descriptor) {
  char marker = 0;
  if (descriptor >= 0) {
    (void)read(descriptor, &marker, 1);
    close(descriptor);
  }
  return marker;
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int root = open(argv[1], O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root < 0) return 3;
  errno = 0;
  int ordinary = openat(root, "target/anchor", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  int ordinary_errno = errno;
  char ordinary_marker = read_marker(ordinary);
  const unsigned long resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                                RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV;
  errno = 0;
  int secure = openat2_call(root, "target/anchor", O_RDONLY | O_CLOEXEC, resolve);
  int secure_errno = errno;
  char secure_marker = read_marker(secure);
  close(root);
  printf(
      "{\"ordinaryCrossedBindMount\":%s,\"ordinaryReadAttackerMarker\":%s,"
      "\"ordinaryErrno\":%d,\"openat2NoXdevRejected\":%s,"
      "\"openat2NoXdevErrno\":%d,\"openat2UnexpectedMarker\":%s}\n",
      ordinary_marker != 0 ? "true" : "false",
      ordinary_marker == 'E' ? "true" : "false", ordinary_errno,
      secure < 0 ? "true" : "false", secure_errno,
      secure_marker != 0 ? "true" : "false");
  return 0;
}
