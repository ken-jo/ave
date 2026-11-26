#pragma once

#include <fcntl.h>
#include <io.h>
#include <sddl.h>

namespace {

constexpr DWORD MAX_DACL_FRAME_BYTES = 1024 * 1024;
constexpr DWORD MAX_DACL_FRAME_PATHS = 2048;
constexpr size_t MAX_PATH_FACTS_OUTPUT_BYTES = 8 * 1024 * 1024;

bool read_dacl_frame(std::vector<std::wstring>& paths) {
  // Both supported Windows architectures store DWORD values little-endian.
  DWORD size = 0;
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || std::fread(&size, sizeof(size), 1, stdin) != 1
      || size < sizeof(DWORD) || size > MAX_DACL_FRAME_BYTES) return false;
  std::vector<char> bytes(size);
  if (std::fread(bytes.data(), 1, size, stdin) != size || std::fgetc(stdin) != EOF
      || std::ferror(stdin)) return false;

  size_t offset = 0;
  const auto read_length = [&](DWORD& length) {
    if (bytes.size() - offset < sizeof(length)) return false;
    std::memcpy(&length, bytes.data() + offset, sizeof(length));
    offset += sizeof(length);
    return true;
  };
  DWORD count = 0;
  if (!read_length(count) || count == 0 || count > MAX_DACL_FRAME_PATHS) return false;
  paths.reserve(count);
  for (DWORD index = 0; index < count; ++index) {
    DWORD length = 0;
    if (!read_length(length) || length == 0 || length > bytes.size() - offset) return false;
    const char* encoded = bytes.data() + offset;
    if (std::memchr(encoded, '\0', length)) return false;
    const int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, encoded, static_cast<int>(length), nullptr, 0);
    if (units <= 0 || units >= 32768) return false;
    auto& path = paths.emplace_back(static_cast<size_t>(units), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, encoded, static_cast<int>(length), path.data(), units) != units) return false;
    offset += length;
  }
  return offset == bytes.size();
}

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
    + ",\"canonical\":null,\"volumeSerial\":null,\"fileId\":null,\"volumeSerialNumber\":null,\"fileIndex\":null,\"fileSystemName\":null,\"changeTime\":null,\"attributes\":0,\"reparseTag\":0,\"reparseTarget\":null,\"directory\":false}";
  return "{\"exists\":true,\"canonical\":" + json_string(facts.canonical)
    + ",\"volumeSerial\":" + hex_number(facts.id.VolumeSerialNumber) + ",\"fileId\":" + file_id(facts.id.FileId)
    + ",\"volumeSerialNumber\":" + hex_number(facts.legacy.dwVolumeSerialNumber)
    + ",\"fileIndex\":" + hex_number((static_cast<ULONGLONG>(facts.legacy.nFileIndexHigh) << 32) | facts.legacy.nFileIndexLow)
    + ",\"fileSystemName\":" + (facts.file_system_name.empty() ? "null" : json_string(facts.file_system_name))
    + ",\"changeTime\":" + hex_number(static_cast<ULONGLONG>(facts.change_time.QuadPart))
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

constexpr int CONTENT_TOO_LARGE_EXIT_CODE = 5;
int content_json(HANDLE handle, std::string& output) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0) return 4;
  if (size.QuadPart > 1048576) return CONTENT_TOO_LARGE_EXIT_CODE;
  std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart)); DWORD read = 0;
  if (!bytes.empty() && (!ReadFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) || read != bytes.size())) return 4;
  static constexpr char HEX[] = "0123456789abcdef";
  output = "\"";
  for (BYTE byte : bytes) { output += HEX[byte >> 4]; output += HEX[byte & 15]; }
  output += "\"";
  return 0;
}

