/* Linux process lifetime primitive for the TypeScript test runners (the web
 * suite's and the engine suite's: engine/src/process/supervised-run.ts).
 * Node exposes neither child-subreaper ownership nor pidfd signalling/wait4.
 * Keep this boundary outside the watched runtime; tests and policy stay in TS.
 * Linux manuals: PR_SET_CHILD_SUBREAPER(2), pidfd_open(2), wait4(2).
 *
 * Usage: test-process-supervisor [--checkout <dir> --scratch <dir> [--writable <dir>]...]
 *                                [--pass-fd] <timeout ms> <grace ms> <command> [args...]
 *        test-process-supervisor --probe-confinement --checkout <dir> --scratch <dir> [--writable <dir>]...
 * fd 3 carries this supervisor's receipt. With --pass-fd, the caller's fd 4
 * becomes the COMMAND's fd 3 (a command that reports on fd 3, like the engine
 * test worker, keeps its channel) and the supervisor holds no copy of it.
 *
 * THE COMMAND SEES THE WHOLE FILESYSTEM READ-ONLY (#293's class, under the
 * user's rule that a malicious module cannot bypass core: decision
 * TEST-CONFINEMENT-SELF-BIND). With --checkout <dir> --scratch <dir>
 * [--writable <dir>]..., the command starts in new user, mount, network and
 * IPC namespaces where:
 *   - every mount is read-only, recursively (mount_setattr AT_RECURSIVE: a
 *     mount already beneath the checkout is read-only too);
 *   - fresh empty tmpfs mounts cover /tmp, /run and /dev/shm, so no socket
 *     or shared object of a same-user service outside is reachable by path;
 *     the network namespace holds only its own loopback, and the IPC
 *     namespace its own System V and POSIX queues;
 *   - writable again: the per-run --scratch root (outside the checkout,
 *     discarded by the caller) and each --writable place, a declared state
 *     directory of the checkout. Each is opened without following a link,
 *     checked to be a real directory at exactly its own canonical path (a
 *     place inside the checkout for --writable, outside it for --scratch,
 *     with no file of more than one name beneath a --writable place: a hard
 *     link could alias a checkout file), and bound FROM THAT DESCRIPTOR, so
 *     nothing can be swapped between the check and the bind;
 *   - a SECOND user and mount namespace locks every mount (MNT_LOCKED,
 *     MNT_LOCK_READONLY): the command, root in its own namespace, can
 *     neither remount nor unmount;
 *   - every inherited descriptor is closed but 0-2 (and the passed 3).
 * The pid namespace is not changed: this supervisor still owns, stops and
 * reaps the command. Any step that cannot be done refuses the run (exit 125
 * and the step that failed), never an unconfined run.
 * --probe-confinement sets the same namespaces up in a child and proves them:
 * a write in the checkout and outside it is EROFS, each writable place takes
 * a write, a remount read-write is refused; exit 0, or 125 with the step.
 *
 * THE RUNNER'S DEATH IS ONE STOP. It arrives as the parent-death signal, and
 * the kernel sends that on EVERY reparent: a dying multi-threaded runner (Node
 * always is) hands this process to each of its still-live threads in turn, so
 * one SIGKILL of the runner delivered one to three signals (measured 15 times,
 * PROMO01-SUPERVISOR-PDEATH). It therefore has a signal of its own
 * (RUNNER_DEATH_SIGNAL), never one of the stop signals: its first delivery is
 * the stop, its repeats are the same death and change nothing, while a real
 * second stop (SIGTERM, SIGINT, SIGHUP) during the grace still kills at once.
 */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <ftw.h>
#include <net/if.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* The parent-death signal (see the header): never a stop signal, so its repeats are told apart. */
#define RUNNER_DEATH_SIGNAL SIGUSR1

static FILE *receipt;
static bool first_reaped = true;
static bool spawned = false, failing = false;
static pid_t command_pid;
static void cleanup_descendants(void);

static void fail(const char *operation) {
    perror(operation);
    if (spawned) fprintf(stderr, "test supervisor: owned command pid %ld\n", (long)command_pid);
    if (spawned && !failing) {
        failing = true;
        /* Release the receipt descriptor before emergency cleanup, including
         * EMFILE after fork. A failure never publishes a success receipt. */
        if (receipt) { fclose(receipt); receipt = NULL; }
        cleanup_descendants();
    }
    exit(1);
}

static double monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) fail("test supervisor clock");
    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}

static double bound(const char *text) {
    char *end;
    errno = 0;
    double value = strtod(text, &end);
    if (errno || !*text || *end || !isfinite(value) || value <= 0 || value > INT_MAX) {
        fprintf(stderr, "test supervisor: invalid process bound\n");
        exit(1);
    }
    return value;
}

static int pidfd(pid_t pid) {
    int fd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (fd < 0) fail("test supervisor pidfd_open");
    return fd;
}

