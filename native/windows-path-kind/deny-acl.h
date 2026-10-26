// Read-only deny proof. Path components stay pinned while their DACLs are read.
#include <cstddef>

namespace {

struct DenyMasks {
  DWORD mask = 0;
  DWORD inheritable = 0;
};

bool read_leading_denies(HANDLE handle, PSID sid, DenyMasks& masks) {
  NativeDacl facts;
  if (!read_descriptor(handle, facts)) return false;
  const auto dacl = facts.dacl;
  if (dacl == nullptr) return true;
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

bool read_deny_row(const wchar_t* input, PSID sid, std::string& output) {
  PinnedPath pinned;
  if (!pin_path(input, pinned)) return false;
  bool directory = false;
  for (const auto& handle : pinned.handles) {
    if (!ordinary_handle(handle.value, directory)) return false;
  }
  if (pinned.facts.back().exists == 0) {
    output += "{\"denyMask\":0,\"inheritableMask\":0,\"parentMask\":0,\"directory\":false}";
    return true;
  }
  const auto& handles = pinned.handles;
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
