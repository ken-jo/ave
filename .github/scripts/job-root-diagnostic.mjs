import { spawn } from "node:child_process";
import { windowsPowerShellEnv, windowsPowerShellPath } from "../../scripts/lib/windows-powershell-env.mjs";

const TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 20;
const SCAN_LIMIT = 128;
const DENY_LIMIT = 8;
const PROCESS_PATH_LIMIT = 256;
const MAX_HOLDERS = 128;
const FILE_OUTPUT_LIMIT = 32 * 1024;
const HOLDER_OUTPUT_LIMIT = 52 * 1024;
const STATUS_RESERVE = 1024;
const PROCESS_MATCH_RESERVE = 2048;
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
ImportReadMethod kernel32.dll QueryFullProcessImageNameW ([bool]) @($processHandleType, [uint32], [Text.StringBuilder], $outLength)
$fileTime = [long].MakeByRefType()
ImportReadMethod kernel32.dll GetProcessTimes ([bool]) @($processHandleType, $fileTime, $fileTime, $fileTime, $fileTime)
$native = $interop.CreateType()

$readAttributes = 0x80
$readControl = 0x20000
$readData = 1
$shareAll = 7
$shareWithoutDelete = 3
$directoryFlag = [IO.FileAttributes]::Directory
$reparseFlag = [IO.FileAttributes]::ReparsePoint

function OpenRelative($parent, $name, $access, $sharing, $statusOut = $null) {
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
    if ($statusOut) { $statusOut.Value = $status }
    if ($status -eq 0) { return $handleType::new($raw, $true) }
  } finally {
    $marshal::FreeHGlobal($request)
    $marshal::FreeHGlobal($nameBuffer)
  }
}

function ReadBasicInformation($handle, $attributesOnly = $false) {
  $bytes = [byte[]]::new(40)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    # FileBasicInformation.
    $status = $native::NtQueryInformationFile($handle, $ioStatus, $bytes, $bytes.Length, 4)
    if ($status -ne 0) { throw "FileBasicInformation status=$status" }
    $attributes = [IO.FileAttributes][BitConverter]::ToInt32($bytes, 32)
    if ($attributesOnly) { return $attributes }
    return @{
      attributes = $attributes
      created = ReadFileTime $bytes 0
      lastWrite = ReadFileTime $bytes 16
    }
  } finally { $marshal::FreeHGlobal($ioStatus) }
}

