#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <vector>
#include <string>

[[noreturn]] static void endHeld(const char* record, DWORD code);
static const char kLost[] = "AVJ1 lost\n";
static const char kUnconfirmed[] = "AVJ1 unconfirmed\n";
// A held policy reader's resume and an observed owner stop are decided under one lock:
// a stop seen before the resume ends the run with the child still suspended.
static SRWLOCK startupLock = SRWLOCK_INIT;
static HANDLE suspendedJob = nullptr;
// The control pipe is never inherited by the command. EOF means its owner died
// or released the job; a blocking reader and kernel wait avoid polling.
static DWORD WINAPI watchOwner(void* pipe) {
  char byte;
  DWORD count;
  while (ReadFile(static_cast<HANDLE>(pipe), &byte, 1, &count, nullptr) && count) {}
  AcquireSRWLockExclusive(&startupLock);
  if (suspendedJob) {
    CloseHandle(suspendedJob);
    endHeld(kUnconfirmed, 125);
  }
  ReleaseSRWLockExclusive(&startupLock);
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

// Handles the host passed beyond the three standard ones, read from the startup block.
static HANDLE inheritedHandle(size_t fd) {
  STARTUPINFOW startup{};
  GetStartupInfoW(&startup);
  int count = 0;
  if (!startup.lpReserved2 || startup.cbReserved2 < sizeof(count)) return INVALID_HANDLE_VALUE;
  memcpy(&count, startup.lpReserved2, sizeof(count));
  if (count <= 0 || fd >= static_cast<size_t>(count) || startup.cbReserved2 < sizeof(count) + count * (1 + sizeof(HANDLE))) return INVALID_HANDLE_VALUE;
  HANDLE handle = INVALID_HANDLE_VALUE;
  memcpy(&handle, startup.lpReserved2 + sizeof(count) + count + fd * sizeof(HANDLE), sizeof(handle));
  return handle;
}
static bool holdTransfer(HANDLE channel, bool write, void* target, DWORD size) {
  auto* cursor = static_cast<char*>(target);
  while (size) {
    DWORD count = 0;
    if (!(write ? WriteFile(channel, cursor, size, &count, nullptr) : ReadFile(channel, cursor, size, &count, nullptr)) || !count) return false;
    cursor += count;
    size -= count;
  }
  return true;
}
struct PolicyReport { DWORD kind; DWORD pid; ULONGLONG admission; };
static_assert(sizeof(PolicyReport) == 16);
struct PolicyControl { HANDLE channel; HANDLE reportPipe; DWORD pid; ULONGLONG admission; };
#ifdef AVE_TEST_POLICY_READER
static bool policyFixtureFault(const wchar_t* fault) {
  wchar_t value[32]{};
  return GetEnvironmentVariableW(L"AVE_TEST_POLICY_FAULT", value, _countof(value)) != 0 && wcscmp(value, fault) == 0;
}
static bool waitForPolicyFixture(char phase) {
  const HANDLE gate = inheritedHandle(7);
  char next = 0;
  return holdTransfer(gate, true, &phase, 1) && holdTransfer(gate, false, &next, 1) && next == '+';
}
#endif
static bool controlEmpty(HANDLE channel) {
  DWORD available = 0;
  return PeekNamedPipe(channel, nullptr, 0, nullptr, &available, nullptr) && available == 0;
}
static DWORD WINAPI confirmPolicyReader(void* context) {
  const auto& control = *static_cast<const PolicyControl*>(context);
  PolicyReport report{0x31505641, control.pid, control.admission}; // AVP1
  DWORD reply[2]{};
  if (!controlEmpty(control.channel) || !holdTransfer(control.reportPipe, true, &report, sizeof(report))) return 1;
#ifdef AVE_TEST_POLICY_READER
  if (policyFixtureFault(L"delayed trailer")) {
    char extra = '+';
    if (!waitForPolicyFixture('T') || !holdTransfer(control.reportPipe, true, &extra, 1)) return 1;
  }
#endif
  if (!CloseHandle(control.reportPipe) || !holdTransfer(control.channel, false, reply, sizeof(reply)) ||
      reply[0] != 0x31525641 || reply[1] != control.pid) return 1; // AVR1
  // The reply is the only host frame. Anything after it is invalid, including a duplicate.
  char extra;
  DWORD count = 0;
  if (ReadFile(control.channel, &extra, 1, &count, nullptr)) return count == 0 ? 0 : 1;
  const DWORD error = GetLastError();
  return error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED ? 0 : 1;
}

// One frame to the hold helper and its 9-byte reply; returns the reply kind, 0 on failure.
static char holdAsk(HANDLE channel, DWORD kind, DWORD value, ULONGLONG* answer = nullptr) {
  struct { DWORD kind; DWORD value; } frame{kind, value};
  char reply[9]{};
  if (!holdTransfer(channel, true, &frame, sizeof(frame)) || !holdTransfer(channel, false, reply, sizeof(reply))) return 0;
  if (answer) memcpy(answer, reply + 1, sizeof(*answer));
  return reply[0];
}
// A held run ends here and nowhere else: one verdict record on the host's private handle, then the
// exit. Ending this process closes its job, which stops the command's tree.
static HANDLE verdictPipe = INVALID_HANDLE_VALUE;
static volatile LONG ending = 0;
[[noreturn]] static void endHeld(const char* record, DWORD code) {
  if (InterlockedExchange(&ending, 1) != 0) Sleep(INFINITE);
  DWORD written = 0;
  WriteFile(verdictPipe, record, static_cast<DWORD>(strlen(record)), &written, nullptr);
  TerminateProcess(GetCurrentProcess(), code);
  Sleep(INFINITE);
}
// A phase that outlasts its deadline ends the run with that phase's verdict, whatever is stalled.
struct Deadline { HANDLE met; DWORD milliseconds; const char* record; };
static DWORD WINAPI enforceDeadline(void* context) {
  auto* deadline = static_cast<Deadline*>(context);
  if (WaitForSingleObject(deadline->met, deadline->milliseconds) == WAIT_TIMEOUT) endHeld(deadline->record, 125);
  return 0;
}
// Members still running when the root exits, other than console hosts the system attaches.
static bool jobHasLiveDescendants(HANDLE job, DWORD root) {
  std::vector<unsigned char> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 1024 * sizeof(ULONG_PTR));
  auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(buffer.size()), nullptr)) return false;
  for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
    // The exited root can still be listed while the system retires it.
    if (list->ProcessIdList[index] == root) continue;
    // The snapshot can contain a process that exited or whose id was reused before we opened it.
    HANDLE member = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(list->ProcessIdList[index]));
    if (!member) continue;
    wchar_t image[MAX_PATH + 1]{};
    DWORD size = MAX_PATH;
    BOOL belongsToJob = FALSE;
    const bool liveDescendant = IsProcessInJob(member, job, &belongsToJob) && belongsToJob &&
        QueryFullProcessImageNameW(member, 0, image, &size) && WaitForSingleObject(member, 0) == WAIT_TIMEOUT;
    CloseHandle(member);
    if (!liveDescendant) continue;
    const std::wstring path(image, size);
    if (path.size() < 12 || _wcsicmp(path.c_str() + path.size() - 12, L"\\conhost.exe") != 0) return true;
  }
  return false;
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

