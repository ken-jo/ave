import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
  method?: 0 | 8;
  descriptor?: "signed" | "unsigned" | "missing";
  compressedData?: Buffer;
  extra?: Buffer;
}

/** Builds small archives whose framing can be changed independently in tests. */
export function createZipFixture(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const compressed = entry.compressedData ?? (method === 0 ? data : deflateRawSync(data));
    const extra = entry.extra ?? Buffer.alloc(0);
    const flags = 0x800 | (entry.descriptor ? 8 : 0);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = entry.descriptor && entry.descriptor !== "missing"
      ? Buffer.alloc(entry.descriptor === "signed" ? 16 : 12)
      : Buffer.alloc(0);
    if (descriptor.length > 0) {
      const offset = descriptor.length === 16 ? 4 : 0;
      if (offset) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, offset);
      descriptor.writeUInt32LE(compressed.length, offset + 4);
      descriptor.writeUInt32LE(data.length, offset + 8);
    }
    localParts.push(local, name, extra, compressed, descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name, extra);
    localOffset += local.length + name.length + extra.length + compressed.length + descriptor.length;
    centralSize += central.length + name.length + extra.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function zipCentralOffset(bytes: Buffer): number {
  return bytes.readUInt32LE(bytes.length - 6);
}
