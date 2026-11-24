// File operations that act inside directories this process holds open: the browser download staging folder and the folder the
// user chose. Each mode opens its directories once, checks that each is the plain directory with the identity it was given, and
// then names every file relative to those descriptors (openat, renameat, unlinkat, fstatat), never by a path. A directory moved,
// or replaced by a link, after that check changes nothing: the operation still acts in the directory that was checked.
// README.md has the protocol; native/windows-path-kind implements the same modes with directory handles.
#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
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

struct left_part {
  char name[HIDDEN_NAME_SIZE];
  struct stat own;
  const char *verdict;
  int observed;
  int part_left;
};

#define FINGERPRINT_SIZE 173
#define MAX_RECORD_BYTES 8192

static int open_regular(int directory, const char *name) {
  return openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
}

static int names_entry(int directory, const char *name, int fd, int allow_links) {
  struct stat named, held;
  return fstat(fd, &held) == 0 && (S_ISREG(held.st_mode) || (allow_links && S_ISLNK(held.st_mode))) &&
    fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
    (named.st_mode & S_IFMT) == (held.st_mode & S_IFMT) &&
    named.st_dev == held.st_dev && named.st_ino == held.st_ino &&
    (held.st_birthtimespec.tv_sec != 0 || held.st_birthtimespec.tv_nsec != 0) &&
    named.st_birthtimespec.tv_sec == held.st_birthtimespec.tv_sec &&
    named.st_birthtimespec.tv_nsec == held.st_birthtimespec.tv_nsec;
}

static int names_file(int directory, const char *name, int fd) {
  return names_entry(directory, name, fd, 0);
}

static void hex_encode(const unsigned char *bytes, size_t length, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < length; ++i) {
    out[2 * i] = digits[bytes[i] >> 4];
    out[2 * i + 1] = digits[bytes[i] & 15];
  }
  out[2 * length] = '\0';
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static uint64_t nanos(struct timespec time) {
  return (uint64_t)time.tv_sec * UINT64_C(1000000000) + (uint64_t)time.tv_nsec;
}

static int fingerprint(int fd, struct stat *identity, char out[FINGERPRINT_SIZE]) {
  if (fstat(fd, identity) != 0 || !S_ISREG(identity->st_mode) || identity->st_size < 0) return 0;
  const off_t size = identity->st_size;
  const size_t span = size < FINGERPRINT_SPAN ? (size_t)size : FINGERPRINT_SPAN;
  static unsigned char bytes[FINGERPRINT_SPAN];
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  char head[2 * CC_SHA256_DIGEST_LENGTH + 1], tail[sizeof head];
  if (!read_at(fd, bytes, span, 0)) return 0;
  CC_SHA256(bytes, (CC_LONG)span, hash);
  hex_encode(hash, sizeof hash, head);
  if (!read_at(fd, bytes, span, size - (off_t)span)) return 0;
  CC_SHA256(bytes, (CC_LONG)span, hash);
  hex_encode(hash, sizeof hash, tail);
  struct stat after;
  if (fstat(fd, &after) != 0 || after.st_size != size ||
      nanos(after.st_mtimespec) != nanos(identity->st_mtimespec) ||
      nanos(after.st_ctimespec) != nanos(identity->st_ctimespec)) return 0;
  snprintf(out, FINGERPRINT_SIZE, "%" PRIu64 ":%" PRIu64 ":%s:%s",
    (uint64_t)size, nanos(identity->st_mtimespec), head, tail);
  return 1;
}

static int fingerprint_matches(int fd, const char *expected) {
  struct stat identity;
  char found[FINGERPRINT_SIZE];
  return fingerprint(fd, &identity, found) && strcmp(found, expected) == 0;
}