#ifdef AVE_TEST_POLICY_READER
static DWORD policyBytes(const wchar_t* name) {
  HANDLE reader = CreateFileW(name, GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (reader == INVALID_HANDLE_VALUE) return MAXDWORD;
  DWORD total = 0;
  char buffer[4096];
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(reader, buffer, sizeof(buffer), &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED && error != ERROR_NO_DATA) total = MAXDWORD;
      break;
    }
    if (!read) break;
    total += read;
  }
  CloseHandle(reader);
  return total;
}

static void measureOtherReaders(const wchar_t* self, STARTUPINFOEXW& startup) {
  wchar_t pipe[128]{};
  const DWORD length = GetEnvironmentVariableW(L"AVE_TEST_POLICY_READER_PIPE", pipe, _countof(pipe));
  if (!length || length >= _countof(pipe)) return;
  const DWORD launcherBytes = policyBytes(pipe);
  std::wstring command = L"\"" + std::wstring(self) + L"\" --test-policy-reader " + pipe;
  PROCESS_INFORMATION sibling{};
  DWORD siblingBytes = MAXDWORD;
  if (CreateProcessW(self, command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                     nullptr, nullptr, &startup.StartupInfo, &sibling)) {
    if (WaitForSingleObject(sibling.hProcess, 5000) == WAIT_OBJECT_0) GetExitCodeProcess(sibling.hProcess, &siblingBytes);
    CloseHandle(sibling.hProcess);
    CloseHandle(sibling.hThread);
  }
  std::printf("other-readers %lu %lu\n", launcherBytes, siblingBytes);
  std::fflush(stdout);
}
#endif

