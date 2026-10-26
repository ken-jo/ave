#pragma once

namespace {

std::string json_string(const std::wstring& text) {
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (length == 0 && !text.empty()) return "null";
  std::string bytes(static_cast<size_t>(length), '\0');
  if (length != 0) WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), bytes.data(), length, nullptr, nullptr);
  std::string output = "\"";
  for (const unsigned char character : bytes) {
    if (character == '"' || character == '\\') { output += '\\'; output += character; }
    else if (character < 32) { char escaped[7]; std::snprintf(escaped, sizeof(escaped), "\\u%04x", character); output += escaped; }
    else output += character;
  }
  return output + "\"";
}

std::string hex_number(ULONGLONG number) {
  char buffer[19];
  std::snprintf(buffer, sizeof(buffer), "0x%016llx", number);
  return "\"" + std::string(buffer) + "\"";
}

std::string file_id(const FILE_ID_128& id) {
  std::string output = "\"0x";
  // Treat the byte sequence as a little-endian integer, so the low 64 bits
  // compare directly with the legacy file index on filesystems that use it.
  for (int index = 15; index >= 0; --index) {
    char byte[3]; std::snprintf(byte, sizeof(byte), "%02x", id.Identifier[index]); output += byte;
  }
  return output + "\"";
}

std::string facts_json(const PathFacts& facts) {
  if (facts.exists != 1) return std::string("{\"exists\":") + (facts.exists == 0 ? "false" : "null")
    + ",\"canonical\":null,\"volumeSerial\":null,\"fileId\":null,\"volumeSerialNumber\":null,\"fileIndex\":null,\"attributes\":0,\"reparseTag\":0,\"reparseTarget\":null,\"directory\":false}";
  return "{\"exists\":true,\"canonical\":" + json_string(facts.canonical)
    + ",\"volumeSerial\":" + hex_number(facts.id.VolumeSerialNumber) + ",\"fileId\":" + file_id(facts.id.FileId)
    + ",\"volumeSerialNumber\":" + hex_number(facts.legacy.dwVolumeSerialNumber)
    + ",\"fileIndex\":" + hex_number((static_cast<ULONGLONG>(facts.legacy.nFileIndexHigh) << 32) | facts.legacy.nFileIndexLow)
    + ",\"attributes\":" + std::to_string(facts.tag.FileAttributes) + ",\"reparseTag\":" + std::to_string(facts.tag.ReparseTag)
    + ",\"reparseTarget\":" + (facts.reparse_target.empty() ? "null" : json_string(facts.reparse_target))
    + ",\"directory\":" + ((facts.tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? "true}" : "false}");
}

bool sid_json(PSID sid, std::string& output) {
  if (sid == nullptr || !IsValidSid(sid)) return false;
  LPWSTR text = nullptr;
  if (!ConvertSidToStringSidW(sid, &text)) return false;
  LocalAllocation allocation{text};
  output = json_string(text);
  return true;
}

std::string account_json(PSID sid) {
  DWORD name_size = 0, domain_size = 0; SID_NAME_USE use{};
  LookupAccountSidW(nullptr, sid, nullptr, &name_size, nullptr, &domain_size, &use);
  if (name_size == 0) return "";
  std::vector<wchar_t> name(name_size), domain(domain_size);
  if (!LookupAccountSidW(nullptr, sid, name.data(), &name_size, domain.data(), &domain_size, &use)) return "";
  return ",\"account\":" + json_string((domain_size == 0 ? L"" : std::wstring(domain.data()) + L"\\") + name.data());
}

bool descriptor_json(HANDLE handle, const PathFacts& facts, std::string& output) {
  NativeDacl security;
  if (!read_descriptor(handle, security)) return false;
  const auto owner = security.owner, group = security.group;
  const auto dacl = security.dacl;
  std::string owner_text, group_text;
  if (!sid_json(owner, owner_text) || (group != nullptr && !sid_json(group, group_text))) return false;
  output = "{\"identity\":{\"volumeSerial\":" + hex_number(facts.id.VolumeSerialNumber)
    + ",\"fileId\":" + file_id(facts.id.FileId) + "},\"owner\":" + owner_text + (group != nullptr ? ",\"group\":" + group_text : "")
    + ",\"protected\":" + ((security.control & SE_DACL_PROTECTED) != 0 ? "true" : "false")
    + ",\"nullDacl\":" + (dacl == nullptr ? "true" : "false") + ",\"aces\":[";
  if (dacl != nullptr) {
    for (DWORD index = 0; index < dacl->AceCount; ++index) {
      void* raw = nullptr;
      if (!GetAce(dacl, index, &raw)) return false;
      const auto* header = static_cast<ACE_HEADER*>(raw);
      if (header->AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK)) return false;
      const auto* bytes = static_cast<const BYTE*>(raw);
      DWORD mask = 0; std::memcpy(&mask, bytes + sizeof(ACE_HEADER), sizeof(mask));
      size_t offset = 0;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE) offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
      else if (header->AceType == ACCESS_ALLOWED_OBJECT_ACE_TYPE || header->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE) {
        if (header->AceSize < 12) return false;
        DWORD flags = 0; std::memcpy(&flags, bytes + 8, sizeof(flags));
        if ((flags & ~(ACE_OBJECT_TYPE_PRESENT | ACE_INHERITED_OBJECT_TYPE_PRESENT)) != 0) return false;
        offset = 12 + ((flags & ACE_OBJECT_TYPE_PRESENT) != 0 ? sizeof(GUID) : 0) + ((flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) != 0 ? sizeof(GUID) : 0);
      }
      std::string trustee = "null", account;
      if (offset != 0) {
        if (offset + 8 > header->AceSize) return false;
        PSID sid = const_cast<BYTE*>(bytes + offset);
        const size_t sid_size = 8 + 4 * static_cast<size_t>(bytes[offset + 1]);
        if (offset + sid_size > header->AceSize || !sid_json(sid, trustee)) return false;
        account = account_json(sid);
      }
      if (index != 0) output += ",";
      output += "{\"type\":" + std::to_string(header->AceType) + ",\"flags\":" + std::to_string(header->AceFlags)
        + ",\"mask\":" + std::to_string(mask) + ",\"sid\":" + trustee + account + "}";
    }
  }
  output += "]}";
  return true;
}

