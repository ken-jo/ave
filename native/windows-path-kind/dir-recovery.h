#pragma once

#include <bcrypt.h>
#include <sddl.h>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "advapi32.lib")

namespace dir_ops {

#if defined(AVE_TEST_DIR_RECOVERY)
DWORD test_restore_write_result(DWORD result);
FileFailure test_remove_result();
#endif

constexpr size_t kRecordLimit = 8192;
constexpr size_t kDigestSpan = 64 * 1024;
constexpr char kHex[] = "0123456789abcdef";
constexpr ULONGLONG kTicksToNs = 100;

inline std::string hex_bytes(const BYTE* bytes, size_t length) {
  std::string result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    result += kHex[bytes[index] >> 4];
    result += kHex[bytes[index] & 15];
  }
  return result;
}

inline int hex_digit(wchar_t digit) {
  if (digit >= L'0' && digit <= L'9') return digit - L'0';
  if (digit >= L'a' && digit <= L'f') return digit - L'a' + 10;
  return -1;
}

inline bool decode_hex(const std::wstring& text, BYTE* bytes, size_t length) {
  if (text.size() != length * 2) return false;
  for (size_t index = 0; index < length; ++index) {
    const int high = hex_digit(text[2 * index]);
    const int low = hex_digit(text[2 * index + 1]);
    if (high < 0 || low < 0) return false;
    bytes[index] = static_cast<BYTE>(16 * high + low);
  }
  return true;
}

inline bool missing(DWORD error) {
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

#if defined(AVE_TEST_DIR_RECOVERY)
bool test_file_id_result(bool queried, FILE_ID_INFO& id);
#endif

inline bool read_id(HANDLE file, FILE_ID_INFO& id) {
  bool queried = GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) != 0;
#if defined(AVE_TEST_DIR_RECOVERY)
  queried = test_file_id_result(queried, id);
#endif
  if (!queried) return false;
  const FILE_ID_128 empty{};
  if (std::memcmp(&id.FileId, &empty, sizeof(empty)) != 0) return true;
  SetLastError(ERROR_NOT_SUPPORTED);
  return false;
}

inline bool same_id(const FILE_ID_INFO& first, const FILE_ID_INFO& second) {
  return first.VolumeSerialNumber == second.VolumeSerialNumber
    && std::memcmp(&first.FileId, &second.FileId, sizeof(first.FileId)) == 0;
}

inline std::string id_text(const FILE_ID_INFO& id, char separator) {
  BYTE big_endian[sizeof(id.FileId.Identifier)];
  for (size_t index = 0; index < sizeof(big_endian); ++index) {
    big_endian[index] = id.FileId.Identifier[sizeof(big_endian) - 1 - index];
  }
  return std::to_string(id.VolumeSerialNumber) + separator + hex_bytes(big_endian, sizeof(big_endian));
}

inline bool parse_id(const wchar_t* volume, const wchar_t* number, FILE_ID_INFO& id) {
  BYTE big_endian[sizeof(id.FileId.Identifier)];
  if (!parse_number(volume, id.VolumeSerialNumber) || !decode_hex(number, big_endian, sizeof(big_endian))) return false;
  for (size_t index = 0; index < sizeof(big_endian); ++index) {
    id.FileId.Identifier[index] = big_endian[sizeof(big_endian) - 1 - index];
  }
  return true;
}