#if defined(AVE_DIR_OPS_TEST_SWAP_RESTORED) || defined(AVE_DIR_OPS_TEST_FAIL_RESTORED) || defined(AVE_DIR_OPS_TEST_SWAP_COMMIT)
static void swap_file(int directory, const char *part) {
  if (renameat(directory, part, directory, "probe-written") != 0) return;
  const int replacement = openat(directory, part, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (replacement < 0) return;
  static const unsigned char text[] = "replacement";
  (void)write_all(replacement, text, sizeof text - 1);
  close(replacement);
}
#endif

// An incomplete or replaced restoration is left at part. The source is still held and is never retired on that result.
enum restore_result { RESTORE_BLOCKED, RESTORE_PART_LEFT, RESTORE_VERIFIED };

static enum restore_result copy_held_source(int directory, int source, const char *part, const char *expected) {
  struct stat info;
  if (fstat(source, &info) != 0 || !S_ISREG(info.st_mode)) return RESTORE_BLOCKED;
  const int target = openat(directory, part, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, info.st_mode & 0777);
  if (target < 0) return RESTORE_BLOCKED;
  int copied = 1;
  static unsigned char bytes[FINGERPRINT_SPAN];
  for (;;) {
    const ssize_t count = read(source, bytes, sizeof bytes);
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) break;
#if defined(AVE_DIR_OPS_TEST_FAIL_RESTORED)
    if (count > 0) (void)write_all(target, bytes, 1);
    copied = 0;
    break;
#endif
    if (count < 0 || write_all(target, bytes, (size_t)count) != 0) {
      copied = 0;
      break;
    }
  }
  copied = copied && fsync(target) == 0;
#if defined(AVE_DIR_OPS_TEST_SWAP_RESTORED)
  if (copied) swap_file(directory, part);
#endif
#if defined(AVE_DIR_OPS_TEST_FAIL_RESTORED)
  swap_file(directory, part);
#endif
  const int verified = copied && fingerprint_matches(source, expected) && names_file(directory, part, target);
  return close(target) == 0 && verified ? RESTORE_VERIFIED : RESTORE_PART_LEFT;
}

static void report_left(const char *answer, int directory, const struct left_part *left, int part_left) {
  if (*answer != '\0') printf("%s ", answer);
  fputs("left", stdout);
  if (*left->name != '\0') {
    printf(" %s %" PRIu64 " %" PRIu64 " %s ", left->name, (uint64_t)left->own.st_dev,
      (uint64_t)left->own.st_ino, left->verdict);
    const int fd = left->observed;
    struct stat identity;
    char content[FINGERPRINT_SIZE];
    if (fd >= 0 && fingerprint(fd, &identity, content) && names_file(directory, left->name, fd)) {
      printf("%" PRIu64 ":%" PRIu64 ":%" PRIu64 ":%s", (uint64_t)identity.st_dev, (uint64_t)identity.st_ino,
        nanos(identity.st_birthtimespec), content);
    } else {
      fputc('-', stdout);
    }
    if (part_left) fputs(" part-left", stdout);
  }
  fputc('\n', stdout);
  fflush(stdout);
}

// Retire only an exclusively isolated entry verified against the descriptor. Undo a mismatched move exclusively or report its new name.
enum remove_result { REMOVE_LEFT, REMOVE_ABSENT, REMOVE_DONE };

static enum remove_result retire_held(int directory, const char *name, int fd, struct left_part *left, const char *expected, int allow_links) {
  char aside[HIDDEN_NAME_SIZE];
  if (fstat(fd, &left->own) != 0) return REMOVE_LEFT;
  fresh_hidden_name(aside);
  if (renameatx_np(directory, name, directory, aside, RENAME_EXCL) != 0) {
    return errno == ENOENT ? REMOVE_ABSENT : REMOVE_LEFT;
  }
  const int verified = (expected == NULL || fingerprint_matches(fd, expected)) && names_entry(directory, aside, fd, allow_links);
  if (verified) {
    if (unlinkat(directory, aside, 0) == 0) return REMOVE_DONE;
    if (errno == ENOENT) return REMOVE_ABSENT;
  } else if (renameatx_np(directory, aside, directory, name, RENAME_EXCL) == 0) {
    return REMOVE_LEFT;
  }
  memcpy(left->name, aside, HIDDEN_NAME_SIZE);
  left->verdict = verified ? "remove-failed" : "mismatch";
  left->observed = verified ? fd : expected == NULL ? open_regular(directory, aside) : -1;
  return REMOVE_LEFT;
}

static int matches_file(int fd, uint64_t dev, uint64_t ino, uint64_t birth) {
  struct stat info;
  return fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
    (uint64_t)info.st_dev == dev && (uint64_t)info.st_ino == ino &&
    birth != 0 && nanos(info.st_birthtimespec) == birth;
}