int wmain(int argc, wchar_t** argv) {
#ifdef AVE_TEST_POLICY_READER
  if (argc == 3 && wcscmp(argv[1], L"--test-policy-reader") == 0) ExitProcess(policyBytes(argv[2]));
#endif
  // `--receipt <absolute path>` appends "0" to an existing registered receipt only
  // after the closed job is proven empty.
  const bool contained = argc >= 2 && wcscmp(argv[1], L"--receipt") == 0;
  // `--hold`: the fourth standard handle reaches a working-directory hold helper and the fifth takes
  // the verdict. This launcher joins the helper's kill-on-close job before it starts the command, so
  // the helper's exit stops both. It alone decides the run: `AVJ1 ok <exit code> <stopped>` once its
  // own job is proven empty and the helper confirms the held directory, `AVJ1 lost` (exit 125) when
  // the hold was refused or the directory changed, `AVJ1 unconfirmed` (exit 125) otherwise.
  const bool heldPolicy = argc >= 2 && wcscmp(argv[1], L"--hold-policy-v1") == 0;
  const bool held = heldPolicy || (argc >= 2 && wcscmp(argv[1], L"--hold") == 0);
  const int first = contained ? 3 : held ? 2 : 1;
  if (contained && (argc < 3 || !absolutePath(argv[2]))) {
    std::fprintf(stderr, "Windows job launcher requires an absolute receipt path\n");
    return 125;
  }
  HANDLE hold = INVALID_HANDLE_VALUE;
  if (held) {
    hold = inheritedHandle(3);
    verdictPipe = inheritedHandle(4);
    if (hold == INVALID_HANDLE_VALUE || verdictPipe == INVALID_HANDLE_VALUE) {
      std::fprintf(stderr, "Windows job launcher requires the hold and verdict handles\n");
      return 125;
    }
  }
  const HANDLE policyChannel = heldPolicy ? inheritedHandle(5) : INVALID_HANDLE_VALUE;
  const HANDLE policyReport = heldPolicy ? inheritedHandle(6) : INVALID_HANDLE_VALUE;
  if (heldPolicy && (GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE || !controlEmpty(policyChannel) ||
      GetFileType(policyReport) != FILE_TYPE_PIPE))
    endHeld(kUnconfirmed, 125);
  if (argc <= first || !absolutePath(argv[first])) {
    std::fprintf(stderr, "Windows job launcher requires an absolute executable path\n");
    return 125;
  }
  if (held && !heldPolicy) {
    constexpr wchar_t pipePrefix[] = L"\\\\.\\pipe\\";
    for (int i = first + 1; i + 1 < argc; ++i) {
      if (wcscmp(argv[i], L"--config") == 0 && _wcsnicmp(argv[i + 1], pipePrefix, _countof(pipePrefix) - 1) == 0)
        endHeld(kUnconfirmed, 125);
    }
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
  ULONGLONG admissionProof = 0;
#ifdef AVE_TEST_POLICY_READER
  if (heldPolicy && policyFixtureFault(L"early report")) {
    PolicyReport report{0x31505641, GetCurrentProcessId() + 1, 0};
    if (!holdTransfer(policyReport, true, &report, sizeof(report)) || !CloseHandle(policyReport) ||
        !waitForPolicyFixture('E')) endHeld(kUnconfirmed, 125);
    endHeld(kUnconfirmed, 125);
  }
#endif
  if (held) {
    // The helper challenges the process named on the private channel. 'A' follows once that process
    // signals the duplicated event and joins the helper's job.
    static Deadline admission{CreateEventW(nullptr, TRUE, FALSE, nullptr), 10000, kLost};
    if (!admission.met || !CreateThread(nullptr, 0, enforceDeadline, &admission, 0, nullptr)) endHeld(kLost, 125);
    ULONGLONG proof = 0;
    const bool admitted = holdAsk(hold, 0x32485641, GetCurrentProcessId(), &proof) == 'C' &&
                          SetEvent(reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(proof))) &&
                          CloseHandle(reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(proof)));
    char reply[9]{};
    if (!admitted || !holdTransfer(hold, false, reply, sizeof(reply)) || reply[0] != 'A') {
      std::fprintf(stderr, "Windows job launcher: the working directory hold is not available\n");
      endHeld(kLost, 125);
    }
    memcpy(&admissionProof, reply + 1, sizeof(admissionProof));
    SetEvent(admission.met);
  }
  PROCESS_INFORMATION child{};
  // Assignment is atomic with creation, eliminating even an abandoned suspended
  // process if this launcher is terminated between creation and assignment.
  if (!CreateProcessW(argv[first], commandLine.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | (heldPolicy ? CREATE_SUSPENDED : 0),
                      nullptr, nullptr, &startup.StartupInfo, &child)) {
    fail("CreateProcess in job");
    if (held) endHeld(kUnconfirmed, 125);
    return 125;
  }
  const auto closeStartup = [&]() {
    DeleteProcThreadAttributeList(attributes);
    for (HANDLE handle : inherited) CloseHandle(handle);
  };