inline bool ordinary(HANDLE file) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  return GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag))
    && (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

enum class NameIdentity { kAbsent, kMatches, kUnverified };

#if defined(AVE_TEST_DIR_RECOVERY)
NameIdentity test_commit_result(NameIdentity result);
#endif

inline bool read_birth(HANDLE file, ULONGLONG& birth);

inline NameIdentity check_name(HANDLE directory, const std::wstring& name, const FILE_ID_INFO& wanted, ULONGLONG birth = 0, bool allow_reparse = false) {
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS status = open_relative(directory, name, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    kOpenExisting, kOpenReparsePoint, opened);
  if (status < 0) return missing(status_error(status)) ? NameIdentity::kAbsent : NameIdentity::kUnverified;
  const PinnedHandle entry(opened);
  FILE_ID_INFO actual{};
  ULONGLONG actual_birth = 0;
  return (allow_reparse || ordinary(entry.value)) && read_id(entry.value, actual) && same_id(actual, wanted) &&
      (birth == 0 || (read_birth(entry.value, actual_birth) && actual_birth == birth))
    ? NameIdentity::kMatches : NameIdentity::kUnverified;
}

inline bool seek_to(HANDLE file, LONGLONG offset) {
  LARGE_INTEGER position{};
  position.QuadPart = offset;
  return SetFilePointerEx(file, position, nullptr, FILE_BEGIN) != 0;
}

inline bool hash_bytes(const BYTE* data, DWORD length, std::string& digest) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  BYTE bytes[32];
  const NTSTATUS status = BCryptHash(algorithm, nullptr, 0, const_cast<BYTE*>(data), length, bytes, sizeof(bytes));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) return false;
  digest = hex_bytes(bytes, sizeof(bytes));
  return true;
}

inline bool hash_span(HANDLE file, LONGLONG offset, DWORD length, std::string& digest) {
  if (!seek_to(file, offset)) return false;
  std::vector<BYTE> data(length == 0 ? 1 : length);
  DWORD used = 0;
  while (used < length) {
    DWORD count = 0;
    if (!ReadFile(file, data.data() + used, length - used, &count, nullptr) || count == 0) return false;
    used += count;
  }
  return hash_bytes(data.data(), length, digest);
}

inline bool time_ns(LARGE_INTEGER ticks, ULONGLONG& ns) {
  if (ticks.QuadPart < 0 || static_cast<ULONGLONG>(ticks.QuadPart) > ULLONG_MAX / kTicksToNs) return false;
  ns = static_cast<ULONGLONG>(ticks.QuadPart) * kTicksToNs;
  return true;
}

inline bool read_birth(HANDLE file, ULONGLONG& birth) {
  FILE_BASIC_INFO basic{};
  return GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) &&
    time_ns(basic.CreationTime, birth) && birth != 0;
}

inline bool fingerprint(HANDLE file, const FILE_BASIC_INFO& before, std::string& result) {
  LARGE_INTEGER size{};
  ULONGLONG mtime = 0;
  if (!time_ns(before.LastWriteTime, mtime) || !GetFileSizeEx(file, &size) || size.QuadPart < 0) return false;
  const DWORD span = size.QuadPart < static_cast<LONGLONG>(kDigestSpan)
    ? static_cast<DWORD>(size.QuadPart) : static_cast<DWORD>(kDigestSpan);
  std::string head;
  std::string tail;
  if (!hash_span(file, 0, span, head) || !hash_span(file, size.QuadPart - span, span, tail)) return false;
  FILE_BASIC_INFO after{};
  LARGE_INTEGER size_after{};
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &after, sizeof(after)) || !GetFileSizeEx(file, &size_after)
      || before.ChangeTime.QuadPart != after.ChangeTime.QuadPart || before.LastWriteTime.QuadPart != after.LastWriteTime.QuadPart
      || size.QuadPart != size_after.QuadPart) return false;
  result = std::to_string(size.QuadPart) + ":" + std::to_string(mtime) + ":" + head + ":" + tail;
  return true;
}

struct ExpectedFile {
  FILE_ID_INFO id{};
  bool check_birth = false;
  ULONGLONG birth = 0;
  std::string content;
};

inline bool parse_fingerprint(const std::wstring& token, bool restore, ExpectedFile& expected) {
  const size_t first = token.find(L':');
  if (first == std::wstring::npos || !parse_number(token.substr(0, first).c_str(), expected.birth) || expected.birth == 0) return false;
  expected.check_birth = true;
  const auto body = token.substr(first + 1);
  if (!restore && body == L"-") return true;
  const size_t size_end = body.find(L':');
  if (size_end == std::wstring::npos) return false;
  const size_t time_end = body.find(L':', size_end + 1);
  if (time_end == std::wstring::npos || body.size() != time_end + 130 || body[time_end + 65] != L':') return false;
  ULONGLONG number = 0;
  BYTE digest[32];
  if (!parse_number(body.substr(0, size_end).c_str(), number)
      || !parse_number(body.substr(size_end + 1, time_end - size_end - 1).c_str(), number)
      || !decode_hex(body.substr(time_end + 1, 64), digest, sizeof(digest))
      || !decode_hex(body.substr(time_end + 66), digest, sizeof(digest))) return false;
  for (const wchar_t digit : body) expected.content += static_cast<char>(digit);
  return true;
}

