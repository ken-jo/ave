#include <windows.h>
#include <winternl.h>
#include <winioctl.h>
#include <aclapi.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "pin.h"
#pragma comment(lib, "ntdll.lib")
#pragma comment(lib, "advapi32.lib")

namespace {
int fail(const char* stage) {
  std::fprintf(stderr, "%s failed: %lu\n", stage, GetLastError());
  return 1;
}
bool junction(const std::wstring& path, const std::wstring& target) {
  PinnedHandle writer(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (writer.value == INVALID_HANDLE_VALUE) return false;
  const std::wstring substitute = L"\\??\\" + target;
  const WORD size = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  const WORD print_size = static_cast<WORD>(target.size() * sizeof(wchar_t));
  std::vector<BYTE> data(16 + size + print_size + 2 * sizeof(wchar_t));
  const DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
  const WORD length = static_cast<WORD>(data.size() - 8);
  const WORD print_offset = size + sizeof(wchar_t);
  std::memcpy(data.data(), &tag, 4);
  std::memcpy(data.data() + 4, &length, 2);
  std::memcpy(data.data() + 10, &size, 2);
  std::memcpy(data.data() + 12, &print_offset, 2);
  std::memcpy(data.data() + 14, &print_size, 2);
  std::memcpy(data.data() + 16, substitute.data(), size);
  std::memcpy(data.data() + 16 + print_offset, target.data(), print_size);
  DWORD returned = 0;
  return DeviceIoControl(writer.value, FSCTL_SET_REPARSE_POINT, data.data(), static_cast<DWORD>(data.size()),
    nullptr, 0, &returned, nullptr) != 0;
}

bool snapshot(const std::wstring& path, PinnedPath& pinned) {
  // Deliberately permit fixture mutation so the checks can be staged between steps.
  HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  pinned.components.push_back(path);
  pinned.handles.emplace_back(handle);
  pinned.facts.emplace_back();
  return handle_facts(handle, pinned.facts.back());
}

bool pin_facts(const std::wstring& path, PathFacts& facts) {
  PinnedPath pinned;
  if (!pin_path(path.c_str(), pinned)) return false;
  facts = pinned.facts.back();
  return true;
}

bool same_identity(const PathFacts& before, const PathFacts& after) {
  return before.id.VolumeSerialNumber == after.id.VolumeSerialNumber
    && std::memcmp(&before.id.FileId, &after.id.FileId, sizeof(FILE_ID_128)) == 0;
}

bool add_fixture_ace(const std::wstring& path) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
  PinnedHandle token(raw);
  DWORD size = 0;
  GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> user(size);
  if (!GetTokenInformation(raw, TokenUser, user.data(), size, &size)) return false;
  const PSID sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  PinnedHandle file(CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return false;
  PACL previous = nullptr;
  PSECURITY_DESCRIPTOR security = nullptr;
  if (GetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &previous, nullptr, &security) != ERROR_SUCCESS) return false;
  if (previous == nullptr) { LocalFree(security); return false; }
  const DWORD ace_size = sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid);
  std::vector<BYTE> bytes(previous->AclSize + ace_size);
  const auto updated = reinterpret_cast<PACL>(bytes.data());
  bool success = InitializeAcl(updated, static_cast<DWORD>(bytes.size()), previous->AclRevision) != 0;
  for (DWORD index = 0; success && index < previous->AceCount; ++index) {
    void* ace = nullptr;
    success = GetAce(previous, index, &ace) && AddAce(updated, previous->AclRevision, MAXDWORD,
      ace, static_cast<ACE_HEADER*>(ace)->AceSize);
  }
  success = success && AddAccessAllowedAceEx(updated, previous->AclRevision, 0, FILE_READ_ATTRIBUTES, sid)
    && SetSecurityInfo(file.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, updated, nullptr) == ERROR_SUCCESS;
  LocalFree(security);
  return success;
}

int change_time(const std::wstring& root) {
  const std::wstring path = root + L"\\change-time", renamed = root + L"\\change-time-renamed";
  { PinnedHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) return fail("create changeTime fixture"); }
  PathFacts original, unchanged, secured, moved;
  if (!pin_facts(path, original) || !pin_facts(path, unchanged)) return fail("pin changeTime fixture");
  if (original.change_time.QuadPart == 0 || original.change_time.QuadPart != unchanged.change_time.QuadPart
      || !same_identity(original, unchanged)) return fail("stable changeTime");
  Sleep(20);
  if (!add_fixture_ace(path) || !pin_facts(path, secured)) return fail("pin after fixture ACL change");
  if (original.change_time.QuadPart == secured.change_time.QuadPart || !same_identity(original, secured)) return fail("ACL changeTime and identity");
  Sleep(20);
  if (!MoveFileExW(path.c_str(), renamed.c_str(), 0) || !pin_facts(renamed, moved)) return fail("pin renamed fixture");
  if (secured.change_time.QuadPart == moved.change_time.QuadPart || !same_identity(secured, moved)) return fail("rename changeTime and identity");
  std::puts("native changeTime: stable pins; ACL and rename advance time while volume serial and file ID stay equal");
  return 0;
}

