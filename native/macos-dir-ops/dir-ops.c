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
#include <sys/attr.h>
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

// A file named by an evidence token, `<dev>:<ino>:<class>:<value>`. This helper backs only `birth` (the birth time in nanoseconds,
// which a rename keeps on macOS); any other class is unresolved (`birth` stays 0) and matches nothing.
struct expected_file {
  uint64_t dev;
  uint64_t ino;
  uint64_t birth;
};

// A token: decimal device and inode, a lowercase class and a value without blanks. `birth` needs a nonzero decimal value. Returns 0
// for a malformed token, which is a usage error.
static int parse_token(const char *text, struct expected_file *expected) {
  char number[21];
  const char *cursor = text;
  uint64_t *fields[] = { &expected->dev, &expected->ino };
  for (size_t index = 0; index < 2; ++index) {
    const char *colon = strchr(cursor, ':');
    if (colon == NULL || (size_t)(colon - cursor) >= sizeof number) return 0;
    memcpy(number, cursor, (size_t)(colon - cursor));
    number[colon - cursor] = '\0';
    if (!parse_u64(number, fields[index])) return 0;
    cursor = colon + 1;
  }
  const char *colon = strchr(cursor, ':');
  if (colon == NULL || colon == cursor || strspn(cursor, "abcdefghijklmnopqrstuvwxyz") != (size_t)(colon - cursor)) return 0;
  const char *value = colon + 1;
  if (*value == '\0' || strpbrk(value, " \t\r\n") != NULL) return 0;
  expected->birth = 0;
  if ((size_t)(colon - cursor) != strlen("birth") || strncmp(cursor, "birth", strlen("birth")) != 0) return 1;
  return parse_u64(value, &expected->birth) && expected->birth != 0;
}

// The size of a token this helper writes: two 20-digit numbers, `:birth:` and a third, the separators and the end.
#define TOKEN_SIZE 72

static uint64_t nanos(struct timespec time);

// The token for a file's stat: its device, inode and birth time. A file without a birth time has no evidence this helper can name,
// so its token is `none:-`, which the host refuses.
static void token_text(const struct stat *info, char out[TOKEN_SIZE]) {
  const uint64_t birth = nanos(info->st_birthtimespec);
  if (birth == 0) snprintf(out, TOKEN_SIZE, "%" PRIu64 ":%" PRIu64 ":none:-", (uint64_t)info->st_dev, (uint64_t)info->st_ino);
  else snprintf(out, TOKEN_SIZE, "%" PRIu64 ":%" PRIu64 ":birth:%" PRIu64, (uint64_t)info->st_dev, (uint64_t)info->st_ino, birth);
}

// Say `<frame> <token>` for a file's stat.
static void say_token(const char *frame, const struct stat *info) {
  char token[TOKEN_SIZE];
  token_text(info, token);
  printf("%s %s\n", frame, token);
  fflush(stdout);
}

// Named options after the positional operands: each one this mode allows at most once, a valued one with its value, nothing else.
enum {
  OPTION_EXPECT = 1 << 0, OPTION_CONTENT = 1 << 1, OPTION_WRITER = 1 << 2, OPTION_RENAMED_WRITER = 1 << 3, OPTION_RETIRE = 1 << 4,
  OPTION_LENGTH = 1 << 5, OPTION_DIGEST = 1 << 6, OPTION_KEEP_RECORDS = 1 << 7,
};

struct options {
  unsigned seen;
  const char *values[8];
};

static const struct { const char *name; unsigned bit; int valued; } OPTION_NAMES[] = {
  { "--expect", OPTION_EXPECT, 1 }, { "--content", OPTION_CONTENT, 1 }, { "--writer", OPTION_WRITER, 1 },
  { "--renamed-writer", OPTION_RENAMED_WRITER, 1 }, { "--retire", OPTION_RETIRE, 0 }, { "--length", OPTION_LENGTH, 1 },
  { "--digest", OPTION_DIGEST, 1 }, { "--keep-records", OPTION_KEEP_RECORDS, 0 },
};

