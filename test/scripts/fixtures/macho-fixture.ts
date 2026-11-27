// A synthesized thin arm64 Mach-O executable: header, __TEXT and __LINKEDIT segments, LC_UUID, LC_CODE_SIGNATURE and a
// trailing signature blob. Enough for the image digest's parser on any host, with no toolchain.
export interface MachoFixtureOptions {
  readonly code?: Buffer;
  readonly uuid?: Buffer;
  readonly signature?: Buffer;
  readonly magic?: number;
  readonly signatureCommands?: number;
  readonly trailing?: Buffer;
}

export function machoFixture({ code = Buffer.from("code-bytes-0123456789abcdef"), uuid = Buffer.alloc(16, 0xab),
  signature = Buffer.alloc(64, 0x5a), magic = 0xfeedfacf, signatureCommands = 1, trailing = Buffer.alloc(0) }: MachoFixtureOptions = {}): Buffer {
  const segment = (name: string, fileoff: number, filesize: number): Buffer => {
    const command = Buffer.alloc(72);
    command.writeUInt32LE(0x19, 0);
    command.writeUInt32LE(72, 4);
    command.write(name, 8, "latin1");
    command.writeBigUInt64LE(BigInt(filesize), 32); // vmsize
    command.writeBigUInt64LE(BigInt(fileoff), 40);
    command.writeBigUInt64LE(BigInt(filesize), 48);
    return command;
  };
  const uuidCommand = Buffer.alloc(24);
  uuidCommand.writeUInt32LE(0x1b, 0);
  uuidCommand.writeUInt32LE(24, 4);
  uuid.copy(uuidCommand, 8);
  const commandBytes = 72 * 2 + 24 + 16 * signatureCommands;
  const codeOffset = 32 + commandBytes;
  const linkeditOffset = codeOffset + code.length;
  const symbols = Buffer.from("symbol-table-bytes");
  const dataoff = linkeditOffset + symbols.length;
  const signatureCommand = (): Buffer => {
    const command = Buffer.alloc(16);
    command.writeUInt32LE(0x1d, 0);
    command.writeUInt32LE(16, 4);
    command.writeUInt32LE(dataoff, 8);
    command.writeUInt32LE(signature.length, 12);
    return command;
  };
  const header = Buffer.alloc(32);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(3 + signatureCommands, 16);
  header.writeUInt32LE(commandBytes, 20);
  return Buffer.concat([
    header, segment("__TEXT", 0, linkeditOffset), segment("__LINKEDIT", linkeditOffset, symbols.length + signature.length),
    uuidCommand, ...Array.from({ length: signatureCommands }, signatureCommand), code, symbols, signature, trailing,
  ]);
}
