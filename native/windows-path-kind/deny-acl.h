// Read-only deny proof. Path components stay pinned while their DACLs are read.
#include <aclapi.h>
#include <sddl.h>
#include <cstddef>

#pragma comment(lib, "advapi32.lib")

namespace {

struct PinnedHandle {
  HANDLE value;
  explicit PinnedHandle(HANDLE handle) : value(handle) {}
  PinnedHandle(const PinnedHandle&) = delete;
  PinnedHandle& operator=(const PinnedHandle&) = delete;
  PinnedHandle(PinnedHandle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  ~PinnedHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

struct LocalAllocation {
  void* value = nullptr;
  ~LocalAllocation() { if (value != nullptr) LocalFree(value); }
};

struct DenyMasks {
  DWORD mask = 0;
  DWORD inheritable = 0;
};

bool read_leading_denies(HANDLE handle, PSID sid, DenyMasks& masks) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &dacl, nullptr, &descriptor);
  LocalAllocation allocation{descriptor};
  if (result != ERROR_SUCCESS || descriptor == nullptr || !IsValidSecurityDescriptor(descriptor)) return false;
  if (dacl == nullptr) return true;
  if (!IsValidAcl(dacl)) return false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(dacl, index, &raw)) return false;
    const auto* header = static_cast<const ACE_HEADER*>(raw);
    // Later denies cannot undo access already satisfied by an earlier allow.
    if (header->AceType != ACCESS_DENIED_ACE_TYPE || (header->AceFlags & INHERITED_ACE) != 0) break;
    if (header->AceSize < sizeof(ACCESS_DENIED_ACE)) return false;
    auto* ace = static_cast<ACCESS_DENIED_ACE*>(raw);
    PSID trustee = &ace->SidStart;
    if (!IsValidSid(trustee) || GetLengthSid(trustee) > header->AceSize - offsetof(ACCESS_DENIED_ACE, SidStart)) return false;
    if (!EqualSid(trustee, sid) || (header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    masks.mask |= ace->Mask;
    constexpr BYTE inheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    if ((header->AceFlags & inheritance) == inheritance && (header->AceFlags & NO_PROPAGATE_INHERIT_ACE) == 0) {
      masks.inheritable |= ace->Mask;
    }
  }
  return true;
}

bool ordinary_handle(HANDLE handle, bool& directory) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return false;
  directory = (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  return (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

bool read_deny_row(const wchar_t* input, PSID sid, std::string& output) {
  const DWORD length = GetFullPathNameW(input, 0, nullptr, nullptr);
  if (length == 0 || length > 32768) return false;
  std::vector<wchar_t> buffer(length);
  const DWORD written = GetFullPathNameW(input, length, buffer.data(), nullptr);
  if (written == 0 || written >= length) return false;
  std::wstring path(buffer.data());
  if (path.compare(0, 8, L"\\\\?\\UNC\\") == 0) path = L"\\\\" + path.substr(8);
  else if (path.compare(0, 4, L"\\\\?\\") == 0) path = path.substr(4);
  size_t root_end = 0;
  if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') root_end = 3;
  else if (path.compare(0, 2, L"\\\\") == 0 && path.size() > 2 && path[2] != L'.') {
    const size_t server_end = path.find(L'\\', 2);
    if (server_end == std::wstring::npos) return false;
    const size_t share_end = path.find(L'\\', server_end + 1);
    root_end = share_end == std::wstring::npos ? path.size() : share_end + 1;
  } else return false;
  while (path.size() > root_end && path.back() == L'\\') path.pop_back();
  if (path.find(L':', root_end) != std::wstring::npos) return false;
  std::vector<std::wstring> components{path.substr(0, root_end)};
  for (size_t end = root_end; end < path.size();) {
    end = path.find(L'\\', end + 1);
    if (end == std::wstring::npos) end = path.size();
    components.push_back(path.substr(0, end));
  }
  std::vector<PinnedHandle> handles;
  bool directory = false;
  for (const auto& component : components) {
    const std::wstring extended = component.compare(0, 2, L"\\\\") == 0
      ? L"\\\\?\\UNC\\" + component.substr(2) : L"\\\\?\\" + component;
    HANDLE handle = CreateFileW(extended.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
        output += "{\"denyMask\":0,\"inheritableMask\":0,\"parentMask\":0,\"directory\":false}";
        return true;
      }
      return false;
    }
    handles.emplace_back(handle);
    if (!ordinary_handle(handle, directory)) return false;
    if (handles.size() < components.size() && !directory) return false;
  }
  if (handles.size() < 2) return false;
  DenyMasks target, parent;
  if (!read_leading_denies(handles.back().value, sid, target)
      || !read_leading_denies(handles[handles.size() - 2].value, sid, parent)) return false;
  for (const auto& handle : handles) {
    bool ignored = false;
    if (!ordinary_handle(handle.value, ignored)) return false;
  }
  output += "{\"denyMask\":" + std::to_string(target.mask)
    + ",\"inheritableMask\":" + std::to_string(target.inheritable)
    + ",\"parentMask\":" + std::to_string(parent.mask)
    + ",\"directory\":" + (directory ? "true}" : "false}");
  return true;
}

int print_deny_acls(int argc, wchar_t** argv) {
  PSID sid = nullptr;
  if (argc < 4 || !ConvertStringSidToSidW(argv[2], &sid)) {
    std::fputs("invalid deny DACL request\n", stderr);
    return 2;
  }
  LocalAllocation allocation{sid};
  std::string output = "[";
  for (int index = 3; index < argc; ++index) {
    if (index != 3) output += ",";
    if (!read_deny_row(argv[index], sid, output)) {
      std::fputs("could not verify deny DACL handles\n", stderr);
      return 4;
    }
  }
  output += "]\n";
  return std::fwrite(output.data(), 1, output.size(), stdout) == output.size() && std::fflush(stdout) == 0 ? 0 : 3;
}

}  // namespace
