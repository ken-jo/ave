const { inflateSync } = require("node:zlib");

/**
 * The decoded image a PNG carries: its header plus the inflated pixel stream.
 *
 * Everything the deflate encoder is free to choose — block splitting, match
 * lengths, the trailing checksum's stream position — is dropped, so two PNGs
 * that draw the same picture normalize to the same bytes no matter which zlib
 * produced them. Returns null for anything that is not a PNG, which is how a
 * non-image asset falls back to the plain byte comparison.
 */
function normalizedPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  const parts = [];
  const pixels = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === "IDAT") pixels.push(body);
    else parts.push(Buffer.from(type, "ascii"), body);
    offset += 12 + length;
  }
  if (pixels.length === 0) return null;
  try {
    return Buffer.concat([...parts, inflateSync(Buffer.concat(pixels))]);
  } catch {
    return null;
  }
}

/**
 * The decoded images an ICO carries, in directory order.
 *
 * Each directory entry's byte offset and length are dropped for the same
 * reason the deflate stream is: they move when an image re-compresses to a
 * different size, without the icon depicting anything different.
 */
function normalizedIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (count === 0 || bytes.length < 6 + count * 16) return null;
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    // Width/height/colours/planes/bpp describe the image; offset and size
    // describe where the encoder happened to put it.
    parts.push(bytes.subarray(entry, entry + 8));
    const size = bytes.readUInt32LE(entry + 8);
    const at = bytes.readUInt32LE(entry + 12);
    const image = bytes.subarray(at, at + size);
    if (image.length !== size) return null;
    const decoded = normalizedPng(image);
    if (decoded === null) return null;
    parts.push(decoded);
  }
  return Buffer.concat(parts);
}

/** Normalize an asset to what it depicts, or null when it is not an image. */
function normalizedImage(bytes) {
  return normalizedIco(bytes) ?? normalizedPng(bytes);
}

module.exports = { normalizedImage };