static int parse_options(int argc, char **argv, int first, unsigned allowed, struct options *options) {
  memset(options, 0, sizeof *options);
  if (argc < first) return 0;
  for (int index = first; index < argc; ++index) {
    size_t known = sizeof OPTION_NAMES / sizeof OPTION_NAMES[0];
    for (size_t candidate = 0; candidate < sizeof OPTION_NAMES / sizeof OPTION_NAMES[0]; ++candidate) {
      if (strcmp(argv[index], OPTION_NAMES[candidate].name) == 0) known = candidate;
    }
    if (known == sizeof OPTION_NAMES / sizeof OPTION_NAMES[0]) return 0;
    const unsigned bit = OPTION_NAMES[known].bit;
    if ((allowed & bit) == 0 || (options->seen & bit) != 0) return 0;
    options->seen |= bit;
    if (OPTION_NAMES[known].valued) {
      if (index + 1 >= argc) return 0;
      options->values[known] = argv[++index];
    }
  }
  return 1;
}

static const char *option(const struct options *options, unsigned bit) {
  for (size_t index = 0; index < sizeof OPTION_NAMES / sizeof OPTION_NAMES[0]; ++index) {
    if (OPTION_NAMES[index].bit == bit) return options->values[index];
  }
  return NULL;
}

// A fingerprint operand: `<size>:<mtime-ns>:<head>:<tail>`, both digests 64 lowercase hex digits.
static int fingerprint_text(const char *text) {
  char number[21];
  const char *cursor = text;
  for (size_t index = 0; index < 2; ++index) {
    const char *colon = strchr(cursor, ':');
    uint64_t value = 0;
    if (colon == NULL || (size_t)(colon - cursor) >= sizeof number) return 0;
    memcpy(number, cursor, (size_t)(colon - cursor));
    number[colon - cursor] = '\0';
    if (!parse_u64(number, &value)) return 0;
    cursor = colon + 1;
  }
  return strlen(cursor) == 129 && cursor[64] == ':' && strspn(cursor, "0123456789abcdef") == 64 &&
    strspn(cursor + 65, "0123456789abcdef") == 64;
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
static void swap_file(int directory, const char *part, const char *saved, const char *text) {
  if (renameat(directory, part, directory, saved) != 0) return;
  const int replacement = openat(directory, part, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (replacement < 0) return;
  (void)write_all(replacement, (const unsigned char *)text, strlen(text));
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
  if (copied) swap_file(directory, part, "probe-written", "replacement");
#endif
#if defined(AVE_DIR_OPS_TEST_FAIL_RESTORED)
  swap_file(directory, part, "probe-written", "replacement");
#endif
  const int verified = copied && fingerprint_matches(source, expected) && names_file(directory, part, target);
  return close(target) == 0 && verified ? RESTORE_VERIFIED : RESTORE_PART_LEFT;
}

static void report_left(const char *answer, int directory, const struct left_part *left, int part_left) {
  if (*answer != '\0') printf("%s ", answer);
  fputs("left", stdout);
  if (*left->name != '\0') {
    char own[TOKEN_SIZE];
    token_text(&left->own, own);
    printf(" %s %s %s ", left->name, own, left->verdict);
    const int fd = left->observed;
    struct stat identity;
    char content[FINGERPRINT_SIZE];
    if (fd >= 0 && fingerprint(fd, &identity, content) && names_file(directory, left->name, fd)) {
      char token[TOKEN_SIZE];
      token_text(&identity, token);
      printf("%s/%s", token, content);
    } else {
      fputc('-', stdout);
    }
    if (part_left) fputs(" part-left", stdout);
  }
  fputc('\n', stdout);
  fflush(stdout);
}

enum remove_result { REMOVE_LEFT, REMOVE_ABSENT, REMOVE_DONE };
enum entry_mode { ENTRY_REMOVE, ENTRY_RETIRE_HIDDEN, ENTRY_RENAME_AWAY, ENTRY_RESTORE, ENTRY_RECORD_WRITE,
  ENTRY_RECORD_REMOVE, ENTRY_RECORD_SWEEP };

struct entry_change {
  enum entry_mode mode;
  int directory;
  const char *name;
  const struct stat *stamp;
  const char *fingerprint;
  const unsigned char *body;
  size_t length;
  int allow_links;
  struct stat *written;
};

static int entry_absent(int directory, const char *name);

static int same_stamp(const struct stat *first, const struct stat *second) {
  return (first->st_mode & S_IFMT) == (second->st_mode & S_IFMT) && first->st_dev == second->st_dev &&
    first->st_ino == second->st_ino && nanos(first->st_birthtimespec) != 0 &&
    nanos(first->st_birthtimespec) == nanos(second->st_birthtimespec);
}

static enum remove_result mutate_entry(int directory, const char *name, int fd,
    const struct entry_change *change, struct left_part *left) {
  if (change->mode == ENTRY_RECORD_WRITE) {
    const int record = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (record < 0) return REMOVE_LEFT;
    int error = write_all(record, change->body, change->length);
    if (error == 0 && fsync(record) != 0) error = errno;
    struct stat stamp, named;
    unsigned char observed[MAX_RECORD_BYTES];
    if (error == 0 && (fstat(record, &stamp) != 0 || stamp.st_size != (off_t)change->length ||
        !read_at(record, observed, change->length, 0) || memcmp(observed, change->body, change->length) != 0)) error = EIO;
    if (close(record) != 0 && error == 0) error = errno;
    if (error == 0 && fsync(directory) != 0) error = errno;
    if (error == 0 && (fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_stamp(&stamp, &named))) error = EIO;
    if (error == 0 && change->written != NULL) *change->written = stamp;
    return error == 0 ? REMOVE_DONE : (errno = error, REMOVE_LEFT);
  }

  const int owns_fd = change->mode == ENTRY_RECORD_REMOVE || change->mode == ENTRY_RECORD_SWEEP;
  struct stat held, named;
  if (fstat(fd, &held) != 0) {
    if (owns_fd) close(fd);
    return REMOVE_LEFT;
  }
  if (left != NULL) left->own = held;
  if (fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    const int absent = errno == ENOENT;
    if (owns_fd) close(fd);
    return absent ? REMOVE_ABSENT : REMOVE_LEFT;
  }
  if ((!S_ISREG(held.st_mode) && !(change->allow_links && S_ISLNK(held.st_mode))) || !same_stamp(&held, &named) ||
      (change->stamp != NULL && !same_stamp(&held, change->stamp)) ||
      (change->fingerprint != NULL && !fingerprint_matches(fd, change->fingerprint))) {
    if (owns_fd) close(fd);
    errno = ESTALE;
    return REMOVE_LEFT;
  }

  const int renaming = change->mode == ENTRY_RENAME_AWAY || change->mode == ENTRY_RESTORE;
  const int isolated = change->mode == ENTRY_RETIRE_HIDDEN;
  char aside[HIDDEN_NAME_SIZE];
  if (!renaming && !isolated) fresh_hidden_name(aside);
  const char *target = renaming ? change->name : isolated ? name : aside;
  const int to = renaming ? change->directory : directory;
  const int held_operation = owns_fd ? fd : dup(fd);
  if (held_operation < 0) return REMOVE_LEFT;
#if defined(AVE_DIR_OPS_TEST_SWAP_COMMIT)
  const size_t length = strlen(name);
  const int swap_commit = change->mode == ENTRY_RENAME_AWAY && length > 5 && strcmp(name + length - 5, ".part") == 0;
  if (swap_commit) swap_file(directory, name, "probe-written", "replacement");
#endif
  if (!isolated && renameatx_np(directory, name, to, target, RENAME_EXCL) != 0) {
    const int error = errno;
    close(held_operation);
    errno = error;
    return error == ENOENT ? REMOVE_ABSENT : REMOVE_LEFT;
  }
  struct stat moved;
  const int observed = fstatat(to, target, &moved, AT_SYMLINK_NOFOLLOW) == 0;
  const int verified = observed && same_stamp(&held, &moved) &&
    (change->fingerprint == NULL || fingerprint_matches(held_operation, change->fingerprint));
  if (!verified && observed && !isolated) {
    const int rollback = openat(to, target, O_EVTONLY | O_SYMLINK | O_NOFOLLOW | O_CLOEXEC);
    if (rollback >= 0) {
      struct stat pinned, current;
      const int pinned_matches = fstat(rollback, &pinned) == 0 && same_stamp(&moved, &pinned);
#if defined(AVE_DIR_OPS_TEST_SWAP_ROLLBACK)
      if (pinned_matches && swap_commit) swap_file(to, target, "probe-displaced", "another replacement");
#endif
      const int restored = pinned_matches &&
        fstatat(to, target, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&pinned, &current) &&
        renameatx_np(to, target, directory, name, RENAME_EXCL) == 0 &&
        fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&pinned, &current);
      close(rollback);
      if (restored) {
        close(held_operation);
        errno = ESTALE;
        return REMOVE_LEFT;
      }
    }
  }
  if (verified && !renaming) (void)unlinkat(to, target, 0);
  if (close(held_operation) == 0 && verified) {
    if (!renaming && entry_absent(to, target) && (isolated || entry_absent(directory, name))) return REMOVE_DONE;
    if (renaming && fstatat(to, target, &named, AT_SYMLINK_NOFOLLOW) == 0 && same_stamp(&held, &named)) return REMOVE_DONE;
  }
  if (left != NULL && !renaming && !isolated) {
    memcpy(left->name, aside, sizeof aside);
    left->verdict = verified ? "remove-failed" : "mismatch";
    left->observed = verified ? fd : change->fingerprint == NULL ? open_regular(directory, aside) : -1;
  }
  errno = verified ? EIO : ESTALE;
  return REMOVE_LEFT;
}

static enum remove_result retire_held(int directory, const char *name, int fd, struct left_part *left,
    const char *expected, int allow_links) {
  const struct entry_change change = { .mode = ENTRY_REMOVE, .fingerprint = expected, .allow_links = allow_links };
  return mutate_entry(directory, name, fd, &change, left);
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

// `writer` is the file that took the target's place, as published after the commit (`--writer`) or as recorded before the commit
// rename (`--renamed-writer`). A rename on macOS keeps the birth time, so both are matched in full.
static int recover_target(int directory, const char *hidden, const char *target, uint64_t dev, uint64_t ino,
    uint64_t birth, const char *expected, int retire_only, const struct expected_file *writer) {
  const int flags = (expected == NULL ? O_EVTONLY : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
  int published = -1;
  int vacant = 0;
  int committed = retire_only;
  if (!retire_only) {
    published = openat(directory, target, flags);
    vacant = published < 0 && errno == ENOENT;
    if (published < 0 && !vacant) return done("left");
    committed = published >= 0 && writer != NULL && matches_file(published, writer->dev, writer->ino, writer->birth) &&
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
  if (!committed && !vacant) return done("left");
  struct stat stamp;
  if (fstat(fd, &stamp) != 0 || (uint64_t)stamp.st_dev != dev || (uint64_t)stamp.st_ino != ino ||
      nanos(stamp.st_birthtimespec) != birth) return done("left");
  const struct entry_change change = { .mode = committed ? ENTRY_RETIRE_HIDDEN : ENTRY_RESTORE,
    .directory = directory, .name = target, .stamp = &stamp, .fingerprint = expected };
  return done(mutate_entry(directory, hidden, fd, &change, NULL) == REMOVE_DONE ? "resolved" : "left");
}

static int run_recovery(int argc, char **argv, enum recovery_mode mode) {
  const int restore = mode != RECOVER_REMOVE;
  const char *name = argv[3];
  const char *part = restore ? argv[4] : NULL;
  if (!plain_name(name) || (restore && (!plain_name(part) || strcmp(name, part) == 0))) return EXIT_USAGE;
  if (mode == RECOVER_RESTORE_TARGET && !hidden_name(name)) return EXIT_USAGE;
  struct options options;
  const unsigned allowed = OPTION_EXPECT | OPTION_CONTENT |
    (mode == RECOVER_RESTORE_TARGET ? OPTION_WRITER | OPTION_RENAMED_WRITER | OPTION_RETIRE : 0);
  if (!parse_options(argc, argv, restore ? 5 : 4, allowed, &options)) return EXIT_USAGE;
  const char *expect = option(&options, OPTION_EXPECT);
  const char *expected = option(&options, OPTION_CONTENT);
  const char *full_writer = option(&options, OPTION_WRITER);
  const char *renamed_writer = option(&options, OPTION_RENAMED_WRITER);
  const int retire_only = (options.seen & OPTION_RETIRE) != 0;
  const char *writer_token = full_writer != NULL ? full_writer : renamed_writer;
  if (expect == NULL || (full_writer != NULL && renamed_writer != NULL) || (writer_token != NULL && retire_only) ||
      (mode == RECOVER_RESTORE_PART && expected == NULL) || (expected != NULL && !fingerprint_text(expected))) return EXIT_USAGE;
  struct expected_file file;
  struct expected_file writer;
  if (!parse_token(expect, &file) ||
      (writer_token != NULL && (!parse_token(writer_token, &writer) || writer.dev != file.dev || writer.ino == file.ino)))
    return EXIT_USAGE;
  const uint64_t dev = file.dev, ino = file.ino, birth = file.birth;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (mode == RECOVER_RESTORE_TARGET)
    return recover_target(directory, name, part, dev, ino, birth, expected, retire_only, writer_token == NULL ? NULL : &writer);
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

enum record_mode { RECORD_READ, RECORD_WRITE, RECORD_REMOVE, RECORD_SWEEP };

static int run_record(int argc, char **argv, enum record_mode mode) {
  const char *name = argv[3];
  if (!record_name(name)) return EXIT_USAGE;
  uint64_t max = 0;
  uint64_t device = 0, inode = 0, birth = 0;
  const char *digest_text = NULL;
  static unsigned char bytes[MAX_RECORD_BYTES + 1];
  if (mode == RECORD_WRITE) {
    const size_t size = strlen(argv[4]);
    if (size > 2 * MAX_RECORD_BYTES || size % 2 != 0) return EXIT_USAGE;
    max = size / 2;
    for (size_t i = 0; i < max; ++i) {
      const int hi = hex_digit(argv[4][2 * i]), lo = hex_digit(argv[4][2 * i + 1]);
      if (hi < 0 || lo < 0) return EXIT_USAGE;
      bytes[i] = (unsigned char)(16 * hi + lo);
    }
  } else if (mode == RECORD_REMOVE) {
    struct options options;
    struct expected_file stamp;
    if (!parse_options(argc, argv, 4, OPTION_EXPECT | OPTION_LENGTH | OPTION_DIGEST, &options)) return EXIT_USAGE;
    const char *expect = option(&options, OPTION_EXPECT);
    const char *length = option(&options, OPTION_LENGTH);
    digest_text = option(&options, OPTION_DIGEST);
    // A record is removed only by a stamp this helper can compare.
    if (expect == NULL || length == NULL || digest_text == NULL || !parse_token(expect, &stamp) || stamp.birth == 0 ||
        !parse_u64(length, &max) || max > MAX_RECORD_BYTES || strlen(digest_text) != 64 ||
        strspn(digest_text, "0123456789abcdef") != 64) return EXIT_USAGE;
    device = stamp.dev;
    inode = stamp.ino;
    birth = stamp.birth;
  } else if (!parse_u64(argv[4], &max) || max == 0 || max > MAX_RECORD_BYTES) {
    return EXIT_USAGE;
  }
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (mode == RECORD_WRITE) {
    struct stat written;
    const struct entry_change change = { .mode = ENTRY_RECORD_WRITE, .body = bytes, .length = (size_t)max, .written = &written };
    if (mutate_entry(directory, name, -1, &change, NULL) != REMOVE_DONE) return failed(errno);
    say_token("written", &written);
    return EXIT_DONE;
  }
  const int fd = open_regular(directory, name);
  if (fd < 0) return errno == ENOENT || errno == ELOOP ? done("absent") : failed(errno);
  struct stat info;
  if (fstat(fd, &info) != 0) return failed(errno);
  if (!S_ISREG(info.st_mode)) return done("absent");
  if (mode == RECORD_REMOVE) {
    if ((uint64_t)info.st_dev != device || (uint64_t)info.st_ino != inode || nanos(info.st_birthtimespec) != birth)
      return done("kept");
    char expected[FINGERPRINT_SIZE];
    snprintf(expected, sizeof expected, "%" PRIu64 ":%" PRIu64 ":%s:%s", max,
      nanos(info.st_mtimespec), digest_text, digest_text);
    const struct entry_change change = { .mode = ENTRY_RECORD_REMOVE, .stamp = &info, .fingerprint = expected };
    const enum remove_result removed = mutate_entry(directory, name, fd, &change, NULL);
    return done(removed == REMOVE_DONE ? "removed" : "kept");
  }
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
  static char encoded[2 * MAX_RECORD_BYTES + TOKEN_SIZE + sizeof "record  "];
  char token[TOKEN_SIZE];
  token_text(&info, token);
  const int prefix = mode == RECORD_READ ? snprintf(encoded, sizeof encoded, "record ")
    : snprintf(encoded, sizeof encoded, "record %s ", token);
  hex_encode(bytes, used, encoded + prefix);
  if (mode == RECORD_READ) return done(encoded);
  if (!names_file(directory, name, fd) || info.st_size != (off_t)used) return done("absent");
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  char hex[2 * sizeof digest + 1];
  CC_SHA256(bytes, (CC_LONG)used, digest);
  hex_encode(digest, sizeof digest, hex);
  char expected[FINGERPRINT_SIZE];
  snprintf(expected, sizeof expected, "%" PRIu64 ":%" PRIu64 ":%s:%s",
    (uint64_t)used, nanos(info.st_mtimespec), hex, hex);
  if (!fingerprint_matches(fd, expected)) return done("absent");
  if (!proceed(encoded) || !names_file(directory, name, fd) || !fingerprint_matches(fd, expected)) return done("kept");
  const struct entry_change change = { .mode = ENTRY_RECORD_SWEEP, .stamp = &info, .fingerprint = expected };
  const enum remove_result removed = mutate_entry(directory, name, fd, &change, NULL);
  return done(removed == REMOVE_DONE ? "removed" : "kept");
}

static int remove_own_part(int to, const char *part, const struct written_file *written, struct left_part *left) {
  const struct entry_change change = { .mode = ENTRY_REMOVE };
  return mutate_entry(to, part, written->fd, &change, left) != REMOVE_LEFT;
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

// Move the staged file `name` to a vacant `target`, only while `name` is still the file `--expect` names.
static int run_rename(int argc, char **argv) {
  const char *name = argv[3];
  const char *target = argv[7];
  struct options options;
  struct expected_file expected;
  if (!plain_name(name) || !plain_name(target) || !parse_options(argc, argv, 8, OPTION_EXPECT, &options) ||
      option(&options, OPTION_EXPECT) == NULL || !parse_token(option(&options, OPTION_EXPECT), &expected)) return EXIT_USAGE;
  int from = -1;
  int to = -1;
  int status = hold_directory(argv[0], argv[1], argv[2], "from", &from);
  if (status == 0) status = hold_directory(argv[4], argv[5], argv[6], "to", &to);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  const int fd = open_regular(from, name);
  if (fd < 0) return errno == ENOENT || errno == ELOOP ? refused("source") : failed(errno);
  struct stat info;
  if (fstat(fd, &info) != 0) return failed(errno);
  if (!matches_file(fd, expected.dev, expected.ino, expected.birth) || !names_file(from, name, fd)) return refused("source");
  status = check_replaceable(to, target);
  if (status != 0) return status;
  if (!entry_absent(to, target)) return done("replace");
  const struct entry_change change = { .mode = ENTRY_RENAME_AWAY, .directory = to, .name = target, .stamp = &info };
  const enum remove_result renamed = mutate_entry(from, name, fd, &change, NULL);
  const int error = errno;
  struct stat moved;
  const int read_back = renamed == REMOVE_DONE && fstat(fd, &moved) == 0;
  close(fd);
  if (renamed == REMOVE_DONE) {
    if (!read_back) return failed(EIO);
    // What the moved file is now, read from the descriptor that moved it; the caller records it before it settles the move.
    say_token("published", &moved);
    return done("committed");
  }
  if (error == EXDEV) return done("cross-volume");
  if (error == EEXIST || error == ESTALE) return refused("target");
  return failed(error);
}

static enum remove_result replace_copy_name(int directory, const char *from, const char *to, int fd,
    const struct stat *stamp, int restoring) {
#if defined(AVE_DIR_OPS_TEST_COPY_COMMIT_FAILURE) || defined(AVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE)
#if !defined(AVE_DIR_OPS_TEST_COPY_RESTORE_FAILURE)
  if (!restoring)
#endif
  {
    errno = EIO;
    return REMOVE_LEFT;
  }
#endif
  const struct entry_change change = { .mode = restoring ? ENTRY_RESTORE : ENTRY_RENAME_AWAY,
    .directory = directory, .name = to, .stamp = stamp };
  return mutate_entry(directory, from, fd, &change, NULL);
}

static void finish_copy_target(int directory, const char *target, const char *aside, int old,
    const struct stat *identity, int committed) {
  if (*aside == '\0') return;
  if (names_file(directory, aside, old)) {
    const struct entry_change change = { .mode = ENTRY_RETIRE_HIDDEN, .stamp = identity };
    if ((committed ? mutate_entry(directory, aside, old, &change, NULL)
        : replace_copy_name(directory, aside, target, old, identity, 1)) == REMOVE_DONE) {
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

// The destination volume must offer what a copy's protocol relies on: exclusive rename (RENAME_EXCL) for the commit and the old
// target's move aside, file ids that persist (the inode the writing descriptor reports is the one the commit leaves at the target),
// and birth times for every token. The held directory's own volume capabilities answer that before anything is created; exFAT and
// FAT report neither of the first two. Returns 0, `refused volume` for a volume that lacks one, or `refused volume-unknown` when the
// capabilities cannot be read.
static int check_volume(int directory) {
#if defined(AVE_DIR_OPS_TEST_VOLUME_UNKNOWN)
  (void)directory;
  return refused("volume-unknown");
#else
  struct attrlist request = {
    .bitmapcount = ATTR_BIT_MAP_COUNT, .volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES | ATTR_VOL_ATTRIBUTES,
  };
  struct {
    uint32_t length;
    vol_capabilities_attr_t capabilities;
    vol_attributes_attr_t attributes;
  } __attribute__((aligned(4), packed)) reply;
  memset(&reply, 0, sizeof reply);
  if (fgetattrlist(directory, &request, &reply, sizeof reply, 0) != 0 || reply.length < sizeof reply) return refused("volume-unknown");
  const vol_capabilities_attr_t capabilities = reply.capabilities;
  const vol_attributes_attr_t attributes = reply.attributes;
  const uint32_t interfaces = capabilities.valid[VOL_CAPABILITIES_INTERFACES] & capabilities.capabilities[VOL_CAPABILITIES_INTERFACES];
  const uint32_t format = capabilities.valid[VOL_CAPABILITIES_FORMAT] & capabilities.capabilities[VOL_CAPABILITIES_FORMAT];
  const int supported = (interfaces & VOL_CAP_INT_RENAME_EXCL) != 0 && (format & VOL_CAP_FMT_PERSISTENTOBJECTIDS) != 0 &&
    (attributes.validattr.commonattr & ATTR_CMN_CRTIME) != 0;
  return supported ? 0 : refused("volume");
#endif
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
  // Before the source or an existing target is opened, and before anything is written.
  status = check_volume(to);
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
    say_token("target-id", &old_identity);
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
  say_token("writing", &identity);
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
    say_token("copy-id", &final);
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
    const struct entry_change change = { .mode = ENTRY_RENAME_AWAY, .directory = to, .name = aside, .stamp = &old_identity };
    if (mutate_entry(to, target, old, &change, NULL) != REMOVE_DONE) {
      return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    }
    if (!names_file(to, aside, old)) {
      finish_copy_target(to, target, aside, old, &old_identity, 0);
      return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    }
  }
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
  const struct entry_change publish = { .mode = ENTRY_RENAME_AWAY, .directory = to, .name = target, .stamp = &final };
  if ((old >= 0 ? replace_copy_name(to, part, target, written.fd, &final, 0)
      : mutate_entry(to, part, written.fd, &publish, NULL)) != REMOVE_DONE) {
    const int code = errno;
    finish_copy_target(to, target, aside, old, &old_identity, 0);
    if (code == EEXIST || code == ENOTSUP || code == EINVAL || code == ESTALE)
      return stopped_copy(to, part, &written, "refused target", EXIT_REFUSED);
    return abandon(to, part, &written, code);
  }
  // The commit rename verified the target against the writing descriptor. What the published file is now, read from that descriptor;
  // the caller records it before it treats the commit as settled, so nothing but the old target's retirement follows.
  struct stat published;
  if (fstat(written.fd, &published) != 0) published = final;
  say_token("published", &published);
  finish_copy_target(to, target, aside, old, &old_identity, 1);
  return done("committed");
}

// Remove a file or link directly in the held directory through its own descriptor, only while it is still the entry `stamp` names:
// the same type, device, inode and birth time. REMOVE_LEFT with `*kept` set reports another entry at the name, which stays.
static enum remove_result remove_staged_entry(int directory, const char *name, const struct stat *stamp, int *kept) {
  *kept = 0;
  const int fd = openat(directory, name, O_RDONLY | O_SYMLINK | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? REMOVE_ABSENT : REMOVE_LEFT;
  struct stat info;
  enum remove_result result = REMOVE_LEFT;
  if (fstat(fd, &info) != 0) {
    close(fd);
    return REMOVE_LEFT;
  }
  if ((!S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode)) || !same_stamp(&info, stamp)) {
    *kept = 1;
  } else {
    struct left_part left = { .observed = -1 };
    result = retire_held(directory, name, fd, &left, NULL, 1);
    if (left.observed >= 0 && left.observed != fd) close(left.observed);
  }
  close(fd);
  return result;
}

// Remove the staged file `name`, only while it is still the file `--expect` names; `refused source` for another entry, which stays.
static int run_remove(int argc, char **argv) {
  const char *name = argv[3];
  struct options options;
  struct expected_file expected;
  if (!plain_name(name) || record_name(name) || !parse_options(argc, argv, 4, OPTION_EXPECT, &options) ||
      option(&options, OPTION_EXPECT) == NULL || !parse_token(option(&options, OPTION_EXPECT), &expected)) return EXIT_USAGE;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  struct stat info;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? done("absent") : failed(errno);
  if (S_ISDIR(info.st_mode)) return failed(EISDIR);
  // The stamp an entry must still have: the regular file the token names.
  struct stat stamp = { .st_mode = S_IFREG, .st_dev = (dev_t)expected.dev, .st_ino = (ino_t)expected.ino };
  stamp.st_birthtimespec.tv_sec = (time_t)(expected.birth / UINT64_C(1000000000));
  stamp.st_birthtimespec.tv_nsec = (long)(expected.birth % UINT64_C(1000000000));
  if ((uint64_t)stamp.st_dev != expected.dev || (uint64_t)stamp.st_ino != expected.ino) return refused("source");
  int kept = 0;
  const enum remove_result result = remove_staged_entry(directory, name, &stamp, &kept);
  if (kept) return refused("source");
  return result == REMOVE_LEFT ? failed(EIO) : done(result == REMOVE_DONE ? "removed" : "absent");
}

// The stamp of the regular file `name` in the held directory, which a later move or removal of that entry must carry.
static int run_stamp(char **argv) {
  const char *name = argv[3];
  if (!plain_name(name) || record_name(name)) return EXIT_USAGE;
  int directory = -1;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", &directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  struct stat info;
  if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? done("absent") : failed(errno);
  // Another kind of entry, or a file without a birth time, has no stamp this helper can name.
  if (!S_ISREG(info.st_mode) || nanos(info.st_birthtimespec) == 0) return refused("source");
  say_token("stamp", &info);
  return EXIT_DONE;
}

// Remove the files and links directly in the held folder, each only while it is still the entry the listing stamped; directories and
// anything else stay, and nothing is removed recursively.
static int run_sweep(int argc, char **argv) {
  struct options options;
  if (!parse_options(argc, argv, 3, OPTION_KEEP_RECORDS, &options)) return EXIT_USAGE;
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
        record_name(entry->d_name)) continue;
    struct stat info;
    if (fstatat(directory, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      return failed(errno);
    }
    if (!S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode)) continue;
    int kept = 0;
    const enum remove_result result = remove_staged_entry(directory, entry->d_name, &info, &kept);
    if (kept) continue;
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
  if (argc < 2) {
    fputs("usage: ave-dir-ops --dir-<mode> <arguments>\n", stderr);
    return EXIT_USAGE;
  }
  const char *mode = argv[1];
  const int count = argc - 2;
  char **const rest = argv + 2;
  if (strcmp(mode, "--dir-rename") == 0 && count >= 8) return run_rename(count, rest);
  if (strcmp(mode, "--dir-copy") == 0 && count == 10) return run_copy(rest);
  if (strcmp(mode, "--dir-remove") == 0 && count >= 4) return run_remove(count, rest);
  if (strcmp(mode, "--dir-stamp") == 0 && count == 4) return run_stamp(rest);
  if (strcmp(mode, "--dir-sweep") == 0 && count >= 3) return run_sweep(count, rest);
  if (strcmp(mode, "--dir-list-records") == 0 && count == 3) return run_records(rest);
  if (strcmp(mode, "--dir-read") == 0 && count == 5) return run_record(count, rest, RECORD_READ);
  if (strcmp(mode, "--dir-write-record") == 0 && count == 5) return run_record(count, rest, RECORD_WRITE);
  if (strcmp(mode, "--dir-sweep-record") == 0 && count == 5) return run_record(count, rest, RECORD_SWEEP);
  if (strcmp(mode, "--dir-remove-record") == 0 && count >= 4) return run_record(count, rest, RECORD_REMOVE);
  if (strcmp(mode, "--dir-remove-id") == 0 && count >= 4) return run_recovery(count, rest, RECOVER_REMOVE);
  if (strcmp(mode, "--dir-restore") == 0 && count >= 5) return run_recovery(count, rest, RECOVER_RESTORE_PART);
  if (strcmp(mode, "--dir-restore-target") == 0 && count >= 5) return run_recovery(count, rest, RECOVER_RESTORE_TARGET);
  fputs("usage: ave-dir-ops --dir-<mode> <arguments>\n", stderr);
  return EXIT_USAGE;
}
