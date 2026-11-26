/** A minimal PE32+ image whose only content is `marker`. */
export function helperImage(marker: string): Buffer {
  const image = Buffer.alloc(0x400);
  image.writeUInt16LE(0x5a4d);
  image.writeUInt32LE(64, 60);
  image.writeUInt32LE(0x4550, 64);
  image.writeUInt16LE(240, 84);
  image.writeUInt16LE(0x20b, 88);
  image.writeUInt32LE(16, 88 + 108);
  image.write(marker, 0x200);
  return image;
}