static void signal_owned(int fd, int signal) {
    /* A pidfd cannot name a recycled PID. WNOWAIT also proves this is still
     * our child without releasing its identity before signalling it. */
    siginfo_t info = {0};
    if (waitid(P_PIDFD, fd, &info, WEXITED | WNOHANG | WNOWAIT))
        fail("test supervisor child ownership");
    if (syscall(SYS_pidfd_send_signal, fd, signal, NULL, 0) && errno != ESRCH)
        fail("test supervisor pidfd_send_signal");
}

static pid_t reap(pid_t child, int *status, int options) {
    pid_t pid;
    do { pid = waitpid(child, status, options); } while (pid < 0 && errno == EINTR);
    return pid;
}

/* Reaps `child` by `deadline`; false when the deadline passed or a stop
 * arrived (`*interrupted`). The runner's death is a stop only where
 * `runner_death_stops` says so: during a grace it is a repeat of the first. */
static bool wait_until(pid_t child, int *status, double deadline,
                       const sigset_t *signals, bool runner_death_stops, bool *interrupted) {
    for (;;) {
        pid_t pid = reap(child, status, WNOHANG);
        if (pid == child) return true;
        if (pid < 0) fail("test supervisor waitpid");
        if (*interrupted) return false;
        double left = deadline - monotonic_ms();
        if (left <= 0) return false;
        struct timespec remaining = {
            .tv_sec = (time_t)(left / 1000),
            .tv_nsec = (long)(fmod(left, 1000) * 1000000)
        };
        int received = sigtimedwait(signals, NULL, &remaining);
        if (received == SIGTERM || received == SIGINT || received == SIGHUP ||
            (received == RUNNER_DEATH_SIGNAL && runner_death_stops)) *interrupted = true;
        else if (received < 0 && errno != EAGAIN && errno != EINTR)
            fail("test supervisor sigtimedwait");
    }
}

static void record_reaped(pid_t pid, int status, bool killed) {
    if (!receipt) return;
    fprintf(receipt, "%s{\"pid\":%ld,\"status\":%d,\"killed\":%s}",
            first_reaped ? "" : ",", (long)pid, status, killed ? "true" : "false");
    first_reaped = false;
}

static void cleanup_descendants(void) {
    for (;;) {
        int status;
        pid_t pid = reap(-1, &status, WNOHANG);
        if (pid > 0) { record_reaped(pid, status, false); continue; }
        if (pid < 0) {
            if (errno == ECHILD) return;
            fail("test supervisor reap descendants");
        }
        /* This process has no other threads/reapers and has not released
         * these children, so their PIDs cannot be recycled during this read.
         * Kill/reap one generation; newly adopted grandchildren then enter
         * the next iteration, including descendants that changed sessions. */
        char path[128];
        snprintf(path, sizeof(path), "/proc/%ld/task/%ld/children", (long)getpid(), (long)getpid());
        FILE *children = fopen(path, "r");
        if (!children) fail("test supervisor owned children");
        char *generation = NULL;
        size_t capacity = 0;
        if (getdelim(&generation, &capacity, '\n', children) <= 0) fail("test supervisor missing owned child");
        fclose(children);
        /* Snapshot each generation once. Do not reap until all its members
         * have been signalled: their unreaped identities cannot be reused. */
        char *cursor = generation, *end;
        long next;
        while ((next = strtol(cursor, &end, 10)) > 0) {
            if (failing) {
                /* The single reaper has not waited on these direct children.
                 * WNOWAIT proves ownership; keeping zombies unreaped prevents
                 * PID recycling even when no descriptor can be allocated. */
                siginfo_t info = {0};
                if (waitid(P_PID, (id_t)next, &info, WEXITED | WNOHANG | WNOWAIT))
                    fail("test supervisor emergency ownership");
                if (kill((pid_t)next, SIGKILL) && errno != ESRCH)
                    fail("test supervisor emergency signal");
            } else {
                int fd = pidfd((pid_t)next);
                signal_owned(fd, SIGKILL);
                close(fd);
            }
            cursor = end;
        }
        cursor = generation;
        while ((next = strtol(cursor, &end, 10)) > 0) {
            pid = reap((pid_t)next, &status, 0);
            if (pid != next) fail("test supervisor wait for killed child");
            record_reaped(pid, status, true);
            cursor = end;
        }
        free(generation);
    }
}

static int64_t cpu_us(const struct rusage *usage) {
    return (int64_t)usage->ru_utime.tv_sec * 1000000 + usage->ru_utime.tv_usec
         + (int64_t)usage->ru_stime.tv_sec * 1000000 + usage->ru_stime.tv_usec;
}

/* A process's start time (`/proc/<pid>/stat` field 22, clock ticks since
 * boot: the identity the engine's process facts read), or -1. */