static int hidden_name(const char *name) {
  return strlen(name) == HIDDEN_NAME_SIZE - 1 && name[0] == '.' &&
    strspn(name + 1, "0123456789abcdef") == 32 && strcmp(name + 33, ".removing") == 0;
}

enum recovery_mode { RECOVER_REMOVE, RECOVER_RESTORE_PART, RECOVER_RESTORE_TARGET };

static int entry_absent(int directory, const char *name) {
  struct stat entry;
  return fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}

static int recover_target(int directory, const char *hidden, const char *target, uint64_t dev, uint64_t ino,
    uint64_t birth, const char *expected, const char *replacement, uint64_t writer, uint64_t writer_birth) {
  const int retire_only = replacement != NULL && strcmp(replacement, "retire") == 0;
  const int flags = (expected == NULL ? O_EVTONLY : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
  int published = -1;
  int vacant = 0;
  int committed = retire_only;
  if (!retire_only) {
    published = openat(directory, target, flags);
    vacant = published < 0 && errno == ENOENT;
    if (published < 0 && !vacant) return done("left");
    committed = published >= 0 && replacement != NULL && matches_file(published, dev, writer, writer_birth) &&
      names_file(directory, target, published);
  }
  const int fd = openat(directory, hidden, flags);
  if (fd < 0) {
    if (errno != ENOENT) return done("left");
    const int restored = published >= 0 && matches_file(published, dev, ino, birth) &&
      (expected == NULL || fingerprint_matches(published, expected)) && names_file(directory, target, published);
    return done(committed || restored ? "resolved" : "left");
  }
  if (!matches_file(fd, dev, ino, birth) || (expected != NULL && !fingerprint_matches(fd, expected)) ||
      !names_file(directory, hidden, fd)) return done("left");
  if (committed) {
    return done(unlinkat(directory, hidden, 0) == 0 && entry_absent(directory, hidden) ? "resolved" : "left");
  }
  if (!vacant || renameatx_np(directory, hidden, directory, target, RENAME_EXCL) != 0) return done("left");
  if (names_file(directory, target, fd)) return done("resolved");
  (void)renameatx_np(directory, target, directory, hidden, RENAME_EXCL);
  return done("left");
}

static int run_recovery(char **argv, enum recovery_mode mode, int with_fingerprint, const char *replacement) {
  const int restore = mode != RECOVER_REMOVE;
  const char *name = argv[3];
  const char *part = restore ? argv[4] : NULL;
  const int file_arg = restore ? 5 : 4;
  const char *expected = NULL;
  uint64_t dev, ino, birth = 0;
  if (!plain_name(name) || (restore && (!plain_name(part) || strcmp(name, part) == 0)) ||
      !parse_u64(argv[file_arg], &dev) || !parse_u64(argv[file_arg + 1], &ino)) return EXIT_USAGE;
  if (mode == RECOVER_RESTORE_TARGET && !hidden_name(name)) return EXIT_USAGE;
  uint64_t writer = 0, writer_birth = 0;
  if (replacement != NULL && strcmp(replacement, "retire") != 0) {
    const char *separator = strchr(replacement, ':');
    char number[21];
    if (separator == NULL || (size_t)(separator - replacement) >= sizeof number) return EXIT_USAGE;
    memcpy(number, replacement, (size_t)(separator - replacement));
    number[separator - replacement] = '\0';
    if (!parse_u64(number, &writer) || writer == ino || !parse_u64(separator + 1, &writer_birth) || writer_birth == 0)
      return EXIT_USAGE;
  }
  if (with_fingerprint) {
    const char *token = argv[file_arg + 2];
    const char *colon = strchr(token, ':');
    char time[21];
    if (colon == NULL || (size_t)(colon - token) >= sizeof time) return EXIT_USAGE;
    memcpy(time, token, (size_t)(colon - token));
    time[colon - token] = '\0';
    if (!parse_u64(time, &birth) || birth == 0) return EXIT_USAGE;
    if (strcmp(colon + 1, "-") != 0) expected = colon + 1;
  }
  if (mode == RECOVER_RESTORE_PART && expected == NULL) return EXIT_USAGE;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (mode == RECOVER_RESTORE_TARGET) return recover_target(directory, name, part, dev, ino, birth, expected, replacement, writer, writer_birth);
  const int fd = open_regular(directory, name);
  if (fd < 0) {
    return done(errno == ENOENT ? "absent" : "left");
  }
  if (!matches_file(fd, dev, ino, birth) || (expected != NULL && !fingerprint_matches(fd, expected))) return done("left");
  struct left_part left = { .observed = -1 };
  if (restore) {
    const enum restore_result restored = copy_held_source(directory, fd, part, expected);
    if (restored == RESTORE_BLOCKED) return done("left");
    if (restored == RESTORE_PART_LEFT) {
      if (fstat(fd, &left.own) != 0) return done("left");
      strcpy(left.name, name);
      left.verdict = "mismatch";
      left.observed = fd;
      report_left("", directory, &left, 1);
      return EXIT_DONE;
    }
  }
  const enum remove_result removed = retire_held(directory, name, fd, &left, expected, 0);
  if (removed != REMOVE_LEFT) return done(restore ? "restored" : removed == REMOVE_DONE ? "removed" : "absent");
  report_left("", directory, &left, 0);
  return EXIT_DONE;
}

static int record_name(const char *name) {
  if (strlen(name) != 45 || strcmp(name + 32, ".cleanup.json") != 0) return 0;
  for (size_t i = 0; i < 32; ++i) if (hex_digit(name[i]) < 0) return 0;
  return 1;
}

static int run_records(char **argv) {
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  DIR *entries = fdopendir(directory);
  if (entries == NULL) return failed(errno);
  // Keep a bounded single terminal line. A failed enumeration must never authorize a sweep.
  static char outcome[1024 * 1024] = "records";
  size_t used = strlen(outcome);
  for (;;) {
    errno = 0;
    const struct dirent *entry = readdir(entries);
    if (entry == NULL) return errno == 0 ? done(outcome) : failed(errno);
    if (!record_name(entry->d_name)) continue;
    if (used + 47 > sizeof outcome) return failed(EFBIG);
    outcome[used++] = ' ';
    memcpy(outcome + used, entry->d_name, 46);
    used += 45;
  }
}

static int run_record(char **argv, int writing) {
  const char *name = argv[3];
  if (!record_name(name)) return EXIT_USAGE;
  uint64_t max = 0;
  static unsigned char bytes[MAX_RECORD_BYTES + 1];
  if (writing) {
    const size_t size = strlen(argv[4]);
    if (size > 2 * MAX_RECORD_BYTES || size % 2 != 0) return EXIT_USAGE;
    max = size / 2;
    for (size_t i = 0; i < max; ++i) {
      const int hi = hex_digit(argv[4][2 * i]), lo = hex_digit(argv[4][2 * i + 1]);
      if (hi < 0 || lo < 0) return EXIT_USAGE;
      bytes[i] = (unsigned char)(16 * hi + lo);
    }
  } else if (!parse_u64(argv[4], &max) || max == 0 || max > MAX_RECORD_BYTES) {
    return EXIT_USAGE;
  }
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (writing) {
    const int fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return failed(errno);
    const int result = write_all(fd, bytes, (size_t)max);
    if (result != 0) return failed(result);
    if (fsync(fd) != 0 || fsync(directory) != 0) return failed(errno);
    return done("written");
  }
  const int fd = open_regular(directory, name);
  if (fd < 0) return errno == ENOENT || errno == ELOOP ? done("absent") : failed(errno);
  struct stat info;
  if (fstat(fd, &info) != 0) return failed(errno);
  if (!S_ISREG(info.st_mode)) return done("absent");
  if ((uint64_t)info.st_size > max) return failed(EFBIG);
  size_t used = 0;
  while (used <= max) {
    const ssize_t count = read(fd, bytes + used, (size_t)max + 1 - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return failed(errno);
    if (count == 0) break;
    used += (size_t)count;
  }
  if (used > max) return failed(EFBIG);
  static char encoded[2 * MAX_RECORD_BYTES + sizeof "record "];
  memcpy(encoded, "record ", sizeof "record " - 1);
  hex_encode(bytes, used, encoded + sizeof "record " - 1);
  return done(encoded);
}

// Isolate the part before checking ownership. A volume without exclusive rename never authorizes unlink.
static int remove_own_part(int to, const char *part, const struct written_file *written, struct left_part *left) {
  char aside[HIDDEN_NAME_SIZE];
  fresh_hidden_name(aside);
  struct stat part_info;
  if (fstatat(to, part, &part_info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT;
  if (!S_ISREG(part_info.st_mode) || fstat(written->fd, &left->own) != 0) return 0;

  int exclusive = 1;
  if (renameatx_np(to, part, to, aside, RENAME_EXCL) != 0) {
    if (errno == ENOENT) return 1;
    if (errno != ENOTSUP && errno != EINVAL) return 0;
    struct stat there;
    if (fstatat(to, aside, &there, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return 0;
#if defined(AVE_DIR_OPS_TEST_SWAP_BEFORE_PLAIN_RENAME)
    if (renameat(to, part, to, "probe-written") == 0) (void)mkdirat(to, part, 0700);
#endif
    if (renameat(to, part, to, aside) != 0) return errno == ENOENT;
    exclusive = 0;
  }

  memcpy(left->name, aside, HIDDEN_NAME_SIZE);
  left->verdict = "mismatch";
  left->observed = open_regular(to, aside);
  struct stat moved;
  if (fstatat(to, aside, &moved, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT;
  struct stat own;
  if (fstat(written->fd, &own) != 0) return 0;
  left->own = own;
#if defined(AVE_DIR_OPS_TEST_REUSED_FILE_ID)
  if (!exclusive) {
    moved.st_dev = own.st_dev;
    moved.st_ino = own.st_ino;
  }
#endif
  const int same_id = S_ISREG(moved.st_mode) && moved.st_dev == own.st_dev && moved.st_ino == own.st_ino;
  if (exclusive) {
    if (same_id && names_file(to, aside, written->fd)) {
      left->observed = written->fd;
      if (unlinkat(to, aside, 0) == 0 || errno == ENOENT) return 1;
      left->verdict = "remove-failed";
    } else if (renameatx_np(to, aside, to, part, RENAME_EXCL) == 0) {
      left->name[0] = '\0';
    }
    return 0;
  }

  if (same_id && same_content(to, aside, written->fd)) {
    left->verdict = "remove-failed";
    return 0;
  }
  if (S_ISDIR(moved.st_mode)) {
    if (renameatx_np(to, aside, to, part, RENAME_EXCL) == 0) left->name[0] = '\0';
    return 0;
  }
  // The exclusive create in copy_held_source is the absence check. A directory or occupied part stays untouched.
  struct stat source;
  char expected[FINGERPRINT_SIZE];
  if (left->observed >= 0 && fingerprint(left->observed, &source, expected) && names_file(to, aside, left->observed)) {
    left->part_left = copy_held_source(to, left->observed, part, expected) == RESTORE_PART_LEFT;
  }
  return 0;
}

static int stopped_copy(int to, const char *part, const struct written_file *written, const char *answer, int exit_code) {
  struct left_part left = { .observed = -1 };
  if (written != NULL && remove_own_part(to, part, written, &left)) {
    say(exit_code == EXIT_REFUSED ? "refused target removed" : answer);
  } else {
    report_left(answer, to, &left, left.part_left);
  }
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

static int replace_copy_name(int directory, const char *from, const char *to, int restoring) {
#if defined(AVE_DIR_OPS_TEST_COPY_COMMIT_FAILURE) || defined(AVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE)
#if !defined(AVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE)
  if (!restoring)
#endif
  {
    errno = EIO;
    return -1;
  }
#endif
  (void)restoring;
  return renameatx_np(directory, from, directory, to, RENAME_EXCL);
}

static void finish_copy_target(int directory, const char *target, const char *aside, int old,
    const struct stat *identity, int committed) {
  if (*aside == '\0') return;
  if (names_file(directory, aside, old)) {
    if (committed ? unlinkat(directory, aside, 0) == 0 && entry_absent(directory, aside)
        : replace_copy_name(directory, aside, target, 1) == 0 && names_file(directory, target, old)) {
      puts(committed ? "target-retired" : "target-restored");
      fflush(stdout);
      return;
    }
  }
  struct left_part left = {
    .own = *identity, .observed = old, .verdict = committed ? "remove-failed" : "mismatch",
  };
  memcpy(left.name, aside, HIDDEN_NAME_SIZE);
  report_left("target-left", directory, &left, 0);
}

static int run_copy(char **argv) {
  const char *name = argv[3];
  const char *target = argv[7];
  const char *part = argv[8];
  const char *hidden = argv[9];
  if (!plain_name(name) || !plain_name(target) || !plain_name(part) || !hidden_name(hidden) ||
      strcmp(part, target) == 0 || strcmp(hidden, target) == 0 || strcmp(hidden, part) == 0) return EXIT_USAGE;
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
  int old = open_regular(to, target);
  if (old < 0 && (errno == EACCES || errno == EPERM)) {
    old = openat(to, target, O_EVTONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  }
  struct stat old_identity;
  struct stat directory_identity;
  if (fstat(to, &directory_identity) != 0) return refused("to");
  if (old < 0 && errno != ENOENT) return errno == ELOOP ? refused("target") : failed(errno);
  if (old >= 0) {
    if (fstat(old, &old_identity) != 0 || !S_ISREG(old_identity.st_mode) ||
        old_identity.st_dev != directory_identity.st_dev) return refused("target");
    printf("target-id %" PRIu64 " %" PRIu64 " %" PRIu64 "\n", (uint64_t)old_identity.st_dev,
      (uint64_t)old_identity.st_ino, nanos(old_identity.st_birthtimespec));
    fflush(stdout);
  }
  if (!proceed("ready")) return done("cancelled");
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
  struct stat identity;
  if (fstat(written.fd, &identity) != 0) {
    const int code = errno;
    close(copy);
    return abandon(to, part, NULL, code);
  }
  if (nanos(identity.st_birthtimespec) == 0 || identity.st_dev != directory_identity.st_dev ||
      (old >= 0 && old_identity.st_ino == identity.st_ino)) {
    close(copy);
    return abandon(to, part, NULL, ENOTSUP);
  }
  printf("writing %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
    (uint64_t)identity.st_dev, (uint64_t)identity.st_ino, nanos(identity.st_birthtimespec));
  fflush(stdout);
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
  struct stat final;
  if (failure == 0 && fstat(copy, &final) != 0) failure = errno;
  if (close(copy) != 0 && failure == 0) failure = errno;
  if (failure != 0) return abandon(to, part, &written, failure);
  if (nanos(final.st_birthtimespec) == 0 || final.st_dev != identity.st_dev ||
      (old >= 0 && final.st_ino == old_identity.st_ino)) return abandon(to, part, &written, EIO);
  if (old >= 0) {
    printf("copy-id %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
      (uint64_t)final.st_dev, (uint64_t)final.st_ino, nanos(final.st_birthtimespec));
    fflush(stdout);
  }
  // The rename below is the commit point: the caller answers here whether the copy is still wanted.
  if (!proceed("copied")) return abandon(to, part, &written, 0);
  if (!names_file(to, part, written.fd)) {
    struct stat entry;
    if (fstatat(to, part, &entry, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT) return refused("target removed");
    return refused("target left");
  }
  char aside[HIDDEN_NAME_SIZE] = "";
  if (old >= 0) {
    memcpy(aside, hidden, HIDDEN_NAME_SIZE);
    if (!names_file(to, target, old) || renameatx_np(to, target, to, aside, RENAME_EXCL) != 0) {
      return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    }
    if (!names_file(to, aside, old)) {
      finish_copy_target(to, target, aside, old, &old_identity, 0);
      return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    }
  }
#if defined(AVE_DIR_OPS_TEST_SWAP_COMMIT)
  swap_file(to, part);
#endif
#if defined(AVE_DIR_OPS_TEST_COPY_OCCUPIED)
  if (old >= 0) {
    const int occupied = openat(to, target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (occupied >= 0) {
      static const unsigned char contents[] = "competing bytes";
      (void)write_all(occupied, contents, sizeof contents - 1);
      close(occupied);
    }
  }
#endif
  if ((old >= 0 ? replace_copy_name(to, part, target, 0) : renameatx_np(to, part, to, target, RENAME_EXCL)) != 0) {
    const int code = errno;
    finish_copy_target(to, target, aside, old, &old_identity, 0);
    if (code == EEXIST || code == ENOTSUP || code == EINVAL) return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    return abandon(to, part, &written, code);
  }
  if (!names_file(to, target, written.fd)) {
    // Preserve the entry even if the part name is occupied again.
    const int moved_back = renameatx_np(to, target, to, part, RENAME_EXCL);
    finish_copy_target(to, target, aside, old, &old_identity, 0);
    return refused(moved_back == 0 ? "target left" : "target changed");
  }
  finish_copy_target(to, target, aside, old, &old_identity, 1);
  return done("committed");
}

static enum remove_result remove_staged_entry(int directory, const char *name) {
  const int fd = openat(directory, name, O_RDONLY | O_SYMLINK | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? REMOVE_ABSENT : REMOVE_LEFT;
  struct stat info;
  enum remove_result result = REMOVE_LEFT;
  if (fstat(fd, &info) == 0 && (S_ISREG(info.st_mode) || S_ISLNK(info.st_mode))) {
    struct left_part left = { .observed = -1 };
    result = retire_held(directory, name, fd, &left, NULL, 1);
    if (left.observed >= 0 && left.observed != fd) close(left.observed);
  }
  close(fd);
  return result;
}

static int run_remove(char **argv) {
  const char *name = argv[3];
  if (!plain_name(name)) return EXIT_USAGE;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  const enum remove_result result = remove_staged_entry(directory, name);
  return result == REMOVE_LEFT ? failed(EIO) : done(result == REMOVE_DONE ? "removed" : "absent");
}

// Remove the files and links directly in the held folder; directories and anything else stay, and nothing is removed recursively.
static int run_sweep(char **argv, int keep_records) {
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
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0 ||
        (keep_records && record_name(entry->d_name))) continue;
    struct stat info;
    if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      return failed(errno);
    }
    if (!S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode)) continue;
    const enum remove_result result = remove_staged_entry(directory, entry->d_name);
    if (result == REMOVE_LEFT) return failed(EIO);
    if (result == REMOVE_DONE) removed += 1;
  }
  printf("swept %lu\n", removed);
  fflush(stdout);
  return EXIT_DONE;
}

int main(int argc, char **argv) {
  // An answer written after the caller stopped listening must not end the process before it cleans up.
  signal(SIGPIPE, SIG_IGN);
  if (argc == 10 && strcmp(argv[1], "--dir-rename") == 0) return run_rename(argv + 2);
  if (argc == 12 && strcmp(argv[1], "--dir-copy") == 0) return run_copy(argv + 2);
  if (argc == 6 && strcmp(argv[1], "--dir-remove") == 0) return run_remove(argv + 2);
  if ((argc == 5 || (argc == 6 && strcmp(argv[5], "keep-records") == 0)) && strcmp(argv[1], "--dir-sweep") == 0)
    return run_sweep(argv + 2, argc == 6);
  if (argc == 5 && strcmp(argv[1], "--dir-list-records") == 0) return run_records(argv + 2);
  if (argc == 7 && strcmp(argv[1], "--dir-read") == 0) return run_record(argv + 2, 0);
  if (argc == 7 && strcmp(argv[1], "--dir-write-record") == 0) return run_record(argv + 2, 1);
  if ((argc == 8 || argc == 9) && strcmp(argv[1], "--dir-remove-id") == 0) return run_recovery(argv + 2, RECOVER_REMOVE, argc == 9, NULL);
  if (argc == 10 && strcmp(argv[1], "--dir-restore") == 0) return run_recovery(argv + 2, RECOVER_RESTORE_PART, 1, NULL);
  if ((argc == 10 || argc == 11) && strcmp(argv[1], "--dir-restore-target") == 0)
    return run_recovery(argv + 2, RECOVER_RESTORE_TARGET, 1, argc == 11 ? argv[10] : NULL);
  fputs("usage: ave-dir-ops --dir-rename|--dir-copy|--dir-remove|--dir-sweep <arguments>\n", stderr);
  return EXIT_USAGE;
}