inline bool matches(HANDLE file, const ExpectedFile& expected) {
  FILE_ID_INFO actual{};
  if (!ordinary(file) || !read_id(file, actual) || !same_id(actual, expected.id)) return false;
  if (!expected.check_birth) return false;
  FILE_BASIC_INFO basic{};
  ULONGLONG birth = 0;
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic))
      || !time_ns(basic.CreationTime, birth) || birth != expected.birth) return false;
  std::string content;
  return expected.content.empty() || (fingerprint(file, basic, content) && content == expected.content);
}

enum class EntryMode { kRemove, kRetireHidden, kRenameAway, kRestore, kRecordWrite, kRecordRemove, kRecordSweep };

struct EntryChange {
  EntryMode mode;
  const ExpectedFile* stamp = nullptr;
  HANDLE destination = INVALID_HANDLE_VALUE;
  const std::wstring* target = nullptr;
  const BYTE* body = nullptr;
  DWORD length = 0;
  const std::string* digest = nullptr;
  bool allow_reparse = false;
  ExpectedFile* written = nullptr;
};

inline DWORD create_private_record(HANDLE directory, const std::wstring& name, const BYTE* bytes, DWORD length,
    ExpectedFile& stamp, FileFailure& failure);

inline bool read_stamp(HANDLE file, ExpectedFile& stamp) {
  stamp.check_birth = read_id(file, stamp.id) && read_birth(file, stamp.birth);
  return stamp.check_birth;
}

inline FileFailure mutate_entry(HANDLE directory, const std::wstring& name, PinnedHandle& entry, const EntryChange& change) {
  if (change.mode == EntryMode::kRecordWrite) {
    FileFailure failure;
    const DWORD error = create_private_record(directory, name, change.body, change.length, *change.written, failure);
    return failure.error == ERROR_SUCCESS ? FileFailure{error} : failure;
  }
  if (change.stamp == nullptr || !change.stamp->check_birth || change.stamp->birth == 0)
    return {ERROR_NOT_SUPPORTED};
  const auto& expected = *change.stamp;
  ExpectedFile observed;
  if (!read_stamp(entry.value, observed) || !same_id(observed.id, expected.id) || observed.birth != expected.birth ||
      (!change.allow_reparse && !matches(entry.value, expected)) ||
      check_name(directory, name, expected.id, expected.birth, change.allow_reparse) != NameIdentity::kMatches)
    return {ERROR_ACCESS_DENIED};
  if (change.digest != nullptr) {
    LARGE_INTEGER size{};
    std::string digest;
    if (!GetFileSizeEx(entry.value, &size) || size.QuadPart != change.length ||
        !hash_span(entry.value, 0, change.length, digest) || digest != *change.digest) return {ERROR_ACCESS_DENIED};
  }

  if (change.mode == EntryMode::kRenameAway || change.mode == EntryMode::kRestore) {
    PinnedHandle operation(INVALID_HANDLE_VALUE);
    if (!DuplicateHandle(GetCurrentProcess(), entry.value, GetCurrentProcess(), &operation.value,
        0, FALSE, DUPLICATE_SAME_ACCESS)) return {GetLastError()};
    const DWORD name_bytes = static_cast<DWORD>(change.target->size() * sizeof(wchar_t));
    std::vector<BYTE> bytes(sizeof(FILE_RENAME_INFO) + name_bytes);
    const auto info = reinterpret_cast<FILE_RENAME_INFO*>(bytes.data());
    info->ReplaceIfExists = FALSE;
    info->RootDirectory = change.destination;
    info->FileNameLength = name_bytes;
    std::memcpy(info->FileName, change.target->data(), name_bytes);
    // The native information class preserves the held root and relative name.
    using SetInformation = NTSTATUS(NTAPI*)(HANDLE, IO_STATUS_BLOCK*, void*, ULONG, FILE_INFORMATION_CLASS);
    const auto set_information = ntdll_function<SetInformation>("NtSetInformationFile");
    if (set_information == nullptr) return {ERROR_INVALID_FUNCTION};
    IO_STATUS_BLOCK io{};
    const NTSTATUS status = set_information(operation.value, &io, info, static_cast<ULONG>(bytes.size()),
      static_cast<FILE_INFORMATION_CLASS>(10));
    if (status < 0) return native_failure(status, "NtSetInformationFile");
    if (!CloseHandle(operation.value)) return {GetLastError()};
    operation.value = INVALID_HANDLE_VALUE;
    return check_name(change.destination, *change.target, expected.id, expected.birth) == NameIdentity::kMatches
      ? FileFailure{} : FileFailure{ERROR_ACCESS_DENIED};
  }

  FILE_DISPOSITION_INFO disposition{TRUE};
  if (!SetFileInformationByHandle(entry.value, FileDispositionInfo, &disposition, sizeof(disposition))) return {GetLastError()};
  if (!CloseHandle(entry.value)) return {GetLastError()};
  entry.value = INVALID_HANDLE_VALUE;
  Entry result = Entry::kOther;
  const FileFailure probe = classify(directory, name, result);
  if (probe.error != ERROR_SUCCESS) return probe;
  return result == Entry::kAbsent ? FileFailure{} : FileFailure{ERROR_ACCESS_DENIED};
}

