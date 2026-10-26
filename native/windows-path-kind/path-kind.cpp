// Prints the current MS-DOS device mapping of one drive letter (design
// §18.4.1 stage 2): `ave-path-kind.exe Z:` writes `\Device\Mup\...` or
// `\Device\HarddiskVolume3` as UTF-8 and a newline, and exits 0.
//
// QueryDosDeviceW reads the mapping from the object manager's MS-DOS device
// namespace for this logon session. It opens nothing on the drive, so a
// network drive's server is never contacted. The caller decides what the
// mapping means. Separate read-only facts modes pin path components below.
//
// Exit codes: 0 mapping printed; 1 the OS has no mapping for the drive (the
// call failed, an unknown drive among them, or answered nothing), with the
// Windows error on stderr; 2 the argument is not `X:`; 3 the mapping could
// not be written. Only 1 is an answer about the drive: the caller treats any
// other failure as a broken helper, never as a classification.
#include <windows.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "pin.h"
#include "dacl.h"
#include "deny-acl.h"
#include "path-facts.h"

namespace {

bool is_drive(const wchar_t* text) {
  if (text == nullptr) return false;
  const wchar_t letter = text[0];
  const bool alpha = (letter >= L'A' && letter <= L'Z') || (letter >= L'a' && letter <= L'z');
  return alpha && text[1] == L':' && text[2] == L'\0';
}

bool write_utf8(const std::wstring& text) {
  const int length = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0 && !text.empty()) return false;
  std::string bytes(static_cast<size_t>(length), '\0');
  if (length > 0 &&
      WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), bytes.data(), length, nullptr, nullptr) != length) {
    return false;
  }
  bytes.push_back('\n');
  return std::fwrite(bytes.data(), 1, bytes.size(), stdout) == bytes.size() && std::fflush(stdout) == 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && (std::wstring(argv[1]) == L"--pin" || std::wstring(argv[1]) == L"--dacl")) return print_path_facts(argc, argv);
  if (argc >= 2 && std::wstring(argv[1]) == L"--deny-acls") return print_deny_acls(argc, argv);
  if (argc != 2 || !is_drive(argv[1])) {
    std::fputs("usage: ave-path-kind.exe X:\n", stderr);
    return 2;
  }
  std::vector<wchar_t> buffer(1024);
  for (;;) {
    const DWORD written = QueryDosDeviceW(argv[1], buffer.data(), static_cast<DWORD>(buffer.size()));
    if (written != 0) break;
    const DWORD error = GetLastError();
    // The buffer holds every target of the name; grow it until the first fits, up to 1 MiB of characters.
    if (error == ERROR_INSUFFICIENT_BUFFER && buffer.size() < (1u << 20)) {
      buffer.resize(buffer.size() * 4);
      continue;
    }
    std::fprintf(stderr, "QueryDosDeviceW failed: %lu\n", static_cast<unsigned long>(error));
    return 1;
  }
  // The first NUL-terminated string is the mapping in force.
  const std::wstring mapping(buffer.data());
  if (mapping.empty()) {
    std::fputs("QueryDosDeviceW returned an empty mapping\n", stderr);
    return 1;
  }
  if (!write_utf8(mapping)) {
    std::fputs("could not write the mapping\n", stderr);
    return 3;
  }
  return 0;
}
