import type { FileHandle } from "node:fs/promises";

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const CPU_TYPES = { x64: 0x01000007, arm64: 0x0100000c } as const;
const ELF_MACHINES = { x64: 62, arm64: 183 } as const;
const PE_MACHINES = { x64: 0x8664, arm64: 0xaa64 } as const;

type SupportedArch = keyof typeof CPU_TYPES;
type ReadRange = (offset: number, length: number) => Promise<Buffer | null>;

function isElfProperty(note: Buffer, arch: SupportedArch): boolean {
  if (note.length < 16 || note.length > 1024 || note.readUInt32LE(0) !== 4
    || note.readUInt32LE(8) !== 5 || note.readUInt32LE(12) !== 0x00554e47) return false;
  const end = 16 + note.readUInt32LE(4);
  if (end > note.length) return false;
  let previous = -1;
  for (let offset = 16; offset < end;) {
    if (end - offset < 8) return false;
    const type = note.readUInt32LE(offset);
    const length = note.readUInt32LE(offset + 4);
    if (type <= previous || length > end - offset - 8) return false;
    if (((arch === "arm64" && type === 0xc0000000)
      || (arch === "x64" && [0xc0000002, 0xc0008002, 0xc0010002].includes(type))) && length !== 4) return false;
    previous = type;
    offset += 8 + Math.ceil(length / 8) * 8;
    if (offset > end) return false;
  }
  return true;
}

function contains(size: number, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length)
    && offset >= 0 && length >= 0 && offset <= size && length <= size - offset;
}

function uint64(buffer: Buffer, offset: number, littleEndian = true): number {
  const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN;
}

async function isElf(read: ReadRange, size: number, arch: SupportedArch): Promise<boolean> {
  const header = await read(0, 64);
  if (!header || header.readUInt32BE(0) !== 0x7f454c46
    || header[4] !== 2 || header[5] !== 1 || header[6] !== 1
    || ![0, 3].includes(header[7]!) || ![2, 3].includes(header.readUInt16LE(16))
    || header.readUInt16LE(18) !== ELF_MACHINES[arch] || header.readUInt32LE(20) !== 1
    || header.readUInt16LE(52) !== 64 || header.readUInt16LE(54) !== 56) return false;
  const entry = uint64(header, 24);
  const phoff = uint64(header, 32);
  const shoff = uint64(header, 40);
  const phnum = header.readUInt16LE(56);
  const shnum = header.readUInt16LE(60);
  const shstrndx = header.readUInt16LE(62);
  if (!phnum || phnum * 56 > 65536 || phoff < 64
    || (shoff === 0 ? shnum !== 0 || shstrndx !== 0
      : header.readUInt16LE(58) !== 64 || !shnum || shstrndx >= shnum
        || !contains(size, shoff, shnum * 64))) return false;
  const programs = await read(phoff, phnum * 56);
  if (!programs) return false;
  let executableEntry = false;
  let interpreter = false;
  for (let offset = 0; offset < programs.length; offset += 56) {
    const type = programs.readUInt32LE(offset);
    const flags = programs.readUInt32LE(offset + 4);
    const fileOffset = uint64(programs, offset + 8);
    const address = uint64(programs, offset + 16);
    const fileSize = uint64(programs, offset + 32);
    const memorySize = uint64(programs, offset + 40);
    const alignment = uint64(programs, offset + 48);
    if (!contains(size, fileOffset, fileSize)) return false;
    if (type === 1) {
      if (!Number.isSafeInteger(address + memorySize) || fileSize > memorySize
        || !Number.isSafeInteger(alignment)
        || (alignment > 1 && (!Number.isInteger(Math.log2(alignment))
          || fileOffset % alignment !== address % alignment))) return false;
      if ((flags & 1) !== 0 && entry >= address && entry - address < fileSize) executableEntry = true;
    }
    if (type === 3) {
      if (interpreter || fileSize < 2 || fileSize > 4096) return false;
      interpreter = true;
      const path = await read(fileOffset, fileSize);
      if (!path || path[0] !== 0x2f || path.indexOf(0) !== path.length - 1) return false;
    }
    if (type === 0x6474e553) {
      if (fileSize > 1024) return false;
      const property = await read(fileOffset, fileSize);
      if (!property || !isElfProperty(property, arch)) return false;
    }
  }
  return executableEntry;
}

