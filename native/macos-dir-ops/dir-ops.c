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
// Returns 0, -1 when the name holds something else, or the errno that stopped the check.
static int replaceable(int directory, const char *name) {
  struct stat info;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? 0 : errno;
  return S_ISREG(info.st_mode) ? 0 : -1;
}

// replaceable(), answered: returns 0 or the exit code to end with.
static int check_replaceable(int directory, const char *name) {
  const int found = replaceable(directory, name);
  return found == 0 ? 0 : found < 0 ? refused("target") : failed(found);
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

// `.`, 32 hex digits, `.removing` and its end: the shape of the name the host moves a file aside to (MOVED_ASIDE_NAME in
// src/main/browser/browser-download-files.ts).
#define HIDDEN_NAME_SIZE 43

static void fresh_hidden_name(char name[HIDDEN_NAME_SIZE]) {
  static const char digits[] = "0123456789abcdef";
  unsigned char random[16];
  arc4random_buf(random, sizeof random);
  name[0] = '.';
  for (size_t index = 0; index < sizeof random; ++index) {
    name[1 + 2 * index] = digits[random[index] >> 4];
    name[2 + 2 * index] = digits[random[index] & 0x0f];
  }
  memcpy(name + 1 + 2 * sizeof random, ".removing", sizeof ".removing");
}

// The file a copy writes, known by a descriptor of its own on it, kept until the helper ends. Its identity is taken through that
// descriptor when the file is cleaned up, not when it is created: exFAT gives a new file its lasting file id only once it is written.
struct written_file {
  int fd;
};

// How much of each end of a file is compared to know it by its content (the host's fingerprint span).
#define FINGERPRINT_SPAN (64 * 1024)

static int read_at(int fd, unsigned char *bytes, size_t length, off_t offset) {
  while (length > 0) {
    const ssize_t count = pread(fd, bytes, length, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    bytes += count;
    length -= (size_t)count;
    offset += count;
  }
  return 1;
}

static int same_range(int own, int other, off_t offset, size_t length) {
  static unsigned char mine[FINGERPRINT_SPAN];
  static unsigned char theirs[FINGERPRINT_SPAN];
  return read_at(own, mine, length, offset) && read_at(other, theirs, length, offset) && memcmp(mine, theirs, length) == 0;
}

// Whether the ordinary file at `name`, read through a new descriptor, holds what the copy wrote, read through its own: the same size,
// and the same first and last FINGERPRINT_SPAN bytes.
static int same_content(int to, const char *name, int own) {
  const int other = openat(to, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (other < 0) return 0;
  struct stat mine;
  struct stat theirs;
  int same = fstat(own, &mine) == 0 && fstat(other, &theirs) == 0 && S_ISREG(theirs.st_mode) && mine.st_size == theirs.st_size;
  if (same) {
    const size_t span = mine.st_size < FINGERPRINT_SPAN ? (size_t)mine.st_size : FINGERPRINT_SPAN;
    same = same_range(own, other, 0, span) && same_range(own, other, mine.st_size - (off_t)span, span);
  }
  close(other);
  return same;
}

// Put the file at `hidden` back at `part` without replacing anything: a new file created exclusively at `part` gets its bytes and is
// synced, and only then is `hidden` removed. Returns 1 when the file is back at `part` and no longer at `hidden`.
static int copy_back(int to, const char *hidden, const char *part) {
  const int source = openat(to, hidden, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (source < 0) return 0;
  struct stat info;
  int target = -1;
  if (fstat(source, &info) == 0 && S_ISREG(info.st_mode)) {
    target = openat(to, part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, info.st_mode & 0777);
  }
  int copied = target >= 0;
  static unsigned char chunk[FINGERPRINT_SPAN];
  while (copied) {
    const ssize_t count = read(source, chunk, sizeof chunk);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      copied = count == 0;
      break;
    }
    for (ssize_t done_bytes = 0; copied && done_bytes < count;) {
      const ssize_t written = write(target, chunk + done_bytes, (size_t)(count - done_bytes));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) copied = 0;
      else done_bytes += written;
    }
  }
  if (target >= 0) {
    if (copied && fsync(target) != 0) copied = 0;
    if (close(target) != 0) copied = 0;
  }
  close(source);
  return copied && unlinkat(to, hidden, 0) == 0;
}

// Remove the partial copy `part` from the held folder only while it is the file the copy wrote, never by its name alone: it is moved to a
// fresh hidden name, which nothing else uses, checked there, and only then removed under that name. A file put at `part` meanwhile is put
// back there if the name is still free, or stays under the hidden name. Returns 1 when the copy's file was removed; otherwise 0, with
// `hidden` holding the hidden name a file stays under, or empty when nothing stays under one (the file at `part` could not be moved, or was
// put back).
//
// A volume without an exclusive rename (exFAT, FAT) is checked that the hidden name is free and then renamed to it plainly; the name is
// random, so nothing else is there. There a file is removed only when both its id and its content (read through the copy's own
// descriptor) are the copy's, and a file that is not is put back by copying it to a new file created exclusively at `part`, so it never
// replaces one.
static int remove_own_part(int to, const char *part, const struct written_file *written, char hidden[HIDDEN_NAME_SIZE]) {
  char aside[HIDDEN_NAME_SIZE];
  fresh_hidden_name(aside);
  hidden[0] = '\0';
  int exclusive = 1;
  if (renameatx_np(to, part, to, aside, RENAME_EXCL) != 0) {
    if (errno != ENOTSUP && errno != EINVAL) return 0;
    struct stat there;
    if (fstatat(to, aside, &there, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return 0;
    if (renameat(to, part, to, aside) != 0) return 0;
    exclusive = 0;
  }
  struct stat moved;
  if (fstatat(to, aside, &moved, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) memcpy(hidden, aside, HIDDEN_NAME_SIZE);
    return 0;
  }
  struct stat own;
  if (fstat(written->fd, &own) != 0) {
    memcpy(hidden, aside, HIDDEN_NAME_SIZE);
    return 0;
  }
  const int same_id = moved.st_dev == own.st_dev && moved.st_ino == own.st_ino;
  if (same_id && (exclusive || same_content(to, aside, written->fd))) {
    if (unlinkat(to, aside, 0) == 0) return 1;
    if (errno != ENOENT) memcpy(hidden, aside, HIDDEN_NAME_SIZE);
    return 0;
  }
  const int back = exclusive ? renameatx_np(to, aside, to, part, RENAME_EXCL) == 0 : copy_back(to, aside, part);
  if (!back) memcpy(hidden, aside, HIDDEN_NAME_SIZE);
  return 0;
}

// End a copy that stopped after creating `part` with `answer` and its exit code, saying what became of `part`: nothing more when
// the copy's own file was removed, ` left` when it was not, or ` left <hidden name>` when a file stays under that name. `written` is
// null when the copy's file could not be identified; it is then left.
static int stopped_copy(int to, const char *part, const struct written_file *written, const char *answer, int exit_code) {
  char hidden[HIDDEN_NAME_SIZE] = "";
  if (written != NULL && remove_own_part(to, part, written, hidden)) printf("%s\n", answer);
  else if (hidden[0] == '\0') printf("%s left\n", answer);
  else printf("%s left %s\n", answer, hidden);
  fflush(stdout);
  return exit_code;
}

// Remove the partial copy as stopped_copy() does, and report `failure`, or `cancelled` when there is none.
static int abandon(int to, const char *part, const struct written_file *written, int failure) {
  if (failure == 0) return stopped_copy(to, part, written, "cancelled", EXIT_DONE);
  char answer[32];
  snprintf(answer, sizeof answer, "failed %s", errno_name(failure));
  return stopped_copy(to, part, written, answer, EXIT_FAILED);
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
  // The temporary file is created exclusively, never through a link, in the held folder, and opened for reading too, so a cleanup can
  // compare what it wrote.
  const int copy = openat(to, part, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, info.st_mode & 0777);
  if (copy < 0) return failed(errno);
  // A descriptor on the file this copy writes that outlives the copy's own, so a cleanup removes only that file. The helper ends soon
  // after any cleanup, which closes it.
  struct written_file written;
  written.fd = dup(copy);
  if (written.fd < 0) {
    const int code = errno;
    close(copy);
    return abandon(to, part, NULL, code);
  }
  unsigned char *buffer = malloc(COPY_CHUNK);
  if (buffer == NULL) {
    close(copy);
    return abandon(to, part, &written, ENOMEM);
  }
  int failure = 0;
  unsigned long long copied = 0;
  unsigned long long unsynced = 0;
  for (;;) {
    if (stop_requested()) {
      free(buffer);
      close(copy);
      return abandon(to, part, &written, 0);
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
  if (failure != 0) return abandon(to, part, &written, failure);
  // The rename below is the commit point: the caller answers here whether the copy is still wanted.
  if (!proceed("copied")) return abandon(to, part, &written, 0);
  const int found = replaceable(to, target);
  if (found < 0) return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
  if (found > 0) return abandon(to, part, &written, found);
  if (renameat(to, part, to, target) != 0) return abandon(to, part, &written, errno);
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