int print_path_facts(int argc, wchar_t** argv) {
  const bool dacl = std::wstring(argv[1]) == L"--dacl";
  bool parent = false, content = false, framed = false;
  int start = 2;
  while (start < argc && std::wstring(argv[start]).compare(0, 2, L"--") == 0) {
    const std::wstring flag(argv[start++]);
    if (dacl && flag == L"--parent") parent = true;
    else if (dacl && flag == L"--content") content = true;
    else if (dacl && !framed && flag == L"--stdin") framed = true;
    else return 2;
  }
  std::vector<std::wstring> paths;
  if (framed) {
    if (!parent || content || start != argc || !read_dacl_frame(paths)) return 2;
  } else {
    if (start == argc) return 2;
    paths.assign(argv + start, argv + argc);
  }
  std::string context;
  if (dacl && !token_json(context)) return 4;
  std::string output = "[";
  for (size_t index = 0; index < paths.size(); ++index) {
    const auto& path = paths[index];
    const size_t punctuation = index == 0 ? 2 : 3;  // Comma, closing bracket and LF.
    PinnedPath pinned;
    if (!pin_path(path.c_str(), pinned, content)) { std::fputs("could not read path facts\n", stderr); return 4; }
    std::string row = facts_json(pinned.facts.back()); row.pop_back();
    row += ",\"ancestors\":[";
    for (size_t ancestor = 0; ancestor + 1 < pinned.facts.size(); ++ancestor) {
      if (ancestor != 0) row += ",";
      row += facts_json(pinned.facts[ancestor]);
      if (framed && output.size() + row.size() + punctuation > MAX_PATH_FACTS_OUTPUT_BYTES) return 4;
    }
    row += "]";
    if (dacl) {
      row += context;
      std::string descriptor = "null", parent_descriptor = "null", bytes = "null";
      const auto& facts = pinned.facts.back();
      if (facts.exists == 1) {
        if (!descriptor_json(pinned.handles.back().value, facts, descriptor)) return 4;
        if (content && (facts.tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
          if ((facts.tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) return 4;
          const int result = content_json(pinned.handles.back().value, bytes);
          if (result != 0) return result;
        }
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
    if (framed) row += ",\"requestPath\":" + json_string(path);
    row += "}";
    if (framed && output.size() + row.size() + punctuation > MAX_PATH_FACTS_OUTPUT_BYTES) return 4;
    if (index != 0) output += ",";
    output += row;
  }
  output += "]\n";
  return std::fwrite(output.data(), 1, output.size(), stdout) == output.size() && std::fflush(stdout) == 0 ? 0 : 3;
}

#ifdef AVE_TEST_HOLD_FIXTURE
// Test-only build: a smaller reply limit and a helper that stops before confirming the job is empty.
size_t hold_reply_limit() {
  wchar_t value[32];
  const DWORD length = GetEnvironmentVariableW(L"AVE_TEST_HOLD_REPLY_LIMIT", value, 32);
  return length != 0 && length < 32 ? static_cast<size_t>(wcstoull(value, nullptr, 10)) : MAX_PATH_FACTS_OUTPUT_BYTES;
}
#else
size_t hold_reply_limit() { return MAX_PATH_FACTS_OUTPUT_BYTES; }
#endif

struct HoldJob {
  HANDLE job;
  HANDLE pipe;
  HANDLE admitted;  // Set once the host names the launcher that may connect.
  DWORD launcher = 0;
  HANDLE launcher_process = nullptr;
  const PinnedPath* pinned;
  volatile LONG reported = 0;
};

constexpr DWORD kHoldMagic = 0x31485641;  // "AVH1"
constexpr DWORD kHoldAdmitMs = 30000;

bool send_hold_byte(HANDLE pipe, char byte) {
  DWORD written = 0;
  return WriteFile(pipe, &byte, 1, &written, nullptr) && written == 1;
}

bool read_hold_exact(HANDLE input, void* target, DWORD size) {
  auto* cursor = static_cast<char*>(target);
  while (size) {
    DWORD count = 0;
    if (!ReadFile(input, cursor, size, &count, nullptr) || !count) return false;
    cursor += count;
    size -= count;
  }
  return true;
}

void write_hold_outcome(HoldJob* hold, bool reaped, bool stopped) {
  if (InterlockedExchange(&hold->reported, 1) != 0) return;
  const char* line = !reaped ? "{\"outcome\":\"lost\"}\n" : stopped ? "{\"outcome\":\"reaped\",\"stopped\":true}\n" : "{\"outcome\":\"reaped\",\"stopped\":false}\n";
  std::fwrite(line, 1, std::strlen(line), stdout);
  std::fflush(stdout);
}

DWORD parent_process_id(HANDLE process) {
  struct BasicInformation { LONG_PTR exit; PVOID peb; ULONG_PTR affinity; LONG_PTR priority; ULONG_PTR id; ULONG_PTR parent; };
  using Query = LONG(NTAPI*)(HANDLE, int, PVOID, ULONG, PULONG);
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  const auto address = module == nullptr ? nullptr : GetProcAddress(module, "NtQueryInformationProcess");
  if (address == nullptr) return 0;
  Query query = nullptr;
  std::memcpy(&query, &address, sizeof(query));
  BasicInformation information{};
  return query(process, 0, &information, sizeof(information), nullptr) < 0 ? 0 : static_cast<DWORD>(information.parent);
}

bool created_after(HANDLE later, HANDLE earlier) {
  FILETIME a{}, b{}, unused{};
  if (!GetProcessTimes(later, &a, &unused, &unused, &unused) || !GetProcessTimes(earlier, &b, &unused, &unused, &unused)) return false;
  return CompareFileTime(&a, &b) >= 0;
}

// Reopens the leaf by name without following links: it must still be the directory issued at hold time.
bool leaf_still_pinned(const PinnedPath& pinned) {
  if (!verify_pinned_path(pinned)) return false;
  const std::wstring& leaf = pinned.components.back();
  const std::wstring extended = leaf.compare(0, 2, L"\\\\") == 0 ? L"\\\\?\\UNC\\" + leaf.substr(2) : L"\\\\?\\" + leaf;
  HANDLE handle = CreateFileW(extended.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  PathFacts current;
  const bool read = handle_facts(handle, current);
  CloseHandle(handle);
  const auto& issued = pinned.facts.back();
  return read && current.id.VolumeSerialNumber == issued.id.VolumeSerialNumber
    && std::memcmp(&current.id.FileId, &issued.id.FileId, sizeof(FILE_ID_128)) == 0
    && (current.tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
}

// Members still running when the root exits, other than console hosts the system attaches.
bool job_has_descendants(HANDLE job) {
  std::vector<unsigned char> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 1024 * sizeof(ULONG_PTR));
  auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(buffer.size()), nullptr)) return true;
  for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
    HANDLE member = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(list->ProcessIdList[index]));
    if (member == nullptr) return true;
    wchar_t image[MAX_PATH + 1]{};
    DWORD size = MAX_PATH;
    const bool named = QueryFullProcessImageNameW(member, 0, image, &size) != FALSE;
    CloseHandle(member);
    const std::wstring path(image, size);
    if (!named || path.size() < 12 || _wcsicmp(path.c_str() + path.size() - 12, L"\\conhost.exe") != 0) return true;
  }
  return false;
}

// The host names the launcher it started; only that process may connect. It sends one frame naming its
// suspended child, which joins this job before 'A'. After the root exits, every member is stopped, the
// held chain is rechecked, and 'R' confirms both. The launcher then reports its own teardown ('K' clean),
// and the outcome line on stdout is the host's record of the run.
// A launcher that exits without a full exchange (or never connects) leaves the run lost.
DWORD WINAPI watch_hold_launcher(void* context) {
  auto* hold = static_cast<HoldJob*>(context);
  WaitForSingleObject(hold->launcher_process, INFINITE);
  Sleep(500);
  write_hold_outcome(hold, false, false);
  return 0;
}

DWORD WINAPI serve_hold_job(void* context) {
  auto* hold = static_cast<HoldJob*>(context);
  if (!ConnectNamedPipe(hold->pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) return 0;
  ULONG client = 0;
  struct Frame { DWORD magic; DWORD pid; } frame{};
  DWORD available = 1;
  HANDLE command = nullptr;
  const bool admitted = WaitForSingleObject(hold->admitted, kHoldAdmitMs) == WAIT_OBJECT_0
    && GetNamedPipeClientProcessId(hold->pipe, &client) && client == hold->launcher
    && WaitForSingleObject(hold->launcher_process, 0) == WAIT_TIMEOUT
    && read_hold_exact(hold->pipe, &frame, sizeof(frame)) && frame.magic == kHoldMagic
    && PeekNamedPipe(hold->pipe, nullptr, 0, nullptr, &available, nullptr) && available == 0
    && (command = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, frame.pid)) != nullptr
    && parent_process_id(command) == hold->launcher && created_after(command, hold->launcher_process)
    && AssignProcessToJobObject(hold->job, command);
  if (!admitted) {
    if (command != nullptr) CloseHandle(command);
    send_hold_byte(hold->pipe, 'F');
    write_hold_outcome(hold, false, false);
    // Disconnecting discards anything unread, so a refused client is never left waiting.
    DisconnectNamedPipe(hold->pipe);
    return 0;
  }
  if (!send_hold_byte(hold->pipe, 'A')) TerminateJobObject(hold->job, 125);
  WaitForSingleObject(command, INFINITE);
  CloseHandle(command);
#ifdef AVE_TEST_HOLD_FIXTURE
  if (GetEnvironmentVariableW(L"AVE_TEST_HOLD_EXIT_BEFORE_REAP", nullptr, 0) != 0) ExitProcess(0);
#endif
  const bool stopped = job_has_descendants(hold->job);
  bool reaped = false;
  if (TerminateJobObject(hold->job, 1)) {
    for (const ULONGLONG deadline = GetTickCount64() + 5000;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(hold->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) break;
      if (accounting.ActiveProcesses == 0) { reaped = true; break; }
      if (GetTickCount64() >= deadline) break;
      Sleep(10);
    }
  }
  // A leaf replaced in place (for example made into a junction) no longer matches the facts reported at hold time.
  reaped = reaped && leaf_still_pinned(*hold->pinned);
  char verdict = 0;
  DWORD count = 0;
  const bool clean = send_hold_byte(hold->pipe, reaped ? 'R' : 'X') && reaped
    && ReadFile(hold->pipe, &verdict, 1, &count, nullptr) && count == 1 && verdict == 'K';
  write_hold_outcome(hold, clean, stopped);
  return 0;
}

// The pipe admits only this user, and only the launcher the host names.
HANDLE create_hold_pipe(const wchar_t* name) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return INVALID_HANDLE_VALUE;
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  std::vector<unsigned char> storage(needed);
  const bool user = GetTokenInformation(token, TokenUser, storage.data(), needed, &needed) != FALSE;
  CloseHandle(token);
  LPWSTR sid = nullptr;
  if (!user || !ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid, &sid)) return INVALID_HANDLE_VALUE;
  const std::wstring sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return INVALID_HANDLE_VALUE;
  SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
  HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16, 16, 0, &security);
  LocalFree(descriptor);
  return pipe;
}

