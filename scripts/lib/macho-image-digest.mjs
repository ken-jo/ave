import { createHash } from "node:crypto";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 2;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const HEADER_BYTES = 32;

/**
 * SHA-256 of a thin arm64 Mach-O executable without what code signing rewrites: the signature blob at the file's
 * tail, the signature command's offset and size, the `__LINKEDIT` segment's sizes, and the 16 bytes of `LC_UUID`.
 * Signing (ad hoc or Developer ID) keeps this digest. The UUID is left out because the linker derives it from where
 * its inputs were, so two builds of the same source in different directories differ there only; it carries no code.
 * Any other byte before the signature changes the digest.
 */
export function machoImageDigest(bytes) {
  const invalid = (why) => new Error(`macOS holder helper is not a signable arm64 executable: ${why}`);
  if (bytes.length < HEADER_BYTES) throw invalid("too short");
  if (bytes.readUInt32LE(0) !== MH_MAGIC_64) throw invalid("not a thin 64-bit little-endian Mach-O");
  if (bytes.readUInt32LE(4) !== CPU_TYPE_ARM64) throw invalid("not arm64");
  if (bytes.readUInt32LE(12) !== MH_EXECUTE) throw invalid("not an executable");
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (HEADER_BYTES + commandBytes > bytes.length) throw invalid("load commands overrun the file");
  const zeroed = [];
  let signature;
  let linkedit;
  let uuid = 0;
  let offset = HEADER_BYTES;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > HEADER_BYTES + commandBytes) throw invalid("load command overruns the command area");
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > HEADER_BYTES + commandBytes) throw invalid("malformed load command");
    if (command === LC_CODE_SIGNATURE) {
      if (signature !== undefined || size !== 16) throw invalid("expected one code signature command");
      signature = { dataoff: bytes.readUInt32LE(offset + 8), datasize: bytes.readUInt32LE(offset + 12) };
      zeroed.push([offset + 8, 8]);
    } else if (command === LC_SEGMENT_64 && bytes.toString("latin1", offset + 8, offset + 24).replace(/\0+$/u, "") === "__LINKEDIT") {
      if (linkedit !== undefined || size < 72) throw invalid("expected one __LINKEDIT segment");
      linkedit = { fileoff: Number(bytes.readBigUInt64LE(offset + 40)), filesize: Number(bytes.readBigUInt64LE(offset + 48)) };
      // vmsize at +32 and filesize at +48; fileoff at +40 stays in the digest.
      zeroed.push([offset + 32, 8], [offset + 48, 8]);
    } else if (command === LC_UUID) {
      if (size !== 24) throw invalid("malformed UUID command");
      uuid += 1;
      zeroed.push([offset + 8, 16]);
    }
    offset += size;
  }
  if (signature === undefined) throw invalid("no code signature command");
  if (linkedit === undefined) throw invalid("no __LINKEDIT segment");
  if (uuid > 1) throw invalid("more than one UUID command");
  const { dataoff, datasize } = signature;
  if (dataoff < linkedit.fileoff || dataoff >= linkedit.fileoff + linkedit.filesize) throw invalid("signature does not start inside __LINKEDIT");
  if (dataoff + datasize !== bytes.length) throw invalid("signature is not the file's tail");
  if (dataoff < HEADER_BYTES + commandBytes) throw invalid("signature overlaps the load commands");
  const image = Buffer.from(bytes.subarray(0, dataoff));
  for (const [start, length] of zeroed) image.fill(0, start, start + length);
  return createHash("sha256").update(image).digest("hex");
}