static long long start_time_of(pid_t pid)
{
    char path[64];
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    FILE *stat = fopen(path, "re");
    if (stat == NULL) return -1;
    char line[4096];
    size_t length = fread(line, 1, sizeof(line) - 1, stat);
    fclose(stat);
    line[length] = '\0';
    char *field = strrchr(line, ')');
    if (field == NULL) return -1;
    /* After ") " comes field 3 (state); field 22 is the 20th from there. */
    field += 1;
    for (int index = 3; index <= 22; index++) {
        while (*field == ' ') field++;
        if (*field == '\0') return -1;
        if (index == 22) {
            char *end = NULL;
            long long value = strtoll(field, &end, 10);
            return end == field || value < 0 ? -1 : value;
        }
        while (*field != ' ' && *field != '\0') field++;
    }
    return -1;
}

/* The confinement (see the header): the checkout, the per-run scratch root and the writable places. */
#define MAX_PLACES 32
#define CONFINEMENT_REFUSED 125
static const char *checkout_root = NULL;
static const char *scratch_root = NULL;
static const char *writable[MAX_PLACES];
static int writable_count = 0;
static bool passes_fd = false;

static int write_text(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t length = strlen(text);
    ssize_t written = write(fd, text, length);
    int saved = errno;
    close(fd);
    errno = saved;
    return written == (ssize_t)length ? 0 : -1;
}

/* This user and group, mapped onto themselves: the command keeps its own ids. */
static int map_own_identity(uid_t uid, gid_t gid) {
    char line[64];
    if (write_text("/proc/self/setgroups", "deny") && errno != ENOENT) return -1;
    snprintf(line, sizeof(line), "%lu %lu 1", (unsigned long)uid, (unsigned long)uid);
    if (write_text("/proc/self/uid_map", line)) return -1;
    snprintf(line, sizeof(line), "%lu %lu 1", (unsigned long)gid, (unsigned long)gid);
    return write_text("/proc/self/gid_map", line);
}

/* `path` lies strictly beneath `root` (both canonical absolute paths). */
static bool beneath(const char *path, const char *root) {
    size_t length = strlen(root);
    if (length == 1) return path[1] != '\0';
    return strncmp(path, root, length) == 0 && path[length] == '/';
}

/* A place opened by descriptor: a real directory at exactly its canonical path. -1 (errno, `*why`) when not. */
static int open_place(const char *path, const char **why) {
    int fd = open(path, O_PATH | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) { *why = "open a writable place (it must be a real directory, not a link)"; return -1; }
    char link[64], real[PATH_MAX];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t length = readlink(link, real, sizeof(real) - 1);
    if (length < 0) { *why = "read a writable place's real path"; close(fd); return -1; }
    real[length] = '\0';
    if (strcmp(real, path) != 0) { errno = ELOOP; *why = "a writable place resolves through a link"; close(fd); return -1; }
    return fd;
}

static int aliased = 0;
static int alias_walk(const char *path, const struct stat *stats, int type, struct FTW *where) {
    (void)path; (void)where;
    if (type == FTW_F && S_ISREG(stats->st_mode) && stats->st_nlink > 1) { aliased = 1; return 1; }
    return 0;
}

/* Brings the namespace's own loopback up (a new network namespace starts with it down). */
static int loopback_up(void) {
    int sock = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (sock < 0) return -1;
    struct ifreq request;
    memset(&request, 0, sizeof(request));
    strncpy(request.ifr_name, "lo", IFNAMSIZ - 1);
    int result = ioctl(sock, SIOCGIFFLAGS, &request);
    if (result == 0) { request.ifr_flags |= IFF_UP; result = ioctl(sock, SIOCSIFFLAGS, &request); }
    int saved = errno;
    close(sock);
    errno = saved;
    return result;
}

/* A fresh empty tmpfs over `path` when it exists (what was there is no longer reachable by path). */
static int cover_with_tmpfs(const char *path) {
    struct stat stats;
    if (lstat(path, &stats) != 0 || !S_ISDIR(stats.st_mode)) return 0;
    return mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777");
}

/* THE SOCKETS OF THE HOST, MASKED (#654): every pathname unix socket bound in this network namespace when the run
 * starts, read from /proc/net/unix before the run's own namespace replaces it. A read-only mount does not stop
 * connect(2), so each socket's folder is covered by an empty read-only tmpfs instead — except the run's own (under its
 * scratch root) and those the fresh tmpfs already hides (/tmp, /run, /dev/shm). A folder that cannot be covered
 * without hiding the run's own places (an ancestor of the checkout, the scratch root or a writable place), or a
 * socket inside the checkout outside its writable places, refuses the run. A socket bound later, outside the run,
 * stays reachable until Landlock ABI 9 (LANDLOCK_ACCESS_FS_RESOLVE_UNIX) can refuse it. */
#define MAX_MASKS 4096
static char *masks[MAX_MASKS];
static int mask_count;

static bool at_or_beneath(const char *path, const char *root) {
    return strcmp(path, root) == 0 || beneath(path, root);
}