inline std::string snapshot(HANDLE file, const FILE_ID_INFO& id) {
  FILE_BASIC_INFO basic{};
  ULONGLONG birth = 0;
  std::string content;
  if (!GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic))
      || !time_ns(basic.CreationTime, birth) || !fingerprint(file, basic, content)) return "-";
  return id_text(id, ':') + ":" + std::to_string(birth) + ":" + content;
}

inline bool hidden_name(const std::wstring& name) {
  BYTE random[16];
  return name.size() == 42 && name.front() == L'.' && name.substr(33) == L".removing"
    && decode_hex(name.substr(1, 32), random, sizeof(random));
}

struct Retirement {
  NameIdentity original;
  bool removed = false;
  std::string leftover = "left";
};

inline Retirement retire(HANDLE directory, const std::wstring& name, PinnedHandle& file, const FILE_ID_INFO& id, ULONGLONG birth) {
  Retirement result{check_name(directory, name, id, birth)};
  if (result.original != NameIdentity::kMatches) return result;
  // The handle excludes deleters while it verifies the name and sets disposition.
  // Keep the recorded name so a pending disposition can be observed on restart.
#if defined(AVE_TEST_DIR_RECOVERY)
  if (test_remove_result().error != ERROR_SUCCESS) return result;
#endif
  const ExpectedFile expected{id, true, birth, {}};
  result.removed = mutate_entry(directory, name, file, {EntryMode::kRemove, &expected}).error == ERROR_SUCCESS;
  if (!result.removed) result.leftover = "left remove-failed";
  return result;
}

inline int stopped_copy(HANDLE directory, const std::wstring& name, PinnedHandle& file, const FILE_ID_INFO& id, ULONGLONG birth,
    FileFailure failure, bool refused_commit) {
  const Retirement result = retire(directory, name, file, id, birth);
  const bool gone = result.removed || result.original == NameIdentity::kAbsent;
  const std::string suffix = gone ? "" : " " + result.leftover;
  if (refused_commit) return refused(gone ? "target removed" : ("target" + suffix).c_str());
  if (failure.error != ERROR_SUCCESS) return failed(failure, suffix.c_str());
  return done(("cancelled" + suffix).c_str());
}

enum class RecoveryMode { kRemove, kRestorePart, kRestoreTarget };

