#pragma once

#include <cstdint>
#include <utility>
#include <winternl.h>
#include <winioctl.h>

namespace {

struct PinnedHandle {
  HANDLE value;
  explicit PinnedHandle(HANDLE handle) : value(handle) {}
  PinnedHandle(const PinnedHandle&) = delete;
  PinnedHandle& operator=(const PinnedHandle&) = delete;
  PinnedHandle(PinnedHandle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  ~PinnedHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

struct PathFacts {
  // -1 means not inspected: an enclosing reparse object was not followed.
  int exists = -1;
  std::wstring canonical;
  FILE_ID_INFO id{};
  BY_HANDLE_FILE_INFORMATION legacy{};
  LARGE_INTEGER change_time{};
  std::wstring file_system_name;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  std::wstring reparse_target;
};

struct PinnedPath {
  std::vector<std::wstring> components;
  std::vector<PinnedHandle> handles;
  std::vector<PathFacts> facts;
};

bool path_components(const wchar_t* input, std::vector<std::wstring>& components) {
  std::wstring original(input);
  // Reject relative, drive-relative and device namespace paths before normalization.
  if (original.compare(0, 4, L"\\\\.\\") == 0) return false;
  if (original.compare(0, 8, L"\\\\?\\UNC\\") == 0) original = L"\\\\" + original.substr(8);
  else if (original.compare(0, 4, L"\\\\?\\") == 0) original = original.substr(4);
  for (auto& character : original) if (character == L'/') character = L'\\';
  if (!(original.size() >= 3 && original[1] == L':' && original[2] == L'\\')
      && original.compare(0, 2, L"\\\\") != 0) return false;
  const DWORD length = GetFullPathNameW(original.c_str(), 0, nullptr, nullptr);
  if (length == 0 || length > 32768) return false;
  std::vector<wchar_t> buffer(length);
  const DWORD written = GetFullPathNameW(original.c_str(), length, buffer.data(), nullptr);
  if (written == 0 || written >= length) return false;
  std::wstring path(buffer.data());
  size_t root_end = 0;
  if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') root_end = 3;
  else if (path.compare(0, 2, L"\\\\") == 0 && path.size() > 2 && path[2] != L'.') {
    const size_t server_end = path.find(L'\\', 2);
    if (server_end == std::wstring::npos || server_end == 2) return false;
    const size_t share_end = path.find(L'\\', server_end + 1);
    root_end = share_end == std::wstring::npos ? path.size() : share_end + 1;
    if (root_end <= server_end + 1) return false;
  } else return false;
  while (path.size() > root_end && path.back() == L'\\') path.pop_back();
  if (path.find(L':', root_end) != std::wstring::npos) return false;
  components.push_back(path.substr(0, root_end));
  for (size_t start = root_end; start < path.size();) {
    const size_t separator = path.find(L'\\', start);
    const size_t end = separator == std::wstring::npos ? path.size() : separator;
    if (end > start) components.push_back(path.substr(0, end));
    start = end + 1;
  }
  return true;
}

bool handle_facts(HANDLE handle, PathFacts& facts) {
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &facts.tag, sizeof(facts.tag))
      || !GetFileInformationByHandleEx(handle, FileIdInfo, &facts.id, sizeof(facts.id))
      || !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic))
      || !GetFileInformationByHandle(handle, &facts.legacy)) return false;
  facts.change_time = basic.ChangeTime;
  wchar_t file_system_name[MAX_PATH + 1]{};
  if (GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, nullptr,
      file_system_name, MAX_PATH + 1)) {
    facts.file_system_name = file_system_name;
  }
  const DWORD length = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length > 32768) return false;
  std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1);
  const DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (written == 0 || written >= buffer.size()) return false;
  facts.canonical.assign(buffer.data(), written);
  facts.exists = 1;
  return true;
}

