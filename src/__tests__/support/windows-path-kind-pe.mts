export function pathKindPe(dll = "KERNEL32.dll", delayed = false): Buffer {
  const binary = Buffer.alloc(0x400);
  binary.writeUInt16LE(0x5a4d);
  binary.writeUInt32LE(64, 60);
  binary.writeUInt32LE(0x4550, 64);
  binary.writeUInt16LE(0x8664, 68);
  binary.writeUInt16LE(1, 70); // One section
  binary.writeUInt16LE(240, 84); // Optional header size
  const optional = 88;
  binary.writeUInt16LE(0x20b, optional);
  binary.writeUInt32LE(16, optional + 108); // Data directory count
  const directory = optional + 112 + 8 * (delayed ? 13 : 1);
  binary.writeUInt32LE(0x1000, directory);
  binary.writeUInt32LE(delayed ? 64 : 40, directory + 4);
  const section = optional + 240;
  binary.writeUInt32LE(0x200, section + 8);
  binary.writeUInt32LE(0x1000, section + 12);
  binary.writeUInt32LE(0x200, section + 16);
  binary.writeUInt32LE(0x200, section + 20);
  if (delayed) binary.writeUInt32LE(1, 0x200);
  binary.writeUInt32LE(0x1080, 0x200 + (delayed ? 4 : 12));
  binary.write(dll, 0x280, "ascii");
  return binary;
}
