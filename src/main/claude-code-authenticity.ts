import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { isRecord } from "../shared/is-record.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { assertCodexExecutableLocation, createPrivateTempDirectory } from "./codex-executable-location.js";
import { queryWindowsSystemDirectory } from "./windows-path-kind-launcher.js";

const PUBLISHER_IDENTITIES = Object.freeze({
  darwin: Object.freeze({
    team: "Q6L2SF6YDW",
    subject: "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)",
    identifier: "com.anthropic.claude-code",
  }),
  win32: Object.freeze({ subject: "Anthropic, PBC", organization: "Anthropic, PBC", codeSigningOid: "1.3.6.1.5.5.7.3.3" }),
  linux: Object.freeze({ fingerprint: "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE" }),
});
const RELEASE_ORIGIN = "https://downloads.claude.ai";
const MAX_METADATA_BYTES = 256 * 1024;
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/u;
const POSIX_VERIFIER_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });

export class ClaudeCodeAuthenticityError extends Error {
  constructor() {
    super("Subscription runtime publisher could not be authenticated");
    this.name = "ClaudeCodeAuthenticityError";
  }
}

async function executeVerifier(command: string, args: readonly string[], env: NodeJS.ProcessEnv = POSIX_VERIFIER_ENV): Promise<string> {
  await assertCodexExecutableLocation(command, "native");
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: "utf8", shell: false, windowsHide: true, env,
      timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs, maxBuffer: MAX_METADATA_BYTES,
    }, (error, stdout) => {
      if (error) reject(new ClaudeCodeAuthenticityError());
      else resolve(stdout);
    });
  });
}

async function sealedHash(executable: string): Promise<string> {
  const file = await openExecutableFile(executable);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

async function authenticateDarwin(executable: string): Promise<void> {
  const identity = PUBLISHER_IDENTITIES.darwin;
  const requirement = [
    "=anchor apple generic",
    "certificate 1[field.1.2.840.113635.100.6.2.6] exists",
    "certificate leaf[field.1.2.840.113635.100.6.1.13] exists",
    `certificate leaf[subject.OU] = "${identity.team}"`,
    `certificate leaf[subject.CN] = "${identity.subject}"`,
    `identifier "${identity.identifier}"`,
  ].join(" and ");
  await executeVerifier("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "--test-requirement", requirement, executable]);
}

async function authenticateWindows(executable: string): Promise<void> {
  const identity = PUBLISHER_IDENTITIES.win32;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$PSModuleAutoLoadingPreference = 'None'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
    "$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:AVE_SIGNATURE_FILE",
    "$certificate = $signature.SignerCertificate",
    "if ($signature.Status -ne 'Valid' -or $null -eq $certificate) { exit 1 }",
    `$subject = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)`,
    `if ($subject -cne '${identity.subject}') { exit 1 }`,
    "$distinguishedName = $certificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)",
    `if ($distinguishedName -cnotmatch '(?m)^O=(?:"${identity.organization}"|${identity.organization})\\r?$') { exit 1 }`,
    "$extensions = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })",
    "if ($extensions.Count -ne 1) { exit 1 }",
    "$eku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($extensions[0], $extensions[0].Critical)",
    "$usages = @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value })",
    `if ($usages -notcontains '${identity.codeSigningOid}') { exit 1 }`,
    "[Console]::Out.Write('authenticated')",
  ].join("\n");
  const systemDirectory = await queryWindowsSystemDirectory();
  const systemRoot = win32.dirname(systemDirectory);
  const output = await executeVerifier(win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    windowsPowerShellEnv({ SystemRoot: systemRoot, WINDIR: systemRoot,
      PATH: `${systemDirectory};${systemRoot}`, AVE_SIGNATURE_FILE: executable }));
  if (output !== "authenticated") throw new ClaudeCodeAuthenticityError();
}

async function downloadMetadata(path: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TOOL_TIMEOUT_POLICY.networkFetchDefaultMs);
  try {
    const response = await fetch(`${RELEASE_ORIGIN}${path}`, { signal: controller.signal, redirect: "error", credentials: "omit" });
    if (!response.ok || !response.body) throw new ClaudeCodeAuthenticityError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_METADATA_BYTES) throw new ClaudeCodeAuthenticityError();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  } finally { clearTimeout(deadline); }
}

