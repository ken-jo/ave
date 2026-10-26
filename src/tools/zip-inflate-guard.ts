/** Validates ZIP framing and bounded payloads before rebuilding supported archive data. */
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipInflateLimits {
  maxUncompressedBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
  ratioCheckMinBytes: number;
}

export interface ZipInflateOptions {
  onEntry?: (name: string, data: Buffer) => void;
  opaqueArchiveMemberPrefixes?: readonly string[];
}

type ZipInflateRejection =
  | "corrupt"
  | "encrypted"
  | "too-many-entries"
  | "too-large"
  | "compression-ratio"
  | "size-mismatch";

export type ZipInflateVerdict =
  | {
    ok: true;
    entries: number;
    uncompressedBytes: number;
    canonicalBytes: Buffer;
    entryNames: readonly string[];
  }
  | { ok: false; reason: ZipInflateRejection; detail: string };

interface CheckedZipEntry {
  name: string;
  nameBytes: Buffer;
  version: number;
  flags: number;
  method: number;
  checksum: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  compressed?: Buffer;
}

const LOCAL_MAGIC = 0x04034b50;
const CENTRAL_MAGIC = 0x02014b50;
const END_MAGIC = 0x06054b50;
const DESCRIPTOR_MAGIC = 0x08074b50;
const FLAG_DESCRIPTOR = 0x8;
const FLAG_UTF8 = 0x800;
const ENCRYPTION_FLAGS = 0x2041;
const SUPPORTED_FLAGS = FLAG_UTF8 | FLAG_DESCRIPTOR | 0x6;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  return magic === LOCAL_MAGIC || magic === END_MAGIC || magic === DESCRIPTOR_MAGIC;
}

function corrupt(detail: string): Extract<ZipInflateVerdict, { ok: false }> {
  return { ok: false, reason: "corrupt", detail };
}

function hasValidExtraFields(bytes: Buffer): boolean {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return false;
    const kind = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    if (kind === 1 || offset + 4 + length > bytes.length) return false;
    offset += 4 + length;
  }
  return true;
}

function decodeMemberName(bytes: Buffer, flags: number): string | undefined {
  let name: string;
  try {
    if (!(flags & FLAG_UTF8) && bytes.some((byte) => byte > 0x7f)) return undefined;
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (!name || /[\u0000-\u001f\u007f\\:]/.test(name) || name.startsWith("/")) return undefined;
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return undefined;
  if (segments[0]!.toLowerCase() === "root entry") return undefined;
  return name;
}

function findEnd(bytes: Buffer): number | undefined {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - MAX_UINT16); offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_MAGIC && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      return offset;
    }
  }
  return undefined;
}

