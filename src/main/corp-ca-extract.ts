// Node TLS does not inherit OS trust like Chromium; all platform readers feed one certificate filter. Keep the user-supplied common name out of script
// text: pass it by environment or argv, never interpolation.
import { execFile } from "node:child_process";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { X509Certificate } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../lib/logger.js";
import type { CorpCaConfig } from "../shared/corp-ca-config.js";

const log = createLogger("corp-ca");
const execFileAsync = promisify(execFile);

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

// Cap on how much certificate text is read from any one source.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// Cap on how many matching certificates are injected.
const MAX_MATCHES = 32;

// What a lookup needs to know. `enabled` is the caller's business — by the time a reader runs, the decision to look at all has been made.
export type CorpCaLookup = Pick<CorpCaConfig, "commonName" | "debugLog">;

// Split a PEM blob into individual certificate blocks. Anything outside the BEGIN/END markers is dropped — trust bundles routinely carry human-readable
// headers between certificates, and `X509Certificate` rejects a block that still has them attached.
export function splitPemBlocks(pem: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  for (;;) {
    const begin = pem.indexOf(PEM_BEGIN, index);
    if (begin === -1) break;
    const end = pem.indexOf(PEM_END, begin);
    if (end === -1) break;
    blocks.push(pem.slice(begin, end + PEM_END.length) + "\n");
    index = end + PEM_END.length;
  }
  return blocks;
}

// How many certificates a PEM blob holds. The one answer to that question: the cache reader, the log lines, and the result count all ask it, and a
// `BEGIN` tally would count a truncated block that nothing can parse.
export function countCertificates(pem: string): number {
  return splitPemBlocks(pem).length;
}

// Match case-insensitive substrings on the CN attribute only; matching organization or locality could inject an unintended certificate.
export function subjectHasCommonName(subject: string, commonName: string): boolean {
  const needle = commonName.toLowerCase();
  for (const line of subject.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("cn=")) continue;
    if (trimmed.slice(3).toLowerCase().includes(needle)) return true;
  }
  return false;
}

// All platform output passes one parser/CN selector and fingerprint deduplicator; skip malformed entries without losing valid later certificates.
export function selectCertificatesByCommonName(pem: string, commonName: string): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const block of splitPemBlocks(pem)) {
    if (matches.length >= MAX_MATCHES) break;
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      continue;
    }
    if (!subjectHasCommonName(cert.subject, commonName)) continue;
    const fingerprint = cert.fingerprint256;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    matches.push(block);
  }
  return matches;
}

// Missing or refused trust-store tools are nonfatal; log error text only, never certificate stdout or the configured name.
async function runTrustStoreTool(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const output = await execFileAsync(file, [...args], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: MAX_SOURCE_BYTES,
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
    }) as unknown;
    const stdout =
      typeof output === "object" && output !== null && "stdout" in output
        ? (output as { stdout?: string | Buffer }).stdout
        : output;
    return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
  } catch (err) {
    log.warn("%s lookup failed: %s", file, (err as Error).message);
    return "";
  }
}

async function readMacosTrustStore(lookup: CorpCaLookup): Promise<string> {
  // `-c` is the tool's own name filter; the shared selector re-checks the CN anyway, so the two platforms that cannot pre-filter behave identically.
  return await runTrustStoreTool("security", [
    "find-certificate",
    "-a",
    "-c",
    lookup.commonName,
    "-p",
    "/Library/Keychains/System.keychain",
  ]);
}