// A version locates signed metadata; neither a path nor a package database authenticates the executable.
async function linuxReleaseVersion(source: string): Promise<string> {
  const leaf = posix.basename(source);
  if (RELEASE_VERSION.test(leaf)) return leaf;
  const parent = posix.basename(posix.dirname(source));
  if (leaf === "claude" && RELEASE_VERSION.test(parent)) return parent;
  if (source !== "/usr/bin/claude" && source !== "/usr/local/bin/claude") throw new ClaudeCodeAuthenticityError();
  const queries = [
    { command: "/usr/bin/dpkg-query", args: ["--show", "--showformat=${Version}", "claude-code"], pattern: /^(?:\d+:)?(\d+\.\d+\.\d+)(?:-[\w.+~]+)?$/u },
    { command: "/usr/bin/rpm", args: ["--query", "--file", source, "--queryformat", "%{VERSION}"], pattern: /^(\d+\.\d+\.\d+)$/u },
    { command: "/sbin/apk", args: ["info", "--who-owns", source], pattern: /^claude-code-(\d+\.\d+\.\d+)-r\d+ owns \/usr\/(?:local\/)?bin\/claude$/u },
  ];
  for (const query of queries) {
    try {
      const output = await executeVerifier(query.command, query.args);
      const version = query.pattern.exec(output.trim())?.[1];
      if (version) return version;
    } catch (error) {
      // Distributions install one of these databases. A failed locator grants no trust; only a signed checksum can admit bytes.
      if (!(error instanceof ClaudeCodeAuthenticityError) && (!isRecord(error) || error.code !== "ENOENT")) throw error;
    }
  }
  throw new ClaudeCodeAuthenticityError();
}

function manifestChecksum(manifest: Uint8Array, version: string, arch: NodeJS.Architecture, hash: string): void {
  const value: unknown = JSON.parse(Buffer.from(manifest).toString("utf8"));
  if (!isRecord(value) || value.version !== version || !isRecord(value.platforms)) throw new ClaudeCodeAuthenticityError();
  if (arch !== "x64" && arch !== "arm64") throw new ClaudeCodeAuthenticityError();
  const platforms = value.platforms;
  const entries = [`linux-${arch}`, `linux-${arch}-musl`].map((platform) => platforms[platform]);
  if (!entries.some((entry) => isRecord(entry) && entry.binary === "claude"
    && typeof entry.checksum === "string" && /^[0-9a-f]{64}$/u.test(entry.checksum) && entry.checksum === hash)) {
    throw new ClaudeCodeAuthenticityError();
  }
}

function assertReleaseSignature(status: string): void {
  const lines = status.split(/\r?\n/u);
  if (lines.some((line) => /^\[GNUPG:\] (?:BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG|FAILURE)\b/u.test(line))) {
    throw new ClaudeCodeAuthenticityError();
  }
  const valid = lines.filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  if (valid.length !== 1) throw new ClaudeCodeAuthenticityError();
  const fields = valid[0]!.split(" ");
  const signer = fields[2];
  const primary = fields[11] ?? signer;
  if (primary !== PUBLISHER_IDENTITIES.linux.fingerprint) throw new ClaudeCodeAuthenticityError();
}

async function authenticateLinux(executable: string, source: string, contentHash: string, arch: NodeJS.Architecture): Promise<void> {
  const version = await linuxReleaseVersion(source);
  const directory = await createPrivateTempDirectory(join(dirname(executable), "signature-"));
  try {
    const [key, manifest, signature] = await Promise.all([
      downloadMetadata("/keys/claude-code.asc"),
      downloadMetadata(`/claude-code-releases/${version}/manifest.json`),
      downloadMetadata(`/claude-code-releases/${version}/manifest.json.sig`),
    ]);
    const keyPath = join(directory, "release.asc");
    const manifestPath = join(directory, "manifest.json");
    const signaturePath = join(directory, "manifest.json.sig");
    await Promise.all([
      fs.writeFile(keyPath, key, { flag: "wx", mode: 0o600 }),
      fs.writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 }),
      fs.writeFile(signaturePath, signature, { flag: "wx", mode: 0o600 }),
    ]);
    const args = ["--no-options", "--homedir", directory, "--batch", "--no-tty", "--no-autostart", "--no-auto-key-retrieve"];
    await executeVerifier("/usr/bin/gpg", [...args, "--import", keyPath]);
    const status = await executeVerifier("/usr/bin/gpg", [...args, "--status-fd", "1", "--verify", signaturePath, manifestPath]);
    assertReleaseSignature(status);
    manifestChecksum(manifest, version, arch, contentHash);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

// Authentication examines the sealed bytes. No command here executes the candidate or learns its identity from its own output.
export async function authenticateClaudeCodeExecutable(
  executable: string,
  source: string,
  contentHash: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<void> {
  try {
    if (await sealedHash(executable) !== contentHash) throw new ClaudeCodeAuthenticityError();
    switch (platform) {
      case "darwin": await authenticateDarwin(executable); break;
      case "win32": await authenticateWindows(executable); break;
      case "linux": await authenticateLinux(executable, source, contentHash, arch); break;
      default: throw new ClaudeCodeAuthenticityError();
    }
    if (await sealedHash(executable) !== contentHash) throw new ClaudeCodeAuthenticityError();
  } catch (error) {
    if (error instanceof ClaudeCodeAuthenticityError) throw error;
    throw new ClaudeCodeAuthenticityError();
  }
}