int non_surrogate_child(const std::wstring& path) {
  if (!CreateDirectoryW(path.c_str(), nullptr)) return -1;
  PinnedHandle parent(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (parent.value == INVALID_HANDLE_VALUE) return -1;
  std::vector<BYTE> data(24);
  data[0] = 0x42;
  // GUID-owned, non-surrogate fixture tag, with no provider-specific payload.
  const GUID owner = {0xdb26d866, 0x5321, 0x4f43, {0x97, 0x7f, 0x45, 0x91, 0xca, 0x0b, 0xf0, 0xee}};
  std::memcpy(data.data() + 8, &owner, sizeof(owner));
  DWORD returned = 0;
  if (!DeviceIoControl(parent.value, FSCTL_SET_REPARSE_POINT, data.data(), static_cast<DWORD>(data.size()),
      nullptr, 0, &returned, nullptr)) return -1;
  wchar_t name[] = L"child";
  UNICODE_STRING text{};
  text.Buffer = name;
  text.Length = text.MaximumLength = 5 * sizeof(wchar_t);
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent.value;
  attributes.ObjectName = &text;
  IO_STATUS_BLOCK status{};
  HANDLE child = INVALID_HANDLE_VALUE;
  const NTSTATUS result = NtCreateFile(&child, GENERIC_WRITE | SYNCHRONIZE, &attributes, &status,
    nullptr, 0, FILE_SHARE_READ, FILE_CREATE, 0x00204020, nullptr, 0);
  if (result < 0) {
    std::fprintf(stdout, "non-surrogate child fixture unavailable: NtCreateFile status=0x%08lx\n", static_cast<ULONG>(result));
    // The fixture has no filesystem provider; clear only its own tag before teardown.
    if (!DeviceIoControl(parent.value, FSCTL_DELETE_REPARSE_POINT, data.data(), static_cast<DWORD>(data.size()),
        nullptr, 0, &returned, nullptr)) return -1;
    return result == static_cast<NTSTATUS>(0xc0000279) ? 0 : -1;
  }
  CloseHandle(child);
  return 1;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  if (change_time(argv[1]) != 0) return 1;
  const std::wstring root = argv[1], parent = root + L"\\retag-parent", target = root + L"\\retag-target";
  if (!CreateDirectoryW(parent.c_str(), nullptr) || !CreateDirectoryW(target.c_str(), nullptr)) return fail("create fixture");
  const std::wstring child = target + L"\\child";
  { PinnedHandle file(CreateFileW(child.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) return fail("create child"); }
  {
    PinnedPath pinned;
    if (!snapshot(parent, pinned)) return fail("snapshot before retag");
    if (!junction(parent, target)) return fail("retag ancestor");
    PinnedHandle opened(open_child(pinned.handles.back().value, L"child", FILE_READ_ATTRIBUTES | READ_CONTROL));
    if (opened.value != INVALID_HANDLE_VALUE) return fail("retagged child lookup redirected");
    if (verify_pinned_path(pinned)) return fail("retag escaped verification");
  }
  if (!RemoveDirectoryW(parent.c_str())) return fail("remove junction");
  if (!CreateDirectoryW(parent.c_str(), nullptr)) return fail("recreate parent");
  {
    PinnedPath pinned;
    const std::wstring parked = root + L"\\parked";
    if (!snapshot(parent, pinned)) return fail("snapshot before swap");
    if (!MoveFileExW(parent.c_str(), parked.c_str(), 0)) return fail("park ancestor");
    if (!CreateDirectoryW(parent.c_str(), nullptr) || !junction(parent, target)) return fail("swap ancestor");
    PinnedHandle opened(open_child(pinned.handles.back().value, L"child", FILE_READ_ATTRIBUTES | READ_CONTROL));
    if (opened.value != INVALID_HANDLE_VALUE) return fail("swapped child lookup redirected");
    if (verify_pinned_path(pinned)) return fail("swap escaped verification");
  }
  // Exercise the full walk too, including its retained-tag verification.
  PinnedPath ordinary;
  if (!pin_path(child.c_str(), ordinary) || !verify_pinned_path(ordinary)) return fail("ordinary full walk");
  bool directory = false;
  if (!ordinary_handle(ordinary.handles.back().value, directory) || directory) return fail("ordinary child");
  const std::wstring cloud = root + L"\\non-surrogate";
  const int cloud_fixture = non_surrogate_child(cloud);
  if (cloud_fixture < 0) return fail("create non-surrogate fixture");
  if (cloud_fixture == 1) {
    PinnedPath cloud_pin;
    if (!pin_path((cloud + L"\\child").c_str(), cloud_pin) || cloud_pin.facts.back().exists != 1) return fail("non-surrogate descent");
    if (cloud_pin.facts[cloud_pin.facts.size() - 2].tag.ReparseTag != 0x42) return fail("non-surrogate tag");
  }
  std::puts("native pin: retagged ancestor and swapped ancestor refused; handle-relative child lookup stayed on original parent");
  return 0;
}
