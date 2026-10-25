const { inflateSync } = require("node:zlib");

// Normalize decoded PNG pixels, ignoring compression choices; non-images return null.
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

// Ignore encoded image offsets and lengths; preserve image order and decoded content.
function normalizedIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (count === 0 || bytes.length < 6 + count * 16) return null;
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    // Image metadata is meaningful; encoded offsets and sizes are not.
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

function normalizedImage(bytes) {
  return normalizedIco(bytes) ?? normalizedPng(bytes);
}

module.exports = { normalizedImage };
