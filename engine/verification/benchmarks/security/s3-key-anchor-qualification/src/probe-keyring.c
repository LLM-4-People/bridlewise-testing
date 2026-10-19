#define _GNU_SOURCE

#include <errno.h>
#include <linux/keyctl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static long keyctl_call(unsigned long command, unsigned long arg2,
                        unsigned long arg3, unsigned long arg4,
                        unsigned long arg5) {
  return syscall(SYS_keyctl, command, arg2, arg3, arg4, arg5);
}

static long add_key_call(const char *type, const char *description,
                         const void *payload, size_t payload_length,
                         int32_t keyring) {
  return syscall(SYS_add_key, type, description, payload, payload_length,
                 keyring);
}

static void wipe(void *pointer, size_t length) {
  volatile unsigned char *bytes = pointer;
  while (length-- > 0) {
    *bytes++ = 0;
  }
}

int main(void) {
  char ring_name[96];
  char user_description[96];
  char logon_description[96];
  unsigned char payload[32];
  unsigned char readback[64];
  for (size_t index = 0; index < sizeof(payload); index++) {
    payload[index] = (unsigned char)(index + 17U);
  }

  snprintf(ring_name, sizeof(ring_name), "s3q-%ld", (long)getpid());
  snprintf(user_description, sizeof(user_description), "s3q-user-%ld",
           (long)getpid());
  snprintf(logon_description, sizeof(logon_description), "s3q:logon:%ld",
           (long)getpid());

  errno = 0;
  long ring = keyctl_call(KEYCTL_JOIN_SESSION_KEYRING,
                          (unsigned long)ring_name, 0, 0, 0);
  int ring_errno = errno;
  if (ring < 0) {
    printf("{\"sessionRingCreated\":false,\"errno\":%d,"
           "\"error\":\"%s\"}\n",
           ring_errno, strerror(ring_errno));
    wipe(payload, sizeof(payload));
    return 0;
  }

  errno = 0;
  long user_key = add_key_call("user", user_description, payload,
                               sizeof(payload), (int32_t)ring);
  int user_add_errno = errno;
  errno = 0;
  long user_read = user_key < 0
                       ? -1
                       : keyctl_call(KEYCTL_READ, (unsigned long)user_key,
                                     (unsigned long)readback,
                                     sizeof(readback), 0);
  int user_read_errno = errno;
  bool user_matches = user_read == (long)sizeof(payload) &&
                      memcmp(payload, readback, sizeof(payload)) == 0;

  bool inherited_child_read = false;
  if (user_key >= 0) {
    pid_t child = fork();
    if (child == 0) {
      unsigned char child_readback[64];
      long count = keyctl_call(KEYCTL_READ, (unsigned long)user_key,
                               (unsigned long)child_readback,
                               sizeof(child_readback), 0);
      bool matches = count == (long)sizeof(payload) &&
                     memcmp(payload, child_readback, sizeof(payload)) == 0;
      wipe(child_readback, sizeof(child_readback));
      _exit(matches ? 0 : 1);
    }
    int status = 0;
    if (child > 0 && waitpid(child, &status, 0) == child) {
      inherited_child_read = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
  }

  errno = 0;
  long logon_key = add_key_call("logon", logon_description, payload,
                                sizeof(payload), (int32_t)ring);
  int logon_add_errno = errno;
  errno = 0;
  long logon_read = logon_key < 0
                        ? -1
                        : keyctl_call(KEYCTL_READ, (unsigned long)logon_key,
                                      (unsigned long)readback,
                                      sizeof(readback), 0);
  int logon_read_errno = errno;

  keyctl_call(KEYCTL_CLEAR, (unsigned long)ring, 0, 0, 0);
  wipe(payload, sizeof(payload));
  wipe(readback, sizeof(readback));

  printf(
      "{\"sessionRingCreated\":true,\"userKeyAdded\":%s,"
      "\"userAddErrno\":%d,\"userReadBytes\":%ld,"
      "\"userReadErrno\":%d,\"userPayloadExportable\":%s,"
      "\"inheritedChildCanReadUserPayload\":%s,"
      "\"logonKeyAdded\":%s,\"logonAddErrno\":%d,"
      "\"logonReadBytes\":%ld,\"logonReadErrno\":%d,"
      "\"logonReadError\":\"%s\",\"cleared\":true}\n",
      user_key >= 0 ? "true" : "false", user_add_errno, user_read,
      user_read_errno, user_matches ? "true" : "false",
      inherited_child_read ? "true" : "false",
      logon_key >= 0 ? "true" : "false", logon_add_errno, logon_read,
      logon_read_errno,
      logon_read_errno == 0 ? "none" : strerror(logon_read_errno));
  return 0;
}
