#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <vector>
#include <string>

// The control pipe is never inherited by the command. EOF means its owner died
// or released the job; a blocking reader and kernel wait avoid polling.
static DWORD WINAPI watchOwner(void* pipe) {
  char byte;
  DWORD count;
  while (ReadFile(static_cast<HANDLE>(pipe), &byte, 1, &count, nullptr) && count) {}
  return 0;
}
static int fail(const char* operation) {
  std::fprintf(stderr, "Windows job launcher: %s failed (%lu)\n", operation, GetLastError());
  return 125;
}
static bool duplicateOutput(DWORD id, HANDLE* output) {
  return DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(),
                         output, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
static bool absolutePath(const wchar_t* path) {
  return (iswalpha(path[0]) && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) ||
         (path[0] == L'\\' && path[1] == L'\\');
}
// Skips one command-line token; a token that does not spell `expected` clears `same`.
static wchar_t* skipArgument(wchar_t* command, const wchar_t* expected, bool* same) {
  std::wstring token;
  bool quoted = false;
  while (*command && (quoted || !iswspace(*command))) {
    if (*command == L'"') quoted = !quoted; else token += *command;
    ++command;
  }
  while (iswspace(*command)) ++command;
  if (expected && token != expected) *same = false;
  return command;
}
// Completion messages only wake the wait; the job query alone decides.
static bool waitForEmptyJob(HANDLE job, HANDLE port) {
  const ULONGLONG deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr))
      { fail("QueryInformationJobObject"); return false; }
    if (accounting.ActiveProcesses == 0) return true;
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) {
      std::fprintf(stderr, "Windows job launcher: %lu job processes did not exit\n", accounting.ActiveProcesses);
      return false;
    }
    DWORD message;
    ULONG_PTR key;
    LPOVERLAPPED overlapped;
    if (!GetQueuedCompletionStatus(port, &message, &key, &overlapped, static_cast<DWORD>(deadline - now)) &&
        GetLastError() != WAIT_TIMEOUT) { fail("GetQueuedCompletionStatus"); return false; }
  }
}

enum class JobCleanup { Failed, Terminated, AlreadyEmpty };

static JobCleanup emptyJob(HANDLE job, bool requireCleanExit) {
  HANDLE port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
  if (!port) { fail("CreateIoCompletionPort"); return JobCleanup::Failed; }
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job, port};
  JobCleanup cleanup = JobCleanup::Failed;
#ifdef AVE_TEST_UNQUERYABLE_JOB
  HANDLE queried = INVALID_HANDLE_VALUE;
#else
  HANDLE queried = job;
#endif
  if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof(association))) {
    fail("job completion port");
  } else if (requireCleanExit && waitForEmptyJob(queried, port)) {
    cleanup = JobCleanup::AlreadyEmpty;
  } else if (!TerminateJobObject(job, 1)) {
    fail("TerminateJobObject");
  } else if (waitForEmptyJob(queried, port)) {
    cleanup = JobCleanup::Terminated;
  }
  CloseHandle(port);
  return cleanup;
}

int wmain(int argc, wchar_t** argv) {
  // `--receipt <absolute path>` appends "0" to an existing registered receipt only
  // after the closed job is proven empty.
  const bool contained = argc >= 2 && wcscmp(argv[1], L"--receipt") == 0;
  const int first = contained ? 3 : 1;
  if (contained && (argc < 3 || !absolutePath(argv[2]))) {
    std::fprintf(stderr, "Windows job launcher requires an absolute receipt path\n");
    return 125;
  }
  if (argc <= first || !absolutePath(argv[first])) {
    std::fprintf(stderr, "Windows job launcher requires an absolute executable path\n");
    return 125;
  }
  // Strip only this launcher's own arguments. Forward the original command tail
  // so arguments undergo precisely the same quoting as a direct pipe spawn.
  bool same = true;
  wchar_t* command = skipArgument(GetCommandLineW(), nullptr, &same);
  for (int i = 1; i < first; ++i) command = skipArgument(command, argv[i], &same);
  if (!same) {
    std::fprintf(stderr, "Windows job launcher could not separate its own arguments\n");
    return 125;
  }

  std::wstring commandLine(command);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return fail("CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return fail("SetInformationJobObject");
  HANDLE receipt = INVALID_HANDLE_VALUE;
  if (contained) {
    receipt = CreateFileW(argv[2], FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (receipt == INVALID_HANDLE_VALUE) return fail("receipt open");
  }

  HANDLE inherited[3]{};
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  inherited[0] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_EXISTING, 0, nullptr);
  if (inherited[0] == INVALID_HANDLE_VALUE || !duplicateOutput(STD_OUTPUT_HANDLE, &inherited[1]) ||
      !duplicateOutput(STD_ERROR_HANDLE, &inherited[2])) return fail("stdio handles");
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
  std::vector<unsigned char> storage(bytes);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) return fail("attribute list");
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                inherited, sizeof(inherited), nullptr, nullptr)) return fail("handle list");
#ifdef AVE_TEST_INVALID_JOB
  // The separately built failure fixture proves creation fails before user code runs.
  HANDLE assignedJob = INVALID_HANDLE_VALUE;
#else
  HANDLE assignedJob = job;
#endif
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                &assignedJob, sizeof(assignedJob), nullptr, nullptr)) return fail("job list");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION child{};
  // Assignment is atomic with creation, eliminating even an abandoned suspended
  // process if this launcher is terminated between creation and assignment.
  if (!CreateProcessW(argv[first], commandLine.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup.StartupInfo, &child)) return fail("CreateProcess in job");
  DeleteProcThreadAttributeList(attributes);
  for (HANDLE handle : inherited) CloseHandle(handle);
  CloseHandle(child.hThread);
  HANDLE owner = CreateThread(nullptr, 0, watchOwner, GetStdHandle(STD_INPUT_HANDLE), 0, nullptr);
  if (!owner) return fail("owner watcher");
  HANDLE waits[]{child.hProcess, owner};
  DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  DWORD code = 125;
  if (result == WAIT_OBJECT_0) {
    if (!GetExitCodeProcess(child.hProcess, &code)) code = fail("GetExitCodeProcess");
  } else if (result == WAIT_OBJECT_0 + 1) {
    code = 130;
  } else {
    code = fail("WaitForMultipleObjects");
  }
  if (contained) {
    wchar_t strict[2]{};
    const bool requireCleanExit = code == 0 &&
        GetEnvironmentVariableW(L"AVE_CI_REQUIRE_EMPTY_JOB", strict, 2) == 1 && strict[0] == L'1';
    const JobCleanup cleanup = emptyJob(job, requireCleanExit);
    DWORD written = 0;
    if (cleanup == JobCleanup::Failed) code = 125;
    else if (!WriteFile(receipt, "0", 1, &written, nullptr) || written != 1) code = fail("receipt write");
    else if (requireCleanExit && cleanup != JobCleanup::AlreadyEmpty) code = 125;
    CloseHandle(receipt);
  }
  // A completed root command must not leave descendants retaining its pipes.
  CloseHandle(job);
  CloseHandle(child.hProcess);
  CloseHandle(owner);
  // ExitProcess also stops the blocking owner reader on normal command exit.
  ExitProcess(code);
}