// Read the configured name from environment and compare literal CN substrings; wildcard matching would interpret user-supplied pattern characters.
const WINDOWS_EXPORT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$needle = $env:AVE_CORP_CA_QUERY
if ([string]::IsNullOrWhiteSpace($needle)) { exit 0 }
$stores = @(
  'Cert:\\LocalMachine\\Root',
  'Cert:\\LocalMachine\\CA',
  'Cert:\\CurrentUser\\Root',
  'Cert:\\CurrentUser\\CA'
)
foreach ($store in $stores) {
  if (-not (Test-Path $store)) { continue }
  foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
    $cn = ($cert.Subject -split ',') |
      Where-Object { $_.Trim().StartsWith('CN=', 'OrdinalIgnoreCase') } |
      ForEach-Object { $_.Trim().Substring(3) }
    if (-not $cn) { continue }
    $hit = $false
    foreach ($value in $cn) {
      if ($value.ToLowerInvariant().Contains($needle.ToLowerInvariant())) { $hit = $true }
    }
    if (-not $hit) { continue }
    Write-Output '-----BEGIN CERTIFICATE-----'
    Write-Output ([Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks'))
    Write-Output '-----END CERTIFICATE-----'
  }
}
`;

async function readWindowsTrustStore(lookup: CorpCaLookup): Promise<string> {
  // `-NoProfile -NonInteractive` so a user profile script cannot change what comes back, and the name travels as data, never as script text.
  return await runTrustStoreTool(
    win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_EXPORT_SCRIPT],
    windowsPowerShellEnv({ ...process.env, AVE_CORP_CA_QUERY: lookup.commonName }),
  );
}

// Where distributions keep trust anchors. Bundles first (one file, everything the system trusts), then the drop-in directories an administrator or an
// MDM writes a corporate root into.
const LINUX_TRUST_SOURCES: readonly string[] = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/usr/local/share/ca-certificates",
  "/usr/share/ca-certificates",
  "/etc/pki/ca-trust/source/anchors",
  "/etc/ca-certificates/trust-source/anchors",
];

// Check size and read through one descriptor; separate path stat/read operations permit a trust-store file swap.
async function readCertFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return "";
    return await handle.readFile("utf-8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// One file, or every certificate file one directory deep. "" when unreadable.
async function readCertSource(path: string): Promise<string> {
  const fileText = await readCertFile(path);
  if (fileText !== "") return fileText;
  // Not a readable regular file — the other thing a trust source can be is a directory of drop-in anchors. `readdir` fails for everything else, which is
  // the same "" this returns for an unreadable file.
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.(crt|pem|cer)$/i.test(entry)) continue;
    parts.push(await readCertSource(join(path, entry)));
  }
  return parts.join("\n");
}

// Linux bundles and drop-in files may duplicate anchors; shared fingerprint selection deduplicates them.
export async function readLinuxTrustStore(
  _lookup: CorpCaLookup,
  sources: readonly string[] = LINUX_TRUST_SOURCES,
): Promise<string> {
  const parts: string[] = [];
  for (const source of sources) {
    const text = await readCertSource(source);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

type TrustStoreReader = (lookup: CorpCaLookup) => Promise<string>;

// The only place platform is branched on. Adding a platform means adding a reader here; it cannot mean adding another idea of what a match is.
const TRUST_STORE_READERS: Partial<Record<NodeJS.Platform, TrustStoreReader>> = {
  darwin: readMacosTrustStore,
  win32: readWindowsTrustStore,
  linux: readLinuxTrustStore,
};

// No corporate CA is normal: return null and preserve default verification. Inject readers to test without the machine trust store.
export async function extractCorporateCa(
  lookup: CorpCaLookup,
  platform: NodeJS.Platform = process.platform,
  readers: Partial<Record<NodeJS.Platform, TrustStoreReader>> = TRUST_STORE_READERS,
): Promise<string | null> {
  const read = readers[platform];
  if (read === undefined) {
    log.warn("unsupported platform %s — skipping the certificate lookup", platform);
    return null;
  }
  const matches = selectCertificatesByCommonName(await read(lookup), lookup.commonName);
  if (matches.length === 0) {
    // Not warned about here: the caller already says once, unconditionally, that no corporate CA was found and that verification is unchanged. A second line
    // for the same fact would be noise on every launch of every machine that has no such certificate, which is most of them.
    if (lookup.debugLog) {
      log.info("%s: no certificate in the trust store matched the configured name", platform);
    }
    return null;
  }
  if (lookup.debugLog) {
    log.info("%s: %d certificate(s) matched", platform, matches.length);
  }
  return matches.join("");
}