// Child names are resolved by the pinned directory object, never by its pathname.
HANDLE open_child(HANDLE parent, const std::wstring& name, DWORD access) {
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (module == nullptr || name.empty() || name.size() > 32767
      || name.find_first_of(L"\\/:") != std::wstring::npos) { SetLastError(ERROR_INVALID_NAME); return INVALID_HANDLE_VALUE; }
  const auto address = GetProcAddress(module, "NtCreateFile");
  decltype(&NtCreateFile) create = nullptr;
  static_assert(sizeof(create) == sizeof(address));
  std::memcpy(&create, &address, sizeof(create));
  if (create == nullptr) { SetLastError(ERROR_PROC_NOT_FOUND); return INVALID_HANDLE_VALUE; }
  UNICODE_STRING text{};
  text.Buffer = const_cast<wchar_t*>(name.data());
  text.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  text.MaximumLength = text.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &text;
  attributes.Attributes = 0x40;  // OBJ_CASE_INSENSITIVE
  IO_STATUS_BLOCK status{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  // FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT.
  const NTSTATUS result = create(&handle, access | SYNCHRONIZE, &attributes, &status, nullptr,
    0, FILE_SHARE_READ, FILE_OPEN, 0x00204020, nullptr, 0);
  if (result < 0) {
    SetLastError(result == static_cast<NTSTATUS>(0xc0000034) ? ERROR_FILE_NOT_FOUND
      : result == static_cast<NTSTATUS>(0xc000003a) ? ERROR_PATH_NOT_FOUND : ERROR_OPEN_FAILED);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

bool read_reparse_target(HANDLE handle, PathFacts& facts) {
  if (facts.tag.ReparseTag != IO_REPARSE_TAG_MOUNT_POINT && facts.tag.ReparseTag != IO_REPARSE_TAG_SYMLINK) return true;
  std::vector<BYTE> bytes(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
  DWORD returned = 0;
  if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(),
      static_cast<DWORD>(bytes.size()), &returned, nullptr) || returned < 16) return false;
  DWORD tag = 0; WORD length = 0, offset = 0, size = 0;
  std::memcpy(&tag, bytes.data(), 4);
  std::memcpy(&length, bytes.data() + 4, 2);
  std::memcpy(&offset, bytes.data() + 8, 2);
  std::memcpy(&size, bytes.data() + 10, 2);
  const size_t start = tag == IO_REPARSE_TAG_SYMLINK ? 20 : 16;
  if (tag != facts.tag.ReparseTag || static_cast<size_t>(length) + 8 > returned || size == 0
      || offset % 2 != 0 || size % 2 != 0 || start + offset + size > static_cast<size_t>(length) + 8) return false;
  facts.reparse_target.resize(size / sizeof(wchar_t));
  std::memcpy(facts.reparse_target.data(), bytes.data() + start + offset, size);
  if (facts.reparse_target.find(L'\0') != std::wstring::npos) return false;
  DWORD flags = 0;
  if (tag == IO_REPARSE_TAG_SYMLINK) std::memcpy(&flags, bytes.data() + 16, sizeof(flags));
  if ((flags & ~1u) != 0) return false;
  if ((flags & 1) != 0) return facts.reparse_target.find_first_of(L"\\/") != 0
    && facts.reparse_target.find(L':') == std::wstring::npos;
  if (facts.reparse_target.compare(0, 8, L"\\??\\UNC\\") == 0) facts.reparse_target = L"\\\\" + facts.reparse_target.substr(8);
  else if (facts.reparse_target.compare(0, 4, L"\\??\\") == 0) facts.reparse_target.erase(0, 4);
  // Unmapped device/volume targets must not be reinterpreted as relative grants.
  return facts.reparse_target.compare(0, 2, L"\\\\") == 0
    || (facts.reparse_target.size() >= 3 && facts.reparse_target[1] == L':' && facts.reparse_target[2] == L'\\');
}

bool verify_pinned_path(const PinnedPath& pinned) {
  for (size_t index = 0; index < pinned.handles.size(); ++index) {
    PathFacts current;
    const auto& previous = pinned.facts[index];
    if (!handle_facts(pinned.handles[index].value, current)
        || current.id.VolumeSerialNumber != previous.id.VolumeSerialNumber
        || std::memcmp(&current.id.FileId, &previous.id.FileId, sizeof(FILE_ID_128)) != 0
        || current.tag.FileAttributes != previous.tag.FileAttributes || current.tag.ReparseTag != previous.tag.ReparseTag
        || current.canonical != previous.canonical) return false;
  }
  return true;
}

bool pin_path(const wchar_t* input, PinnedPath& pinned, bool content = false) {
  if (!path_components(input, pinned.components)) return false;
  bool blocked = false;
  bool missing = false;
  for (size_t index = 0; index < pinned.components.size(); ++index) {
    pinned.facts.emplace_back();
    auto& facts = pinned.facts.back();
    if (blocked || missing) { if (missing) facts.exists = 0; continue; }
    const auto& component = pinned.components[index];
    const std::wstring extended = component.compare(0, 2, L"\\\\") == 0
      ? L"\\\\?\\UNC\\" + component.substr(2) : L"\\\\?\\" + component;
    DWORD access = FILE_READ_ATTRIBUTES | READ_CONTROL;
    if (content && index + 1 == pinned.components.size()) access |= FILE_READ_DATA;
    HANDLE handle = index == 0
      ? CreateFileW(extended.c_str(), access, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)
      : open_child(pinned.handles.back().value, component.substr(pinned.components[index - 1].size()
          + (pinned.components[index - 1].back() == L'\\' ? 0 : 1)), access);
    if (handle == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return false;
      facts.exists = 0;
      missing = true;
      continue;
    }
    pinned.handles.emplace_back(handle);
    if (!handle_facts(handle, facts) || !read_reparse_target(handle, facts)) return false;
    blocked = (facts.tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
      && (facts.tag.ReparseTag == 0 || (facts.tag.ReparseTag & 0x20000000) != 0);
    if (!blocked && index + 1 < pinned.components.size() && (facts.tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
  }
  return verify_pinned_path(pinned);
}

// The compatibility deny mode keeps its refusal contract; facts modes report all tags.
bool ordinary_handle(HANDLE handle, bool& directory) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return false;
  directory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

}  // namespace