bool token_json(std::string& output) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
  PinnedHandle token(raw);
  DWORD size = 0;
  GetTokenInformation(raw, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(raw, TokenUser, buffer.data(), size, &size)) return false;
  std::string sid;
  if (!sid_json(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, sid)) return false;
  TOKEN_ELEVATION elevation{};
  if (!GetTokenInformation(raw, TokenElevation, &elevation, sizeof(elevation), &size)) return false;
  output = ",\"currentUserSid\":" + sid + ",\"elevated\":" + (elevation.TokenIsElevated != 0 ? "true" : "false") + ",\"principals\":{";
  bool first = true;
  wchar_t machine[MAX_COMPUTERNAME_LENGTH + 1]; DWORD machine_size = MAX_COMPUTERNAME_LENGTH + 1;
  if (!GetComputerNameW(machine, &machine_size)) return false;
  for (const auto* name : {L"srt-sandbox", L"sandbox-runtime-users"}) {
    const std::wstring account = std::wstring(machine) + L"\\" + name;
    DWORD sid_size = 0, domain_size = 0; SID_NAME_USE use{};
    LookupAccountNameW(nullptr, account.c_str(), nullptr, &sid_size, nullptr, &domain_size, &use);
    if (GetLastError() == ERROR_NONE_MAPPED) continue;
    std::vector<BYTE> account_sid(sid_size); std::vector<wchar_t> domain(domain_size);
    if (!LookupAccountNameW(nullptr, account.c_str(), account_sid.data(), &sid_size, domain.data(), &domain_size, &use)) return false;
    std::string account_text;
    if (!sid_json(account_sid.data(), account_text)) return false;
    if (!first) output += ",";
    first = false;
    output += account_text + ":" + json_string(name);
  }
  output += "}";
  return true;
}

bool content_json(HANDLE handle, std::string& output) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0 || size.QuadPart > 1048576) return false;
  std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart)); DWORD read = 0;
  if (!bytes.empty() && (!ReadFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size())) return false;
  static constexpr char HEX[] = "0123456789abcdef";
  output = "\"";
  for (BYTE byte : bytes) { output += HEX[byte >> 4]; output += HEX[byte & 15]; }
  output += "\"";
  return true;
}

int print_path_facts(int argc, wchar_t** argv) {
  const bool dacl = std::wstring(argv[1]) == L"--dacl";
  bool parent = false, content = false;
  int start = 2;
  while (start < argc && std::wstring(argv[start]).compare(0, 2, L"--") == 0) {
    const std::wstring flag(argv[start++]);
    if (dacl && flag == L"--parent") parent = true;
    else if (dacl && flag == L"--content") content = true;
    else return 2;
  }
  if (start == argc) return 2;
  std::string context;
  if (dacl && !token_json(context)) return 4;
  std::string output = "[";
  for (int index = start; index < argc; ++index) {
    PinnedPath pinned;
    if (!pin_path(argv[index], pinned, content)) { std::fputs("could not read path facts\n", stderr); return 4; }
    std::string row = facts_json(pinned.facts.back()); row.pop_back();
    row += ",\"ancestors\":[";
    for (size_t ancestor = 0; ancestor + 1 < pinned.facts.size(); ++ancestor) {
      if (ancestor != 0) row += ",";
      row += facts_json(pinned.facts[ancestor]);
    }
    row += "]";
    if (dacl) {
      row += context;
      std::string descriptor = "null", parent_descriptor = "null", bytes = "null";
      const auto& facts = pinned.facts.back();
      if (facts.exists == 1) {
        if (!descriptor_json(pinned.handles.back().value, facts, descriptor)) return 4;
        if (content && (facts.tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0
            && ((facts.tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || !content_json(pinned.handles.back().value, bytes))) return 4;
      }
      if (parent && pinned.facts.size() > 1 && pinned.facts[pinned.facts.size() - 2].exists == 1) {
        const size_t position = pinned.facts.size() - 2;
        if (!descriptor_json(pinned.handles[position].value, pinned.facts[position], parent_descriptor)) return 4;
      }
      row += descriptor == "null" ? ",\"identity\":null" : "," + descriptor.substr(1, descriptor.size() - 2);
      if (parent) row += ",\"parent\":" + parent_descriptor;
      if (content) row += ",\"contentHex\":" + bytes;
    }
    if (!verify_pinned_path(pinned)) return 4;
    row += "}";
    if (index != start) output += ",";
    output += row;
  }
  output += "]\n";
  return std::fwrite(output.data(), 1, output.size(), stdout) == output.size() && std::fflush(stdout) == 0 ? 0 : 3;
}

}  // namespace