#ifdef AVE_TEST_HOLD_FIXTURE
// 'L' asks for the job's member process ids as one JSON line on stderr.
void report_hold_members(HANDLE job) {
  std::vector<unsigned char> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 1024 * sizeof(ULONG_PTR));
  auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
  std::string line = "[";
  if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(buffer.size()), nullptr)) {
    for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index)
      line += (index ? "," : "") + std::to_string(list->ProcessIdList[index]);
  }
  line += "]\n";
  std::fwrite(line.data(), 1, line.size(), stderr);
  std::fflush(stderr);
}

// `--breakaway <executable>`: try to start a process outside every job; prints whether the system refused.
int try_breakaway(int argc, wchar_t** argv) {
  if (argc != 3) return 2;
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  std::wstring command = L"\"" + std::wstring(argv[2]) + L"\"";
  if (CreateProcessW(argv[2], command.data(), nullptr, nullptr, FALSE, CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                     nullptr, nullptr, &startup, &process)) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    std::fputs("breakaway allowed\n", stdout);
    return 1;
  }
  std::fprintf(stdout, "breakaway refused %lu\n", GetLastError());
  return 0;
}
#endif

// `--hold <directory> --pipe <name>`: report the --pin row, then keep every component held until stdin
// closes. The helper owns the only handle to a kill-on-close job; the launcher the host names on stdin
// puts its command in that job, so the command cannot outlive the hold.
int hold_path(int argc, wchar_t** argv) {
  if (argc != 5 || std::wstring(argv[3]) != L"--pipe" || std::wstring(argv[4]).rfind(L"\\\\.\\pipe\\ave-hold-", 0) != 0) return 2;
  PinnedPath pinned;
  if (!pin_path(argv[2], pinned, false, true) || pinned.handles.size() != pinned.components.size()
      || (pinned.facts.back().tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    std::fputs("could not hold the directory\n", stderr);
    return 4;
  }
  // Binary stdout keeps the wire length equal to the length checked here.
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return 3;
  const size_t limit = hold_reply_limit();
  constexpr size_t kFraming = 5;  // "[" + row + "]}]\n"
  std::string row = facts_json(pinned.facts.back()); row.pop_back();
  row += ",\"ancestors\":[";
  for (size_t ancestor = 0; ancestor + 1 < pinned.facts.size(); ++ancestor) {
    if (ancestor != 0) row += ",";
    row += facts_json(pinned.facts[ancestor]);
    if (row.size() + kFraming > limit) break;
  }
  if (row.size() + kFraming > limit) { std::fputs("held directory reply exceeds the limit\n", stderr); return 3; }
  const std::string output = "[" + row + "]}]\n";
  HoldJob hold{CreateJobObjectW(nullptr, nullptr), INVALID_HANDLE_VALUE, CreateEventW(nullptr, TRUE, FALSE, nullptr), 0, nullptr, &pinned};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (hold.job == nullptr || hold.admitted == nullptr || !SetInformationJobObject(hold.job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    std::fputs("could not create the hold job\n", stderr);
    return 3;
  }
  hold.pipe = create_hold_pipe(argv[4]);
  if (hold.pipe == INVALID_HANDLE_VALUE) {
    std::fputs("could not open the hold pipe\n", stderr);
    return 3;
  }
  if (std::fwrite(output.data(), 1, output.size(), stdout) != output.size() || std::fflush(stdout) != 0) return 3;
  if (CreateThread(nullptr, 0, serve_hold_job, &hold, 0, nullptr) == nullptr) return 3;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  DWORD launcher = 0;
  if (read_hold_exact(input, &launcher, sizeof(launcher)) && launcher != 0) {
    hold.launcher_process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, launcher);
    if (hold.launcher_process != nullptr) {
      hold.launcher = launcher;
      SetEvent(hold.admitted);
      if (CreateThread(nullptr, 0, watch_hold_launcher, &hold, 0, nullptr) == nullptr) ExitProcess(3);
    }
    char byte;
    DWORD count;
    while (ReadFile(input, &byte, 1, &count, nullptr) && count) {
#ifdef AVE_TEST_HOLD_FIXTURE
      if (byte == 'L') report_hold_members(hold.job);
#endif
    }
  }
  // Exiting closes the job handle, which stops any command still in it.
  ExitProcess(0);
}

}  // namespace
