// File operations that act inside directories this process holds open: the browser download staging folder and the folder the
// user chose. Each mode opens its directories once, checks that each is the plain directory with the identity it was given, and
// then names every file relative to those descriptors (openat, renameat, unlinkat, fstatat), never by a path. A directory moved,
// or replaced by a link, after that check changes nothing: the operation still acts in the directory that was checked.
// README.md has the protocol; native/windows-path-kind implements the same modes with directory handles.
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { EXIT_DONE = 0, EXIT_USAGE = 2, EXIT_REFUSED = 3, EXIT_FAILED = 4 };

#define COPY_CHUNK (1024 * 1024)
// A copy syncs its temporary file this often, so the final sync is short and the caller keeps hearing progress (README.md).
#define SYNC_INTERVAL (16 * COPY_CHUNK)

static const char *errno_name(int code) {
  switch (code) {
    case EACCES: return "EACCES";
    case EBUSY: return "EBUSY";
    case EDQUOT: return "EDQUOT";
    case EEXIST: return "EEXIST";
    case EFBIG: return "EFBIG";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOTDIR: return "ENOTDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    case ETXTBSY: return "ETXTBSY";
    case EXDEV: return "EXDEV";
    default: return "EUNKNOWN";
  }
}

static void say(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static int done(const char *outcome) {
  say(outcome);
  return EXIT_DONE;
}

static int failed(int code) {
  printf("failed %s\n", errno_name(code));
  fflush(stdout);
  return EXIT_FAILED;
}

static int refused(const char *what) {
  printf("refused %s\n", what);
  fflush(stdout);
  return EXIT_REFUSED;
}

#if defined(AVE_DIR_OPS_TEST_NEVER_READY) || defined(AVE_DIR_OPS_TEST_IGNORES_EOF)
// Test builds that stop answering, to prove the caller stops a helper that hangs (scripts/build-macos-dir-ops.mjs).
static void hang(void) {
  for (;;) pause();
}
#endif

// Announce `step` and wait for the caller's answer: one `c` byte proceeds; any other byte, or the end of input, stops.
static int proceed(const char *step) {
#if defined(AVE_DIR_OPS_TEST_NEVER_READY)
  if (strcmp(step, "ready") == 0) hang();
#endif
  say(step);
#if defined(AVE_DIR_OPS_TEST_IGNORES_EOF)
  if (strcmp(step, "copied") == 0) hang();
#endif
  unsigned char answer = 0;
  for (;;) {
    const ssize_t count = read(STDIN_FILENO, &answer, 1);
    if (count < 0 && errno == EINTR) continue;
    return count == 1 && answer == 'c';
  }
}

// While a copy runs the caller writes nothing: input that becomes readable or ends asks the copy to stop.
static int stop_requested(void) {
#if defined(AVE_DIR_OPS_TEST_IGNORES_EOF)
  // Copies slowly and never sees the caller's request to stop.
  usleep(100000);
  return 0;
#endif
  struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
  int ready;
  do ready = poll(&input, 1, 0); while (ready < 0 && errno == EINTR);
  return ready != 0;
}

static int parse_u64(const char *text, uint64_t *value) {
  if (text[0] == '\0' || (text[0] == '0' && text[1] != '\0')) return 0;
  uint64_t result = 0;
  for (const char *cursor = text; *cursor != '\0'; ++cursor) {
    if (*cursor < '0' || *cursor > '9') return 0;
    const uint64_t digit = (uint64_t)(*cursor - '0');
    if (result > (UINT64_MAX - digit) / 10) return 0;
    result = result * 10 + digit;
  }
  *value = result;
  return 1;
}

// One path component: no separator, not `.` or `..`, and short enough to be a directory entry.
static int plain_name(const char *name) {
  const size_t length = strlen(name);
  return length > 0 && length <= NAME_MAX && strchr(name, '/') == NULL && strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}

// Open `path` as a directory without following a link at it, and keep it only when it has the identity the caller checked.
// A directory that is gone, unreadable, a link or another directory is refused as `what`. Returns 0 or the exit code to end with.
static int hold_directory(const char *path, const char *dev, const char *ino, const char *what, int *held) {
  uint64_t device = 0;
  uint64_t inode = 0;
  if (path[0] != '/' || !parse_u64(dev, &device) || !parse_u64(ino, &inode)) return EXIT_USAGE;
  const int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR || errno == ELOOP || errno == EACCES || errno == EPERM) return refused(what);
    return failed(errno);
  }
  struct stat info;
  if (fstat(fd, &info) != 0) return failed(errno);
  if (!S_ISDIR(info.st_mode) || (uint64_t)info.st_dev != device || (uint64_t)info.st_ino != inode) return refused(what);
  *held = fd;
  return 0;
}

