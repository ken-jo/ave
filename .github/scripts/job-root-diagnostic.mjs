import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TIMEOUT_MS = 5000;
const SUSPECT_TIMEOUT_MS = 1800;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 20;
const SCAN_LIMIT = 128;
const DENY_LIMIT = 8;
const PROCESS_SCAN_LIMIT = 512;
const PROCESS_PATH_LIMIT = 256;
const HOLDER_LIMIT = 16;
const MAX_HOLDERS = 128;
const SUSPECT_OUTPUT_LIMIT = 8 * 1024;
const FILE_OUTPUT_LIMIT = 32 * 1024;
const HOLDER_OUTPUT_LIMIT = 52 * 1024;
const STATUS_RESERVE = 1024;
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
ImportReadMethod rstrtmgr.dll RmStartSession ([uint32]) @($outLength, [uint32], [Text.StringBuilder])
ImportReadMethod rstrtmgr.dll RmRegisterResources ([uint32]) @([uint32], [uint32], [IntPtr], [uint32], [IntPtr], [uint32], [IntPtr])
ImportReadMethod rstrtmgr.dll RmGetList ([uint32]) @([uint32], $outLength, $outLength, [IntPtr], $outLength)
ImportReadMethod rstrtmgr.dll RmEndSession ([uint32]) @([uint32])
$native = $interop.CreateType()

$readAttributes = 0x80
$readControl = 0x20000
$readData = 1
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

