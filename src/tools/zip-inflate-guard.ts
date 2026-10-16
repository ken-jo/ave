/**
 * Zip-bomb guard for zip-container documents (xlsx / ods) read for preview.
 *
 * Runs BEFORE a document parser sees the bytes. The declared sizes in the
 * central directory are checked first (entry count, total, per-entry ratio),
 * then every entry is actually inflated with a hard output ceiling equal to its
 * declared size, so an archive whose headers understate the real payload is
 * refused instead of trusted. The inflated bytes are discarded; the parser
 * re-reads the verified archive.
 */
import AdmZip from "adm-zip";
import { inflateRawSync } from "node:zlib";

export interface ZipInflateLimits {
  maxUncompressedBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
  ratioCheckMinBytes: number;
}

type ZipInflateRejection =
  | "corrupt"
  | "encrypted"
  | "too-many-entries"
  | "too-large"
  | "compression-ratio"
  | "size-mismatch";

export type ZipInflateVerdict =
  | { ok: true; entries: number; uncompressedBytes: number }
  | { ok: false; reason: ZipInflateRejection; detail: string };

const ZIP_LOCAL_HEADER_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const FLAG_ENCRYPTED = 0x1;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_LOCAL_HEADER_MAGIC.every((byte, i) => bytes[i] === byte);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export function verifyZipInflateLimits(bytes: Buffer, limits: ZipInflateLimits): ZipInflateVerdict {
  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(bytes).getEntries();
  } catch (err) {
    return { ok: false, reason: "corrupt", detail: `zip directory unreadable: ${String(err)}` };
  }
  if (entries.length > limits.maxArchiveEntries) {
    return {
      ok: false,
      reason: "too-many-entries",
      detail: `${entries.length} entries exceeds ${limits.maxArchiveEntries}`,
    };
  }

  let declaredTotal = 0;
  for (const entry of entries) {
    const { size, compressedSize, flags } = entry.header;
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      return { ok: false, reason: "encrypted", detail: `${entry.entryName} is encrypted` };
    }
    declaredTotal += size;
    if (declaredTotal > limits.maxUncompressedBytes) {
      return {
        ok: false,
        reason: "too-large",
        detail: `declared uncompressed size exceeds ${limits.maxUncompressedBytes}`,
      };
    }
    if (size >= limits.ratioCheckMinBytes && size / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
      return {
        ok: false,
        reason: "compression-ratio",
        detail: `${entry.entryName} ratio exceeds ${limits.maxCompressionRatio}`,
      };
    }
  }

  // Declared sizes can lie. Inflate each entry with a ceiling of its declared
  // size: a larger real payload throws before it is materialised.
  let actualTotal = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const { size, method } = entry.header;
    let compressed: Buffer;
    try {
      compressed = entry.getCompressedData();
    } catch (err) {
      return { ok: false, reason: "corrupt", detail: `${entry.entryName}: ${String(err)}` };
    }
    let actual: number;
    if (method === METHOD_STORED) {
      actual = compressed.length;
    } else if (method === METHOD_DEFLATED) {
      try {
        actual = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }).length;
      } catch (err) {
        if (errorCode(err) === "ERR_BUFFER_TOO_LARGE") {
          return {
            ok: false,
            reason: "size-mismatch",
            detail: `${entry.entryName} inflates beyond its declared ${size} bytes`,
          };
        }
        return { ok: false, reason: "corrupt", detail: `${entry.entryName}: ${String(err)}` };
      }
    } else {
      return { ok: false, reason: "corrupt", detail: `${entry.entryName}: unsupported method ${method}` };
    }
    if (actual !== size) {
      return {
        ok: false,
        reason: "size-mismatch",
        detail: `${entry.entryName} is ${actual} bytes, declared ${size}`,
      };
    }
    actualTotal += actual;
  }
  return { ok: true, entries: entries.length, uncompressedBytes: actualTotal };
}