/* Judges one socket's folder (canonical) and remembers it to mask. NULL, or why the run is refused. */
static const char *note_socket_folder(const char *folder, const char *const *covered, size_t covered_count) {
    char real[PATH_MAX];
    if (realpath(folder, real) == NULL) return NULL; /* gone, or not reachable from here: nothing to connect to */
    for (size_t index = 0; index < covered_count; index++) if (at_or_beneath(real, covered[index])) return NULL;
    if (at_or_beneath(real, scratch_root)) return NULL;
    errno = EBUSY;
    if (at_or_beneath(checkout_root, real) || at_or_beneath(scratch_root, real)) return "a unix socket's folder holds the run's own places, so it cannot be masked (move the socket)";
    bool in_place = false;
    for (int index = 0; index < writable_count; index++) {
        if (at_or_beneath(writable[index], real)) return "a unix socket's folder holds a writable place, so it cannot be masked (move the socket)";
        if (beneath(real, writable[index])) in_place = true;
    }
    if (beneath(real, checkout_root) && !in_place) return "a unix socket is bound inside the checkout (move the socket)";
    errno = 0;
    for (int index = 0; index < mask_count; index++) if (strcmp(masks[index], real) == 0) return NULL;
    if (mask_count == MAX_MASKS) { errno = E2BIG; return "too many unix sockets' folders to mask"; }
    masks[mask_count] = strdup(real);
    if (masks[mask_count++] == NULL) return "remember a unix socket's folder";
    return NULL;
}

/* A relative socket path is relative to its binder's working directory: the process of THIS user holding the socket
 * (its descriptor names `socket:[inode]`) answers where it is. A socket no process of this user holds is another
 * user's: not reachable as this user's own service, and not this run's to mask. A relative socket whose holder has
 * since changed its working directory cannot be located, and stays reachable (the residual, with sockets bound later). */
static const char *note_relative_socket(unsigned long inode, const char *relative, const char *const *covered, size_t covered_count) {
    char wanted[64];
    snprintf(wanted, sizeof(wanted), "socket:[%lu]", inode);
    DIR *processes = opendir("/proc");
    if (processes == NULL) return "list this host's processes to place a relative unix socket";
    const char *failed = NULL;
    bool placed = false;
    for (struct dirent *entry = readdir(processes); entry != NULL && !placed && failed == NULL; entry = readdir(processes)) {
        if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
        char descriptors[64];
        snprintf(descriptors, sizeof(descriptors), "/proc/%.32s/fd", entry->d_name);
        DIR *fds = opendir(descriptors);
        if (fds == NULL) continue; /* another user's process, or gone */
        for (struct dirent *fd = readdir(fds); fd != NULL && !placed; fd = readdir(fds)) {
            char link[128], target[128];
            snprintf(link, sizeof(link), "%s/%.32s", descriptors, fd->d_name);
            ssize_t length = readlink(link, target, sizeof(target) - 1);
            if (length < 0) continue;
            target[length] = '\0';
            if (strcmp(target, wanted) != 0) continue;
            char cwd_link[64], cwd[PATH_MAX], folder[PATH_MAX * 2];
            snprintf(cwd_link, sizeof(cwd_link), "/proc/%.32s/cwd", entry->d_name);
            ssize_t cwd_length = readlink(cwd_link, cwd, sizeof(cwd) - 1);
            if (cwd_length < 0) continue;
            cwd[cwd_length] = '\0';
            snprintf(folder, sizeof(folder), "%s/%s", cwd, relative);
            /* Only where the socket file really is: a holder that moved since it bound is no answer. */
            struct stat found;
            if (lstat(folder, &found) != 0 || !S_ISSOCK(found.st_mode)) continue;
            char *slash = strrchr(folder, '/');
            *slash = '\0';
            failed = note_socket_folder(folder, covered, covered_count);
            placed = true;
        }
        closedir(fds);
    }
    closedir(processes);
    return failed;
}

static const char *collect_socket_masks(const char *const *covered, size_t covered_count) {
    FILE *table = fopen("/proc/net/unix", "re");
    if (table == NULL) return "read the host's unix sockets (/proc/net/unix)";
    char line[PATH_MAX + 256];
    const char *failed = NULL;
    if (fgets(line, sizeof(line), table) == NULL) { fclose(table); return NULL; } /* the header */
    while (failed == NULL && fgets(line, sizeof(line), table) != NULL) {
        line[strcspn(line, "\n")] = '\0';
        /* Num RefCount Protocol Flags Type St Inode Path: the inode is the seventh field, the path the rest. */
        char *cursor = line;
        unsigned long inode = 0;
        for (int field = 0; field < 7 && cursor != NULL; field++) {
            while (*cursor == ' ') cursor++;
            if (field == 6) inode = strtoul(cursor, NULL, 10);
            cursor = strchr(cursor, ' ');
        }
        if (cursor == NULL) continue;
        while (*cursor == ' ') cursor++;
        if (*cursor == '\0' || *cursor == '@') continue; /* unbound, or abstract (the network namespace scopes those) */
        if (*cursor != '/') { failed = note_relative_socket(inode, cursor, covered, covered_count); continue; }
        char folder[PATH_MAX];
        snprintf(folder, sizeof(folder), "%s", cursor);
        char *slash = strrchr(folder, '/');
        if (slash == NULL || slash == folder) continue;
        *slash = '\0';
        failed = note_socket_folder(folder, covered, covered_count);
    }
    fclose(table);
    return failed;
}

