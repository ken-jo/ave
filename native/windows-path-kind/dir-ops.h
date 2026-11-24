#pragma once
// File operations that act inside directories this process holds open: the browser download staging folder and the folder the
// user chose. Each mode opens its directories component by component from the volume root, every component through the handle of
// the one above it and without delete sharing, so neither a held directory nor a folder above it can be renamed or removed while
// the mode runs, and a link, junction or mount point at any component is refused. The last handle's identity must be the one the
// caller checked. Every file is then created, renamed and removed relative to those handles (NtCreateFile with a root directory,
// native FileRenameInformation with RootDirectory and FileDispositionInformation on the file's own handle), never by a path. README.md, "Held directory
// operations", has the protocol; native/macos-dir-ops implements the same modes with directory descriptors.
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace dir_ops {

constexpr int kExitDone = 0;
constexpr int kExitUsage = 2;
constexpr int kExitRefused = 3;
constexpr int kExitFailed = 4;
constexpr DWORD kCopyChunk = 1024 * 1024;
// A copy flushes its temporary file this often, so the final flush is short and the caller keeps hearing progress.
constexpr ULONGLONG kSyncInterval = 16ULL * kCopyChunk;
constexpr size_t kNameLimit = 255;
// A name surrogate (link, junction, mount point) redirects a path; other reparse points (cloud files) do not.
constexpr DWORD kNameSurrogate = 0x20000000;
constexpr ULONG kCaseInsensitive = 0x40;          // OBJ_CASE_INSENSITIVE
constexpr ULONG kOpenExisting = 1;               // FILE_OPEN
constexpr ULONG kCreateNew = 2;                  // FILE_CREATE
constexpr ULONG kDirectoryFile = 0x00000001;     // FILE_DIRECTORY_FILE
constexpr ULONG kSequentialOnly = 0x00000004;    // FILE_SEQUENTIAL_ONLY
constexpr ULONG kSynchronousIo = 0x00000020;     // FILE_SYNCHRONOUS_IO_NONALERT
constexpr ULONG kNonDirectoryFile = 0x00000040;  // FILE_NON_DIRECTORY_FILE
constexpr ULONG kBackupIntent = 0x00004000;      // FILE_OPEN_FOR_BACKUP_INTENT
constexpr ULONG kOpenReparsePoint = 0x00200000;  // FILE_OPEN_REPARSE_POINT
constexpr DWORD kIsADirectory = 336;             // ERROR_DIRECTORY_NOT_SUPPORTED

// The errno names the caller maps (the lock codes it retries among them), from the Windows error of a failed call.
inline const char* error_name(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_ACCESS_DENIED: return "EPERM";
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION: return "EBUSY";
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS: return "EEXIST";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL: return "ENOSPC";
    case ERROR_FILE_TOO_LARGE: return "EFBIG";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case kIsADirectory: return "EISDIR";
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY: return "ENOMEM";
    default: return "EUNKNOWN";
  }
}

template <typename Function>
Function ntdll_function(const char* name) {
  Function function = nullptr;
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (module == nullptr) return function;
  const auto address = GetProcAddress(module, name);
  static_assert(sizeof(function) == sizeof(address));
  std::memcpy(&function, &address, sizeof(function));
  return function;
}

// The Windows error for an NTSTATUS, as the system translates it.
inline DWORD status_error(NTSTATUS status) {
  using Translate = ULONG(WINAPI*)(NTSTATUS);
  const auto translate = ntdll_function<Translate>("RtlNtStatusToDosError");
  return translate == nullptr ? ERROR_INVALID_FUNCTION : static_cast<DWORD>(translate(status));
}

struct FileFailure {
  DWORD error = ERROR_SUCCESS;
  NTSTATUS status = 0;
  const char* operation = nullptr;
};

inline FileFailure native_failure(NTSTATUS status, const char* operation) {
  return {status_error(status), status, operation};
}

