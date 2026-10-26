#pragma once

#include <aclapi.h>
#include <sddl.h>

#pragma comment(lib, "advapi32.lib")

namespace {

struct LocalAllocation {
  void* value = nullptr;
  ~LocalAllocation() { if (value != nullptr) LocalFree(value); }
};

struct NativeDacl {
  PSID owner = nullptr;
  PSID group = nullptr;
  PACL dacl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control{};
  LocalAllocation allocation;
};

bool read_descriptor(HANDLE handle, NativeDacl& facts) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &facts.owner, &facts.group, &facts.dacl, nullptr, &descriptor);
  facts.allocation.value = descriptor;
  if (result != ERROR_SUCCESS || descriptor == nullptr || !IsValidSecurityDescriptor(descriptor)) return false;
  DWORD revision = 0;
  return GetSecurityDescriptorControl(descriptor, &facts.control, &revision)
    && (facts.dacl == nullptr || IsValidAcl(facts.dacl));
}

}  // namespace