function NewProcessRecord($row, $kind) {
  @{
    kind = $kind; pid = $row.ProcessId; parentPid = $row.ParentProcessId
    image = LimitProcessPath $row.ExecutablePath
    created = if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
}

`;

const SUSPECT_QUERY = String.raw`
${EVIDENCE_WRITER}
${PROCESS_RECORDS}
function ReadParentName($id, $childCreated) {
  if (!$id) { return }
  try {
    $parent = [Diagnostics.Process]::GetProcessById($id)
    try {
      $name = $parent.ProcessName
      if ($childCreated -and $parent.StartTime.ToUniversalTime() -gt $childCreated.ToUniversalTime()) { return }
      return $name + '.exe'
    } finally { $parent.Dispose() }
  } catch {}
}

function FindNamedSuspects {
  if (!(Get-Process -Name setup_wm,unregmp2,wmplayer -ErrorAction SilentlyContinue)) { return }
  $filter = "Name = 'setup_wm.exe' OR Name = 'unregmp2.exe' OR Name = 'wmplayer.exe'"
  Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate |
    ForEach-Object {
      try {
        $record = NewProcessRecord $_ 'suspect'
        $record.name = $_.Name
        $record.parentName = ReadParentName $_.ParentProcessId $_.CreationDate
        $record
      } catch { $script:processFailed = $true }
    }
}

$script:processFailed = $false
$limited = $false
try {
  FindNamedSuspects | ForEach-Object {
    if (!(WriteEvidence $_ ${SUSPECT_OUTPUT_LIMIT - 256})) { $limited = $true }
  }
} catch { $script:processFailed = $true }
$null = WriteEvidence @{ kind = 'suspects'; failed = $script:processFailed; limited = $limited } ${SUSPECT_OUTPUT_LIMIT}
`;

function queryScript(root) {
  return String.raw`
${EVIDENCE_WRITER}
$root = '${root.replaceAll("'", "''")}'
$prefix = $root.TrimEnd('\') + '\'
$script:failed = $false
$script:changed = $false
${HANDLE_QUERY}
${PROCESS_RECORDS}

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

function ReadHolderMetadata($record, $started) {
  $process = $native::OpenProcess(0x1000, $false, $record.pid)
  try {
    if ($process.IsInvalid) { return }
    $created = $exited = $kernel = $user = 0L
    if (!$native::GetProcessTimes($process, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user) -or
        $created -ne $started) { return }
    $image = [Text.StringBuilder]::new(32768)
    $length = [uint32]$image.Capacity
    if ($native::QueryFullProcessImageNameW($process, 0, $image, [ref]$length)) {
      $record.image = LimitProcessPath $image.ToString()
    }
    $info = [byte[]]::new(6 * $pointerSize)
    if ($native::NtQueryInformationProcess($process, 0, $info, $info.Length, 0) -eq 0) {
      $record.parentPid = (ReadProcessPointer $info (5 * $pointerSize) $pointerSize).ToInt64()
    }
  } finally { $process.Dispose() }
}

function FindFileHolders([string[]]$paths) {
  $path = $paths[0]
  $session = [uint32]0
  $key = [Text.StringBuilder]::new(33)
  $operation = 'RmStartSession'
  $code = $native::RmStartSession([ref]$session, 0, $key)
  if ($code -ne 0) { @{ kind = 'restartManager'; path = $path; operation = $operation; code = $code }; return }
  $files = $buffer = [IntPtr]::Zero
  $strings = [IntPtr[]]::new($paths.Length)
  try {
    $files = $marshal::AllocHGlobal($pointerSize * $paths.Length)
    for ($i = 0; $i -lt $paths.Length; $i++) {
      $strings[$i] = $marshal::StringToHGlobalUni($paths[$i])
      $marshal::WriteIntPtr($files, $i * $pointerSize, $strings[$i])
    }
    $operation = 'RmRegisterResources'
    $code = $native::RmRegisterResources($session, $paths.Length, $files, 0, 0, 0, 0)
    if ($code -eq 0) {
      # RM_PROCESS_INFO is a PID and FILETIME, two WCHAR arrays (256 and 64),
      # and four 32-bit fields. The native record has no pointers.
      $rowSize = 668
      $count = [uint32]${HOLDER_LIMIT}
      $buffer = $marshal::AllocHGlobal($rowSize * $count)
      $needed = $reasons = [uint32]0
      $operation = 'RmGetList'
      $code = $native::RmGetList($session, [ref]$needed, [ref]$count, $buffer, [ref]$reasons)
      if ($code -eq 234 -and $needed -gt ${HOLDER_LIMIT} -and $needed -le ${MAX_HOLDERS}) {
        $count = $needed
        $buffer = $marshal::ReAllocHGlobal($buffer, [IntPtr]($rowSize * $count))
        $code = $native::RmGetList($session, [ref]$needed, [ref]$count, $buffer, [ref]$reasons)
      }
      if ($code -eq 0) {
        for ($i = 0; $i -lt $count; $i++) {
          $row = [IntPtr]::Add($buffer, $i * $rowSize)
          $id = $marshal::ReadInt32($row)
          if ($id -le 0 -or $id -eq $PID) { continue }
          # A multi-file registration cannot attribute a PID to a particular file.
          if ($paths.Length -gt 1) { return $true }
          $started = $marshal::ReadInt64($row, 4)
          $record = @{
            kind = 'holder'; path = $path; pid = $id; parentPid = $null; image = $null
            app = $marshal::PtrToStringUni([IntPtr]::Add($row, 12), 256).Split([char]0)[0].Trim()
            service = $marshal::PtrToStringUni([IntPtr]::Add($row, 524), 64).Split([char]0)[0]
            created = [DateTime]::FromFileTimeUtc($started).ToString('o')
          }
          try { ReadHolderMetadata $record $started } catch {}
          if (!$record.app) { $record.app = [IO.Path]::GetFileName($record.image) }
          $record
        }
      }
    }
    if ($code -ne 0) {
      @{ kind = 'restartManager'; path = $path; operation = $operation; code = $code }
    }
  } finally {
    $marshal::FreeHGlobal($buffer)
    $marshal::FreeHGlobal($files)
    foreach ($string in $strings) { $marshal::FreeHGlobal($string) }
    $code = $native::RmEndSession($session)
    if ($code -ne 0) { @{ kind = 'restartManager'; path = $path; operation = 'RmEndSession'; code = $code } }
  }
}

function TestFileIdentity($file, $handle) {
  if (!$handle) { return $false }
  $kind = (ReadBasicInformation $handle).attributes -band ($directoryFlag -bor $reparseFlag)
  return $kind -eq 0 -and (ReadFileIdentity $handle) -eq $file.identity
}

function NewUnverifiedPath($file) {
  @{ kind = 'restartManager'; path = $file.path; operation = 'unverified-path'; code = $null }
}

function TestCandidatePath($file) {
  if (!$file.parentPinned) { return $false }
  $handle = OpenRelative $file.parent $file.name $readAttributes $shareAll
  try { return TestFileIdentity $file $handle }
  finally { if ($handle) { $handle.Dispose() } }
}

function ReadVerifiedHolders($file) {
  $unverified = NewUnverifiedPath $file
  if (!$file.parentPinned) { return $unverified }
  # Data access activates delete-share checks. An exclusive holder can deny
  # data access, so use metadata-only identity checks around the lookup then.
  $pin = OpenRelative $file.parent $file.name ($readData -bor $readAttributes) $shareWithoutDelete
  $handle = $pin
  try {
    if (!$handle) { $handle = OpenRelative $file.parent $file.name $readAttributes $shareAll }
    if (!(TestFileIdentity $file $handle)) { return $unverified }
    $rows = @(FindFileHolders $file.path)
    if ($pin) {
      if (!(TestFileIdentity $file $pin)) { return $unverified }
    } elseif (!(TestCandidatePath $file)) { return $unverified }
    return $rows
  } finally { if ($handle) { $handle.Dispose() } }
}

function ReadHolderGroup([object[]]$group) {
  if ($group.Length -eq 1) {
    $file = $group[0]
    try { ReadVerifiedHolders $file }
    catch { @{ kind = 'restartManager'; path = $file.path; operation = 'query'; code = $null } }
    return
  }
  $verified = [Collections.Generic.List[object]]::new()
  foreach ($file in $group) {
    if (TestCandidatePath $file) { $verified.Add($file) }
    else { NewUnverifiedPath $file }
  }
  if (!$verified.Count) { return }
  if ($verified.Count -eq 1) { ReadHolderGroup $verified.ToArray(); return }
  # Batch results only select files for individually verified lookups.
  $rows = @(FindFileHolders ($verified | ForEach-Object { $_.path }))
  if (!$rows.Count) {
    foreach ($file in $verified) {
      if (!(TestCandidatePath $file)) { NewUnverifiedPath $file }
    }
    return
  }
  # Split groups with holders or native errors until each result names one file.
  $middle = $verified.Count -shr 1
  ReadHolderGroup $verified[0..($middle - 1)]
  ReadHolderGroup $verified[$middle..($verified.Count - 1)]
}

function FindJobProcesses {
  $rootPattern = '(?<![\w:\\])(?:\\\\\?\\)?' + [regex]::Escape($root) +
    '(?:\\[^\s"''<>|;&=,)]*)?(?=$|[\s"''<>|;&=,):])'
  $pattern = [regex]::new($rootPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $inspected = 0
  $matched = 0
  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |
    Sort-Object CreationDate -Descending | Select-Object -First ${PROCESS_SCAN_LIMIT + 1} | ForEach-Object {
    if (++$inspected -gt ${PROCESS_SCAN_LIMIT}) { $script:processLimited = $true; return }
    if ($matched -gt ${RESULT_LIMIT}) { return }
    $row = $_
    if ($row.ProcessId -eq $PID -or $row.ProcessId -eq 0) { return }
    try {
      $reason = $null
      if (TestJobPath $row.ExecutablePath) { $reason = 'image' }
      elseif ($row.CommandLine) {
        foreach ($match in $pattern.Matches($row.CommandLine.Replace('/', '\'))) {
          if (TestJobPath $match.Value) { $reason = 'argument'; break }
        }
      }
      if (!$reason -and (TestJobPath (ReadCurrentDirectory $row.ProcessId))) { $reason = 'cwd' }
      if (!$reason) { return }
      if (++$matched -gt ${RESULT_LIMIT}) { $script:processLimited = $true; return }
      $record = NewProcessRecord $row 'process'
      $record.reason = $reason
      $record
    } catch { $script:processFailed = $true }
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

function FindSetupLog($rootHandle, $parentPinned) {
  $directory = OpenRelative $rootHandle 'tmp' ($readData -bor $readAttributes -bor $readControl) $shareWithoutDelete
  if (!$directory) {
    $directory = OpenRelative $rootHandle 'tmp' ($readData -bor $readAttributes) $shareWithoutDelete
  }
  if (!$directory) { return }
  $handles.Add($directory)
  $kindMask = $directoryFlag -bor $reparseFlag
  if (((ReadBasicInformation $directory).attributes -band $kindMask) -ne $directoryFlag) { return }
  $file = OpenRelative $directory 'wmsetup.log' $readAttributes $shareAll
  if (!$file) { return }
  try {
    $attributes = (ReadBasicInformation $file).attributes
    if ($attributes -band $kindMask) { return }
    return @{ path = $setupLog; name = 'wmsetup.log'; attributes = $attributes
      parent = $directory; parentAcl = (ReadEntryAcl $directory); parentPinned = $parentPinned }
  } finally { $file.Dispose() }
}

function FindSurvivingEntries {
  $queue = [Collections.Generic.Queue[object]]::new()
  $volume = [IO.Path]::GetPathRoot($root)
  if ($volume -notmatch '^[a-zA-Z]:\\$') { throw 'Expected a local drive path' }
  $parentName = [IO.Path]::GetDirectoryName($root).Substring($volume.Length)
  $volumeAccess = if ($parentName) { $readAttributes } else { $readAttributes -bor $readControl }
  # OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS and FILE_FLAG_OPEN_REPARSE_POINT.
  $drive = $native::CreateFileW(('\\?\' + $volume), $volumeAccess, $shareWithoutDelete, 0, 3, 0x02200000, 0)
  $handles.Add($drive)
  if ($drive.IsInvalid) { throw 'Cannot open job volume' }
  $parent = $drive
  $parentPinned = $true
  if ((ReadBasicInformation $parent).attributes -band $reparseFlag) { throw 'Job volume is a reparse point' }
  if ($parentName) {
    $ancestors = $parentName.Split('\')
    for ($i = 0; $i -lt $ancestors.Length; $i++) {
      $access = $readAttributes -bor $readData
      if ($i -eq $ancestors.Length - 1) { $access = $access -bor $readControl }
      $ancestor = OpenRelative $parent $ancestors[$i] $access $shareWithoutDelete
      if (!$ancestor -and ($access -band $readControl)) {
        $ancestor = OpenRelative $parent $ancestors[$i] ($readAttributes -bor $readData) $shareWithoutDelete
      }
      if (!$ancestor) {
        $parentPinned = $false
        $ancestor = OpenRelative $parent $ancestors[$i] $readAttributes $shareAll
      }
      if (!$ancestor) { throw 'Cannot open job parent without following redirects' }
      $handles.Add($ancestor)
      if ((ReadBasicInformation $ancestor).attributes -band $reparseFlag) { throw 'Job parent is a reparse point' }
      $parent = $ancestor
    }
  }
  $queue.Enqueue(@{ path = $root; name = [IO.Path]::GetFileName($root); attributes = $directoryFlag;
    parent = $parent; parentAcl = (ReadEntryAcl $parent); parentPinned = $parentPinned })
  $setupEntry = $null
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
    if ($isFile) {
      $identity = try { ReadFileIdentity $handle } catch { $script:failed = $true; $null }
      $files.Add(@{ path = $next.path; parent = $next.parent; name = $next.name
        parentPinned = $next.parentPinned -and $null -ne $identity; identity = $identity })
    }
    if ($isRoot -or !$acl -or ($attributes -band ($reparseFlag -bor [IO.FileAttributes]::ReadOnly)) -or
        ($acl.deleteRights -band [Security.AccessControl.FileSystemRights]::Delete) -or
        ($next.parentAcl.deleteRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)) {
      $priority.Add($entry)
    } else { $survivors.Add($entry) }
    if ($canList) {
      $remaining = ${SCAN_LIMIT} - $script:discovered
      if ($isRoot) {
        # Keep one discovery slot for the known log even if the root fills the queue.
        $setupEntry = FindSetupLog $handle $next.parentPinned
        if ($setupEntry) { $remaining-- }
      }
      if ($setupEntry -and $next.path -eq [IO.Path]::GetDirectoryName($setupLog)) { $remaining++ }
      try {
        foreach ($child in (ReadChildren $handle $remaining)) {
          $path = [IO.Path]::Combine($next.path, $child.name)
          if ($setupEntry -and $path -eq $setupLog) { continue }
          if ($script:discovered -ge ${SCAN_LIMIT}) { break }
          $queue.Enqueue(@{ path = $path; name = $child.name;
            attributes = $child.attributes; parent = $handle; parentAcl = $acl; parentPinned = $next.parentPinned })
          $script:discovered++
        }
      } catch { $script:failed = $true }
      if ($isRoot -and $setupEntry) {
        $queue.Enqueue($setupEntry)
        $script:discovered++
      }
    }
  }
}

$priority = [Collections.Generic.List[object]]::new()
$survivors = [Collections.Generic.List[object]]::new()
$handles = [Collections.Generic.List[object]]::new()
$files = [Collections.Generic.List[object]]::new()
$setupLog = [IO.Path]::Combine($root, 'tmp', 'wmsetup.log')
$script:discovered = 0
$script:holderFailed = $false
try {
  try { FindSurvivingEntries } catch { $script:failed = $true }
  $entries = @($priority.ToArray() + $survivors.ToArray() | Select-Object -First ${RESULT_LIMIT})
  $fileLimited = $priority.Count + $survivors.Count -gt ${RESULT_LIMIT} -or $script:discovered -ge ${SCAN_LIMIT}
  foreach ($entry in $entries) {
    if (!(WriteEvidence $entry ${FILE_OUTPUT_LIMIT})) { $fileLimited = $true }
  }
  $null = WriteEvidence @{
    kind = 'files'; failed = $script:failed; changed = $script:changed; limited = $fileLimited
    empty = $entries.Count -eq 0
  } ${FILE_OUTPUT_LIMIT + 256}

  $holderLimited = $false
  $holderFailures = [Collections.Generic.List[object]]::new()
  & {
    $known = @($files | Where-Object { $_.path -eq $setupLog })
    $others = @($files | Where-Object { $_.path -ne $setupLog })
    try {
      if ($known.Count) { ReadHolderGroup $known }
      if ($others.Count) { ReadHolderGroup $others }
    } catch {
      @{ kind = 'restartManager'; path = $root; operation = 'query'; code = $null }
      $script:holderFailed = $true
    }
  } | ForEach-Object {
    if ($_.kind -eq 'restartManager') { $holderFailures.Add($_) }
    elseif (!(WriteEvidence $_ ${HOLDER_OUTPUT_LIMIT})) { $holderLimited = $true }
  }
  foreach ($failure in $holderFailures) {
    if ($failure.code -eq 234) { $holderLimited = $true }
    if (!(WriteEvidence $failure ${HOLDER_OUTPUT_LIMIT})) { $holderLimited = $true }
  }
} finally {
  foreach ($handle in $handles) { $handle.Dispose() }
}
$null = WriteEvidence @{ kind = 'holders'; limited = $holderLimited; failed = $script:holderFailed } ${HOLDER_OUTPUT_LIMIT + 256}
$script:processFailed = $false
$script:processLimited = $false
try {
  FindJobProcesses | ForEach-Object {
    if (!(WriteEvidence $_ ${OUTPUT_LIMIT - SUSPECT_OUTPUT_LIMIT - STATUS_RESERVE})) { $script:processLimited = $true }
  }
} catch { $script:processFailed = $true }
$null = WriteEvidence @{
  kind = 'processes'; failed = $script:processFailed; limited = $script:processLimited
} ${OUTPUT_LIMIT - SUSPECT_OUTPUT_LIMIT}
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

function formatProcess({ kind, pid, parentPid, image, created, path, app, service, name, parentName, reason }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 ||
      (parentPid !== null && (!Number.isSafeInteger(parentPid) || parentPid < 0))) {
    throw new Error("Invalid cleanup process identity");
  }
  const base = `${kind} pid=${pid} parent-pid=${parentPid ?? '"not determined"'} image=${formatOptionalText(image, PROCESS_PATH_LIMIT)}`;
  const started = `created=${formatOptionalText(created, 32)}`;
  if (kind === "holder") {
    if (typeof path !== "string") throw new Error("Invalid holder path");
    return `${base} path=${JSON.stringify(path)} app=${formatOptionalText(app, 256)} service=${formatOptionalText(service, 64)} ${started}`;
  }
  if (kind === "suspect") {
    return `${base} parent-name=${formatOptionalText(parentName, 256)} name=${formatOptionalText(name, 256)} ${started}`;
  }
  if (!["image", "cwd", "argument"].includes(reason)) throw new Error("Invalid process match reason");
  return `${base} match=${reason} ${started}`;
}

function formatRestartManagerFailure({ path, operation, code }) {
  if (typeof path !== "string" ||
      !["RmStartSession", "RmRegisterResources", "RmGetList", "RmEndSession", "unverified-path", "query"].includes(operation) ||
      (code !== null && (!Number.isSafeInteger(code) || code < 0))) {
    throw new Error("Invalid Restart Manager status");
  }
  return `Restart Manager lookup failed path=${JSON.stringify(path)} operation=${operation}` +
    (code === null ? "" : ` code=${code}`);
}

function collectQuery(script, timeout, maxBuffer, readRecord, run) {
  if (timeout <= 0) return Promise.resolve(false);
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(QUERY_COMMAND, "utf16le").toString("base64")];
  const options = {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer,
    env: { ...windowsPowerShellEnv(), [QUERY_VARIABLE]: script },
  };
  return new Promise(resolve => {
    let child;
    let settled = false;
    let failed = false;
    let pending = "";
    let inputBytes = 0;

    function consume(chunk) {
      if (settled) return;
      if (inputBytes === maxBuffer) {
        failed = true;
        return;
      }
      const size = Buffer.byteLength(chunk);
      if (inputBytes + size > maxBuffer) {
        failed = true;
        chunk = Buffer.from(chunk).subarray(0, maxBuffer - inputBytes).toString("utf8");
      }
      inputBytes = Math.min(maxBuffer, inputBytes + size);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        try { readRecord(JSON.parse(line)); }
        catch { failed = true; }
      }
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(!error && !failed && !pending);
    }

    const deadline = setTimeout(() => {
      finish(true);
      try { child?.kill(); } catch {}
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref?.();
    }, timeout);
    try {
      child = run("powershell.exe", args, options, (error, stdout) => {
        if (!child?.stdout && stdout) consume(stdout);
        finish(error);
      });
      child?.stdout?.on("data", consume);
    } catch (error) { finish(error); }
  });
}

export async function diagnoseJobRoot(root, diagnostic, run = runJobRootQuery) {
  const expiresAt = performance.now() + TIMEOUT_MS;
  let outputBytes = 0;
  let outputLimited = false;
  let failed = false;
  let suspectsComplete = false;

  function emit(line, limit = OUTPUT_LIMIT - STATUS_RESERVE) {
    const size = Buffer.byteLength(line) + 1;
    if (outputBytes + size <= limit) {
      diagnostic(line);
      outputBytes += size;
    } else {
      outputLimited = true;
    }
  }

  const suspectsOk = await collectQuery(SUSPECT_QUERY, SUSPECT_TIMEOUT_MS, SUSPECT_OUTPUT_LIMIT, row => {
    if (!suspectsComplete && row.kind === "suspect") {
      emit(formatProcess(row), SUSPECT_OUTPUT_LIMIT - 256);
    } else if (!suspectsComplete && row.kind === "suspects") {
      suspectsComplete = true;
      if (row.failed) {
        failed = true;
        emit("Cleanup named suspect query was incomplete", SUSPECT_OUTPUT_LIMIT);
      }
      if (row.limited) emit("Cleanup named suspect output reached its reporting limit", SUSPECT_OUTPUT_LIMIT);
    } else {
      throw new Error("Unexpected suspect record");
    }
  }, run);
  if (!suspectsOk || !suspectsComplete) {
    failed = true;
    emit("Cleanup named suspect query was incomplete", SUSPECT_OUTPUT_LIMIT);
  }

  let filesComplete = false;
  let holdersComplete = false;
  let processesComplete = false;
  let fileCount = 0;
  let processCount = 0;
  const filesOutputEnd = outputBytes + FILE_OUTPUT_LIMIT;
  let holdersOutputEnd = 0;
  const script = queryScript(root);
  const queryOk = await collectQuery(script, Math.floor(expiresAt - performance.now()), OUTPUT_LIMIT - SUSPECT_OUTPUT_LIMIT, row => {
    if (!filesComplete && row.kind === "candidate") {
      if (fileCount++ < RESULT_LIMIT) emit(formatCandidate(row), filesOutputEnd);
    } else if (!filesComplete && row.kind === "files") {
      filesComplete = true;
      failed ||= row.failed;
      if (row.empty && !row.failed) emit("Cleanup path scan found no surviving entries");
      if (row.changed) emit("Cleanup path scan skipped an entry whose directory or reparse attributes changed");
      if (row.limited) emit("Cleanup path scan reached its inspection or reporting limit");
      holdersOutputEnd = outputBytes + HOLDER_OUTPUT_LIMIT - FILE_OUTPUT_LIMIT;
    } else if (filesComplete && !holdersComplete) {
      if (row.kind === "holders") {
        holdersComplete = true;
        failed ||= row.failed;
        if (row.limited) emit("Restart Manager output reached its reporting limit");
      } else if (row.kind === "restartManager") {
        emit(formatRestartManagerFailure(row), holdersOutputEnd);
      } else if (row.kind === "holder") {
        emit(formatProcess(row), holdersOutputEnd);
      } else {
        throw new Error("Unexpected holder record");
      }
    } else if (holdersComplete && !processesComplete) {
      if (row.kind === "processes") {
        processesComplete = true;
        if (row.limited) emit("Cleanup process scan reached its inspection or reporting limit");
        if (row.failed) emit("Cleanup process scan was incomplete");
      } else if (row.kind === "process") {
        if (processCount++ < RESULT_LIMIT) emit(formatProcess(row));
      } else {
        throw new Error("Unexpected process record");
      }
    } else {
      throw new Error("Unexpected cleanup record");
    }
  }, run);
  if (filesComplete && !holdersComplete) emit("Restart Manager lookup was incomplete");
  if (outputLimited) emit("Cleanup diagnostic output reached its byte limit", OUTPUT_LIMIT);
  if (!queryOk || failed || !filesComplete || !processesComplete) throw new Error("Cleanup query was incomplete");
}