inline int recover_target(HANDLE directory, const std::wstring& hidden, const std::wstring& target,
    const ExpectedFile& old, const wchar_t* replacement, const ExpectedFile& writer) {
  const bool retire_only = replacement != nullptr && std::wcscmp(replacement, L"retire") == 0;
  const ACCESS_MASK read_access = FILE_READ_ATTRIBUTES | (old.content.empty() ? 0 : FILE_READ_DATA);
  PinnedHandle published(INVALID_HANDLE_VALUE);
  bool vacant = false;
  bool committed = retire_only;
  if (!retire_only) {
    const NTSTATUS opening = open_relative(directory, target, read_access, FILE_SHARE_READ,
      kOpenExisting, kOpenReparsePoint, published.value);
    vacant = opening < 0 && missing(status_error(opening));
    if (opening < 0 && !vacant) return done("left");
    committed = !vacant && replacement != nullptr && matches(published.value, writer)
      && check_name(directory, target, writer.id, writer.birth) == NameIdentity::kMatches;
  }
  PinnedHandle source(INVALID_HANDLE_VALUE);
  const NTSTATUS opening = open_relative(directory, hidden, read_access | DELETE, FILE_SHARE_READ,
    kOpenExisting, kOpenReparsePoint, source.value);
  if (opening < 0) {
    if (!missing(status_error(opening))) return done("left");
    const bool restored = published.value != INVALID_HANDLE_VALUE && matches(published.value, old)
      && check_name(directory, target, old.id, old.birth) == NameIdentity::kMatches;
    return done(committed || restored ? "resolved" : "left");
  }
  if (!matches(source.value, old) || check_name(directory, hidden, old.id, old.birth) != NameIdentity::kMatches) return done("left");
  if (committed) {
    return done(mutate_entry(directory, hidden, source, {EntryMode::kRetireHidden, &old}).error == ERROR_SUCCESS ? "resolved" : "left");
  }
  return done(vacant && mutate_entry(directory, hidden, source, {EntryMode::kRestore, &old, directory, &target}).error == ERROR_SUCCESS
    ? "resolved" : "left");
}

inline int run_recovery(int argc, wchar_t** argv, RecoveryMode mode) {
  const bool restore = mode != RecoveryMode::kRemove;
  const std::wstring name(argv[3]);
  const wchar_t* part_name = restore ? argv[4] : L"";
  if (!plain_name(argv[3]) || (restore && (!plain_name(part_name) || _wcsicmp(argv[3], part_name) == 0))) return kExitUsage;
  if (mode == RecoveryMode::kRestoreTarget && !hidden_name(name)) return kExitUsage;
  const int id = restore ? 5 : 4;
  ExpectedFile expected;
  if (!parse_id(argv[id], argv[id + 1], expected.id)
      || (argc > id + 2 && !parse_fingerprint(argv[id + 2], mode == RecoveryMode::kRestorePart, expected))) return kExitUsage;
  const wchar_t* replacement = mode == RecoveryMode::kRestoreTarget && argc > id + 3 ? argv[id + 3] : nullptr;
  ExpectedFile writer;
  if (replacement != nullptr && std::wcscmp(replacement, L"retire") != 0) {
    const std::wstring token(replacement);
    const size_t separator = token.find(L':');
    if (separator == std::wstring::npos || !parse_id(argv[id], token.substr(0, separator).c_str(), writer.id) ||
        same_id(writer.id, expected.id) || !parse_number(token.c_str() + separator + 1, writer.birth) || writer.birth == 0)
      return kExitUsage;
    writer.check_birth = true;
  }
  HeldDirectory directory;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (mode == RecoveryMode::kRestoreTarget)
    return recover_target(directory.handle(), name, part_name, expected, replacement, writer);
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS opening = open_relative(directory.handle(), name, FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE,
    FILE_SHARE_READ, kOpenExisting, kOpenReparsePoint, opened);
  if (opening < 0) {
    return done(missing(status_error(opening)) ? "absent" : "left");
  }
  PinnedHandle source(opened);
  if (!matches(source.value, expected)) return done("left");
  if (!restore) {
    const Retirement result = retire(directory.handle(), name, source, expected.id, expected.birth);
    if (result.removed) return done("removed");
    return done(result.original == NameIdentity::kAbsent ? "absent" : result.leftover.c_str());
  }

  HANDLE created = INVALID_HANDLE_VALUE;
  const NTSTATUS creating = open_relative(directory.handle(), part_name, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES,
    0, kCreateNew, kNonDirectoryFile | kSequentialOnly, created);
  if (creating < 0) return done("left");
  const PinnedHandle target(created);
  FILE_ID_INFO target_id{};
  if (!read_id(target.value, target_id) || !seek_to(source.value, 0)) return done("left");
  std::vector<BYTE> buffer(kCopyChunk);
  for (;;) {
    DWORD count = 0;
    if (!ReadFile(source.value, buffer.data(), kCopyChunk, &count, nullptr)) return done("left");
    if (count == 0) break;
    DWORD written = write_all(target.value, buffer.data(), count);
#if defined(AVE_TEST_DIR_RECOVERY)
    written = test_restore_write_result(written);
#endif
    if (written != ERROR_SUCCESS) return done("left");
  }
  // Keep both names on a failed copy or verification. Retire the source while the target still excludes writers and deleters.
  if (!FlushFileBuffers(target.value) || check_name(directory.handle(), part_name, target_id) != NameIdentity::kMatches) return done("left");
  const Retirement result = retire(directory.handle(), name, source, expected.id, expected.birth);
  if (!result.removed) return done(result.leftover.c_str());
  return done("restored");
}

