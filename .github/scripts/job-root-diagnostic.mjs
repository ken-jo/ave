import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 20;
const SCAN_LIMIT = 128;
const DENY_LIMIT = 8;
const PROCESS_SCAN_LIMIT = 512;
const PROCESS_PATH_LIMIT = 256;
const QUERY_VARIABLE = "AVE_CI_JOB_ROOT_QUERY";
const QUERY_COMMAND = `$query = [Environment]::GetEnvironmentVariable('${QUERY_VARIABLE}'); & ([ScriptBlock]::Create($query))`;

// Bind directory enumeration and metadata reads to handles. Reflection.Emit
// builds the interop in memory without a compiler or temporary files.
const HANDLE_QUERY = String.raw`
$marshal = [Runtime.InteropServices.Marshal]
$pointerSize = [IntPtr]::Size
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  [Reflection.AssemblyName]::new('JobRootQuery'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$interop = $assembly.DefineDynamicModule('Native').DefineType('Native', 'Public')
function ImportReadMethod($dll, $name, $result, [type[]]$parameters) {
  $method = $interop.DefinePInvokeMethod($name, $dll, 'Public, Static, PinvokeImpl',
    [Reflection.CallingConventions]::Standard, $result, $parameters,
    [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
$handleType = [Microsoft.Win32.SafeHandles.SafeFileHandle]
$outPointer = [IntPtr].MakeByRefType()
$outLength = [uint32].MakeByRefType()
ImportReadMethod kernel32.dll CreateFileW $handleType @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])
ImportReadMethod ntdll.dll NtOpenFile ([int]) @($outPointer, [uint32], [IntPtr], [IntPtr], [uint32], [uint32])
ImportReadMethod ntdll.dll NtQueryInformationFile ([int]) @($handleType, [IntPtr], [byte[]], [uint32], [int])
ImportReadMethod ntdll.dll NtQueryDirectoryFile ([int]) @(
  $handleType, [IntPtr], [IntPtr], [IntPtr], [IntPtr], [byte[]], [uint32], [int], [byte], [IntPtr], [byte])
ImportReadMethod ntdll.dll NtQuerySecurityObject ([int]) @($handleType, [uint32], [byte[]], [uint32], $outLength)
$processHandleType = [Microsoft.Win32.SafeHandles.SafeProcessHandle]
ImportReadMethod kernel32.dll OpenProcess $processHandleType @([uint32], [bool], [uint32])
ImportReadMethod ntdll.dll NtQueryInformationProcess ([int]) @($processHandleType, [int], [byte[]], [uint32], [IntPtr])
ImportReadMethod kernel32.dll ReadProcessMemory ([bool]) @($processHandleType, [IntPtr], [byte[]], [IntPtr], [IntPtr])
$native = $interop.CreateType()

$readAttributes = 0x80
$readControl = 0x20000
$listDirectory = 1
$shareAll = 7
$shareWithoutDelete = 3
$directoryFlag = [IO.FileAttributes]::Directory
$reparseFlag = [IO.FileAttributes]::ReparsePoint

function OpenRelative($parent, $name, $access, $sharing) {
  $nameBuffer = $marshal::StringToHGlobalUni($name)
  $request = $marshal::AllocHGlobal(10 * $pointerSize)
  try {
    # Lay out OBJECT_ATTRIBUTES, UNICODE_STRING and IO_STATUS_BLOCK.
    $unicode = [IntPtr]::Add($request, 6 * $pointerSize)
    $ioStatus = [IntPtr]::Add($request, 8 * $pointerSize)
    $bytes = [int16]($name.Length * 2)
    $marshal::WriteInt16($unicode, 0, $bytes)
    $marshal::WriteInt16($unicode, 2, $bytes)
    $marshal::WriteIntPtr($unicode, $pointerSize, $nameBuffer)
    $marshal::WriteInt32($request, 0, 6 * $pointerSize)
    $marshal::WriteIntPtr($request, $pointerSize, $parent.DangerousGetHandle())
    $marshal::WriteIntPtr($request, 2 * $pointerSize, $unicode)
    # OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE. Open the final link itself.
    $marshal::WriteInt32($request, 3 * $pointerSize, 0x1040)
    $marshal::WriteIntPtr($request, 4 * $pointerSize, [IntPtr]::Zero)
    $marshal::WriteIntPtr($request, 5 * $pointerSize, [IntPtr]::Zero)
    $raw = [IntPtr]::Zero
    # SYNCHRONIZE, FILE_OPEN_REPARSE_POINT and FILE_SYNCHRONOUS_IO_NONALERT.
    $status = $native::NtOpenFile([ref]$raw, ($access -bor 0x100000), $request, $ioStatus, $sharing, 0x200020)
    if ($status -eq 0) { return $handleType::new($raw, $true) }
  } finally {
    $marshal::FreeHGlobal($request)
    $marshal::FreeHGlobal($nameBuffer)
  }
}

function ReadBasicInformation($handle) {
  $bytes = [byte[]]::new(40)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    # FileBasicInformation.
    if ($native::NtQueryInformationFile($handle, $ioStatus, $bytes, $bytes.Length, 4) -ne 0) {
      throw 'Cannot read basic information from directory entry handle'
    }
    return @{
      attributes = [IO.FileAttributes][BitConverter]::ToInt32($bytes, 32)
      created = ReadFileTime $bytes 0
      lastWrite = ReadFileTime $bytes 16
    }
  } finally { $marshal::FreeHGlobal($ioStatus) }
}

function ReadFileTime($bytes, $offset) {
  try { [DateTime]::FromFileTimeUtc([BitConverter]::ToInt64($bytes, $offset)).ToString('o') }
  catch { return $null }
}

function ReadChildren($handle, $limit) {
  $bytes = [byte[]]::new(16384)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    while ($limit -gt 0) {
      # FileDirectoryInformation. STATUS_NO_MORE_FILES ends the scan.
      $status = $native::NtQueryDirectoryFile($handle, 0, 0, 0, $ioStatus, $bytes, $bytes.Length, 1, 0, 0, 0)
      if ($status -eq -2147483642) { return }
      if ($status -ne 0) { throw 'Cannot enumerate directory handle' }
      $offset = 0
      do {
        $nameLength = [BitConverter]::ToInt32($bytes, $offset + 60)
        $name = [Text.Encoding]::Unicode.GetString($bytes, $offset + 64, $nameLength)
        if ($name -ne '.' -and $name -ne '..') {
          $attributes = [IO.FileAttributes][BitConverter]::ToInt32($bytes, $offset + 56)
          @{ name = $name; attributes = $attributes }
          if (--$limit -eq 0) { return }
        }
        $advance = [BitConverter]::ToInt32($bytes, $offset)
        $offset += $advance
      } while ($advance -ne 0)
    }
  } finally { $marshal::FreeHGlobal($ioStatus) }
}
`;