// The chosen name may hold nothing yet, or an ordinary file the user agreed to replace; never a link or anything else.
// Returns 0 or the exit code to end with.
static int check_replaceable(int directory, const char *name) {
  struct stat info;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? 0 : failed(errno);
  return S_ISREG(info.st_mode) ? 0 : refused("target");
}

// Test builds of this helper make each write take part of what it is given, or nothing, to prove the copy handles both.
static ssize_t write_some(int target, const unsigned char *bytes, size_t length) {
#if defined(AVE_DIR_OPS_TEST_STALLED_WRITES)
  (void)target;
  (void)bytes;
  (void)length;
  return 0;
#elif defined(AVE_DIR_OPS_TEST_WRITE_LIMIT)
  return write(target, bytes, length < AVE_DIR_OPS_TEST_WRITE_LIMIT ? length : AVE_DIR_OPS_TEST_WRITE_LIMIT);
#else
  return write(target, bytes, length);
#endif
}

// Write all of `length` bytes, however many each write takes; a write that makes no progress fails the copy.
static int write_all(int target, const unsigned char *bytes, size_t length) {
  while (length > 0) {
    const ssize_t written = write_some(target, bytes, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      return errno;
    }
    if (written == 0) return EIO;
    bytes += written;
    length -= (size_t)written;
  }
  return 0;
}

// Remove the partial copy from the held folder. Then report `failure`, or `cancelled` when there is none; a partial copy
// that cannot be removed is itself the failure reported.
static int abandon(int to, const char *part, int failure) {
  if (unlinkat(to, part, 0) != 0 && errno != ENOENT) return failed(errno);
  return failure != 0 ? failed(failure) : done("cancelled");
}