function buildCanonicalArchive(entries: readonly CheckedZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    const flags = (entry.flags | FLAG_UTF8) & ~FLAG_DESCRIPTOR;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_MAGIC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.checksum, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    parts.push(local, entry.nameBytes, entry.compressed!);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_MAGIC, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.checksum, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    if (entry.name.endsWith("/")) central.writeUInt32LE(0x10, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, entry.nameBytes);
    offset += local.length + entry.nameBytes.length + entry.compressedSize;
    directorySize += central.length + entry.nameBytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_MAGIC, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

/** The trusted callback must not mutate entry bytes or retain unnecessary members. */
export function verifyZipInflateLimits(
  bytes: Buffer,
  limits: ZipInflateLimits,
  options: ZipInflateOptions = {},
): ZipInflateVerdict {
  const end = findEnd(bytes);
  if (end === undefined) return corrupt("ZIP end record is missing or truncated");
  const entriesCount = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (entriesCount === MAX_UINT16 || directorySize === MAX_UINT32 || directoryOffset === MAX_UINT32) {
    return corrupt("ZIP64 archives are unsupported");
  }
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== entriesCount) return corrupt("Split ZIP archives are unsupported");
  if (entriesCount > limits.maxArchiveEntries) {
    return { ok: false, reason: "too-many-entries", detail: `${entriesCount} entries exceeds ${limits.maxArchiveEntries}` };
  }
  if (directoryOffset + directorySize !== end) return corrupt("ZIP directory boundaries do not match");

  const entries: CheckedZipEntry[] = [];
  const names = new Set<string>();
  let offset = directoryOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== CENTRAL_MAGIC) return corrupt("Invalid ZIP directory entry");
    const version = bytes.readUInt16LE(offset + 6);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) return corrupt("Truncated ZIP directory entry");
    if (version > 20 || size === MAX_UINT32 || compressedSize === MAX_UINT32 || localOffset === MAX_UINT32
      || !hasValidExtraFields(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength))) {
      return corrupt("Unsupported ZIP version or ZIP64 metadata");
    }
    if (bytes.readUInt16LE(offset + 34) !== 0) return corrupt("Split ZIP entries are unsupported");
    if (localOffset + 30 > directoryOffset) return corrupt("ZIP local entry is outside the member area");
    if (flags & ENCRYPTION_FLAGS) return { ok: false, reason: "encrypted", detail: "ZIP member is encrypted" };
    if ((flags & ~SUPPORTED_FLAGS) || (method !== METHOD_STORED && method !== METHOD_DEFLATED)
      || (method === METHOD_STORED && (flags & 0x6))) return corrupt("Unsupported ZIP flags or compression method");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeMemberName(nameBytes, flags);
    if (name === undefined || names.has(name.toLowerCase())) return corrupt("Invalid or duplicate ZIP member name");
    names.add(name.toLowerCase());
    declaredTotal += size;
    if (declaredTotal > limits.maxUncompressedBytes) {
      return { ok: false, reason: "too-large", detail: `declared uncompressed size exceeds ${limits.maxUncompressedBytes}` };
    }
    if (size >= limits.ratioCheckMinBytes && size / Math.max(1, compressedSize) > limits.maxCompressionRatio) {
      return { ok: false, reason: "compression-ratio", detail: `${name} ratio exceeds ${limits.maxCompressionRatio}` };
    }
    entries.push({ name, nameBytes, version, flags, method, checksum, compressedSize, size, localOffset });
    offset = next;
  }
  if (offset !== end) return corrupt("ZIP directory has unindexed data");
  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if ((ordered[0]?.localOffset ?? directoryOffset) !== 0) return corrupt("ZIP has an unsupported prefix");

  let actualTotal = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    const local = entry.localOffset;
    const boundary = ordered[index + 1]?.localOffset ?? directoryOffset;
    if (local + 30 > boundary || bytes.readUInt32LE(local) !== LOCAL_MAGIC) return corrupt("Invalid or overlapping ZIP local entry");
    const localFlags = bytes.readUInt16LE(local + 6);
    const nameLength = bytes.readUInt16LE(local + 26);
    const extraLength = bytes.readUInt16LE(local + 28);
    const dataOffset = local + 30 + nameLength + extraLength;
    if (bytes.readUInt16LE(local + 4) !== entry.version || localFlags !== entry.flags
      || bytes.readUInt16LE(local + 8) !== entry.method || dataOffset > boundary
      || !bytes.subarray(local + 30, local + 30 + nameLength).equals(entry.nameBytes)
      || !hasValidExtraFields(bytes.subarray(local + 30 + nameLength, dataOffset))) {
      return corrupt(`${entry.name}: local and directory headers disagree`);
    }
    const localChecksum = bytes.readUInt32LE(local + 14);
    const localCompressed = bytes.readUInt32LE(local + 18);
    const localSize = bytes.readUInt32LE(local + 22);
    const matching = localChecksum === entry.checksum && localCompressed === entry.compressedSize && localSize === entry.size;
    const deferred = Boolean(localFlags & FLAG_DESCRIPTOR);
    if (!matching && !(deferred && localChecksum === 0 && localCompressed === 0 && localSize === 0)) {
      return corrupt(`${entry.name}: local sizes or checksum disagree`);
    }
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > boundary) return corrupt(`${entry.name}: compressed payload overlaps another record`);
    if (deferred) {
      const descriptorSize = boundary - dataEnd;
      if (descriptorSize !== 12 && descriptorSize !== 16) return corrupt(`${entry.name}: invalid data descriptor length`);
      const descriptor = dataEnd + (descriptorSize === 16 ? 4 : 0);
      if ((descriptorSize === 16 && bytes.readUInt32LE(dataEnd) !== DESCRIPTOR_MAGIC)
        || bytes.readUInt32LE(descriptor) !== entry.checksum
        || bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize
        || bytes.readUInt32LE(descriptor + 8) !== entry.size) return corrupt(`${entry.name}: data descriptor disagrees`);
    } else if (dataEnd !== boundary) return corrupt(`${entry.name}: ZIP has unindexed local data`);

    const compressed = bytes.subarray(dataOffset, dataEnd);
    let data: Buffer;
    if (entry.method === METHOD_STORED) data = compressed;
    else {
      try {
        // The runtime's info result exposes consumed input, preventing a valid
        // stream prefix from hiding bytes that another decoder could interpret.
        const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size), info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (result.engine.bytesWritten !== compressed.length) return corrupt(`${entry.name}: unread compressed payload`);
        data = result.buffer;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
          return { ok: false, reason: "size-mismatch", detail: `${entry.name} inflates beyond its declared ${entry.size} bytes` };
        }
        return corrupt(`${entry.name}: invalid compressed payload`);
      }
    }
    if (data.length !== entry.size) {
      return { ok: false, reason: "size-mismatch", detail: `${entry.name} is ${data.length} bytes, declared ${entry.size}` };
    }
    if (crc32(data) !== entry.checksum) return corrupt(`${entry.name}: checksum mismatch`);
    if (entry.name.endsWith("/") && data.length !== 0) return corrupt(`${entry.name}: directory contains data`);
    if (hasZipMagic(data) && !options.opaqueArchiveMemberPrefixes?.some((prefix) => prefix.endsWith("/") && entry.name.startsWith(prefix))) {
      return corrupt(`${entry.name}: nested ZIP archives are unsupported`);
    }
    actualTotal += data.length;
    entry.compressed = compressed;
    options.onEntry?.(entry.name, data);
  }
  return {
    ok: true,
    entries: entries.length,
    uncompressedBytes: actualTotal,
    canonicalBytes: buildCanonicalArchive(entries),
    entryNames: entries.map((entry) => entry.name),
  };
}
