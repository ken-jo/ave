#pragma once
#include <windows.h>
#include <sddl.h>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")

namespace mxc_policy {

constexpr DWORD MAX_POLICY_BYTES = 4 * 1024 * 1024;
constexpr DWORD PIPE_INSTANCES = 4;

struct Delivery {
  HANDLE bound;
  HANDLE done;
  HANDLE client = nullptr;
  DWORD pid = 0;
  ULONGLONG deadline = 0;
  volatile LONG accepted = 0;
  volatile LONG completed = 0;
  volatile LONG failed = 0;
  std::vector<char> bytes;
};

struct Instance {
  Delivery* delivery;
  HANDLE pipe;
};

inline DWORD remaining(const Delivery* delivery) {
  const ULONGLONG now = GetTickCount64();
  return now < delivery->deadline ? static_cast<DWORD>(delivery->deadline - now) : 0;
}

inline DWORD fail_delivery(Delivery* delivery) {
  InterlockedExchange(&delivery->failed, 1);
  SetEvent(delivery->done);
  return 1;
}

inline bool read_exact(HANDLE input, void* target, DWORD size) {
  auto cursor = static_cast<char*>(target);
  while (size) {
    DWORD count = 0;
    if (!ReadFile(input, cursor, size, &count, nullptr) || !count) return false;
    cursor += count;
    size -= count;
  }
  return true;
}

inline DWORD WINAPI watch_owner(void* context) {
  auto delivery = static_cast<Delivery*>(context);
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  DWORD pid = 0;
  if (!read_exact(input, &pid, sizeof(pid)) || !pid) return 1;
  HANDLE client = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!client || WaitForSingleObject(client, 0) != WAIT_TIMEOUT) {
    if (client) CloseHandle(client);
    return 1;
  }
  delivery->pid = pid;
  delivery->client = client;
  SetEvent(delivery->bound);
  char byte;
  DWORD count;
  ReadFile(input, &byte, 1, &count, nullptr);
  return 1;
}

inline DWORD WINAPI serve(void* context) {
  auto instance = static_cast<Instance*>(context);
  auto delivery = instance->delivery;
  const HANDLE pipe = instance->pipe;
  while (WaitForSingleObject(delivery->done, 0) == WAIT_TIMEOUT) {
    if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) return fail_delivery(delivery);
    if (WaitForSingleObject(delivery->bound, remaining(delivery)) != WAIT_OBJECT_0) return fail_delivery(delivery);
    ULONG pid = 0;
    if (!GetNamedPipeClientProcessId(pipe, &pid) || pid != delivery->pid ||
        WaitForSingleObject(delivery->client, 0) != WAIT_TIMEOUT) {
      DisconnectNamedPipe(pipe);
      continue;
    }
    LONG accepted = InterlockedCompareExchange(&delivery->accepted, 0, 0);
    for (;;) {
      if (accepted >= 2) { DisconnectNamedPipe(pipe); return 0; }
      const LONG previous = InterlockedCompareExchange(&delivery->accepted, accepted + 1, accepted);
      if (previous == accepted) break;
      accepted = previous;
    }
    DWORD written = 0;
    const DWORD size = static_cast<DWORD>(delivery->bytes.size());
    const BOOL sent = WriteFile(pipe, delivery->bytes.data(), size, &written, nullptr);
    DWORD error = sent ? ERROR_SUCCESS : GetLastError();
    if (sent && written != size) return fail_delivery(delivery);
    if (sent) {
      if (!FlushFileBuffers(pipe) || !WriteFile(pipe, "", 0, &written, nullptr)) {
        error = GetLastError();
      } else {
        // A zero-length message ends byte reads without releasing an instance.
        // Discard client writes; only private stdin supplies policy bytes.
        char discard[256];
        DWORD count = 0;
        while (ReadFile(pipe, discard, sizeof(discard), &count, nullptr)) {
          if (!remaining(delivery)) return fail_delivery(delivery);
        }
        error = GetLastError();
      }
    }
    // The existence check may close without reading; disconnect only after close.
    if (error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA) return fail_delivery(delivery);
    DisconnectNamedPipe(pipe);
    if (InterlockedIncrement(&delivery->completed) == 2) SetEvent(delivery->done);
  }
  return 0;
}

inline int run(int argc, wchar_t** argv) {
  if (argc != 4) return 2;
  const std::wstring name(argv[2]);
  const std::wstring prefix = L"\\\\.\\pipe\\ave-mxc-";
  if (name.size() != prefix.size() + 32 || name.compare(0, prefix.size(), prefix) != 0 ||
      name.find_first_not_of(L"0123456789abcdef", prefix.size()) != std::wstring::npos) return 2;
  wchar_t* end = nullptr;
  const unsigned long timeout = std::wcstoul(argv[3], &end, 10);
  if (!timeout || *end || timeout == INFINITE) return 2;
  DWORD size = 0;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!read_exact(input, &size, sizeof(size)) || !size || size > MAX_POLICY_BYTES) return 2;
  Delivery delivery{};
  delivery.deadline = GetTickCount64() + timeout;
  delivery.bytes.resize(size);
  if (!read_exact(input, delivery.bytes.data(), size)) return 2;

  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 1;
  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  std::vector<unsigned char> storage(needed);
  if (!GetTokenInformation(token, TokenUser, storage.data(), needed, &needed)) {
    CloseHandle(token);
    return 1;
  }
  CloseHandle(token);
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage.data())->User.Sid, &sid)) return 1;
  const std::wstring sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return 1;
  SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
  Instance instances[PIPE_INSTANCES]{};
  // Fill the fixed instance limit before readiness: back-to-back opens have spare
  // listeners while PID binding or disconnect is pending, and no foreign instance fits.
  for (DWORD index = 0; index < PIPE_INSTANCES; ++index) {
    instances[index].delivery = &delivery;
    instances[index].pipe = CreateNamedPipeW(name.c_str(),
        PIPE_ACCESS_DUPLEX | (index == 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_MESSAGE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_INSTANCES, MAX_POLICY_BYTES, 256, 0, &security);
    if (instances[index].pipe == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      LocalFree(descriptor);
      for (DWORD opened = 0; opened < index; ++opened) CloseHandle(instances[opened].pipe);
      std::fprintf(stderr, "Windows sandbox policy pipe creation failed (%lu)\n", error);
      return 1;
    }
  }
  LocalFree(descriptor);
  delivery.bound = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  delivery.done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!delivery.bound || !delivery.done) ExitProcess(1);
  HANDLE owner = CreateThread(nullptr, 0, watch_owner, &delivery, 0, nullptr);
  if (!owner) ExitProcess(1);
  for (DWORD index = 0; index < PIPE_INSTANCES; ++index) {
    if (!CreateThread(nullptr, 0, serve, &instances[index], 0, nullptr)) ExitProcess(1);
  }
  // Raw handle write: CRT text-mode stdout would send "ready\r\n".
  DWORD readyWritten = 0;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "ready\n", 6, &readyWritten, nullptr) || readyWritten != 6) ExitProcess(1);
  HANDLE waits[]{delivery.done, owner};
  const DWORD result = WaitForMultipleObjects(2, waits, FALSE, remaining(&delivery));
  const DWORD code = result == WAIT_OBJECT_0 && !InterlockedCompareExchange(&delivery.failed, 0, 0) ? 0 : 1;
  if (code) std::fputs("Windows sandbox policy delivery failed or expired\n", stderr);
  // Terminate blocking pipe and owner reads together; no handle is inherited.
  ExitProcess(code);
}

}  // namespace mxc_policy
