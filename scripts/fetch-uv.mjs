// postinstall downloads only the current platform binary; --target and --all select others.

import { existsSync } from "node:fs";
import { mkdir, chmod, rename, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UV_TARGETS, getUvTargetByDir, resolveUvTarget } from "./uv-targets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DEFAULT_VERSION = "0.7.3"; // Pin downloads to a reproducible version.
const METADATA_FILE = "uv.meta.json";

function usage() {
  return [
    "Usage: node scripts/fetch-uv.mjs [options]",
    "",
    "Options:",
    "  --current          Download only the current OS/arch uv binary (default)",
    "  --target <dir>     Download one target dir. Repeatable. Example: linux-x64",
    "  --all              Download every known target",
    "  --list-targets     Print known target dirs",
  ].join("\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = "current";
  const targets = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--list-targets") {
      process.stdout.write(`${UV_TARGETS.map((target) => target.dir).join("\n")}\n`);
      process.exit(0);
    }
    if (arg === "--current") {
      mode = "current";
      continue;
    }
    if (arg === "--all") {
      mode = "all";
      continue;
    }
    if (arg === "--target") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fail("--target requires a value");
      mode = "target";
      targets.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      mode = "target";
      targets.push(...arg.slice("--target=".length).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return { mode, targets };
}

const CLI_ARGS = parseArgs();
const UV_VERSION = DEFAULT_VERSION;

function log(msg) {
  process.stdout.write(`[fetch-uv] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[fetch-uv] ERROR: ${msg}\n`);
  process.exit(1);
}

function currentTarget() {
  return resolveUvTarget(process.platform, process.arch);
}

function selectedTargets() {
  if (CLI_ARGS.mode === "all") return UV_TARGETS;
  if (CLI_ARGS.mode === "current") return [currentTarget()];

  const selected = [];
  for (const dir of CLI_ARGS.targets) {
    selected.push(getUvTargetByDir(dir));
  }
  if (selected.length === 0) {
    throw new Error("--target mode requires at least one target");
  }
  return [...new Map(selected.map((target) => [target.dir, target])).values()];
}

async function fetchWithRedirect(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  }
  return resp;
}

// Parse the decompressed tar directly without external tools.
async function extractTarGz(buffer, targetBin) {
  const { gunzipSync } = await import("node:zlib");
  const tarBuf = gunzipSync(buffer);

  // Tar records use 512-byte blocks.
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const name = readCString(header, 0, 100);
    const sizeOctal = readCString(header, 124, 12);
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    offset += 512;

    if (typeflag === "0" || typeflag === "\0") {
      const basename = name.split("/").pop() ?? name;
      if (basename === targetBin || basename === "uv" || basename === "uv.exe") {
        const fileData = tarBuf.subarray(offset, offset + size);
        offset += Math.ceil(size / 512) * 512;
        return fileData;
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  throw new Error(`아카이브에서 '${targetBin}' 바이너리를 찾을 수 없습니다.`);
}

function readCString(buf, start, maxLen) {
  let end = start;
  while (end < start + maxLen && buf[end] !== 0) end++;
  return buf.subarray(start, end).toString("utf8");
}

async function extractZip(buffer, targetBin) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = buffer.length - 22;
  while (eocdOffset >= 0) {
    if (buffer.readUInt32LE(eocdOffset) === EOCD_SIG) break;
    eocdOffset--;
  }
  if (eocdOffset < 0) throw new Error("ZIP EOCD를 찾을 수 없습니다.");

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);

  const CD_SIG = 0x02014b50;
  let cdPos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(cdPos) !== CD_SIG) break;
    const filenameLen = buffer.readUInt16LE(cdPos + 28);
    const extraLen = buffer.readUInt16LE(cdPos + 30);
    const commentLen = buffer.readUInt16LE(cdPos + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdPos + 42);
    const filename = buffer.subarray(cdPos + 46, cdPos + 46 + filenameLen).toString("utf8");
    cdPos += 46 + filenameLen + extraLen + commentLen;

    const basename = filename.split("/").pop() ?? filename;
    if (basename === targetBin || basename === "uv.exe" || basename === "uv") {
      const LFH_SIG = 0x04034b50;
      if (buffer.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
        throw new Error("ZIP 로컬 파일 헤더 손상");
      }
      const lfhFilenameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
      const compressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
      const compressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);

      const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        return compressedData;
      } else if (compressionMethod === 8) {
        const { inflateRawSync } = await import("node:zlib");
        return inflateRawSync(compressedData);
      } else {
        throw new Error(`지원하지 않는 ZIP 압축 방식: ${compressionMethod}`);
      }
    }
  }

  throw new Error(`ZIP에서 '${targetBin}' 바이너리를 찾을 수 없습니다.`);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
  return sha256Hex(await readFile(filePath));
}

