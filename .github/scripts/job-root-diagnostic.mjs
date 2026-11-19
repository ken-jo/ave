import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";

const TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 20;
const SCAN_LIMIT = 128;
const DENY_LIMIT = 8;

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
$processes = @()
try {
  $processes = @(Get-Process | Where-Object {
    $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  } | Select-Object -First ${RESULT_LIMIT} | ForEach-Object {
    @{ pid = $_.Id; image = [IO.Path]::GetFileName($_.Path) }
  })
} catch { $script:failed = $true }

function ReadEntryAcl($path) {
  try {
    $acl = Get-Acl -LiteralPath $path
    $denies = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      Where-Object AccessControlType -eq Deny)
    $deleteRights = 0
    foreach ($rule in $denies) {
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      $deleteRights = $deleteRights -bor [int]$rule.FileSystemRights
    }
    return @{
      owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      deleteRights = $deleteRights
      omitted = [Math]::Max(0, $denies.Count - ${DENY_LIMIT})
      deny = @($denies | Select-Object -First ${DENY_LIMIT} | ForEach-Object {
        @{ sid = $_.IdentityReference.Value; rights = $_.FileSystemRights.ToString() }
      })
    }
  } catch { $script:failed = $true }
}

$priority = [Collections.Generic.List[object]]::new()
$survivors = [Collections.Generic.List[object]]::new()
$queue = [Collections.Generic.Queue[object]]::new()
$queue.Enqueue(@{ path = $root; parentAcl = $null })
$discovered = 0
while ($queue.Count) {
  $next = $queue.Dequeue()
  $isRoot = $next.path -eq $root
  $item = $null
  try { $item = Get-Item -Force -LiteralPath $next.path } catch { $script:failed = $true }
  $attributes = $item.Attributes
  $isReparse = $attributes -band [IO.FileAttributes]::ReparsePoint
  if ($isRoot -and (!$item.PSIsContainer -or $isReparse)) {
    $script:failed = $true
    break
  }
  $acl = if ($item) { ReadEntryAcl $next.path }
  if (!$isRoot) {
    $entry = @{
      path = $next.path
      attributes = $(if ($item) { $attributes.ToString() })
      owner = $acl.owner
      deny = $acl.deny
      denyOmitted = $acl.omitted
      parentDeny = $next.parentAcl.deny
      parentDenyOmitted = $next.parentAcl.omitted
    }
    if (!$item -or !$acl -or $isReparse -or ($attributes -band [IO.FileAttributes]::ReadOnly) -or
        ($acl.deleteRights -band [Security.AccessControl.FileSystemRights]::Delete) -or
        ($next.parentAcl.deleteRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)) {
      $priority.Add($entry)
    } else { $survivors.Add($entry) }
  }
  # Get-Acl reads the junction itself. Enumerating it would walk the target.
  if ($item.PSIsContainer -and !$isReparse -and $discovered -lt ${SCAN_LIMIT}) {
    try {
      Get-ChildItem -Force -LiteralPath $next.path | Select-Object -First (${SCAN_LIMIT} - $discovered) | ForEach-Object {
        $queue.Enqueue(@{ path = $_.FullName; parentAcl = $acl })
        $discovered++
      }
    } catch { $script:failed = $true }
  }
}
ConvertTo-Json -Compress -Depth 6 -InputObject @{
  processes = $processes
  failed = $script:failed
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
  const { processes, entries, failed, limited } = JSON.parse(stdout);
  if (!Array.isArray(processes) || !Array.isArray(entries) || typeof failed !== "boolean" || typeof limited !== "boolean") {
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
  if (limited) lines.push("Cleanup path scan reached its inspection or reporting limit");
  if (Buffer.byteLength(lines.join("\n") + "\n") > OUTPUT_LIMIT) throw new Error("Cleanup diagnostic output exceeded the limit");
  for (const line of lines) diagnostic(line);
  if (failed) throw new Error("Cleanup query was incomplete");
}
