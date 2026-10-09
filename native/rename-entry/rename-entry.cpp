// One same-volume, exclusive rename. Existing destinations are never replaced.
#ifdef _WIN32
#include <windows.h>
#include <cstdio>

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
  if (MoveFileExW(argv[1], argv[2], 0)) return 0;
  const DWORD error = GetLastError();
  const char* code = "EIO";
  switch (error) {
    case ERROR_FILE_EXISTS: case ERROR_ALREADY_EXISTS: code = "EEXIST"; break;
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: code = "EBUSY"; break;
    case ERROR_ACCESS_DENIED:
      code = GetFileAttributesW(argv[2]) == INVALID_FILE_ATTRIBUTES ? "EACCES" : "EEXIST";
      break;
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: code = "ENOENT"; break;
    case ERROR_NOT_SAME_DEVICE: code = "EXDEV"; break;
    case ERROR_DIR_NOT_EMPTY: code = "ENOTEMPTY"; break;
  }
  std::fprintf(stderr, "%s\n", code);
  return 1;
}
#else
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

int main(int argc, char** argv) {
  if (argc != 3) return 2;
#ifdef __APPLE__
  const int result = renamex_np(argv[1], argv[2], RENAME_EXCL);
#elif defined(__linux__)
  const long result = syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE);
#else
#error Unsupported exclusive rename platform
#endif
  if (result == 0) return 0;
  const char* code = "EIO";
  switch (errno) {
    case EEXIST: code = "EEXIST"; break;
    case ENOTEMPTY: code = "ENOTEMPTY"; break;
    case EBUSY: code = "EBUSY"; break;
    case EACCES: code = "EACCES"; break;
    case EPERM: code = "EPERM"; break;
    case ENOENT: code = "ENOENT"; break;
    case ENOTDIR: code = "ENOTDIR"; break;
    case EXDEV: code = "EXDEV"; break;
    case ENOSYS: code = "ENOSYS"; break;
    case EINVAL: code = "EINVAL"; break;
  }
  std::fprintf(stderr, "%s\n", code);
  return 1;
}
#endif