async function isThinMachO(read: ReadRange, size: number, arch: SupportedArch): Promise<boolean> {
  const header = await read(0, 32);
  if (!header || header.readUInt32LE(0) !== 0xfeedfacf
    || header.readUInt32LE(4) !== CPU_TYPES[arch] || header.readUInt32LE(12) !== 2
    || header.readUInt32LE(28) !== 0) return false;
  const count = header.readUInt32LE(16);
  const length = header.readUInt32LE(20);
  if (!count || count > length / 8) return false;
  const commands = await read(32, length);
  if (!commands) return false;
  let offset = 0;
  let entry: number | null = null;
  const executableRanges: Array<{ offset: number; size: number }> = [];
  for (let index = 0; index < count; index += 1) {
    if (!contains(commands.length, offset, 8)) return false;
    const command = commands.readUInt32LE(offset);
    const commandSize = commands.readUInt32LE(offset + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || !contains(commands.length, offset, commandSize)) return false;
    if (command === 0x19) {
      if (commandSize < 72 || commandSize !== 72 + commands.readUInt32LE(offset + 64) * 80) return false;
      const fileOffset = uint64(commands, offset + 40);
      const fileSize = uint64(commands, offset + 48);
      const memorySize = uint64(commands, offset + 32);
      if (!contains(size, fileOffset, fileSize) || fileSize > memorySize) return false;
      if ((commands.readUInt32LE(offset + 60) & 4) !== 0) executableRanges.push({ offset: fileOffset, size: fileSize });
      for (let section = offset + 72; section < offset + commandSize; section += 80) {
        const sectionSize = uint64(commands, section + 40);
        const sectionOffset = commands.readUInt32LE(section + 48);
        const sectionType = commands.readUInt32LE(section + 64) & 0xff;
        if (![1, 0xc, 0x12].includes(sectionType)
          && (!contains(size, sectionOffset, sectionSize)
            || sectionOffset < fileOffset || sectionOffset + sectionSize > fileOffset + fileSize)) return false;
      }
    }
    if (command === 0x80000028) {
      if (commandSize !== 24 || entry !== null) return false;
      entry = uint64(commands, offset + 8);
    }
    offset += commandSize;
  }
  return offset === length && entry !== null
    && executableRanges.some((range) => entry >= range.offset && entry - range.offset < range.size);
}

async function isMachO(read: ReadRange, size: number, arch: SupportedArch): Promise<boolean> {
  const header = await read(0, 8);
  if (!header) return false;
  const magic = header.readUInt32BE(0);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return isThinMachO(read, size, arch);
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const uint32 = (buffer: Buffer, offset: number) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const count = uint32(header, 4);
  if (!count || count > 128) return false;
  const entrySize = fat64 ? 32 : 20;
  const table = await read(8, count * entrySize);
  if (!table) return false;
  const ranges: Array<{ offset: number; size: number }> = [];
  let matches = false;
  for (let index = 0; index < count; index += 1) {
    const start = index * entrySize;
    const cpu = uint32(table, start);
    const sliceArch = cpu === CPU_TYPES.x64 ? "x64" : cpu === CPU_TYPES.arm64 ? "arm64" : null;
    if (!sliceArch) return false;
    const offset = fat64 ? uint64(table, start + 8, littleEndian) : uint32(table, start + 8);
    const length = fat64 ? uint64(table, start + 16, littleEndian) : uint32(table, start + 12);
    const alignment = uint32(table, start + (fat64 ? 24 : 16));
    if (!contains(size, offset, length) || offset < 8 + table.length || alignment > 31
      || offset % 2 ** alignment !== 0 || (fat64 && uint32(table, start + 28) !== 0)
      || ranges.some((range) => offset < range.offset + range.size && range.offset < offset + length)) return false;
    const sliceRead: ReadRange = (position, bytes) => contains(length, position, bytes) ? read(offset + position, bytes) : Promise.resolve(null);
    if (!await isThinMachO(sliceRead, length, sliceArch)) return false;
    ranges.push({ offset, size: length });
    if (sliceArch === arch) matches = true;
  }
  return matches;
}

