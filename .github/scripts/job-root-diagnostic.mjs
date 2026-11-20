import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 20;
const SCAN_LIMIT = 128;
const DENY_LIMIT = 8;

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

function ReadAttributes($handle) {
  $bytes = [byte[]]::new(8)
  $ioStatus = $marshal::AllocHGlobal(2 * $pointerSize)
  try {
    # FileAttributeTagInformation.
    if ($native::NtQueryInformationFile($handle, $ioStatus, $bytes, $bytes.Length, 35) -ne 0) {
      throw 'Cannot read attributes from directory entry handle'
    }
    return [IO.FileAttributes][BitConverter]::ToInt32($bytes, 0)
  } finally { $marshal::FreeHGlobal($ioStatus) }
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
$processes = @()
try {
  $processes = @(Get-Process | Where-Object {
    $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First ${RESULT_LIMIT} | ForEach-Object {
    @{ pid = $_.Id; image = [IO.Path]::GetFileName($_.Path) }
  })
} catch { $script:failed = $true }

${HANDLE_QUERY}

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
  if ((ReadAttributes $parent) -band $reparseFlag) { throw 'Job parent is a reparse point' }
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
    $attributes = ReadAttributes $handle
    if (($attributes -band ($directoryFlag -bor $reparseFlag)) -ne $expectedKind) {
      $changed = $true
      $script:failed = $true
      continue
    }
    $acl = ReadEntryAcl $handle
    $entry = @{
      path = $next.path
      attributes = $attributes.ToString()
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
ConvertTo-Json -Compress -Depth 6 -InputObject @{
  processes = $processes
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

export async function diagnoseJobRoot(root, diagnostic, run = runJobRootQuery) {
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(queryScript(root), "utf16le").toString("base64")];
  const stdout = await new Promise((resolve, reject) => {
    run("powershell.exe", args, {
      encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, env: windowsPowerShellEnv(),
    }, (error, output) => error ? reject(error) : resolve(output));
  });
  if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) throw new Error("Cleanup query output exceeded the limit");
  const { processes, entries, failed, changed, limited } = JSON.parse(stdout);
  if (!Array.isArray(processes) || !Array.isArray(entries) || typeof failed !== "boolean" ||
      typeof changed !== "boolean" || typeof limited !== "boolean") {
    throw new Error("Invalid cleanup query results");
  }
  const lines = processes.slice(0, RESULT_LIMIT).map(({ pid, image }) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof image !== "string") throw new Error("Invalid cleanup process details");
    return `process pid=${pid} image=${JSON.stringify(win32.basename(image).slice(0, 256))}`;
  });
  for (const entry of entries.slice(0, RESULT_LIMIT)) {
    const { path, attributes, owner, deny, denyOmitted, parentDeny, parentDenyOmitted } = entry;
    if (typeof path !== "string" || (attributes !== null && typeof attributes !== "string") || (owner !== null && typeof owner !== "string")) {
      throw new Error("Invalid cleanup path details");
    }
    lines.push(`candidate path=${JSON.stringify(path)} owner=${JSON.stringify(owner ?? "not determined")}` +
      ` deny=${formatDenies(deny, denyOmitted)} parent-deny=${formatDenies(parentDeny, parentDenyOmitted)}` +
      ` attributes=${JSON.stringify(attributes ?? "not determined")} handle="not determined"`);
  }
  if (!failed && entries.length === 0) lines.push("Cleanup path scan found no surviving entries");
  if (changed) lines.push("Cleanup path scan skipped an entry whose directory or reparse attributes changed");
  if (limited) lines.push("Cleanup path scan reached its inspection or reporting limit");
  if (Buffer.byteLength(lines.join("\n") + "\n") > OUTPUT_LIMIT) throw new Error("Cleanup diagnostic output exceeded the limit");
  for (const line of lines) diagnostic(line);
  if (failed) throw new Error("Cleanup query was incomplete");
}
