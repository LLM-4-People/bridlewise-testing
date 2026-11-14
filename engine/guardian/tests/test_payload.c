/*
 * test_payload.c — tiny helper exec'd by the guardian in run-tests.sh.
 *
 * usage: test_payload <read|write|create|list> <path>
 *        test_payload <socket|fork-exec> <inet|inet6|unix|netlink>
 *        test_payload socketpair unix
 *        test_payload socketpair <unix|unspec> <stream|dgram|seqpacket|invalid> <none|cloexec|nonblock|both|invalid>
 *        test_payload <io-uring|spin> -
 *        test_payload signal <pid>
 *   read:   open(path, O_RDONLY) + read 1 byte
 *   write:  open(path, O_WRONLY|O_CREAT, 0600) + write 1 byte
 *   create: open(path, O_WRONLY|O_CREAT|O_EXCL, 0600)
 *   list:   opendir(path) + readdir loop
 *
 * Prints one line to stdout:
 *   OK            on file/socketpair success
 *   OK:AF_<name>  on socket success, from the actual SO_DOMAIN
 *   ENOSYS:<errno> when io_uring_setup is refused by seccomp or the host
 *   EACCES:<errno> when a file or socket operation gets EACCES
 *   ERROR:<errno> on any other error
 * Exit codes: 0 = OK, 1 = EACCES/EPERM/ENOSYS, 2 = other error;
 * spin and an unexpected successful invalid io_uring/socketpair setup return 3.
 *
 * This exercises real open/read/write (Landlock-restrictable), not stat(2).
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdlib.h>
#include <limits.h>

static int report(int kind, int e)
{
    if (kind == 0) { printf("OK\n"); return 0; }
    if (kind == 1) { printf("EACCES:%d\n", e); return 1; }
    printf("ERROR:%d\n", e);
    return 2;
}


struct socket_family_case {
    const char *selector;
    const char *name;
    int domain;
    int socket_type;
};

static const struct socket_family_case socket_families[] = {
    { "inet", "AF_INET", AF_INET, SOCK_STREAM },
    { "inet6", "AF_INET6", AF_INET6, SOCK_STREAM },
    { "unix", "AF_UNIX", AF_UNIX, SOCK_STREAM },
    { "netlink", "AF_NETLINK", AF_NETLINK, SOCK_RAW },
    { "unspec", "AF_UNSPEC", AF_UNSPEC, SOCK_STREAM },
};

static const struct socket_family_case *socket_family(const char *selector)
{
    for (size_t i = 0; i < sizeof(socket_families) / sizeof(socket_families[0]); i++)
        if (strcmp(selector, socket_families[i].selector) == 0) return &socket_families[i];
    return NULL;
}

static const char *socket_domain_name(int domain)
{
    for (size_t i = 0; i < sizeof(socket_families) / sizeof(socket_families[0]); i++)
        if (domain == socket_families[i].domain) return socket_families[i].name;
    return NULL;
}

struct socket_type_case {
    const char *selector;
    const char *name;
    int type;
};

static const struct socket_type_case socket_types[] = {
    { "stream", "SOCK_STREAM", SOCK_STREAM },
    { "dgram", "SOCK_DGRAM", SOCK_DGRAM },
    { "seqpacket", "SOCK_SEQPACKET", SOCK_SEQPACKET },
};

static int socketpair_type(const char *selector, int *type)
{
    if (strcmp(selector, "invalid") == 0) { *type = INT_MAX; return 1; }
    for (size_t i = 0; i < sizeof(socket_types) / sizeof(socket_types[0]); i++) {
        if (strcmp(selector, socket_types[i].selector) == 0) {
            *type = socket_types[i].type;
            return 1;
        }
    }
    return 0;
}

static const char *socket_type_name(int type)
{
    for (size_t i = 0; i < sizeof(socket_types) / sizeof(socket_types[0]); i++)
        if (type == socket_types[i].type) return socket_types[i].name;
    return NULL;
}

static int socketpair_flags(const char *selector, int *flags)
{
    if (strcmp(selector, "none") == 0) *flags = 0;
    else if (strcmp(selector, "cloexec") == 0) *flags = SOCK_CLOEXEC;
    else if (strcmp(selector, "nonblock") == 0) *flags = SOCK_NONBLOCK;
    else if (strcmp(selector, "both") == 0) *flags = SOCK_CLOEXEC | SOCK_NONBLOCK;
    else if (strcmp(selector, "invalid") == 0) *flags = INT_MIN;
    else return 0;
    return 1;
}

static int socket_property(int fd, int option, int *value)
{
    socklen_t size = sizeof(*value);
    if (getsockopt(fd, SOL_SOCKET, option, value, &size) < 0) return errno;
    return size == sizeof(*value) ? 0 : EPROTO;
}

struct socketpair_observation {
    int domain;
    int type;
    int cloexec;
    int nonblock;
};

static int observe_socketpair_end(int fd, struct socketpair_observation *observed)
{
    int e = socket_property(fd, SO_DOMAIN, &observed->domain);
    if (e) return e;
    e = socket_property(fd, SO_TYPE, &observed->type);
    if (e) return e;
    int descriptor_flags = fcntl(fd, F_GETFD);
    if (descriptor_flags < 0) return errno;
    int status_flags = fcntl(fd, F_GETFL);
    if (status_flags < 0) return errno;
    observed->cloexec = (descriptor_flags & FD_CLOEXEC) != 0;
    observed->nonblock = (status_flags & O_NONBLOCK) != 0;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: test_payload <read|write|create|list|socket|socketpair|fork-exec|io-uring|spin|signal> <path|inet|inet6|unix|netlink|pid|->\n");
        return 2;
    }
    const char *mode = argv[1];
    const char *path = argv[2];

    if (strcmp(mode, "read") == 0) {
        int f = open(path, O_RDONLY);
        if (f < 0) return report(errno == EACCES ? 1 : 2, errno);
        char b;
        ssize_t n = read(f, &b, 1);
        int e = errno;
        close(f);
        if (n < 0) return report(e == EACCES ? 1 : 2, e);
        return report(0, 0);
    } else if (strcmp(mode, "write") == 0) {
        int f = open(path, O_WRONLY | O_CREAT, 0600);
        if (f < 0) return report(errno == EACCES ? 1 : 2, errno);
        char b = 'x';
        ssize_t n = write(f, &b, 1);
        int e = errno;
        close(f);
        if (n < 0) return report(e == EACCES ? 1 : 2, e);
        return report(0, 0);
    } else if (strcmp(mode, "create") == 0) {
        int f = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (f < 0) return report(errno == EACCES ? 1 : 2, errno);
        close(f);
        return report(0, 0);
    } else if (strcmp(mode, "list") == 0) {
        DIR *d = opendir(path);
        if (!d) return report(errno == EACCES ? 1 : 2, errno);
        errno = 0;
        struct dirent *de;
        long count = 0;
        while ((de = readdir(d)) != NULL) { count++; (void)de; }
        int e = errno;
        closedir(d);
        if (e == EACCES) return report(1, e);
        if (e != 0) return report(2, e);
        return report(0, 0);
    } else if (strcmp(mode, "socket") == 0) {
        /* Select explicitly: an unknown selector must never become IPv4. */
        const struct socket_family_case *family = socket_family(path);
        if (!family) return report(2, EINVAL);
        int fd = socket(family->domain, family->socket_type | SOCK_CLOEXEC, 0);
        if (fd < 0) return report(errno == EACCES ? 1 : 2, errno);
        int domain = -1;
        int e = socket_property(fd, SO_DOMAIN, &domain);
        close(fd);
        if (e) return report(2, e);
        const char *domain_name = socket_domain_name(domain);
        if (!domain_name) return report(2, EAFNOSUPPORT);
        printf("OK:%s\n", domain_name);
        return 0;
    } else if (strcmp(mode, "socketpair") == 0) {
        /* Legacy unix keeps STREAM|CLOEXEC and exactly OK for static test20. */
        const struct socket_family_case *family = socket_family(path);
        if (!family) return report(2, EINVAL);
        int legacy = argc == 3;
        int type = SOCK_STREAM;
        int flags = SOCK_CLOEXEC;
        if (legacy) {
            if (family->domain != AF_UNIX) return report(2, EINVAL);
        } else if (argc != 5 || !socketpair_type(argv[3], &type)
                   || !socketpair_flags(argv[4], &flags)) {
            return report(2, EINVAL);
        }
        int pair[2];
        if (socketpair(family->domain, type | flags, 0, pair) < 0)
            return report(errno == EACCES ? 1 : 2, errno);
        /* A raw invalid-argument control must fail at creation. Do not let a
         * later property mismatch masquerade as its expected kernel error. */
        if (family->domain == AF_UNSPEC || type == INT_MAX || flags == INT_MIN) {
            close(pair[0]);
            close(pair[1]);
            printf("UNEXPECTED_SOCKETPAIR_SUCCESS\n");
            return 3;
        }
        struct socketpair_observation observed[2] = {0};
        int e = 0;
        for (int i = 0; i < 2; i++) {
            e = observe_socketpair_end(pair[i], &observed[i]);
            if (e) break;
            if (observed[i].domain != family->domain || observed[i].type != type
                || observed[i].cloexec != ((flags & SOCK_CLOEXEC) != 0)
                || observed[i].nonblock != ((flags & SOCK_NONBLOCK) != 0)) {
                e = EPROTO;
                break;
            }
        }
        const char *domain_name = e ? NULL : socket_domain_name(observed[0].domain);
        const char *type_name = e ? NULL : socket_type_name(observed[0].type);
        if (!e && (!domain_name || !type_name)) e = EPROTO;
        for (int sender = 0; !e && sender < 2; sender++) {
            char sent = (char)('a' + sender);
            char received = 0;
            /* The owned byte is queued before its read, including NONBLOCK. */
            ssize_t n = write(pair[sender], &sent, 1);
            if (n != 1) { e = n < 0 ? errno : EIO; break; }
            n = read(pair[1 - sender], &received, 1);
            if (n != 1) { e = n < 0 ? errno : EIO; break; }
            if (received != sent) { e = EPROTO; break; }
        }
        close(pair[0]);
        close(pair[1]);
        /* Only creation EACCES uses exit 1; an acquired-path failure must not
         * be mistaken for the governed creation-denial control. */
        if (e) return report(2, e);
        if (legacy) return report(0, 0);
        printf("OK:%s:%s:fd0(FD_CLOEXEC=%d,O_NONBLOCK=%d):fd1(FD_CLOEXEC=%d,O_NONBLOCK=%d)\n",
               domain_name, type_name, observed[0].cloexec, observed[0].nonblock,
               observed[1].cloexec, observed[1].nonblock);
        return 0;
    } else if (strcmp(mode, "fork-exec") == 0) {
        /* Re-exec this known executable: both fork and exec must inherit. */
        pid_t child = fork();
        if (child < 0) return report(2, errno);
        if (child == 0) {
            execl(argv[0], argv[0], "socket", path, (char *)NULL);
            return report(2, errno);
        }
        int status;
        pid_t waited;
        do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
        if (waited < 0) return report(2, errno);
        if (WIFEXITED(status)) return WEXITSTATUS(status);
        if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
        return report(2, ECHILD);
    } else if (strcmp(mode, "io-uring") == 0) {
        /* Invalid arguments cannot create a ring; do not probe a live channel. */
        long fd = syscall(__NR_io_uring_setup, 0U, NULL);
        if (fd >= 0) {
            close((int)fd);
            printf("UNEXPECTED_IO_URING_FD\n");
            return 3;
        }
        int e = errno;
        if (e == ENOSYS) { printf("ENOSYS:%d\n", e); return 1; }
        return report(2, e);
    } else if (strcmp(mode, "spin") == 0) {
        /* Burn a BOUNDED amount of CPU work (far past any ceiling a test sets):
         * a CPU ceiling ends it first; without one it returns, never hangs. */
        volatile unsigned long n = 0;
        for (unsigned long i = 0; i < 40000000000UL; i++) n++;
        printf("SPIN_ENDED\n");
        return 3;
    } else if (strcmp(mode, "signal") == 0) {
        /* `signal <pid>`: may SIGTERM reach that process? */
        if (kill((pid_t)atol(path), SIGTERM) == 0) return report(0, 0);
        printf("%s:%d\n", errno == EPERM ? "EPERM" : "ERROR", errno);
        return 1;
    }

    fprintf(stderr, "unknown mode '%s'\n", mode);
    return 2;
}