async function isPe(read: ReadRange, size: number, arch: SupportedArch): Promise<boolean> {
  const dos = await read(0, 64);
  if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return false;
  const peOffset = dos.readUInt32LE(60);
  if (peOffset < 64) return false;
  const coff = await read(peOffset, 24);
  if (!coff || coff.readUInt32LE(0) !== 0x00004550 || coff.readUInt16LE(4) !== PE_MACHINES[arch]
    || (coff.readUInt16LE(22) & 0x2002) !== 2) return false;
  const sections = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  if (!sections || sections > 96 || optionalSize < 112) return false;
  const optional = await read(peOffset + 24, optionalSize);
  if (!optional || optional.readUInt16LE(0) !== 0x20b
    || optional.readUInt32LE(108) > (optionalSize - 112) / 8) return false;
  const entry = optional.readUInt32LE(16);
  const sectionAlignment = optional.readUInt32LE(32);
  const fileAlignment = optional.readUInt32LE(36);
  const imageSize = optional.readUInt32LE(56);
  const headersSize = optional.readUInt32LE(60);
  if (!sectionAlignment || !fileAlignment || !Number.isInteger(Math.log2(sectionAlignment))
    || !Number.isInteger(Math.log2(fileAlignment)) || sectionAlignment < fileAlignment
    || headersSize > size || headersSize < peOffset + 24 + optionalSize + sections * 40
    || imageSize % sectionAlignment !== 0 || headersSize % fileAlignment !== 0) return false;
  const table = await read(peOffset + 24 + optionalSize, sections * 40);
  if (!table) return false;
  let executableEntry = false;
  for (let offset = 0; offset < table.length; offset += 40) {
    const virtualSize = table.readUInt32LE(offset + 8);
    const address = table.readUInt32LE(offset + 12);
    const rawSize = table.readUInt32LE(offset + 16);
    const rawOffset = table.readUInt32LE(offset + 20);
    if (!contains(size, rawOffset, rawSize) || address % sectionAlignment !== 0
      || address + Math.max(virtualSize, rawSize) > imageSize
      || (rawSize > 0 && (rawOffset < headersSize || rawOffset % fileAlignment !== 0))) return false;
    if ((table.readUInt32LE(offset + 36) & 0x20000000) !== 0
      && entry >= address && entry - address < Math.min(virtualSize, rawSize)) executableEntry = true;
  }
  return executableEntry;
}

// Validate the native loader header and its bounded tables, never just a signature.
export async function isNativeExecutableFile(
  handle: FileHandle,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Promise<boolean> {
  if (arch !== "x64" && arch !== "arm64") return false;
  const stat = await handle.stat();
  if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return false;
  const read: ReadRange = async (offset, length) => {
    if (!contains(stat.size, offset, length) || length > MAX_HEADER_BYTES) return null;
    const buffer = Buffer.alloc(length);
    let cursor = 0;
    while (cursor < length) {
      const { bytesRead } = await handle.read(buffer, cursor, length - cursor, offset + cursor);
      if (!bytesRead) return null;
      cursor += bytesRead;
    }
    return buffer;
  };
  if (platform === "darwin") return isMachO(read, stat.size, arch);
  if (platform === "linux") return isElf(read, stat.size, arch);
  if (platform === "win32") return isPe(read, stat.size, arch);
  return false;
}
