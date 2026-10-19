#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void wipe(void *pointer, size_t length) {
  volatile unsigned char *bytes = pointer;
  while (length-- > 0) {
    *bytes++ = 0;
  }
}

static long vm_lck_kib(void) {
  FILE *status = fopen("/proc/self/status", "r");
  if (status == NULL) return -1;
  char *line = NULL;
  size_t capacity = 0;
  long value = -1;
  while (getline(&line, &capacity, status) >= 0) {
    if (sscanf(line, "VmLck: %ld kB", &value) == 1) break;
  }
  free(line);
  fclose(status);
  return value;
}

int main(void) {
  const long page_size = sysconf(_SC_PAGESIZE);
  struct rlimit core_limit;
  struct rlimit lock_limit;
  getrlimit(RLIMIT_CORE, &core_limit);
  getrlimit(RLIMIT_MEMLOCK, &lock_limit);

  unsigned char *memory = mmap(NULL, (size_t)page_size,
                               PROT_READ | PROT_WRITE,
                               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  bool mapped = memory != MAP_FAILED;
  if (mapped) {
    for (long index = 0; index < page_size; index++) {
      memory[index] = (unsigned char)((index % 251) + 1);
    }
  }
  errno = 0;
  int mlock_result = mapped ? mlock(memory, (size_t)page_size) : -1;
  int mlock_errno = errno;
  long locked_kib = vm_lck_kib();
  errno = 0;
  int dontdump_result = mapped
                            ? madvise(memory, (size_t)page_size,
                                      MADV_DONTDUMP)
                            : -1;
  int dontdump_errno = errno;
  errno = 0;
  int wipefork_result = mapped
                            ? madvise(memory, (size_t)page_size,
                                      MADV_WIPEONFORK)
                            : -1;
  int wipefork_errno = errno;

  bool child_saw_zeroes = false;
  if (mapped && wipefork_result == 0) {
    pid_t child = fork();
    if (child == 0) {
      bool zero = true;
      for (long index = 0; index < page_size; index++) {
        if (memory[index] != 0) {
          zero = false;
          break;
        }
      }
      _exit(zero ? 0 : 1);
    }
    int status = 0;
    if (child > 0 && waitpid(child, &status, 0) == child) {
      child_saw_zeroes = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
  }

  int original_dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  errno = 0;
  int set_dumpable_result = prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  int set_dumpable_errno = errno;
  int dumpable_after = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);

  errno = 0;
#ifdef SYS_memfd_secret
  int secret_fd = (int)syscall(SYS_memfd_secret, FD_CLOEXEC);
#else
  int secret_fd = -1;
  errno = ENOSYS;
#endif
  int memfd_cloexec_flag_errno = errno;
  bool memfd_cloexec_flag_supported = secret_fd >= 0;
#ifdef SYS_memfd_secret
  if (secret_fd < 0 && memfd_cloexec_flag_errno == EINVAL) {
    errno = 0;
    secret_fd = (int)syscall(SYS_memfd_secret, 0U);
  }
#endif
  int memfd_errno = errno;
  bool memfd_mapped = false;
  bool memfd_round_trip = false;
  bool memfd_cloexec = false;
  unsigned char *secret_memory = MAP_FAILED;
  if (secret_fd >= 0) {
    if (!memfd_cloexec_flag_supported) {
      (void)fcntl(secret_fd, F_SETFD, FD_CLOEXEC);
    }
    memfd_cloexec = (fcntl(secret_fd, F_GETFD) & FD_CLOEXEC) != 0;
    if (ftruncate(secret_fd, (off_t)page_size) == 0) {
      secret_memory = mmap(NULL, (size_t)page_size,
                           PROT_READ | PROT_WRITE, MAP_SHARED, secret_fd, 0);
      if (secret_memory != MAP_FAILED) {
        memfd_mapped = true;
        secret_memory[0] = 0x5a;
        secret_memory[1] = 0xa5;
        memfd_round_trip = secret_memory[0] == 0x5a &&
                           secret_memory[1] == 0xa5;
      }
    }
  }

  if (secret_memory != MAP_FAILED) {
    wipe(secret_memory, (size_t)page_size);
    munmap(secret_memory, (size_t)page_size);
  }
  if (secret_fd >= 0) close(secret_fd);
  if (mapped) {
    wipe(memory, (size_t)page_size);
    if (mlock_result == 0) munlock(memory, (size_t)page_size);
    munmap(memory, (size_t)page_size);
  }
  if (original_dumpable >= 0) {
    prctl(PR_SET_DUMPABLE, original_dumpable, 0, 0, 0);
  }

  printf(
      "{\"pageSize\":%ld,\"rlimitCoreSoft\":\"%llu\","
      "\"rlimitCoreHard\":\"%llu\",\"rlimitMemlockSoft\":\"%llu\","
      "\"rlimitMemlockHard\":\"%llu\",\"mlockSucceeded\":%s,"
      "\"mlockErrno\":%d,\"vmLckKiB\":%ld,"
      "\"madvDontDumpSucceeded\":%s,\"madvDontDumpErrno\":%d,"
      "\"madvWipeOnForkSucceeded\":%s,\"madvWipeOnForkErrno\":%d,"
      "\"childSawZeroes\":%s,\"dumpableBefore\":%d,"
      "\"setDumpableZeroSucceeded\":%s,\"setDumpableErrno\":%d,"
      "\"dumpableAfter\":%d,\"memfdSecretCloexecFlagSupported\":%s,"
      "\"memfdSecretCloexecFlagErrno\":%d,"
      "\"memfdSecretSucceeded\":%s,\"memfdSecretErrno\":%d,"
      "\"memfdSecretMapped\":%s,"
      "\"memfdSecretRoundTrip\":%s,\"memfdSecretCloseOnExec\":%s}\n",
      page_size, (unsigned long long)core_limit.rlim_cur,
      (unsigned long long)core_limit.rlim_max,
      (unsigned long long)lock_limit.rlim_cur,
      (unsigned long long)lock_limit.rlim_max,
      mlock_result == 0 ? "true" : "false", mlock_errno, locked_kib,
      dontdump_result == 0 ? "true" : "false", dontdump_errno,
      wipefork_result == 0 ? "true" : "false", wipefork_errno,
      child_saw_zeroes ? "true" : "false", original_dumpable,
      set_dumpable_result == 0 ? "true" : "false", set_dumpable_errno,
      dumpable_after, memfd_cloexec_flag_supported ? "true" : "false",
      memfd_cloexec_flag_errno, secret_fd >= 0 ? "true" : "false", memfd_errno,
      memfd_mapped ? "true" : "false",
      memfd_round_trip ? "true" : "false",
      memfd_cloexec ? "true" : "false");
  return 0;
}