function runJobRootQuery(command, args, options, done) {
  const executable = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command);
  return execFile(executable, args, options, done);
}

function queryScript(root) {
  // Surviving paths show where cleanup stopped. Deny ACEs and attributes
  // give those candidates a priority for reporting.
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = '${root.replaceAll("'", "''")}'
$prefix = $root.TrimEnd('\') + '\'
$script:failed = $false
$changed = $false

${HANDLE_QUERY}

function ReadProcessPointer($bytes, $offset, $size) {
  if ($size -eq 4) { return [IntPtr][long][BitConverter]::ToUInt32($bytes, $offset) }
  return [IntPtr][BitConverter]::ToInt64($bytes, $offset)
}

function ReadCurrentDirectory($id) {
  # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. Skip inaccessible or exited processes.
  $process = $native::OpenProcess(0x410, $false, $id)
  try {
    if ($process.IsInvalid) { return }
    $size = $pointerSize
    $peb = [IntPtr]::Zero
    if ($size -eq 8) {
      # ProcessWow64Information supplies the 32-bit PEB for a WOW64 process.
      $info = [byte[]]::new(8)
      if ($native::NtQueryInformationProcess($process, 26, $info, $info.Length, 0) -ne 0) { return }
      $peb = ReadProcessPointer $info 0 8
      if ($peb -ne [IntPtr]::Zero) { $size = 4 }
    }
    if ($peb -eq [IntPtr]::Zero) {
      # ProcessBasicInformation.
      $info = [byte[]]::new(6 * $size)
      if ($native::NtQueryInformationProcess($process, 0, $info, $info.Length, 0) -ne 0) { return }
      $peb = ReadProcessPointer $info $size $size
    }
    # Read only PEB.ProcessParameters and the CurrentDirectory UNICODE_STRING.
    $parametersOffset = if ($size -eq 8) { 0x20 } else { 0x10 }
    $directoryOffset = if ($size -eq 8) { 0x38 } else { 0x24 }
    $pointer = [byte[]]::new($size)
    if (!$native::ReadProcessMemory($process, [IntPtr]::Add($peb, $parametersOffset), $pointer, $size, 0)) { return }
    $parameters = ReadProcessPointer $pointer 0 $size
    $directory = [byte[]]::new(2 * $size)
    if (!$native::ReadProcessMemory($process, [IntPtr]::Add($parameters, $directoryOffset), $directory, $directory.Length, 0)) { return }
    $length = [BitConverter]::ToUInt16($directory, 0)
    if ($length -eq 0 -or $length -gt 4096 -or ($length % 2)) { return }
    $buffer = ReadProcessPointer $directory $size $size
    $bytes = [byte[]]::new($length)
    if ($native::ReadProcessMemory($process, $buffer, $bytes, $length, 0)) {
      [Text.Encoding]::Unicode.GetString($bytes)
    }
  } finally { $process.Dispose() }
}

function TestJobPath($path) {
  if (!$path) { return $false }
  try {
    $path = $path.Replace('/', '\') -replace '^\\\\\?\\', ''
    if ($path -notmatch '^[a-z]:\\') { return $false }
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    return $full -eq $root -or $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function LimitProcessPath($path) {
  if (!$path) { return $null }
  return $path.Substring(0, [Math]::Min($path.Length, ${PROCESS_PATH_LIMIT}))
}

function FindJobProcesses {
  $rootPattern = '(?<![\w:\\])(?:\\\\\?\\)?' + [regex]::Escape($root) +
    '(?:\\[^\s"''<>|;&=,)]*)?(?=$|[\s"''<>|;&=,):])'
  $pattern = [regex]::new($rootPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |
    Sort-Object CreationDate -Descending | Select-Object -First ${PROCESS_SCAN_LIMIT + 1})
  if ($rows.Count -gt ${PROCESS_SCAN_LIMIT}) { $script:processLimited = $true }
  foreach ($row in ($rows | Select-Object -First ${PROCESS_SCAN_LIMIT})) {
    if ($row.ProcessId -eq $PID -or $row.ProcessId -eq 0) { continue }
    $cwd = ReadCurrentDirectory $row.ProcessId
    if (!(TestJobPath $cwd)) { $cwd = $null }
    # Keep job paths from arguments. Other arguments can contain credentials.
    $commandPaths = @()
    if ($row.CommandLine) {
      $commandPaths = @($pattern.Matches($row.CommandLine.Replace('/', '\')) | ForEach-Object { $_.Value } |
        Where-Object { TestJobPath $_ } | Select-Object -Unique -First 3 | ForEach-Object { LimitProcessPath $_ })
    }
    if (!$cwd -and !$commandPaths.Count -and !(TestJobPath $row.ExecutablePath)) { continue }
    @{
      pid = $row.ProcessId
      parentPid = $row.ParentProcessId
      image = LimitProcessPath $row.ExecutablePath
      commandPaths = $commandPaths
      cwd = LimitProcessPath $cwd
      created = if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    }
  }
}

function ReadEntryAcl($handle) {
  try {
    # OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
    $bytes = [byte[]]::new(0x11000)
    $length = [uint32]0
    if ($native::NtQuerySecurityObject($handle, 5, $bytes, $bytes.Length, [ref]$length) -ne 0) {
      throw 'Cannot read entry security descriptor'
    }
    $acl = [Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
    $denies = @($acl.DiscretionaryAcl | Where-Object AceQualifier -eq AccessDenied)
    $deleteRights = 0
    foreach ($rule in $denies) {
      if ([int]$rule.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) { continue }
      $deleteRights = $deleteRights -bor $rule.AccessMask
    }
    return @{
      owner = $acl.Owner.Value
      deleteRights = $deleteRights
      omitted = [Math]::Max(0, $denies.Count - ${DENY_LIMIT})
      deny = @($denies | Select-Object -First ${DENY_LIMIT} | ForEach-Object {
        @{ sid = $_.SecurityIdentifier.Value; rights = [Enum]::ToObject([Security.AccessControl.FileSystemRights], $_.AccessMask).ToString() }
      })
    }
  } catch { $script:failed = $true }
}

$priority = [Collections.Generic.List[object]]::new()
$survivors = [Collections.Generic.List[object]]::new()
$queue = [Collections.Generic.Queue[object]]::new()
$handles = [Collections.Generic.List[object]]::new()
$discovered = 0
try {
  $volume = [IO.Path]::GetPathRoot($root)
  if ($volume -notmatch '^[a-zA-Z]:\\$') { throw 'Expected a local drive path' }
  $parentName = [IO.Path]::GetDirectoryName($root).Substring($volume.Length)
  $volumeAccess = if ($parentName) { $readAttributes } else { $readAttributes -bor $readControl }
  # OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS and FILE_FLAG_OPEN_REPARSE_POINT.
  $drive = $native::CreateFileW(('\\?\' + $volume), $volumeAccess, $shareWithoutDelete, 0, 3, 0x02200000, 0)
  $handles.Add($drive)
  if ($drive.IsInvalid) { throw 'Cannot open job volume' }
  $parent = $drive
  if ($parentName) {
    $parent = OpenRelative $drive $parentName ($readAttributes -bor $readControl) $shareWithoutDelete
    if (!$parent) { $parent = OpenRelative $drive $parentName $readAttributes $shareAll }
    if (!$parent) { throw 'Cannot open job parent without following redirects' }
    $handles.Add($parent)
  }
  if ((ReadBasicInformation $parent).attributes -band $reparseFlag) { throw 'Job parent is a reparse point' }
  $queue.Enqueue(@{ path = $root; name = [IO.Path]::GetFileName($root); attributes = $directoryFlag;
    parent = $parent; parentAcl = (ReadEntryAcl $parent) })
  while ($queue.Count) {
    $next = $queue.Dequeue()
    $isRoot = $next.path -eq $root
    $expectedKind = $next.attributes -band ($directoryFlag -bor $reparseFlag)
    $canList = $expectedKind -eq $directoryFlag -and $discovered -lt ${SCAN_LIMIT}
    $access = $readAttributes -bor $readControl
    $handle = if ($canList) { OpenRelative $next.parent $next.name ($access -bor $listDirectory) $shareWithoutDelete }
    if (!$handle) {
      if ($canList) { $script:failed = $true }
      $canList = $false
      $handle = OpenRelative $next.parent $next.name $access $shareAll
    }
    if (!$handle) { $handle = OpenRelative $next.parent $next.name $readAttributes $shareAll }
    if (!$handle) { $script:failed = $true; continue }
    $handles.Add($handle)
    $basic = ReadBasicInformation $handle
    $attributes = $basic.attributes
    if (($attributes -band ($directoryFlag -bor $reparseFlag)) -ne $expectedKind) {
      $changed = $true
      $script:failed = $true
      continue
    }
    $acl = ReadEntryAcl $handle
    $entry = @{
      path = $next.path
      attributes = $attributes.ToString()
      created = $basic.created
      lastWrite = $basic.lastWrite
      owner = $acl.owner
      deny = $acl.deny
      denyOmitted = $acl.omitted
      parentDeny = $next.parentAcl.deny
      parentDenyOmitted = $next.parentAcl.omitted
    }
    if ($isRoot -or !$acl -or ($attributes -band ($reparseFlag -bor [IO.FileAttributes]::ReadOnly)) -or
        ($acl.deleteRights -band [Security.AccessControl.FileSystemRights]::Delete) -or
        ($next.parentAcl.deleteRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)) {
      $priority.Add($entry)
    } else { $survivors.Add($entry) }
    if ($canList) {
      try {
        foreach ($child in (ReadChildren $handle (${SCAN_LIMIT} - $discovered))) {
          $queue.Enqueue(@{ path = [IO.Path]::Combine($next.path, $child.name); name = $child.name;
            attributes = $child.attributes; parent = $handle; parentAcl = $acl })
          $discovered++
        }
      } catch { $script:failed = $true }
    }
  }
} catch { $script:failed = $true }
finally {
  foreach ($handle in $handles) { $handle.Dispose() }
}
$processScanFailed = $false
$script:processLimited = $false
$processes = [Collections.Generic.List[object]]::new()
try {
  FindJobProcesses | Select-Object -First ${RESULT_LIMIT + 1} | ForEach-Object { $processes.Add($_) }
} catch { $processScanFailed = $true }
ConvertTo-Json -Compress -Depth 6 -InputObject @{
  processes = @($processes | Select-Object -First ${RESULT_LIMIT})
  processScanFailed = $processScanFailed
  processLimited = $script:processLimited -or $processes.Count -gt ${RESULT_LIMIT}
  failed = $script:failed
  changed = $changed
  limited = $priority.Count + $survivors.Count -gt ${RESULT_LIMIT}
  entries = @($priority.ToArray() + $survivors.ToArray() | Select-Object -First ${RESULT_LIMIT})
}
`;
}

function formatDenies(rules, omitted) {
  if (rules === null) return JSON.stringify("not determined");
  if (!Array.isArray(rules) || !Number.isSafeInteger(omitted) || omitted < 0) throw new Error("Invalid cleanup ACL details");
  const denies = rules.slice(0, DENY_LIMIT).map(({ sid, rights }) => {
    if (typeof sid !== "string" || typeof rights !== "string") throw new Error("Invalid cleanup deny rule");
    return { sid, rights };
  });
  return JSON.stringify(denies) + (omitted ? ` (+${omitted} more)` : "");
}

function formatOptionalText(value, limit) {
  if (value === null) return JSON.stringify("not determined");
  if (typeof value !== "string") throw new Error("Invalid cleanup text field");
  return JSON.stringify(value.slice(0, limit));
}

export async function diagnoseJobRoot(root, diagnostic, run = runJobRootQuery) {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY_COMMAND, "utf16le").toString("base64")];
  const stdout = await new Promise((resolve, reject) => {
    run("powershell.exe", args, {
      encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT,
      env: { ...windowsPowerShellEnv(), [QUERY_VARIABLE]: queryScript(root) },
    }, (error, output) => error ? reject(error) : resolve(output));
  });
  if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) throw new Error("Cleanup query output exceeded the limit");
  const { processes, entries, failed, changed, limited, processScanFailed, processLimited } = JSON.parse(stdout);
  if (!Array.isArray(processes) || !Array.isArray(entries) || typeof failed !== "boolean" ||
      typeof changed !== "boolean" || typeof limited !== "boolean" ||
      typeof processScanFailed !== "boolean" || typeof processLimited !== "boolean") {
    throw new Error("Invalid cleanup query results");
  }
  const lines = processes.slice(0, RESULT_LIMIT).map(({ pid, parentPid, image, commandPaths, cwd, created }) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0 ||
        !Array.isArray(commandPaths) || commandPaths.some(path => typeof path !== "string")) {
      throw new Error("Invalid cleanup process details");
    }
    return `process pid=${pid} parent-pid=${parentPid} image=${formatOptionalText(image, PROCESS_PATH_LIMIT)}` +
      ` command-line-paths=${JSON.stringify(commandPaths.slice(0, 3).map(path => path.slice(0, PROCESS_PATH_LIMIT)))}` +
      ` cwd=${formatOptionalText(cwd, PROCESS_PATH_LIMIT)} created=${formatOptionalText(created, 32)}`;
  });
  for (const entry of entries.slice(0, RESULT_LIMIT)) {
    const { path, attributes, owner, deny, denyOmitted, parentDeny, parentDenyOmitted, created, lastWrite } = entry;
    if (typeof path !== "string" || (attributes !== null && typeof attributes !== "string") || (owner !== null && typeof owner !== "string")) {
      throw new Error("Invalid cleanup path details");
    }
    lines.push(`candidate path=${JSON.stringify(path)} owner=${JSON.stringify(owner ?? "not determined")}` +
      ` deny=${formatDenies(deny, denyOmitted)} parent-deny=${formatDenies(parentDeny, parentDenyOmitted)}` +
      ` attributes=${JSON.stringify(attributes ?? "not determined")} handle="not determined"` +
      ` created=${formatOptionalText(created, 32)} last-write=${formatOptionalText(lastWrite, 32)}`);
  }
  if (!failed && entries.length === 0) lines.push("Cleanup path scan found no surviving entries");
  if (changed) lines.push("Cleanup path scan skipped an entry whose directory or reparse attributes changed");
  if (limited) lines.push("Cleanup path scan reached its inspection or reporting limit");
  if (processLimited) lines.push("Cleanup process scan reached its inspection or reporting limit");
  if (processScanFailed) lines.push("Cleanup process scan was incomplete");
  if (Buffer.byteLength(lines.join("\n") + "\n") > OUTPUT_LIMIT) throw new Error("Cleanup diagnostic output exceeded the limit");
  for (const line of lines) diagnostic(line);
  if (failed) throw new Error("Cleanup query was incomplete");
}