inline void say(const char* line) {
  std::fputs(line, stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

inline int done(const char* outcome) {
  say(outcome);
  return kExitDone;
}

inline int failed(FileFailure failure, const char* suffix = "") {
  std::printf("failed %s%s\n", error_name(failure.error), suffix);
  std::fflush(stdout);
  if (failure.operation == nullptr) {
    std::fprintf(stderr, "Windows error %lu\n", static_cast<unsigned long>(failure.error));
  } else {
    std::fprintf(stderr, "Windows error %lu (NTSTATUS 0x%08lX, %s)\n", static_cast<unsigned long>(failure.error),
      static_cast<unsigned long>(static_cast<ULONG>(failure.status)), failure.operation);
  }
  return kExitFailed;
}

inline int failed(DWORD error) { return failed(FileFailure{error}); }

inline int refused(const char* what) {
  std::printf("refused %s\n", what);
  std::fflush(stdout);
  return kExitRefused;
}

// Announce `step` and wait for the caller's answer: one `c` byte proceeds; any other byte, or the end of input, stops.
inline bool proceed(const char* step) {
  say(step);
  char answer = 0;
  DWORD count = 0;
  return ReadFile(GetStdHandle(STD_INPUT_HANDLE), &answer, 1, &count, nullptr) && count == 1 && answer == 'c';
}

// While a copy runs the caller writes nothing: input that arrives, or a closed input pipe, asks the copy to stop.
inline bool stop_requested() {
  DWORD available = 0;
  if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) return true;
  return available > 0;
}

inline bool parse_number(const wchar_t* text, ULONGLONG& value) {
  if (text[0] == L'\0' || (text[0] == L'0' && text[1] != L'\0')) return false;
  ULONGLONG result = 0;
  for (const wchar_t* cursor = text; *cursor != L'\0'; ++cursor) {
    if (*cursor < L'0' || *cursor > L'9') return false;
    const ULONGLONG digit = static_cast<ULONGLONG>(*cursor - L'0');
    if (result > (ULLONG_MAX - digit) / 10) return false;
    result = result * 10 + digit;
  }
  value = result;
  return true;
}

// One path component: no separator or stream marker, not `.` or `..`, and short enough to be a directory entry.
inline bool plain_name(const wchar_t* text) {
  const std::wstring name(text);
  return !name.empty() && name.size() <= kNameLimit && name.find_first_of(L"\\/:") == std::wstring::npos && name != L"." && name != L"..";
}

// Open `name` through the directory handle `parent`; the name is resolved by that directory object, never by a path.
inline NTSTATUS open_relative(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG share, ULONG disposition,
    ULONG options, HANDLE& handle, PSECURITY_DESCRIPTOR security = nullptr) {
  const auto create = ntdll_function<decltype(&NtCreateFile)>("NtCreateFile");
  if (create == nullptr) return static_cast<NTSTATUS>(0xc0000002);  // STATUS_NOT_IMPLEMENTED
  UNICODE_STRING text{};
  text.Buffer = const_cast<wchar_t*>(name.data());
  text.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &text;
  attributes.Attributes = kCaseInsensitive;
  attributes.SecurityDescriptor = security;
  IO_STATUS_BLOCK io{};
  return create(&handle, access | SYNCHRONIZE, &attributes, &io, nullptr, FILE_ATTRIBUTE_NORMAL, share, disposition,
    options | kSynchronousIo, nullptr, 0);
}

// The directory could not be checked at all (gone, unreadable, not a directory): a refusal, not an operation failure.
inline bool unverifiable(DWORD error) {
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND || error == ERROR_ACCESS_DENIED
    || error == ERROR_DIRECTORY || error == ERROR_INVALID_NAME || error == ERROR_BAD_NETPATH || error == ERROR_BAD_NET_NAME;
}

struct HeldDirectory {
  std::vector<PinnedHandle> components;
  HANDLE handle() const { return components.back().value; }
};

// Hold `path` and every folder above it, and keep it only when its identity is the one the caller checked. Returns 0, or the
// exit code to end with: a refusal as `what` when any component is gone, unreadable, not a directory or a link.
inline int hold_directory(const wchar_t* path, const wchar_t* volume, const wchar_t* index, const char* what, HeldDirectory& held) {
  ULONGLONG expected_volume = 0;
  ULONGLONG expected_index = 0;
  std::vector<std::wstring> names;
  if (!parse_number(volume, expected_volume) || !parse_number(index, expected_index) || !path_components(path, names)) return kExitUsage;
  for (size_t position = 0; position < names.size(); ++position) {
    // Traverse access counts for sharing, so this open blocks a rename or removal of the component until it is closed;
    // the held directory itself is also listed by the sweep.
    const ACCESS_MASK access = static_cast<ACCESS_MASK>(FILE_TRAVERSE | FILE_READ_ATTRIBUTES | (position + 1 == names.size() ? FILE_LIST_DIRECTORY : 0));
    HANDLE opened = INVALID_HANDLE_VALUE;
    if (position == 0) {
      const std::wstring& root = names[0];
      const std::wstring extended = root.compare(0, 2, L"\\\\") == 0 ? L"\\\\?\\UNC\\" + root.substr(2) : L"\\\\?\\" + root;
      opened = CreateFileW(extended.c_str(), access | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (opened == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        return unverifiable(error) ? refused(what) : failed(error);
      }
    } else {
      const std::wstring& above = names[position - 1];
      const std::wstring child = names[position].substr(above.size() + (above.back() == L'\\' ? 0 : 1));
      const NTSTATUS status = open_relative(held.components.back().value, child, access, FILE_SHARE_READ | FILE_SHARE_WRITE,
        kOpenExisting, kDirectoryFile | kBackupIntent | kOpenReparsePoint, opened);
      if (status < 0) {
        const DWORD error = status_error(status);
        return unverifiable(error) ? refused(what) : failed(native_failure(status, "NtCreateFile"));
      }
    }
    held.components.emplace_back(opened);
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (!GetFileInformationByHandleEx(opened, FileAttributeTagInfo, &tag, sizeof(tag))) return failed(GetLastError());
    if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return refused(what);
    if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && (tag.ReparseTag == 0 || (tag.ReparseTag & kNameSurrogate) != 0)) {
      return refused(what);
    }
  }
  BY_HANDLE_FILE_INFORMATION facts{};
  if (!GetFileInformationByHandle(held.handle(), &facts)) return failed(GetLastError());
  const ULONGLONG found_index = (static_cast<ULONGLONG>(facts.nFileIndexHigh) << 32) | facts.nFileIndexLow;
  if (static_cast<ULONGLONG>(facts.dwVolumeSerialNumber) != expected_volume || found_index != expected_index) return refused(what);
  return 0;
}

// What a name in a held directory is: nothing, an ordinary file, or something else (a directory, a link or another reparse point).
enum class Entry { kAbsent, kOrdinary, kOther };

inline FileFailure classify(HANDLE directory, const std::wstring& name, Entry& entry) {
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS status = open_relative(directory, name, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    kOpenExisting, kOpenReparsePoint, opened);
  if (status < 0) {
    const DWORD error = status_error(status);
    if (error != ERROR_FILE_NOT_FOUND) return native_failure(status, "NtCreateFile");
    entry = Entry::kAbsent;
    return {};
  }
  const PinnedHandle closer(opened);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(opened, FileAttributeTagInfo, &tag, sizeof(tag))) return {GetLastError()};
  entry = (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 ? Entry::kOrdinary : Entry::kOther;
  return {};
}

// The chosen name may hold nothing yet, or an ordinary file the user agreed to replace; never a link or anything else.
// Returns 0 or the exit code to end with.
inline int check_replaceable(HANDLE directory, const std::wstring& name) {
  Entry entry = Entry::kAbsent;
  const FileFailure failure = classify(directory, name, entry);
  if (failure.error != ERROR_SUCCESS) return failed(failure);
  return entry == Entry::kOther ? refused("target") : 0;
}

inline FileFailure set_file_information(HANDLE file, void* information, ULONG length, FILE_INFORMATION_CLASS kind) {
  using SetInformation = NTSTATUS(NTAPI*)(HANDLE, IO_STATUS_BLOCK*, void*, ULONG, FILE_INFORMATION_CLASS);
  const auto set_information = ntdll_function<SetInformation>("NtSetInformationFile");
  if (set_information == nullptr) {
    return {ERROR_INVALID_FUNCTION};
  }
  IO_STATUS_BLOCK io{};
  const NTSTATUS status = set_information(file, &io, information, length, kind);
  return status < 0 ? native_failure(status, "NtSetInformationFile") : FileFailure{};
}

// Rename the open file `file` to `name` in the held directory `directory`, replacing an ordinary file there.
inline FileFailure rename_into(HANDLE file, HANDLE directory, const std::wstring& name, bool replace = true) {
  const DWORD name_bytes = static_cast<DWORD>(name.size() * sizeof(wchar_t));
  std::vector<BYTE> bytes(sizeof(FILE_RENAME_INFO) + name_bytes);
  auto info = reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());
  info->ReplaceIfExists = replace ? TRUE : FALSE;
  info->RootDirectory = directory;
  info->FileNameLength = name_bytes;
  std::memcpy(info->FileName, name.data(), name_bytes);
  // Preserve the relative name and its directory handle at the native boundary; the path wrapper normalizes the name.
  // FileRenameInformation is native class 10, distinct from the path wrapper's FileRenameInfo class 3.
  return set_file_information(file, info, static_cast<ULONG>(bytes.size()), static_cast<FILE_INFORMATION_CLASS>(10));
}