static int mask_length_order(const void *left, const void *right) {
    return (int)strlen(*(char *const *)left) - (int)strlen(*(char *const *)right);
}

/* Each collected folder covered by an empty read-only tmpfs, found by a descriptor proven to name it; a folder beneath
 * one already covered is hidden with it. */
static const char *mount_socket_masks(void) {
    qsort(masks, (size_t)mask_count, sizeof(masks[0]), mask_length_order);
    for (int index = 0; index < mask_count; index++) {
        bool inside_earlier = false;
        for (int earlier = 0; earlier < index; earlier++) if (beneath(masks[index], masks[earlier])) inside_earlier = true;
        if (inside_earlier) continue;
        int folder = open(masks[index], O_PATH | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
        if (folder < 0) continue; /* gone since it was read: nothing left to connect to */
        char link[64], named[PATH_MAX];
        snprintf(link, sizeof(link), "/proc/self/fd/%d", folder);
        ssize_t length = readlink(link, named, sizeof(named) - 1);
        if (length < 0 || (named[length] = '\0', strcmp(named, masks[index]) != 0)) { close(folder); errno = EXDEV; return "a unix socket's folder changed before it could be masked"; }
        int result = mount("tmpfs", link, "tmpfs", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4k,mode=0555");
        int saved = errno;
        close(folder);
        errno = saved;
        if (result) return "mask a unix socket's folder with an empty read-only tmpfs";
    }
    return NULL;
}

/* `fd` (a directory of this namespace) cloned, read-write or read-only, and mounted onto `target` (a directory descriptor). */
static int bind_place(int fd, int target, bool writable_place) {
    int tree = (int)syscall(SYS_open_tree, fd, "", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH);
    if (tree < 0) return -1;
    struct mount_attr attr = {0};
    if (writable_place) attr.attr_clr = MOUNT_ATTR_RDONLY; else attr.attr_set = MOUNT_ATTR_RDONLY;
    int result = (int)syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH, &attr, sizeof(attr));
    if (result == 0) result = (int)syscall(SYS_move_mount, tree, "", target, "", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH);
    int saved = errno;
    close(tree);
    errno = saved;
    return result;
}

/* `path`, inside a fresh tmpfs this process just mounted (nobody else can reach it), made as a directory chain and opened. */
static int make_in_fresh_tmpfs(const char *path) {
    char partial[PATH_MAX];
    snprintf(partial, sizeof(partial), "%s", path);
    for (char *slash = strchr(partial + 1, '/'); slash != NULL; slash = strchr(slash + 1, '/')) {
        *slash = '\0';
        if (mkdir(partial, 0700) != 0 && errno != EEXIST) return -1;
        *slash = '/';
    }
    if (mkdir(partial, 0700) != 0 && errno != EEXIST) return -1;
    return open(partial, O_PATH | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
}

/* Sets the confinement up in THIS process (a forked child, before it execs).
 * NULL, or the step that failed (errno says why). */
static const char *confine(void) {
    uid_t uid = getuid();
    gid_t gid = getgid();
    char cwd[PATH_MAX];
    bool have_cwd = getcwd(cwd, sizeof(cwd)) != NULL;
    char real[PATH_MAX];
    if (!realpath(checkout_root, real) || strcmp(real, checkout_root) != 0) return "the checkout must be named by its canonical path";
    if (!realpath(scratch_root, real) || strcmp(real, scratch_root) != 0) return "the scratch root must be named by its canonical path";
    if (beneath(scratch_root, checkout_root) || strcmp(scratch_root, checkout_root) == 0) return "the scratch root must lie outside the checkout";
    static const char *const covered[] = {"/tmp", "/run", "/dev/shm"};
    /* A scratch root under a covered folder (a TMPDIR in /tmp) is re-attached at its own path inside the fresh tmpfs. */
    bool scratch_covered = false;
    for (size_t index = 0; index < sizeof(covered) / sizeof(covered[0]); index++)
        if (beneath(scratch_root, covered[index])) scratch_covered = true;
    for (int index = 0; index < writable_count; index++) {
        if (!beneath(writable[index], checkout_root)) { errno = EINVAL; return "a writable place must lie inside the checkout"; }
        aliased = 0;
        if (nftw(writable[index], alias_walk, 32, FTW_PHYS) < 0) return "walk a writable place";
        if (aliased) { errno = EMLINK; return "a writable place holds a file with more than one name (a hard link could alias a checkout file)"; }
    }
    /* Read in the host's network namespace, before the run's own replaces it. */
    const char *unmaskable = collect_socket_masks(covered, sizeof(covered) / sizeof(covered[0]));
    if (unmaskable != NULL) return unmaskable;
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWIPC)) return "unshare user, mount, network and IPC namespaces";
    if (map_own_identity(uid, gid)) return "map this user into the namespace";
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) return "make the mounts private";
    /* Opened in THIS namespace, before anything is read-only: each bind below is made from its descriptor, in this
     * order: the scratch root; the checkout again, read-only, when it lies inside the scratch root (a test's own
     * fixture checkout in a nested run: the checkout is read-only wherever it lies); then the writable places. */
    int places[MAX_PLACES + 2];
    bool place_writable[MAX_PLACES + 2];
    const char *place_path[MAX_PLACES + 2];
    int count = 0;
    const char *why = NULL;
    place_path[count] = scratch_root;
    place_writable[count] = true;
    places[count] = open_place(scratch_root, &why);
    if (places[count++] < 0) return why;
    if (beneath(checkout_root, scratch_root)) {
        place_path[count] = checkout_root;
        place_writable[count] = false;
        places[count] = open_place(checkout_root, &why);
        if (places[count++] < 0) return why;
    }
    for (int index = 0; index < writable_count; index++) {
        place_path[count] = writable[index];
        place_writable[count] = true;
        places[count] = open_place(writable[index], &why);
        if (places[count++] < 0) return why;
    }
    struct mount_attr read_only = {.attr_set = MOUNT_ATTR_RDONLY};
    if (syscall(SYS_mount_setattr, AT_FDCWD, "/", AT_RECURSIVE, &read_only, sizeof(read_only)))
        return "make every mount read-only (mount_setattr, Linux 5.12 or later)";
    /* The named kernel pseudo-filesystem the run needs to write: /proc (this process's own user-namespace maps,
     * below; nothing of the user's lives there). /dev and /sys stay read-only (a device node is still written). */
    struct mount_attr proc_writable = {.attr_clr = MOUNT_ATTR_RDONLY};
    if (syscall(SYS_mount_setattr, AT_FDCWD, "/proc", 0, &proc_writable, sizeof(proc_writable))) return "keep /proc writable";
    for (size_t index = 0; index < sizeof(covered) / sizeof(covered[0]); index++)
        if (cover_with_tmpfs(covered[index])) return "cover /tmp, /run and /dev/shm with a fresh tmpfs";
    for (int index = 0; index < count; index++) {
        /* The scratch root under a folder the tmpfs covered is re-attached at its own path inside the tmpfs. A place
         * beneath an earlier bind (inside the scratch root) is attached through that bind's new mount: found again by
         * its path, and refused unless it is the very directory its descriptor names (device and inode). */
        bool under_earlier = false;
        for (int earlier = 0; earlier < index; earlier++)
            if (beneath(place_path[index], place_path[earlier])) under_earlier = true;
        int target = index == 0 && scratch_covered ? make_in_fresh_tmpfs(scratch_root)
            : under_earlier ? open(place_path[index], O_PATH | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC)
            : places[index];
        if (target < 0) return "find a place's path under the binds";
        if (under_earlier) {
            struct stat found, opened;
            if (fstat(target, &found) || fstat(places[index], &opened) || found.st_dev != opened.st_dev || found.st_ino != opened.st_ino) {
                errno = EXDEV;
                return "a place found again under the binds is not the directory first opened";
            }
        }
        if (bind_place(places[index], target, place_writable[index])) return "bind a place from its descriptor";
        if (target != places[index]) close(target);
        close(places[index]);
    }
    const char *unmasked = mount_socket_masks();
    if (unmasked != NULL) return unmasked;
    if (loopback_up()) return "bring the network namespace's loopback up";
    /* The lock: copied into a less privileged namespace, these mounts can be
     * neither remounted nor taken away. */
    if (unshare(CLONE_NEWUSER | CLONE_NEWNS)) return "lock the mounts";
    if (map_own_identity(uid, gid)) return "map this user into the locking namespace";
    /* A working directory still named the mount UNDER the binds: entered again, it resolves through them. */
    if (have_cwd && chdir(cwd)) return "re-enter the working directory";
    if (syscall(SYS_close_range, passes_fd ? 4 : 3, ~0U, 0)) return "close every inherited descriptor";
    return NULL;
}

