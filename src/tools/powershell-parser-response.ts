export const MAX_POWERSHELL_PARSER_RESPONSE_BYTES = 1024 * 1024;

/** A parser protocol response has its own byte bound, independent of display. */
export function createPowerShellParserResponse(): { collect(chunk: Buffer): void; read(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  return {
    collect(chunk): void {
      if (exceeded) return;
      if (size + chunk.length > MAX_POWERSHELL_PARSER_RESPONSE_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
    },
    read(): string {
      if (exceeded) throw new Error("PowerShell parser response exceeds the internal byte limit");
      return Buffer.concat(chunks, size).toString("utf8");
    },
  };
}