// Delete the file this handle is open on, once the handle closes.
inline FileFailure delete_on_close(HANDLE file) {
  // Native FileDispositionInformation (class 13) contains one BOOLEAN and names only the open file.
  BOOLEAN disposition = TRUE;
  return set_file_information(file, &disposition, static_cast<ULONG>(sizeof(disposition)), static_cast<FILE_INFORMATION_CLASS>(13));
}

// Write all of `length` bytes, however many each write takes; a write that makes no progress fails the copy.
inline DWORD write_all(HANDLE target, const BYTE* bytes, DWORD length) {
  while (length > 0) {
    DWORD written = 0;
    if (!WriteFile(target, bytes, length, &written, nullptr)) return GetLastError();
    if (written == 0) return ERROR_WRITE_FAULT;
    bytes += written;
    length -= written;
  }
  return ERROR_SUCCESS;
}

}  // namespace dir_ops

#include "dir-recovery.h"

namespace dir_ops {

inline int run_rename(wchar_t** argv) {
  if (!plain_name(argv[3]) || !plain_name(argv[7])) return kExitUsage;
  const std::wstring name(argv[3]);
  const std::wstring target(argv[7]);
  HeldDirectory from;
  HeldDirectory to;
  int status = hold_directory(argv[0], argv[1], argv[2], "from", from);
  if (status == 0) status = hold_directory(argv[4], argv[5], argv[6], "to", to);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS opening = open_relative(from.handle(), name, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, kOpenExisting,
    kOpenReparsePoint, opened);
  if (opening < 0) {
    const DWORD error = status_error(opening);
    return error == ERROR_FILE_NOT_FOUND ? refused("source") : failed(native_failure(opening, "NtCreateFile"));
  }
  const PinnedHandle source(opened);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(source.value, FileAttributeTagInfo, &tag, sizeof(tag))) return failed(GetLastError());
  if ((tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) return refused("source");
  status = check_replaceable(to.handle(), target);
  if (status != 0) return status;
  const FileFailure renamed = rename_into(source.value, to.handle(), target);
  if (renamed.error != ERROR_SUCCESS) {
    return renamed.error == ERROR_NOT_SAME_DEVICE ? done("cross-volume") : failed(renamed);
  }
  return done("committed");
}

#if defined(AVE_TEST_DIR_RECOVERY)
bool test_fail_replacement_rename(bool restoring);
void test_stop_replacement(const char* boundary);
#endif

inline int run_copy(wchar_t** argv) {
  if (!plain_name(argv[3]) || !plain_name(argv[7]) || !plain_name(argv[8])) return kExitUsage;
  const std::wstring name(argv[3]);
  const std::wstring target(argv[7]);
  const std::wstring part_name(argv[8]);
  const std::wstring aside(argv[9]);
  if (!hidden_name(aside) || _wcsicmp(part_name.c_str(), target.c_str()) == 0 ||
      _wcsicmp(aside.c_str(), target.c_str()) == 0 || _wcsicmp(aside.c_str(), part_name.c_str()) == 0) return kExitUsage;
  std::string hidden;
  for (const wchar_t character : aside) hidden += static_cast<char>(character);
  HeldDirectory from;
  HeldDirectory to;
  int status = hold_directory(argv[0], argv[1], argv[2], "from", from);
  if (status == 0) status = hold_directory(argv[4], argv[5], argv[6], "to", to);
  if (status != 0) return status;
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS opening = open_relative(from.handle(), name, FILE_READ_DATA | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, kOpenExisting,
    kOpenReparsePoint | kSequentialOnly, opened);
  if (opening < 0) {
    const DWORD error = status_error(opening);
    return error == ERROR_FILE_NOT_FOUND ? refused("source") : failed(native_failure(opening, "NtCreateFile"));
  }
  const PinnedHandle source(opened);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(source.value, FileAttributeTagInfo, &tag, sizeof(tag))) return failed(GetLastError());
  if ((tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) return refused("source");
  HANDLE previous = INVALID_HANDLE_VALUE;
  NTSTATUS opening_target = open_relative(to.handle(), target, FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
    FILE_SHARE_READ, kOpenExisting, kOpenReparsePoint, previous);
  if (opening_target < 0 && status_error(opening_target) == ERROR_ACCESS_DENIED) {
    opening_target = open_relative(to.handle(), target, FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ,
      kOpenExisting, kOpenReparsePoint, previous);
  }
  if (opening_target < 0 && !missing(status_error(opening_target))) {
    return failed(native_failure(opening_target, "NtCreateFile"));
  }
  PinnedHandle old(previous);
  const bool replacing = old.value != INVALID_HANDLE_VALUE;
  FILE_ID_INFO old_id{};
  ULONGLONG old_birth = 0;
  if (replacing && (!ordinary(old.value) || !read_id(old.value, old_id))) return refused("target");
  FILE_ID_INFO directory_id{};
  if (!read_id(to.handle(), directory_id)) return refused("to");
  if (replacing) {
    if (old_id.VolumeSerialNumber != directory_id.VolumeSerialNumber ||
        !read_birth(old.value, old_birth)) return refused("target");
    say(("target-id " + id_text(old_id, ' ') + " " + std::to_string(old_birth)).c_str());
  }
  if (!proceed("ready")) return done("cancelled");
  // The temporary file is created exclusively and stays open without write or delete sharing through commit or retirement.
  HANDLE created = INVALID_HANDLE_VALUE;
  const NTSTATUS creating = open_relative(to.handle(), part_name, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE,
    FILE_SHARE_READ, kCreateNew, kNonDirectoryFile | kOpenReparsePoint | kSequentialOnly, created);
  if (creating < 0) {
    const FileFailure failure = native_failure(creating, "NtCreateFile");
    if (failure.error == ERROR_ACCESS_DENIED) {
      Entry occupied = Entry::kAbsent;
      if (classify(to.handle(), part_name, occupied).error == ERROR_SUCCESS && occupied != Entry::kAbsent) {
        return failed(ERROR_FILE_EXISTS);
      }
    }
    return failed(failure);
  }
  PinnedHandle part(created);
  FILE_ID_INFO written{};
  ULONGLONG written_birth = 0;
  if (!read_id(part.value, written) || !read_birth(part.value, written_birth))
    return failed(FileFailure{ERROR_NOT_SUPPORTED}, " left");
  if (written.VolumeSerialNumber != directory_id.VolumeSerialNumber || (replacing && same_id(written, old_id)))
    return failed(FileFailure{ERROR_NOT_SUPPORTED}, " left");
  const auto writer_stamp = [&] { return id_text(written, ' ') + " " + std::to_string(written_birth); };
  say(("writing " + writer_stamp()).c_str());
  const auto abandon = [&](FileFailure failure) {
    return stopped_copy(to.handle(), part_name, part.value, written, failure, false);
  };
  std::vector<BYTE> buffer(kCopyChunk);
  ULONGLONG copied = 0;
  ULONGLONG unsynced = 0;
  for (;;) {
    if (stop_requested()) return abandon({});
    DWORD count = 0;
    if (!ReadFile(source.value, buffer.data(), kCopyChunk, &count, nullptr)) return abandon({GetLastError()});
    if (count == 0) break;
    const DWORD writing = write_all(part.value, buffer.data(), count);
    if (writing != ERROR_SUCCESS) return abandon({writing});
    copied += count;
    unsynced += count;
    if (unsynced >= kSyncInterval) {
      if (!FlushFileBuffers(part.value)) return abandon({GetLastError()});
      unsynced = 0;
    }
    // Each chunk is progress the caller hears, so only a copy that stops moving looks stalled.
    std::printf("progress %llu\n", copied);
    std::fflush(stdout);
  }
  if (!FlushFileBuffers(part.value)) return abandon({GetLastError()});
  FILE_ID_INFO final_id{};
  ULONGLONG final_birth = 0;
  if (!read_id(part.value, final_id) || !read_birth(part.value, final_birth) ||
      !same_id(final_id, written) || final_birth != written_birth) return abandon({ERROR_NOT_SUPPORTED});
  if (replacing) say(("copy-id " + writer_stamp()).c_str());
  // The rename below is the commit point: the caller answers here whether the copy is still wanted.
  if (!proceed("copied")) return abandon({});
  const NameIdentity current = check_name(to.handle(), part_name, written, final_birth);
  if (current == NameIdentity::kAbsent) return refused("target removed");
  if (current != NameIdentity::kMatches) return refused("target left");
  const auto report_target_left = [&](bool retiring) {
    const bool verified = check_name(to.handle(), aside, old_id) == NameIdentity::kMatches;
    say(("target-left left " + hidden + " " + id_text(old_id, ' ')
      + (retiring ? " remove-failed " : " mismatch ")
      + (verified && old.value != INVALID_HANDLE_VALUE ? snapshot(old.value, old_id) : "-")).c_str());
#if defined(AVE_TEST_DIR_RECOVERY)
    test_stop_replacement("leftover");
#endif
  };
  const auto restore_target = [&]() {
    if (!replacing) return;
#if defined(AVE_TEST_DIR_RECOVERY)
    if (test_fail_replacement_rename(true)) {
      report_target_left(false);
      return;
    }
#endif
    if (check_name(to.handle(), aside, old_id) != NameIdentity::kMatches ||
        rename_into(old.value, to.handle(), target, false).error != ERROR_SUCCESS ||
        check_name(to.handle(), target, old_id) != NameIdentity::kMatches) report_target_left(false);
    else say("target-restored");
  };
  if (replacing) {
#if defined(AVE_TEST_DIR_RECOVERY)
    test_stop_replacement("before-move");
#endif
    if (check_name(to.handle(), target, old_id) != NameIdentity::kMatches ||
        rename_into(old.value, to.handle(), aside, false).error != ERROR_SUCCESS) {
      return stopped_copy(to.handle(), part_name, part.value, written, {}, true);
    }
    if (check_name(to.handle(), aside, old_id) != NameIdentity::kMatches) {
      restore_target();
      return stopped_copy(to.handle(), part_name, part.value, written, {}, true);
    }
#if defined(AVE_TEST_DIR_RECOVERY)
    test_stop_replacement("after-move");
#endif
  }
  FileFailure renamed;
#if defined(AVE_TEST_DIR_RECOVERY)
  if (replacing && test_fail_replacement_rename(false)) renamed = {ERROR_WRITE_FAULT};
  else
#endif
  renamed = rename_into(part.value, to.handle(), target, false);
  if (renamed.error != ERROR_SUCCESS) {
    restore_target();
    Entry target_entry = Entry::kAbsent;
    classify(to.handle(), target, target_entry);
    if ((!replacing && target_entry != Entry::kAbsent) || renamed.error == ERROR_ALREADY_EXISTS || renamed.error == ERROR_FILE_EXISTS
        || renamed.error == ERROR_NOT_SUPPORTED || renamed.error == ERROR_INVALID_FUNCTION || renamed.error == ERROR_INVALID_PARAMETER) {
      return stopped_copy(to.handle(), part_name, part.value, written, {}, true);
    }
    return abandon(renamed);
  }
  NameIdentity published = check_name(to.handle(), target, written, final_birth);
#if defined(AVE_TEST_DIR_RECOVERY)
  published = test_commit_result(published);
#endif
  if (published != NameIdentity::kMatches) {
    const FileFailure rolled_back = rename_into(part.value, to.handle(), part_name, false);
    restore_target();
    return refused(rolled_back.error == ERROR_SUCCESS ? "target left" : "target changed");
  }
  if (replacing) {
#if defined(AVE_TEST_DIR_RECOVERY)
    test_stop_replacement("after-commit");
#endif
    if (check_name(to.handle(), aside, old_id) != NameIdentity::kMatches ||
        delete_on_close(old.value).error != ERROR_SUCCESS) report_target_left(true);
    else {
      CloseHandle(old.value);
      old.value = INVALID_HANDLE_VALUE;
      if (check_name(to.handle(), aside, old_id) == NameIdentity::kAbsent) say("target-retired");
      else report_target_left(true);
    }
  }
  return done("committed");
}

// Remove `name` from the held directory through its own handle; a directory there (not a link) is not removed.
inline int remove_entry(HANDLE directory, const std::wstring& name, bool& removed) {
  removed = false;
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS status = open_relative(directory, name, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    kOpenExisting, kOpenReparsePoint, opened);
  if (status < 0) {
    const DWORD error = status_error(status);
    return error == ERROR_FILE_NOT_FOUND ? 0 : failed(native_failure(status, "NtCreateFile"));
  }
  const PinnedHandle entry(opened);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(entry.value, FileAttributeTagInfo, &tag, sizeof(tag))) return failed(GetLastError());
  if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 && (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) return failed(kIsADirectory);
  const FileFailure removal = delete_on_close(entry.value);
  if (removal.error != ERROR_SUCCESS) return failed(removal);
  removed = true;
  return 0;
}