inline bool record_name(const std::wstring& name) {
  if (name.size() != 45 || name.compare(32, 13, L".cleanup.json") != 0) return false;
  for (size_t index = 0; index < 32; ++index) {
    if (hex_digit(name[index]) < 0) return false;
  }
  return true;
}

inline int run_list_records(wchar_t** argv) {
  HeldDirectory directory;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  std::string outcome = "records";
  std::vector<BYTE> buffer(64 * 1024);
  for (bool first = true;; first = false) {
    if (!GetFileInformationByHandleEx(directory.handle(), first ? FileFullDirectoryRestartInfo : FileFullDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      const DWORD error = GetLastError();
      return error == ERROR_NO_MORE_FILES ? done(outcome.c_str()) : failed(error);
    }
    for (size_t offset = 0;;) {
      const auto entry = reinterpret_cast<const FILE_FULL_DIR_INFO*>(buffer.data() + offset);
      const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (record_name(name)) {
        if (outcome.size() + 47 > 1024 * 1024) return failed(ERROR_FILE_TOO_LARGE);
        outcome += ' ';
        for (const wchar_t digit : name) outcome += static_cast<char>(digit);
      }
      if (entry->NextEntryOffset == 0) break;
      offset += entry->NextEntryOffset;
    }
  }
}

inline DWORD create_private_record(HANDLE directory, const std::wstring& name, const BYTE* bytes, DWORD length,
    ExpectedFile& stamp, FileFailure& failure) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) return GetLastError();
  const PinnedHandle token(raw_token);
  DWORD needed = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &needed);
  if (needed == 0) return GetLastError();
  std::vector<BYTE> storage(needed);
  if (!GetTokenInformation(token.value, TokenUser, storage.data(), needed, &needed)) return GetLastError();
  wchar_t* sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<const TOKEN_USER*>(storage.data())->User.Sid, &sid)) return GetLastError();
  const std::wstring sddl = std::wstring(L"D:P(A;;FA;;;") + sid + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR security = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &security, nullptr)) return GetLastError();
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS creating = open_relative(directory, name, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES,
    0, kCreateNew, kNonDirectoryFile, opened, security);
  LocalFree(security);
  if (creating < 0) {
    failure = native_failure(creating, "NtCreateFile");
    return failure.error;
  }
  PinnedHandle entry(opened);
  const DWORD written = write_all(entry.value, bytes, length);
  if (written != ERROR_SUCCESS) return written;
  if (!FlushFileBuffers(entry.value)) return GetLastError();
  std::string expected, actual;
  LARGE_INTEGER size{};
  if (!read_stamp(entry.value, stamp) || !GetFileSizeEx(entry.value, &size) || size.QuadPart != length ||
      !hash_bytes(bytes, length, expected) ||
      !hash_span(entry.value, 0, length, actual) || actual != expected) return ERROR_WRITE_FAULT;
  if (!CloseHandle(entry.value)) return GetLastError();
  entry.value = INVALID_HANDLE_VALUE;
  return check_name(directory, name, stamp.id, stamp.birth) == NameIdentity::kMatches ? ERROR_SUCCESS : ERROR_WRITE_FAULT;
}