async function readMetadata(metadataPath) {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeMetadata(metadataPath, metadata) {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function validateCachedTarget(target, destDir, destBin) {
  if (!existsSync(destBin)) return { valid: false, reason: "binary missing" };

  const metadataPath = path.join(destDir, METADATA_FILE);
  const metadata = await readMetadata(metadataPath);
  if (!metadata || typeof metadata !== "object") {
    return { valid: false, reason: "metadata missing or invalid" };
  }

  const expectedArchiveSha256 = target.archiveSha256.toLowerCase();
  const checks = [
    ["version", UV_VERSION],
    ["target", target.dir],
    ["archive", target.archive],
    ["binary", target.bin],
  ];
  for (const [key, expected] of checks) {
    if (metadata[key] !== expected) {
      return { valid: false, reason: `metadata ${key} mismatch` };
    }
  }
  if (metadata.archiveSha256 !== expectedArchiveSha256) {
    return { valid: false, reason: "metadata archiveSha256 mismatch" };
  }
  if (metadata.archiveSha256Source !== "uv-targets") {
    return { valid: false, reason: "metadata archiveSha256Source mismatch" };
  }
  if (typeof metadata.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.binarySha256)) {
    return { valid: false, reason: "metadata binarySha256 missing or invalid" };
  }

  const actualBinarySha256 = await sha256File(destBin);
  if (actualBinarySha256 !== metadata.binarySha256) {
    return { valid: false, reason: "binarySha256 mismatch" };
  }

  return { valid: true, reason: "ok" };
}

// Update DEFAULT_VERSION and UV_TARGETS archive hashes together.
async function verifyArchiveSha256(target, archiveBuffer) {
  const archiveName = target.archive;
  const actual = sha256Hex(archiveBuffer);
  const expected = target.archiveSha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `SHA256 불일치 — 다운로드 무결성 검증 실패.\n` +
      `  archive:  ${archiveName}\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${actual}\n`,
    );
  }
  log(`  SHA256 verified (UV_TARGETS known-good): ${actual.slice(0, 16)}…`);
  return { archiveName, archiveSha256: actual, source: "uv-targets" };
}

async function downloadTarget(target) {
  const destDir = path.join(PROJECT_ROOT, "resources", "uv", target.dir);
  const destBin = path.join(destDir, target.bin);
  const metadataPath = path.join(destDir, METADATA_FILE);

  if (existsSync(destBin)) {
    const cached = await validateCachedTarget(target, destDir, destBin);
    if (cached.valid) {
      log(`SKIP (verified cache): ${path.relative(PROJECT_ROOT, destBin)}`);
      return;
    }
    log(`CACHE STALE (${cached.reason}): ${path.relative(PROJECT_ROOT, destBin)} — redownloading`);
  }

  await mkdir(destDir, { recursive: true });

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.archive}`;
  log(`Downloading: ${url}`);

  const resp = await fetchWithRedirect(url);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  log(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB — extracting ${target.bin}...`);

  const verification = await verifyArchiveSha256(target, buffer);

  let fileData;
  if (target.type === "tar.gz") {
    fileData = await extractTarGz(buffer, target.bin);
  } else if (target.type === "zip") {
    fileData = await extractZip(buffer, target.bin);
  } else {
    fail(`알 수 없는 아카이브 타입: ${target.type}`);
  }

  const tmpBin = destBin + ".tmp";
  await writeFile(tmpBin, fileData);
  await rename(tmpBin, destBin);

  if (process.platform !== "win32" && target.bin !== "uv.exe") {
    await chmod(destBin, 0o755);
  }

  await writeMetadata(metadataPath, {
    schema: 1,
    version: UV_VERSION,
    target: target.dir,
    archive: target.archive,
    archiveSha256: verification.archiveSha256,
    archiveSha256Source: verification.source,
    binary: target.bin,
    binarySha256: sha256Hex(fileData),
  });

  log(`  OK: ${path.relative(PROJECT_ROOT, destBin)} (${(fileData.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  const targets = selectedTargets();
  log(`uv version: ${UV_VERSION}`);
  log(`대상 디렉토리: ${path.join(PROJECT_ROOT, "resources", "uv")}`);
  log(`선택 플랫폼: ${targets.map((target) => target.dir).join(", ")}`);
  log("");

  const errors = [];

  for (const target of targets) {
    try {
      await downloadTarget(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${target.dir}: ${msg}`);
      process.stderr.write(`[fetch-uv] WARN: ${target.dir} 다운로드 실패 — ${msg}\n`);
    }
  }

  log("");
  if (errors.length > 0) {
    process.stderr.write(`[fetch-uv] ${errors.length}개 선택 플랫폼 다운로드 실패:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`[fetch-uv] 네트워크 연결을 확인하거나 수동으로 다운로드하세요.\n`);
    process.exit(1);
  } else {
    log("선택 플랫폼 uv binary 다운로드 완료.");
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
