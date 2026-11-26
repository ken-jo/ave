import { createHash } from "node:crypto";

const DATA_DIRECTORIES = { 0x10b: 96, 0x20b: 112 };
const SECURITY_DIRECTORY = 4;

/**
 * SHA-256 of a PE image without the fields code signing rewrites: the checksum, the certificate
 * table entry and the certificate table itself. Signing an image keeps this digest; changing any
 * header, section or trailing byte outside the table does not.
 */
export function windowsPeImageDigest(bytes) {
  const invalid = () => new Error("Windows helper is not a PE image");
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw invalid();
  const pe = bytes.readUInt32LE(60);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw invalid();
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const sections = optional + optionalSize;
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const directories = DATA_DIRECTORIES[optional + 2 <= bytes.length ? bytes.readUInt16LE(optional) : 0];
  if (!directories || sections + 40 * sectionCount > bytes.length) throw invalid();
  const security = optional + directories + 8 * SECURITY_DIRECTORY;
  if (security + 8 > sections || bytes.readUInt32LE(optional + directories - 4) <= SECURITY_DIRECTORY) throw invalid();
  let imageEnd = bytes.readUInt32LE(optional + 60);
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sections + 40 * index;
    const size = bytes.readUInt32LE(header + 16);
    if (size > 0) imageEnd = Math.max(imageEnd, bytes.readUInt32LE(header + 20) + size);
  }
  const tableStart = bytes.readUInt32LE(security);
  const tableSize = bytes.readUInt32LE(security + 4);
  let end = bytes.length;
  if (tableStart !== 0 || tableSize !== 0) {
    // The table may only replace trailing bytes after the image, and must end the file.
    if (tableStart % 8 !== 0 || tableStart < imageEnd || tableSize === 0 || tableStart + tableSize !== bytes.length) throw invalid();
    end = tableStart;
  }
  if (imageEnd > end) throw invalid();
  const checksum = optional + 64;
  const hash = createHash("sha256")
    .update(bytes.subarray(0, checksum))
    .update(bytes.subarray(checksum + 4, security))
    .update(bytes.subarray(security + 8, end));
  // A signer aligns the table to 8 bytes with zero padding.
  if (end % 8 !== 0) hash.update(Buffer.alloc(8 - (end % 8)));
  return hash.digest("hex");
}