enum class RecordMode { kRead, kWrite, kRemove, kSweep };

inline int run_record(wchar_t** argv, RecordMode mode) {
  const std::wstring name(argv[3]);
  if (!record_name(name)) return kExitUsage;
  ULONGLONG limit = 0;
  BYTE bytes[kRecordLimit + 1];
  ExpectedFile stamp;
  std::string removal_digest;
  if (mode == RecordMode::kWrite) {
    const std::wstring payload(argv[4]);
    limit = payload.size() / 2;
    if (limit > kRecordLimit || !decode_hex(payload, bytes, static_cast<size_t>(limit))) return kExitUsage;
  } else if (mode == RecordMode::kRemove) {
    BYTE digest[32];
    if (!parse_id(argv[4], argv[5], stamp.id) || !parse_number(argv[6], stamp.birth) || stamp.birth == 0 ||
        !parse_number(argv[7], limit) || limit > kRecordLimit || !decode_hex(argv[8], digest, sizeof(digest))) return kExitUsage;
    stamp.check_birth = true;
    removal_digest = hex_bytes(digest, sizeof(digest));
  } else if (!parse_number(argv[4], limit) || limit == 0 || limit > kRecordLimit) {
    return kExitUsage;
  }
  HeldDirectory directory;
  const int status = hold_directory(argv[0], argv[1], argv[2], "from", directory);
  if (status != 0) return status;
  if (!proceed("ready")) return done("cancelled");
  if (mode == RecordMode::kWrite) {
    PinnedHandle record(INVALID_HANDLE_VALUE);
    const FileFailure written = mutate_entry(directory.handle(), name, record,
      {EntryMode::kRecordWrite, nullptr, INVALID_HANDLE_VALUE, nullptr, bytes, static_cast<DWORD>(limit), nullptr, false, &stamp});
    return written.error == ERROR_SUCCESS
      ? done(("written " + id_text(stamp.id, ':') + ":" + std::to_string(stamp.birth)).c_str()) : failed(written);
  }
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NTSTATUS opening = open_relative(directory.handle(), name,
    FILE_READ_DATA | FILE_READ_ATTRIBUTES | (mode != RecordMode::kRead ? DELETE : 0),
    FILE_SHARE_READ, kOpenExisting, kOpenReparsePoint, opened);
  if (opening < 0) return missing(status_error(opening)) ? done("absent") : failed(native_failure(opening, "NtCreateFile"));
  PinnedHandle entry(opened);
  if (!ordinary(entry.value)) return done("absent");
  if (mode == RecordMode::kRemove) {
    const FileFailure removed = mutate_entry(directory.handle(), name, entry,
      {EntryMode::kRecordRemove, &stamp, INVALID_HANDLE_VALUE, nullptr, nullptr, static_cast<DWORD>(limit), &removal_digest});
    return done(removed.error == ERROR_SUCCESS ? "removed" : "kept");
  }
  if (mode == RecordMode::kSweep) {
    if (!read_id(entry.value, stamp.id) || !read_birth(entry.value, stamp.birth)) return done("absent");
    stamp.check_birth = true;
  }
  DWORD used = 0;
  while (used <= limit) {
    DWORD count = 0;
    if (!ReadFile(entry.value, bytes + used, static_cast<DWORD>(limit) + 1 - used, &count, nullptr)) return failed(GetLastError());
    if (count == 0) break;
    used += count;
  }
  if (used > limit) return failed(ERROR_FILE_TOO_LARGE);
  if (mode == RecordMode::kRead) return done(("record " + hex_bytes(bytes, used)).c_str());
  const std::string frame = "record " + id_text(stamp.id, ':') + ":" + std::to_string(stamp.birth) + " " + hex_bytes(bytes, used);
  std::string expected;
  if (!hash_bytes(bytes, used, expected)) return done("absent");
  if (!proceed(frame.c_str())) return done("kept");
  const FileFailure removed = mutate_entry(directory.handle(), name, entry,
    {EntryMode::kRecordSweep, &stamp, INVALID_HANDLE_VALUE, nullptr, nullptr, used, &expected});
  return done(removed.error == ERROR_SUCCESS ? "removed" : "kept");
}

}  // namespace dir_ops
