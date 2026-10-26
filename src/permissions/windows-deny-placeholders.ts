import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { win32 } from "node:path";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { expandTilde, expandWindowsEnvRefs, stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

export interface PlaceholderFilesystem {
  lstatSync(path: string, options: { bigint: true }): BigIntStats;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
}

const filesystem: PlaceholderFilesystem = { lstatSync, readdirSync, rmdirSync, unlinkSync };

export interface DenyPlaceholder {
  readonly path: string;
  readonly ino: bigint;
  readonly dev: bigint;
  readonly birthtimeNs: bigint;
}

function ancestors(path: string): string[] {
  const paths = [path];
  while (true) {
    const parent = win32.dirname(paths[paths.length - 1]!);
    if (parent === paths[paths.length - 1]) return paths.reverse();
    paths.push(parent);
  }
}

export function snapshotMissingDenyPaths(targets: readonly string[], fs: PlaceholderFilesystem = filesystem): string[] {
  const missing = new Map<string, string>();
  for (const raw of targets) {
    const target = expandTilde(stripExtendedPathPrefix(expandWindowsEnvRefs(raw)));
    if (/^[\\/]{2}/.test(target) || /[*?]/.test(target)) continue;
    const chain = ancestors(win32.resolve(target));
    const absent: string[] = [];
    let refused = false;
    for (const path of chain) {
      try {
        const stat = fs.lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink() || (path !== chain[chain.length - 1] && !stat.isDirectory())) {
          refused = true;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          refused = true;
          break;
        }
        absent.push(path);
      }
    }
    if (!refused) for (const path of absent.reverse()) missing.set(path.toLowerCase(), path);
  }
  return [...missing.values()];
}

export function captureDenyPlaceholders(paths: readonly string[], fs: PlaceholderFilesystem = filesystem): DenyPlaceholder[] {
  return paths.flatMap(path => {
    try {
      for (const parent of ancestors(path).slice(0, -1)) {
        const stat = fs.lstatSync(parent, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
      }
      const stat = fs.lstatSync(path, { bigint: true });
      return [{ path, ino: stat.ino, dev: stat.dev, birthtimeNs: stat.birthtimeNs }];
    } catch {
      return [];
    }
  });
}

// File attributes expose reparse tags that the stat mode does not represent.
const PLAIN_PATHS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$plain = @()",
  "foreach ($path in $paths) {",
  "  try {",
  "    $current = $path; $safe = $true",
  "    while ($current) {",
  "      if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $safe = $false; break }",
  "      $current = [IO.Path]::GetDirectoryName($current)",
  "    }",
  "    if ($safe) {",
  "      $acl = if ([IO.Directory]::Exists($path)) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }",
  "      $denies = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Deny' })",
  "      if ($denies.Count -eq 0) { $plain += $path }",
  "    }",
  "  } catch { }",
  "}",
  "ConvertTo-Json -Compress -InputObject @($plain)",
].join("\n");

function plainWindowsPaths(paths: readonly string[]): Set<string> {
  if (process.platform !== "win32" || !process.env.SystemRoot || paths.length === 0) return new Set();
  try {
    const output = execFileSync(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PLAIN_PATHS_SCRIPT,
    ], { input: JSON.stringify(paths), encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
    const value: unknown = JSON.parse(output.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(value) || value.some(path => typeof path !== "string")) return new Set();
    return new Set(value as string[]);
  } catch {
    return new Set();
  }
}

export function cleanupDenyPlaceholders(
  entries: readonly DenyPlaceholder[],
  warn: (path: string) => void,
  fs: PlaceholderFilesystem = filesystem,
  isPlainPath?: (path: string) => boolean,
): void {
  const unique = new Map(entries.map(entry => [entry.path.toLowerCase(), entry]));
  const plain = isPlainPath === undefined ? plainWindowsPaths([...unique.values()].map(entry => entry.path)) : undefined;
  for (const entry of [...unique.values()].sort((a, b) => ancestors(b.path).length - ancestors(a.path).length)) {
    try {
      if (!(isPlainPath?.(entry.path) ?? plain?.has(entry.path))) {
        warn(entry.path);
        continue;
      }
      const stat = fs.lstatSync(entry.path, { bigint: true });
      if (stat.ino === 0n || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.birthtimeNs !== entry.birthtimeNs
        || stat.isSymbolicLink()) {
        warn(entry.path);
        continue;
      }
      if (stat.isFile() && stat.size === 0n) fs.unlinkSync(entry.path);
      else if (stat.isDirectory() && fs.readdirSync(entry.path).length === 0) fs.rmdirSync(entry.path);
      else warn(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(entry.path);
    }
  }
}
