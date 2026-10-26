import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { win32SystemBinary } from "../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";

export const WINDOWS_READ_DENY_MASK = 0x1f01ff;
export const WINDOWS_WRITE_DENY_MASK = 0x10116;

export interface WindowsDenyAcl {
  readonly denyMask: number;
  readonly inheritableMask: number;
  readonly parentMask: number;
  readonly directory: boolean;
}

const READ_DENY_ACL_COMMAND = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
$sid = [Security.Principal.SecurityIdentifier]::new($request.sid)
function Read-DenyMasks($path) {
  $acl = Get-Acl -LiteralPath $path
  if (!$acl.AreAccessRulesCanonical) { throw 'Noncanonical DACL' }
  $mask = 0L; $inheritable = 0L
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference -ne $sid -or $rule.AccessControlType -ne 'Deny') { continue }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $rights = [long]$rule.FileSystemRights -band 0xffffffffL
    $mask = $mask -bor $rights
    if (($rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq 0) {
      $inheritable = $inheritable -bor $rights
    }
  }
  return @{ mask = $mask; inheritable = $inheritable }
}
$rows = @(foreach ($path in $request.paths) {
  $cursor = $path
  while ($cursor) {
    try { $item = Get-Item -LiteralPath $cursor -Force }
    catch [System.Management.Automation.ItemNotFoundException] { $item = $null }
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse path cannot prove deny protection' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if (!(Test-Path -LiteralPath $path)) {
    @{ denyMask = 0; inheritableMask = 0; parentMask = 0; directory = $false }
    continue
  }
  $target = Get-Item -LiteralPath $path -Force
  $masks = Read-DenyMasks $path
  $parent = Read-DenyMasks ([IO.Path]::GetDirectoryName($path))
  @{ denyMask = $masks.mask; inheritableMask = $masks.inheritable;
     parentMask = $parent.mask; directory = [bool]$target.PSIsContainer }
})
ConvertTo-Json -InputObject $rows -Compress
`;

// Read-only evidence is refreshed for every grant; a successful stamp is not proof.
export function readWindowsDenyAcls(paths: readonly string[], sandboxUserSid: string): readonly WindowsDenyAcl[] {
  if (paths.length === 0) return [];
  const targets = paths.map(path => resolve(path));
  const identities = targets.map(path => lstatSync(path, { bigint: true, throwIfNoEntry: false }));
  try {
    const output = execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_DENY_ACL_COMMAND], {
        input: JSON.stringify({ paths: targets, sid: sandboxUserSid }), encoding: "utf8", windowsHide: true,
        timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 2 * 1024 * 1024,
        env: windowsPowerShellEnv(),
      });
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows) || rows.length !== paths.length) throw new Error("Invalid deny DACL response");
    return rows.map((row: WindowsDenyAcl, index) => {
      if (row === null || typeof row !== "object" || typeof row.directory !== "boolean"
        || [row.denyMask, row.inheritableMask, row.parentMask].some(mask => !Number.isInteger(mask) || mask < 0 || mask > 0xffffffff)) {
        throw new Error("Invalid deny DACL masks");
      }
      const before = identities[index];
      const after = lstatSync(targets[index]!, { bigint: true, throwIfNoEntry: false });
      if (before?.dev !== after?.dev || before?.ino !== after?.ino || after?.isSymbolicLink()) {
        throw new Error("Deny DACL object identity changed");
      }
      return row;
    });
  } catch (error) {
    throw new Error("Windows deny DACL verification failed", { cause: error });
  }
}