#ifndef AVE_TEST_POLICY_READER
  closeStartup();
#endif
  if (!heldPolicy) CloseHandle(child.hThread);
  // A NUL stdin has no owner to watch; a held command is then bound to the hold helper alone.
  const bool watched = !held || GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE;
  if (heldPolicy) suspendedJob = job;
  HANDLE owner = watched ? CreateThread(nullptr, 0, watchOwner, GetStdHandle(STD_INPUT_HANDLE), 0, nullptr) : nullptr;
  if (watched && !owner) {
    fail("owner watcher");
    if (held) endHeld(kUnconfirmed, 125);
    return 125;
  }
  if (heldPolicy) {
    PolicyControl control{policyChannel, policyReport, child.dwProcessId, admissionProof};
    HANDLE confirm = CreateThread(nullptr, 0, confirmPolicyReader, &control, 0, nullptr);
    HANDLE startupWaits[]{owner, child.hProcess, confirm};
    DWORD result = 1;
    const bool confirmed = confirm && WaitForMultipleObjects(3, startupWaits, FALSE, 10000) == WAIT_OBJECT_0 + 2 &&
        GetExitCodeThread(confirm, &result) && result == 0;
#ifdef AVE_TEST_POLICY_READER
    if (confirmed) measureOtherReaders(argv[0], startup);
    // Holds the resume decision until a stop requested at the gate reaches the owner watcher.
    const bool stopBeforeResume = policyFixtureFault(L"stop before resume");
    if (confirmed && stopBeforeResume && waitForPolicyFixture('R')) WaitForSingleObject(owner, 5000);
#endif
    AcquireSRWLockExclusive(&startupLock);
    if (!confirmed || ResumeThread(child.hThread) != 1) {
      CloseHandle(job);
      endHeld(kUnconfirmed, 125);
    }
    suspendedJob = nullptr;
    ReleaseSRWLockExclusive(&startupLock);
#ifdef AVE_TEST_POLICY_READER
    // A child resumed despite that stop gets time to show that it ran.
    if (stopBeforeResume) WaitForSingleObject(child.hProcess, 5000);
#endif
    CloseHandle(confirm);
    CloseHandle(policyChannel);
    CloseHandle(child.hThread);
  }
#ifdef AVE_TEST_POLICY_READER
  closeStartup();
#endif
  HANDLE waits[]{child.hProcess, owner};
  DWORD result = WaitForMultipleObjects(watched ? 2 : 1, waits, FALSE, INFINITE);
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
  if (held) {
    // Teardown is bounded as a whole; a stalled helper or job query ends the run unconfirmed.
    static Deadline teardown{CreateEventW(nullptr, TRUE, FALSE, nullptr), 10000, kUnconfirmed};
    if (!teardown.met || !CreateThread(nullptr, 0, enforceDeadline, &teardown, 0, nullptr)) endHeld(kUnconfirmed, 125);
    const bool stopped = result == WAIT_OBJECT_0 && jobHasLiveDescendants(job, child.dwProcessId);
    // Every process the command started is in this job, so its emptiness is the whole reap.
    if (result > WAIT_OBJECT_0 + 1 || emptyJob(job, false) == JobCleanup::Failed) endHeld(kUnconfirmed, 125);
    const char pinned = holdAsk(hold, 0x51485641, 0);
    if (pinned != 'P') endHeld(pinned == 'X' ? kLost : kUnconfirmed, 125);
    char record[48];
    std::snprintf(record, sizeof(record), "AVJ1 ok %lu %d\n", code, stopped ? 1 : 0);
    endHeld(record, code);
  }
  // A completed root command must not leave descendants retaining its pipes.
  CloseHandle(job);
  CloseHandle(child.hProcess);
  if (owner) CloseHandle(owner);
  // ExitProcess also stops the blocking owner reader on normal command exit.
  ExitProcess(code);
}
