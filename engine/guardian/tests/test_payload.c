/*
 * test_payload.c — tiny helper exec'd by the guardian in run-tests.sh.
 *
 * usage: test_payload <read|write|create|list> <path>
 *   read:   open(path, O_RDONLY) + read 1 byte
 *   write:  open(path, O_WRONLY|O_CREAT, 0600) + write 1 byte
 *   create: open(path, O_WRONLY|O_CREAT|O_EXCL, 0600)
 *   list:   opendir(path) + readdir loop
 *
 * Prints one line to stdout:
 *   OK            on success
 *   EACCES:<errno> when an open/read/write/readdir step gets EACCES
 *   ERROR:<errno> on any other error
 * Exit codes: 0 = OK, 1 = EACCES, 2 = other error.
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

static int report(int kind, int e)
{
    if (kind == 0) { printf("OK\n"); return 0; }
    if (kind == 1) { printf("EACCES:%d\n", e); return 1; }
    printf("ERROR:%d\n", e);
    return 2;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: test_payload <read|write|create|list|socket|spin> <path|inet|unix|->\n");
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
        /* `socket inet` / `socket unix`: may a socket of that family be made? */
        int family = strcmp(path, "unix") == 0 ? AF_UNIX : AF_INET;
        int fd = socket(family, SOCK_STREAM, 0);
        if (fd < 0) return report(errno == EACCES ? 1 : 2, errno);
        close(fd);
        return report(0, 0);
    } else if (strcmp(mode, "spin") == 0) {
        /* Burn CPU until a CPU ceiling ends the process (never returns on its own). */
        volatile unsigned long n = 0;
        for (;;) n++;
    }

    fprintf(stderr, "unknown mode '%s'\n", mode);
    return 2;
}