function ReadFileIdentity($handle) {
  $bytes = [byte[]]::new(8)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    # FileInternalInformation is unique on this volume while the original handle is open.
    if ($native::NtQueryInformationFile($handle, $ioStatus, $bytes, $bytes.Length, 6) -ne 0) {
      throw 'Cannot read file identity'
    }
    return [BitConverter]::ToInt64($bytes, 0)
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
      if ($status -ne 0) { throw "NtQueryDirectoryFile status=$status" }
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

function runJobRootQuery(_command, args, { encoding, env, windowsHide }, done) {
  const child = spawn(windowsPowerShellPath(env), args, { env, windowsHide, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.setEncoding(encoding);
  child.once("error", done);
  child.once("close", (code, signal) => done(code === 0 ? null : new Error(
    signal ? `Job root query exited on ${signal}` : `Job root query exited with code ${code}`,
  )));
  return child;
}

const EVIDENCE_WRITER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$script:outputBytes = 0

function WriteEvidence($record, $limit) {
  $line = ConvertTo-Json -Compress -Depth 5 -InputObject $record
  $size = [Text.Encoding]::UTF8.GetByteCount($line) + 2
  if ($script:outputBytes + $size -gt $limit) { return $false }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  $script:outputBytes += $size
  return $true
}
`;

const PROCESS_RECORDS = String.raw`
function LimitProcessPath($path) {
  if (!$path) { return $null }
  return $path.Substring(0, [Math]::Min($path.Length, ${PROCESS_PATH_LIMIT}))
}

`;
const CURRENT_DIRECTORY_PROBE = String.raw`
function ReadProcessPointer($bytes, $offset, $size) {
  if ($size -eq 4) { return [IntPtr][long][BitConverter]::ToUInt32($bytes, $offset) }
  return [IntPtr][BitConverter]::ToInt64($bytes, $offset)
}

function ReadCurrentDirectory($id) {
  # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ.
  $process = $native::OpenProcess(0x410, $false, $id)
  try {
    if ($process.IsInvalid) { return @{ reason = 'OpenProcess failed' } }
    $size = $pointerSize
    $peb = [IntPtr]::Zero
    if ($size -eq 8) {
      # ProcessWow64Information supplies the 32-bit PEB for a WOW64 process.
      $info = [byte[]]::new(8)
      if ($native::NtQueryInformationProcess($process, 26, $info, $info.Length, 0) -ne 0) {
        return @{ reason = 'NtQueryInformationProcess failed' }
      }
      $peb = ReadProcessPointer $info 0 8
      if ($peb -ne [IntPtr]::Zero) { $size = 4 }
    }
    if ($peb -eq [IntPtr]::Zero) {
      # ProcessBasicInformation.
      $info = [byte[]]::new(6 * $size)
      if ($native::NtQueryInformationProcess($process, 0, $info, $info.Length, 0) -ne 0) {
        return @{ reason = 'NtQueryInformationProcess failed' }
      }
      $peb = ReadProcessPointer $info $size $size
    }
    # Read only PEB.ProcessParameters and the CurrentDirectory UNICODE_STRING.
    $parametersOffset = if ($size -eq 8) { 0x20 } else { 0x10 }
    $directoryOffset = if ($size -eq 8) { 0x38 } else { 0x24 }
    $pointer = [byte[]]::new($size)
    if (!$native::ReadProcessMemory($process, [IntPtr]::Add($peb, $parametersOffset), $pointer, $size, 0)) {
      return @{ reason = 'ReadProcessMemory failed' }
    }
    $parameters = ReadProcessPointer $pointer 0 $size
    $directory = [byte[]]::new(2 * $size)
    if (!$native::ReadProcessMemory($process, [IntPtr]::Add($parameters, $directoryOffset), $directory, $directory.Length, 0)) {
      return @{ reason = 'ReadProcessMemory failed' }
    }
    $length = [BitConverter]::ToUInt16($directory, 0)
    if ($length -gt 4096) { return @{ reason = 'cwd exceeds 4096 bytes' } }
    if ($length -eq 0 -or ($length % 2)) { return @{ reason = 'invalid cwd length' } }
    $buffer = ReadProcessPointer $directory $size $size
    $bytes = [byte[]]::new($length)
    if (!$native::ReadProcessMemory($process, $buffer, $bytes, $length, 0)) {
      return @{ reason = 'ReadProcessMemory failed' }
    }
    return @{ path = [Text.Encoding]::Unicode.GetString($bytes) }
  } finally { $process.Dispose() }
}
`;

function queryScript(root, preflight) {
  return String.raw`
${EVIDENCE_WRITER}
$root = '${root.replaceAll("'", "''")}'
$prefix = $root.TrimEnd('\') + '\'
$preflight = $${preflight}
$script:failed = $false
$script:changed = $false
$script:scanFailure = $null
${HANDLE_QUERY}
${PROCESS_RECORDS}

${CURRENT_DIRECTORY_PROBE}

function TestJobPath($path, $source, $failures) {
  try {
    $path = $path.Replace('/', '\') -replace '^\\\\\?\\', ''
    if ($path -notmatch '^[a-z]:\\') { throw 'Expected an absolute drive path' }
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    return $full -eq $root -or $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    $failure = "path conversion failed ($source)"
    if (!$failures.Contains($failure)) { $failures.Add($failure) }
    return $false
  }
}

function TestArgumentPath($path) {
  # Resolve dot segments; trimming trailing dots and spaces from every segment can only add matches.
  $segments = [Collections.Generic.List[string]]::new()
  foreach ($segment in $path.Substring(3).Split('\')) {
    if ($segment -eq '..') { if ($segments.Count) { $segments.RemoveAt($segments.Count - 1) } }
    elseif ($segment -ne '.') {
      $segment = $segment.TrimEnd(' ', '.')
      if ($segment) { $segments.Add($segment) }
    }
  }
  $full = $path.Substring(0, 3) + ($segments -join '\') + '\'
  return $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

# Every drive path start is an operand, also after a switch such as /out: or -o. The first group ends at
# a delimiter, the second only at a quote or a character Win32 file names cannot hold, so quoted paths keep spaces.
$argumentPattern = [regex]::new('(?=([a-z]:\\[^\s"''<>|*?:;,&=)]*))(?=([a-z]:\\[^"''<>|*?:]*))',
  [Text.RegularExpressions.RegexOptions]::IgnoreCase)
$rootLeaf = [IO.Path]::GetFileName($root.TrimEnd('\'))

function FindArgumentReference($commandLine) {
  # Canonical segments appear literally in the operand, so a line without the root's leaf cannot match.
  if ($commandLine.IndexOf($rootLeaf, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  foreach ($match in $argumentPattern.Matches($commandLine.Replace('/', '\'))) {
    if ((TestArgumentPath $match.Groups[1].Value) -or (TestArgumentPath $match.Groups[2].Value)) { return $true }
  }
  return $false
}

function FindProcessReference($row, $failures) {
  if (!$row.ExecutablePath) { $failures.Add('missing CIM ExecutablePath') }
  elseif (TestJobPath $row.ExecutablePath 'image' $failures) { return 'image' }

  if (!$row.CommandLine) { $failures.Add('missing CIM CommandLine') }
  elseif (FindArgumentReference $row.CommandLine) { return 'argument' }
  $cwd = ReadCurrentDirectory $row.ProcessId
  if ($cwd.reason) { $failures.Add($cwd.reason) }
  elseif (TestJobPath $cwd.path 'cwd' $failures) { return 'cwd' }
}

function ReadHolderMetadata($record) {
  $process = $native::OpenProcess(0x1000, $false, $record.pid)
  try {
    if ($process.IsInvalid) { return }
    $created = $exited = $kernel = $user = 0L
    if (!$native::GetProcessTimes($process, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) { return }
    $record.created = [DateTime]::FromFileTimeUtc($created).ToString('o')
    $image = [Text.StringBuilder]::new(32768)
    $length = [uint32]$image.Capacity
    if ($native::QueryFullProcessImageNameW($process, 0, $image, [ref]$length)) {
      $record.image = LimitProcessPath $image.ToString()
    }
    $info = [byte[]]::new(6 * $pointerSize)
    if ($native::NtQueryInformationProcess($process, 0, $info, $info.Length, 0) -eq 0) {
      $record.unresolvedParentPid = (ReadProcessPointer $info (5 * $pointerSize) $pointerSize).ToInt64()
    }
  } finally { $process.Dispose() }
}

function TestFileIdentity($file, $handle) {
  if (!$handle) { return $false }
  $kind = (ReadBasicInformation $handle).attributes -band ($directoryFlag -bor $reparseFlag)
  return $kind -eq 0 -and (ReadFileIdentity $handle) -eq $file.identity
}

function NewHolderFailure($path, $operation) {
  @{ kind = 'holderFailure'; path = $path; operation = $operation }
}

function ReadVerifiedHolders($file) {
  if (!$file.parentPinned) { return (NewHolderFailure $file.path 'unverified-path') }
  # Data access makes the handle participate in delete sharing.
  $pin = OpenRelative $file.parent $file.name ($readData -bor $readAttributes) $shareWithoutDelete
  try {
    if (!(TestFileIdentity $file $pin)) { return (NewHolderFailure $file.path 'unverified-path') }
    $rows = @(ReadFileHolders $pin $file.path)
    if (!(TestFileIdentity $file $pin)) { return (NewHolderFailure $file.path 'unverified-path') }
    return $rows
  } finally { if ($pin) { $pin.Dispose() } }
}

function ReadFileHolders($handle, $path) {
  # FileProcessIdsUsingFileInformation is a count followed by aligned ULONG_PTR PIDs.
  $info = [byte[]]::new((${MAX_HOLDERS} + 1) * $pointerSize)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    $status = $native::NtQueryInformationFile($handle, $ioStatus, $info, $info.Length, 47)
    $count = [BitConverter]::ToUInt32($info, 0)
    if ($status -ne 0 -or $count -gt ${MAX_HOLDERS}) {
      @{ kind = 'handleQuery'; path = $path; status = $status; limited = $count -gt ${MAX_HOLDERS} }
      return
    }
    for ($i = 1; $i -le $count; $i++) {
      $id = (ReadProcessPointer $info ($i * $pointerSize) $pointerSize).ToInt64()
      if ($id -eq $PID) { continue }
      if ($id -le 0 -or $id -gt [int]::MaxValue) { throw 'Invalid file holder PID' }
      $record = @{ kind = 'holder'; path = $path; pid = $id; unresolvedParentPid = $null
        image = $null; created = $null; app = $null; service = $null }
      try { ReadHolderMetadata $record } catch {}
      if (!$record.image) { $record.image = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName }
      $record.app = [IO.Path]::GetFileName($record.image)
      $record
    }
  } finally { $marshal::FreeHGlobal($ioStatus) }
}

function FindJobProcesses {
  $inspected = 0
  $matched = 0
  $sawQueryProcess = $false
  # Rows stream unsorted; the deadline and the byte budget bound the scan.
  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate,Name | ForEach-Object {
    $inspected++
    $row = $_
    if ($row.ProcessId -eq $PID) { $sawQueryProcess = $true; return }
    if ($matched -gt ${RESULT_LIMIT}) { return }
    if ($null -eq $row.ProcessId) { $script:processFailure = 'process row without ProcessId'; return }
    # The idle pseudo-process has no user-mode process to inspect.
    if ($row.ProcessId -eq 0) { return }
    $failures = [Collections.Generic.List[string]]::new()
    $reason = try { FindProcessReference $row $failures }
      catch { $failures.Add('process reference query failed') }
    if ($reason) {
      if (++$matched -gt ${RESULT_LIMIT}) { $script:processMatchLimited = $true; return }
      $record = @{ kind = 'process'; pid = $row.ProcessId; reason = $reason }
      try {
        $record.unresolvedParentPid = $row.ParentProcessId
        $record.image = if ($row.ExecutablePath) { LimitProcessPath $row.ExecutablePath }
          else { LimitProcessPath $row.Name }
        $record.created = if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') }
          else { $null }
      } catch { $script:processFailure = 'process match metadata unavailable' }
      $record
    }
    if ($failures.Count) {
      @{ kind = 'processUnreadable'; pid = $row.ProcessId; reason = $failures -join '; ' }
    }
  }
  $script:processInspected = $inspected
  if ($preflight -and !$sawQueryProcess) { $script:processFailure = 'query process missing from process rows' }
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

function OpenJobParent {
  $volume = [IO.Path]::GetPathRoot($root)
  if ($volume -notmatch '^[a-zA-Z]:\\$') { throw 'Expected a local drive path' }
  $parentPath = [IO.Path]::GetDirectoryName($root).Substring($volume.Length)
  $volumeAccess = if ($parentPath) { $readAttributes } else { $readAttributes -bor $readControl }
  # OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS and FILE_FLAG_OPEN_REPARSE_POINT.
  $drive = $native::CreateFileW(('\\?\' + $volume), $volumeAccess, $shareWithoutDelete, 0, 3, 0x02200000, 0)
  $handles.Add($drive)
  if ($drive.IsInvalid) { throw "CreateFileW could not open job volume $volume" }
  $parent = $drive
  $parentPinned = $true
  if ((ReadBasicInformation $parent $true) -band $reparseFlag) { throw 'Job volume is a reparse point' }
  if ($parentPath) {
    $ancestors = $parentPath.Split('\')
    for ($i = 0; $i -lt $ancestors.Length; $i++) {
      $status = 0
      $access = $readAttributes -bor $readData
      if ($i -eq $ancestors.Length - 1) { $access = $access -bor $readControl }
      $ancestor = OpenRelative $parent $ancestors[$i] $access $shareWithoutDelete
      if (!$ancestor -and ($access -band $readControl)) {
        $ancestor = OpenRelative $parent $ancestors[$i] ($readAttributes -bor $readData) $shareWithoutDelete
      }
      if (!$ancestor) {
        $parentPinned = $false
        $ancestor = OpenRelative $parent $ancestors[$i] $readAttributes $shareAll ([ref]$status)
      }
      if (!$ancestor) { throw "NtOpenFile job ancestor $($ancestors[$i]) status=$status" }
      $handles.Add($ancestor)
      if ((ReadBasicInformation $ancestor $true) -band $reparseFlag) { throw "Job ancestor $($ancestors[$i]) is a reparse point" }
      $parent = $ancestor
    }
  }
  return @{ handle = $parent; pinned = $parentPinned }
}

function FindSurvivingEntries($jobParent) {
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ path = $root; name = [IO.Path]::GetFileName($root); attributes = $directoryFlag;
    parent = $jobParent.handle; parentAcl = (ReadEntryAcl $jobParent.handle); parentPinned = $jobParent.pinned })
  while ($queue.Count) {
    $next = $queue.Dequeue()
    $isRoot = $next.path -eq $root
    $expectedKind = $next.attributes -band ($directoryFlag -bor $reparseFlag)
    $canList = $expectedKind -eq $directoryFlag -and $script:discovered -lt ${SCAN_LIMIT}
    $access = $readAttributes -bor $readControl
    $handle = if ($canList) { OpenRelative $next.parent $next.name ($access -bor $readData) $shareWithoutDelete }
    $isFile = $expectedKind -eq 0
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
      $script:changed = $true
      $script:failed = $true
      continue
    }
    $acl = ReadEntryAcl $handle
    $entry = @{
      kind = 'candidate'
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
    if ($isFile) {
      $identity = try { ReadFileIdentity $handle } catch { $script:failed = $true; $null }
      $files.Add(@{ path = $next.path; parent = $next.parent; name = $next.name
        parentPinned = $next.parentPinned -and $null -ne $identity; identity = $identity })
    }
    if ($canList) {
      $remaining = ${SCAN_LIMIT} - $script:discovered
      try {
        foreach ($child in (ReadChildren $handle $remaining)) {
          $path = [IO.Path]::Combine($next.path, $child.name)
          if ($script:discovered -ge ${SCAN_LIMIT}) { break }
          $queue.Enqueue(@{ path = $path; name = $child.name;
            attributes = $child.attributes; parent = $handle; parentAcl = $acl; parentPinned = $next.parentPinned })
          $script:discovered++
        }
      } catch { $script:failed = $true }
    }
  }
}

$priority = [Collections.Generic.List[object]]::new()
$survivors = [Collections.Generic.List[object]]::new()
$handles = [Collections.Generic.List[object]]::new()
$files = [Collections.Generic.List[object]]::new()
$script:discovered = 0
$script:holderFailed = $false
$holderRecordLimited = $false
$holderByteLimited = $false
$holderLookupLimited = $false
# The precondition is the process scan alone; the bounded entry and holder report runs only after a failure.
if (!$preflight) {
  try {
    try {
      $jobParent = OpenJobParent
      FindSurvivingEntries $jobParent
    } catch { $script:failed = $true; $script:scanFailure = $_.Exception.Message }
    $entries = @($priority.ToArray() + $survivors.ToArray() | Select-Object -First ${RESULT_LIMIT})
    $fileLimited = $priority.Count + $survivors.Count -gt ${RESULT_LIMIT} -or $script:discovered -ge ${SCAN_LIMIT}
    foreach ($entry in $entries) {
      if (!(WriteEvidence $entry ${FILE_OUTPUT_LIMIT})) { $fileLimited = $true }
    }
    $null = WriteEvidence @{
      kind = 'files'; failed = $script:failed; changed = $script:changed; limited = $fileLimited
      empty = $entries.Count -eq 0; reason = $script:scanFailure
    } ${FILE_OUTPUT_LIMIT + 256}

    $holderFailures = [Collections.Generic.List[object]]::new()
    # A holder lookup costs about 15 ms per file, so look up only as many files as the report lists.
    $holderLookupLimited = $files.Count -gt ${RESULT_LIMIT}
    & {
      try {
        foreach ($file in ($files | Select-Object -First ${RESULT_LIMIT})) {
          try { ReadVerifiedHolders $file }
          catch { NewHolderFailure $file.path 'query' }
        }
      } catch {
        $script:holderFailed = $true
        NewHolderFailure $root 'query'
      }
    } | ForEach-Object {
      if ($_.limited) { $holderRecordLimited = $true }
      if ($_.kind -ne 'holder') { $holderFailures.Add($_) }
      elseif (!(WriteEvidence $_ ${HOLDER_OUTPUT_LIMIT})) { $holderByteLimited = $true }
    }
    foreach ($failure in $holderFailures) {
      if (!(WriteEvidence $failure ${HOLDER_OUTPUT_LIMIT})) { $holderByteLimited = $true }
    }
  } finally {
    foreach ($handle in $handles) { $handle.Dispose() }
  }
  $null = WriteEvidence @{
    kind = 'holders'; limited = $holderRecordLimited -or $holderByteLimited; failed = $script:holderFailed
    recordLimited = $holderRecordLimited; byteLimited = $holderByteLimited; lookupLimited = $holderLookupLimited
  } ${HOLDER_OUTPUT_LIMIT + 256}
}
$script:processFailure = $null
$script:processMatchLimited = $false
$script:processByteLimited = $false
$script:processInspected = 0
$processWatch = [Diagnostics.Stopwatch]::StartNew()
try {
  FindJobProcesses | ForEach-Object {
    # Leave room for a positive match even when unreadable references fill the report.
    $limit = if ($_.kind -eq 'processUnreadable') { ${OUTPUT_LIMIT - STATUS_RESERVE - PROCESS_MATCH_RESERVE} }
      else { ${OUTPUT_LIMIT - STATUS_RESERVE} }
    if (!(WriteEvidence $_ $limit)) { $script:processByteLimited = $true }
  }
} catch { $script:processFailure = "process query HRESULT=$($_.Exception.HResult)" }
$script:processFailed = $null -ne $script:processFailure
$script:processLimited = $script:processMatchLimited -or $script:processByteLimited
$null = WriteEvidence @{
  kind = 'processes'; failed = $script:processFailed; limited = $script:processLimited
  reason = $script:processFailure
  matchLimited = $script:processMatchLimited; byteLimited = $script:processByteLimited
  inspected = $script:processInspected; elapsedMs = $processWatch.ElapsedMilliseconds
} ${OUTPUT_LIMIT}
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

function formatCandidate({ path, attributes, owner, deny, denyOmitted, parentDeny, parentDenyOmitted, created, lastWrite }) {
  if (typeof path !== "string") throw new Error("Invalid cleanup path");
  return `candidate path=${JSON.stringify(path)} owner=${formatOptionalText(owner, 192)}` +
    ` deny=${formatDenies(deny, denyOmitted)} parent-deny=${formatDenies(parentDeny, parentDenyOmitted)}` +
    ` attributes=${formatOptionalText(attributes, 192)} handle="not determined"` +
    ` created=${formatOptionalText(created, 32)} last-write=${formatOptionalText(lastWrite, 32)}`;
}

function isProcessId(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function formatProcess({ kind, pid, unresolvedParentPid, image, created, path, app, service, reason }) {
  if (unresolvedParentPid !== null && (!Number.isSafeInteger(unresolvedParentPid) || unresolvedParentPid < 0)) {
    throw new Error("Invalid cleanup process parent PID");
  }
  const base = `${kind} pid=${pid} unresolved-parent-pid=${unresolvedParentPid ?? '"not determined"'} image=${formatOptionalText(image, PROCESS_PATH_LIMIT)}`;
  const started = `created=${formatOptionalText(created, 32)}`;
  if (kind === "holder") {
    if (typeof path !== "string") throw new Error("Invalid holder path");
    return `${base} path=${JSON.stringify(path)} app=${formatOptionalText(app, 256)} service=${formatOptionalText(service, 64)} ${started}`;
  }
  return `${base} match=${reason} ${started}`;
}

function collectQuery(script, timeout, maxBuffer, readRecord, invalidRecord, run) {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY_COMMAND, "utf16le").toString("base64")];
  const options = {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer,
    env: { ...windowsPowerShellEnv(), [QUERY_VARIABLE]: script },
  };
  return new Promise(resolve => {
    let child;
    let settled = false;
    let failure;
    let pending = "";
    let inputBytes = 0;

    function consume(chunk) {
      if (settled) return;
      const size = Buffer.byteLength(chunk);
      if (inputBytes + size > maxBuffer) {
        failure = `Cleanup query output exceeded ${maxBuffer} bytes`;
        if (inputBytes === maxBuffer) return;
        chunk = Buffer.from(chunk).subarray(0, maxBuffer - inputBytes).toString("utf8");
      }
      inputBytes = Math.min(maxBuffer, inputBytes + size);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        try { readRecord(JSON.parse(line)); }
        catch (error) {
          failure ??= error instanceof SyntaxError ? "Invalid cleanup JSON record" : error.message;
          invalidRecord();
        }
      }
    }

    function finish(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(reason ?? failure ?? (pending ? "Cleanup query ended with a partial record" : undefined));
    }

    const deadline = setTimeout(() => {
      finish(`Cleanup query reached its ${timeout} ms deadline`);
      // The query starts no processes; its console host exits with it.
      child?.kill?.();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref?.();
    }, timeout);
    try {
      child = run("powershell.exe", args, options, (error, stdout) => {
        if (!child?.stdout && stdout) consume(stdout);
        finish(error ? queryError(error) : undefined);
      });
      child?.stdout?.on("data", consume);
    } catch (error) { finish(queryError(error)); }
  });
}

function queryError(error) {
  return `Cleanup query failed: ${error?.code ?? error?.message ?? "unknown error"}`;
}

export async function diagnoseJobRoot(root, diagnostic, run) {
  await inspectJobRoot(root, diagnostic, run, false);
}

export async function assertNoJobRootWriters(root, run) {
  const evidence = [];
  let reason = "live processes can still access the job root";
  try {
    if (!(await inspectJobRoot(root, line => evidence.push(line), run, true))) return evidence;
  } catch (error) {
    reason = "writer evidence is incomplete";
    if (evidence.length === 0) evidence.push(error.message);
  }
  throw new Error([`Cannot clean up job root ${root}: ${reason}. Directory left in place.`, ...evidence].join("\n"));
}

async function inspectJobRoot(root, diagnostic, run = runJobRootQuery, preflight) {
  let outputBytes = 0;
  let outputLimited = false;
  let failed = false;

  function emit(line, limit = OUTPUT_LIMIT - STATUS_RESERVE) {
    const size = Buffer.byteLength(line) + 1;
    if (outputBytes + size <= limit) {
      diagnostic(line);
      outputBytes += size;
    } else {
      outputLimited = true;
    }
  }

  // The precondition query streams only process records.
  let filesComplete = preflight;
  let holdersComplete = preflight;
  let processesComplete = false;
  let processScanIncomplete = false;
  let fileCount = 0;
  let processCount = 0;
  let writerFound = false;
  let holdersOutputEnd = 0;
  function incomplete(row, ...flags) {
    for (const key of flags) {
      if (typeof row[key] !== "boolean") throw new Error(`Invalid cleanup ${row.kind} status field: ${key}`);
    }
    return flags.some(key => row[key]);
  }

  const script = queryScript(root, preflight);
  const queryFailure = await collectQuery(script, TIMEOUT_MS, OUTPUT_LIMIT, row => {
    if (!filesComplete && row.kind === "candidate") {
      if (fileCount++ < RESULT_LIMIT) emit(formatCandidate(row), FILE_OUTPUT_LIMIT);
    } else if (!filesComplete && row.kind === "files") {
      failed ||= row.failed;
      filesComplete = true;
      if (row.empty && !row.failed) emit("Cleanup path scan found no surviving entries");
      if (row.changed) emit("Cleanup path scan skipped an entry whose directory or reparse attributes changed");
      if (row.limited) emit("Cleanup path scan reached its inspection or reporting limit");
      holdersOutputEnd = outputBytes + HOLDER_OUTPUT_LIMIT - FILE_OUTPUT_LIMIT;
    } else if (filesComplete && !holdersComplete) {
      if (row.kind === "holders") {
        failed ||= row.failed;
        holdersComplete = true;
        if (row.failed) emit("Native file holder lookup was incomplete");
        if (row.recordLimited) emit(`Native file holder records exceeded the ${MAX_HOLDERS}-record limit`);
        if (row.byteLimited) emit(`Native file holder output reached its ${HOLDER_OUTPUT_LIMIT}-byte limit`);
        if (row.limited && !row.recordLimited && !row.byteLimited) emit("Native file holder output reached its reporting limit");
        if (row.lookupLimited) emit(`Native file holder lookup covered only the first ${RESULT_LIMIT} files`);
      } else if (row.kind === "holderFailure") {
        if (typeof row.path !== "string" || !["unverified-path", "query"].includes(row.operation)) {
          throw new Error("Invalid native file holder operation");
        }
        emit(`Native file holder lookup failed path=${JSON.stringify(row.path)} operation=${row.operation}`, holdersOutputEnd);
      } else if (row.kind === "handleQuery") {
        if (typeof row.path !== "string" || !Number.isInteger(row.status)) throw new Error("Invalid native file holder status");
        const suffix = row.limited ? ` (over ${MAX_HOLDERS} holder records)` : "";
        emit(`Native file holder lookup failed path=${JSON.stringify(row.path)} status=${row.status}${suffix}`, holdersOutputEnd);
      } else if (row.kind === "holder") {
        if (!isProcessId(row.pid)) throw new Error("Invalid native file holder PID");
        emit(formatProcess(row), holdersOutputEnd);
      } else {
        throw new Error("Unexpected holder record");
      }
    } else if (holdersComplete && !processesComplete) {
      if (row.kind === "processes") {
        processesComplete = true;
        if (row.limited) emit("Cleanup process scan reached its inspection or reporting limit");
        if (row.matchLimited) emit(`Cleanup process scan exceeded ${RESULT_LIMIT} process matches`);
        if (row.byteLimited) emit(`Cleanup process output reached its ${OUTPUT_LIMIT}-byte budget`);
        if (row.reason) emit(`Cleanup process scan failed: ${row.reason}`);
        if (Number.isSafeInteger(row.inspected) && Number.isSafeInteger(row.elapsedMs)) {
          emit(`Cleanup process scan inspected ${row.inspected} process rows in ${row.elapsedMs} ms`);
        }
        processScanIncomplete = preflight ? incomplete(row, "failed", "limited") : row.failed;
      } else if (row.kind === "process") {
        const { pid, reason } = row;
        if (!isProcessId(pid) || !["image", "cwd", "argument"].includes(reason)) {
          throw new Error("Invalid process match record");
        }
        writerFound = true;
        if (processCount++ < RESULT_LIMIT) {
          let line;
          try { line = formatProcess(row); }
          catch {
            emit(`process pid=${pid} match=${reason}`);
            emit(`Cleanup process match metadata was unavailable for pid=${pid}`);
            return;
          }
          emit(line);
        }
      } else if (row.kind === "processUnreadable") {
        const { pid, reason } = row;
        if (!isProcessId(pid) || typeof reason !== "string" || !reason) {
          throw new Error("Invalid unreadable process record");
        }
        emit(`process unreadable pid=${pid} reason=${formatOptionalText(reason, PROCESS_PATH_LIMIT)}`,
          OUTPUT_LIMIT - STATUS_RESERVE - PROCESS_MATCH_RESERVE);
      } else {
        throw new Error("Unexpected process record");
      }
    } else {
      throw new Error("Unexpected cleanup record");
    }
  }, () => { failed ||= !holdersComplete; }, run);
  if (preflight) {
    if (queryFailure) emit(queryFailure, OUTPUT_LIMIT);
    if (!processesComplete) emit("Cleanup process scan did not report completion", OUTPUT_LIMIT);
  } else if (filesComplete && !holdersComplete) emit("Native file holder lookup was incomplete");
  const processQueryIncomplete = Boolean(queryFailure) || !processesComplete;
  if (processScanIncomplete || (preflight && (processQueryIncomplete || outputLimited))) {
    emit("Cleanup process scan was incomplete");
  }
  if (outputLimited) emit("Cleanup diagnostic output reached its byte limit", OUTPUT_LIMIT);
  // Process references are the precondition's live-reference evidence: an unfinished scan without a match refuses.
  if (failed || !filesComplete || !holdersComplete || processQueryIncomplete
    || (preflight && processScanIncomplete && !writerFound)) {
    throw new Error("Cleanup query was incomplete");
  }
  return writerFound;
}
