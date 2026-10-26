#pragma once

#include <cstdint>
#include <utility>

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
  FILE_ATTRIBUTE_TAG_INFO tag{};
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
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &facts.tag, sizeof(facts.tag))
      || !GetFileInformationByHandleEx(handle, FileIdInfo, &facts.id, sizeof(facts.id))
      || !GetFileInformationByHandle(handle, &facts.legacy)) return false;
  const DWORD length = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length > 32768) return false;
  std::vector<wchar_t> buffer(static_cast<size_t>(length) + 1);
  const DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (written == 0 || written >= buffer.size()) return false;
  facts.canonical.assign(buffer.data(), written);
  facts.exists = 1;
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
    HANDLE handle = CreateFileW(extended.c_str(), access, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) return false;
      facts.exists = 0;
      missing = true;
      continue;
    }
    pinned.handles.emplace_back(handle);
    if (!handle_facts(handle, facts)) return false;
    blocked = (facts.tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if (!blocked && index + 1 < pinned.components.size() && (facts.tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
  }
  return true;
}

// The compatibility deny mode keeps its refusal contract; facts modes report all tags.
bool ordinary_handle(HANDLE handle, bool& directory) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return false;
  directory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

}  // namespace