inline int run_remove(wchar_t** argv) {
  if (!plain_name(argv[3])) return kExitUsage;
  HeldDirectory directory;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  bool removed = false;
  const int removal = remove_entry(directory.handle(), argv[3], removed);
  if (removal != 0) return removal;
  return done(removed ? "removed" : "absent");
}

// Remove the files and links directly in the held folder; directories and anything else stay, and nothing is removed recursively.
inline int run_sweep(wchar_t** argv, bool keep_records) {
  HeldDirectory directory;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  std::vector<std::wstring> staged;
  std::vector<BYTE> buffer(64 * 1024);
  for (bool first = true;; first = false) {
    if (!GetFileInformationByHandleEx(directory.handle(), first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) break;
      return failed(error);
    }
    for (size_t offset = 0;;) {
      const auto entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      const std::wstring entry_name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      const bool directory_only = (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 && (entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
      if (entry_name != L"." && entry_name != L".." && !directory_only &&
          (!keep_records || !record_name(entry_name))) staged.push_back(entry_name);
      if (entry->NextEntryOffset == 0) break;
      offset += entry->NextEntryOffset;
    }
  }
  unsigned long count = 0;
  for (const auto& entry_name : staged) {
    bool removed = false;
    const int removal = remove_entry(directory.handle(), entry_name, removed);
    if (removal != 0) return removal;
    if (removed) count += 1;
  }
  std::printf("swept %lu\n", count);
  std::fflush(stdout);
  return kExitDone;
}

inline int run(int argc, wchar_t** argv) {
  const std::wstring mode(argv[1]);
  if (argc == 10 && mode == L"--dir-rename") return run_rename(argv + 2);
  if (argc == 12 && mode == L"--dir-copy") return run_copy(argv + 2);
  if (argc == 6 && mode == L"--dir-remove") return run_remove(argv + 2);
  if (mode == L"--dir-sweep" && (argc == 5 || (argc == 6 && std::wstring(argv[5]) == L"keep-records")))
    return run_sweep(argv + 2, argc == 6);
  if (argc == 5 && mode == L"--dir-list-records") return run_list_records(argv + 2);
  if (argc == 7 && mode == L"--dir-read") return run_record(argv + 2, false);
  if (argc == 7 && mode == L"--dir-write-record") return run_record(argv + 2, true);
  if ((argc == 8 || argc == 9) && mode == L"--dir-remove-id") return run_recovery(argc - 2, argv + 2, RecoveryMode::kRemove);
  if (argc == 10 && mode == L"--dir-restore") return run_recovery(argc - 2, argv + 2, RecoveryMode::kRestorePart);
  if ((argc == 10 || argc == 11) && mode == L"--dir-restore-target")
    return run_recovery(argc - 2, argv + 2, RecoveryMode::kRestoreTarget);
  std::fputs("usage: ave-path-kind.exe --dir-<mode> <arguments>\n", stderr);
  return kExitUsage;
}

}  // namespace dir_ops