static int run_rename(char **argv) {
  const char *name = argv[3];
  const char *target = argv[7];
  if (!plain_name(name) || !plain_name(target)) return EXIT_USAGE;
  int from = -1;
  int to = -1;
  int status = hold_directory(argv[0], argv[1], argv[2], "from", &from);
  if (status == 0) status = hold_directory(argv[4], argv[5], argv[6], "to", &to);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  struct stat info;
  if (fstatat(from, name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? refused("source") : failed(errno);
  if (!S_ISREG(info.st_mode)) return refused("source");
  status = check_replaceable(to, target);
  if (status != 0) return status;
  if (renameat(from, name, to, target) != 0) return errno == EXDEV ? done("cross-volume") : failed(errno);
  return done("committed");
}

static int run_copy(char **argv) {
  const char *name = argv[3];
  const char *target = argv[7];
  const char *part = argv[8];
  if (!plain_name(name) || !plain_name(target) || !plain_name(part) || strcmp(part, target) == 0) return EXIT_USAGE;
  int from = -1;
  int to = -1;
  int status = hold_directory(argv[0], argv[1], argv[2], "from", &from);
  if (status == 0) status = hold_directory(argv[4], argv[5], argv[6], "to", &to);
  if (status != 0) return status;
  const int source = openat(from, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (source < 0) return errno == ENOENT || errno == ELOOP ? refused("source") : failed(errno);
  struct stat info;
  if (fstat(source, &info) != 0) return failed(errno);
  if (!S_ISREG(info.st_mode)) return refused("source");
  if (!proceed("ready")) return done("cancelled");
  status = check_replaceable(to, target);
  if (status != 0) return status;
  // The temporary file is created exclusively, never through a link, in the held folder.
  const int copy = openat(to, part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, info.st_mode & 0777);
  if (copy < 0) return failed(errno);
  unsigned char *buffer = malloc(COPY_CHUNK);
  if (buffer == NULL) {
    close(copy);
    return abandon(to, part, ENOMEM);
  }
  int failure = 0;
  unsigned long long copied = 0;
  unsigned long long unsynced = 0;
  for (;;) {
    if (stop_requested()) {
      free(buffer);
      close(copy);
      return abandon(to, part, 0);
    }
    const ssize_t count = read(source, buffer, COPY_CHUNK);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) failure = errno;
    else if (count > 0) failure = write_all(copy, buffer, (size_t)count);
    if (count <= 0 || failure != 0) break;
    copied += (unsigned long long)count;
    unsynced += (unsigned long long)count;
    if (unsynced >= SYNC_INTERVAL) {
      if (fsync(copy) != 0) {
        failure = errno;
        break;
      }
      unsynced = 0;
    }
    // Each chunk is progress the caller hears, so only a copy that stops moving looks stalled.
    printf("progress %llu\n", copied);
    fflush(stdout);
  }
  free(buffer);
  if (failure == 0 && fsync(copy) != 0) failure = errno;
  if (close(copy) != 0 && failure == 0) failure = errno;
  if (failure != 0) return abandon(to, part, failure);
  // The rename below is the commit point: the caller answers here whether the copy is still wanted.
  if (!proceed("copied")) return abandon(to, part, 0);
  status = check_replaceable(to, target);
  if (status != 0) {
    if (unlinkat(to, part, 0) != 0 && errno != ENOENT) return failed(errno);
    return status;
  }
  if (renameat(to, part, to, target) != 0) return abandon(to, part, errno);
  return done("committed");
}

static int run_remove(char **argv) {
  const char *name = argv[3];
  if (!plain_name(name)) return EXIT_USAGE;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (unlinkat(directory, name, 0) != 0) return errno == ENOENT ? done("absent") : failed(errno);
  return done("removed");
}

// Remove the files and links directly in the held folder; directories and anything else stay, and nothing is removed recursively.
static int run_sweep(char **argv) {
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  const int listing = dup(directory);
  if (listing < 0) return failed(errno);
  DIR *entries = fdopendir(listing);
  if (entries == NULL) return failed(errno);
  unsigned long removed = 0;
  for (;;) {
    errno = 0;
    const struct dirent *entry = readdir(entries);
    if (entry == NULL) {
      if (errno != 0) return failed(errno);
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat info;
    if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      return failed(errno);
    }
    if (!S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode)) continue;
    if (unlinkat(directory, entry->d_name, 0) != 0) {
      if (errno == ENOENT) continue;
      return failed(errno);
    }
    removed += 1;
  }
  printf("swept %lu\n", removed);
  fflush(stdout);
  return EXIT_DONE;
}

int main(int argc, char **argv) {
  // An answer written after the caller stopped listening must not end the process before it cleans up.
  signal(SIGPIPE, SIG_IGN);
  if (argc == 10 && strcmp(argv[1], "--dir-rename") == 0) return run_rename(argv + 2);
  if (argc == 11 && strcmp(argv[1], "--dir-copy") == 0) return run_copy(argv + 2);
  if (argc == 6 && strcmp(argv[1], "--dir-remove") == 0) return run_remove(argv + 2);
  if (argc == 5 && strcmp(argv[1], "--dir-sweep") == 0) return run_sweep(argv + 2);
  fputs("usage: ave-dir-ops --dir-rename|--dir-copy|--dir-remove|--dir-sweep <arguments>\n", stderr);
  return EXIT_USAGE;
}