static void refuse_confinement(const char *step) {
    fprintf(stderr, "test supervisor: confinement refused: %s: %s\n", step, errno == 0 ? "-" : strerror(errno));
}

/* Creates and removes one file under `folder`; the open's errno, or 0 when the write was taken. */
static int write_probe(const char *folder) {
    char probe[PATH_MAX];
    snprintf(probe, sizeof(probe), "%s/.confinement-probe-%ld", folder, (long)getpid());
    int fd = open(probe, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) return errno;
    close(fd);
    unlink(probe);
    return 0;
}

/* --probe-confinement: the namespaces set up in a child, and proven. */
static int probe_confinement(void) {
    pid_t child = fork();
    if (child < 0) { perror("test supervisor probe fork"); return 1; }
    if (child == 0) {
        const char *failed = confine();
        if (failed) { refuse_confinement(failed); _exit(CONFINEMENT_REFUSED); }
        char parent[PATH_MAX];
        snprintf(parent, sizeof(parent), "%s", checkout_root);
        char *slash = strrchr(parent, '/');
        if (slash != NULL && slash != parent) *slash = '\0';
        /* Beside the checkout is read-only too, unless the checkout lies in the scratch root (a nested run's fixture
         * checkout), whose folders are the run's to write. */
        const char *const refused[] = {checkout_root, parent};
        size_t refused_count = beneath(checkout_root, scratch_root) ? 1 : 2;
        for (size_t index = 0; index < refused_count; index++) {
            int code = write_probe(refused[index]);
            if (code != EROFS) { errno = code; refuse_confinement(code == 0 ? "a write in the checkout or beside it was taken" : "a write in the checkout or beside it failed, but not read-only"); _exit(CONFINEMENT_REFUSED); }
        }
        for (int index = 0; index <= writable_count; index++) {
            const char *place = index < writable_count ? writable[index] : scratch_root;
            int code = write_probe(place);
            if (code != 0) { errno = code; refuse_confinement("a writable place refused a write"); _exit(CONFINEMENT_REFUSED); }
        }
        struct mount_attr writable_attr = {.attr_clr = MOUNT_ATTR_RDONLY};
        if (syscall(SYS_mount_setattr, AT_FDCWD, checkout_root, 0, &writable_attr, sizeof(writable_attr)) == 0 ||
            mount(NULL, checkout_root, NULL, MS_REMOUNT | MS_BIND, NULL) == 0 || umount2("/", MNT_DETACH) == 0) {
            errno = 0; refuse_confinement("the read-only mounts could be remounted or detached"); _exit(CONFINEMENT_REFUSED);
        }
        _exit(0);
    }
    int status;
    if (reap(child, &status, 0) != child) { perror("test supervisor probe wait"); return 1; }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

int main(int argc, char **argv) {
    bool probe = argc > 1 && strcmp(argv[1], "--probe-confinement") == 0;
    if (probe) { argv++; argc--; }
    while (argc > 2 && (strcmp(argv[1], "--checkout") == 0 || strcmp(argv[1], "--scratch") == 0 || strcmp(argv[1], "--writable") == 0)) {
        if (argv[2][0] != '/') { fprintf(stderr, "test supervisor: a confinement place needs an absolute path\n"); return 1; }
        if (strcmp(argv[1], "--checkout") == 0) checkout_root = argv[2];
        else if (strcmp(argv[1], "--scratch") == 0) scratch_root = argv[2];
        else {
            if (writable_count == MAX_PLACES) { fprintf(stderr, "test supervisor: too many writable places\n"); return 1; }
            writable[writable_count++] = argv[2];
        }
        argv += 2; argc -= 2;
    }
    bool confined = checkout_root != NULL || scratch_root != NULL || writable_count > 0;
    if (confined && (checkout_root == NULL || scratch_root == NULL)) {
        fprintf(stderr, "test supervisor: a confined run needs both --checkout and --scratch\n");
        return 1;
    }
    if (probe) {
        if (!confined) { fprintf(stderr, "test supervisor: --probe-confinement needs --checkout and --scratch\n"); return 1; }
        return probe_confinement();
    }
    bool pass_fd = argc > 1 && strcmp(argv[1], "--pass-fd") == 0;
    if (pass_fd) { argv++; argc--; }
    passes_fd = pass_fd;
    if (argc < 4) { fprintf(stderr, "test supervisor: expected [--pass-fd] timeout grace command\n"); return 1; }
    if (pass_fd && fcntl(4, F_GETFD) < 0) { fprintf(stderr, "test supervisor: --pass-fd needs an open fd 4\n"); return 1; }
    double timeout = bound(argv[1]), grace = bound(argv[2]);
    receipt = fdopen(3, "w");
    if (!receipt) fail("test supervisor receipt");
    if (fcntl(3, F_SETFD, FD_CLOEXEC)) fail("test supervisor receipt ownership");
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) fail("test supervisor subreaper");
    sigset_t signals, original;
    sigemptyset(&signals);
    /* A closed terminal (SIGHUP) ends the run exactly like Ctrl-C: every
     * descendant is killed and reaped before the receipt closes. */
    sigaddset(&signals, SIGCHLD); sigaddset(&signals, SIGTERM); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGHUP);
    sigaddset(&signals, RUNNER_DEATH_SIGNAL);
    if (sigprocmask(SIG_BLOCK, &signals, &original)) fail("test supervisor block signals");
    /* The runner that started this supervisor starts it in a process group
     * of its own (so a terminal's Ctrl-C reaches the runner alone, which
     * forwards ONE stop): if that runner dies without stopping it (SIGKILL,
     * the OOM killer), its death arrives here as ONE stop (RUNNER_DEATH_SIGNAL,
     * see the header). A runner that died before the prctl sent nothing: the
     * parent check closes that race, as the command's own check does below. */
    pid_t runner = getppid();
    if (prctl(PR_SET_PDEATHSIG, RUNNER_DEATH_SIGNAL, 0, 0, 0)) fail("test supervisor parent-death stop");
    bool runner_gone = getppid() != runner;
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL)) fail("test supervisor child disposition");
    double deadline = monotonic_ms() + timeout;
    pid_t supervisor = getpid();
    pid_t child = fork();
    if (child < 0) fail("test supervisor fork");
    if (child == 0) {
        close(3);
        if (pass_fd && (dup2(4, 3) < 0 || close(4))) _exit(126);
        /* If THIS supervisor dies without cleaning up (SIGKILL, the OOM
         * killer), the command dies with it, and the command leads its own
         * process group so whoever started the supervisor can end every
         * descendant that stayed in it (the announced pid below is the
         * group). The parent check closes the race with a supervisor that
         * died before the prctl. */
        if (setpgid(0, 0)) _exit(126);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) || getppid() != supervisor) _exit(126);
        if (sigprocmask(SIG_SETMASK, &original, NULL)) _exit(126);
        if (confined) {
            const char *failed = confine();
            if (failed) { refuse_confinement(failed); _exit(CONFINEMENT_REFUSED); }
        }
        execvp(argv[3], &argv[3]);
        perror("test supervisor exec");
        _exit(127);
    }
    spawned = true;
    command_pid = child;
    /* The passed channel is the command's alone: its end-of-file is the
     * command's (and its descendants') closing, never this process's. */
    if (pass_fd && close(4)) fail("test supervisor release passed descriptor");
    /* The ANNOUNCEMENT, one line before anything can go wrong: the command's
     * pid, which is its process group, BOUND TO ITS START TIME (read now,
     * while the command is this process's unreaped child, so its pid cannot
     * name another process yet): a reader that must stop the group later
     * stops only this process's group, never a recycled pid's (KILL-OWNED-ONLY,
     * security K-2). An unreadable start time is said as null, and owns
     * nothing. The receipt proper is the LAST line. */
    long long started = start_time_of(child);
    if (started < 0) fprintf(receipt, "{\"announcedCommandPid\":%ld,\"announcedCommandStartTime\":null}\n", (long)child);
    else fprintf(receipt, "{\"announcedCommandPid\":%ld,\"announcedCommandStartTime\":%lld}\n", (long)child, started);
    if (fflush(receipt)) fail("test supervisor announcement");
    int fd = pidfd(child), status;
    bool interrupted = runner_gone, timed_out = false, killed = false;
    if (!wait_until(child, &status, deadline, &signals, true, &interrupted)) {
        /* The ceiling or a stop (SIGTERM/SIGINT/SIGHUP): the command is told
         * first (SIGTERM: a runner that reports on its way out — the engine
         * worker aborting its test files — gets the grace to do it), then it
         * and every descendant are killed. A second stop kills at once; the
         * runner's death repeated (or after a real stop) is not a second one. */
        timed_out = !interrupted;
        bool again = false;
        signal_owned(fd, SIGTERM);
        if (!wait_until(child, &status, monotonic_ms() + grace, &signals, false, &again)) {
            signal_owned(fd, SIGKILL);
            killed = true;
            if (reap(child, &status, 0) != child) fail("test supervisor command reap");
        }
    }
    close(fd);
    int result = WIFEXITED(status) ? WEXITSTATUS(status) : -WTERMSIG(status);
    fprintf(receipt, "{\"commandPid\":%ld,\"status\":%d,\"timedOut\":%s,\"interrupted\":%s,\"commandKilled\":%s,\"reaped\":[",
            (long)child, result, timed_out ? "true" : "false", interrupted ? "true" : "false", killed ? "true" : "false");
    cleanup_descendants();
    struct rusage waited, own;
    if (getrusage(RUSAGE_CHILDREN, &waited) || getrusage(RUSAGE_SELF, &own)) fail("test supervisor CPU");
    fprintf(receipt, "],\"noOwnedChildren\":true,\"waitedCpuUs\":%" PRId64 ",\"supervisorCpuUsBeforeReceipt\":%" PRId64 "}\n", cpu_us(&waited), cpu_us(&own));
    int close_result = fclose(receipt);
    receipt = NULL;
    if (close_result) fail("test supervisor close receipt");
    return 0;
}
