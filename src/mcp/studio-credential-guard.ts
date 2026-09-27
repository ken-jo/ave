function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/** Scan bytes so malformed escapes and invalid UTF-8 cannot discard adjacent valid bytes. */
function percentDecodeBytes(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length);
  let written = 0;
  for (let index = 0; index < input.length; index++) {
    if (input[index] === 0x25 && index + 2 < input.length) {
      const high = hexDigit(input[index + 1]!);
      const low = hexDigit(input[index + 2]!);
      if (high >= 0 && low >= 0) {
        output[written++] = high * 16 + low;
        index += 2;
        continue;
      }
    }
    output[written++] = input[index]!;
  }
  return output.subarray(0, written);
}

function stringContainsCredential(value: string, credentialBytes: Buffer): boolean {
  for (const text of [value, value.replaceAll("+", " ")]) {
    let layer: Buffer = Buffer.from(text, "utf8");
    for (let depth = 0; depth <= 3; depth++) {
      if (layer.indexOf(credentialBytes) >= 0) return true;
      if (depth === 3) break;
      const decoded = percentDecodeBytes(layer);
      if (decoded.equals(layer)) break;
      layer = decoded;
    }
  }
  return false;
}

export function containsStoredCredential(value: unknown, credential: string): boolean {
  if (!credential) return false;
  const credentialBytes = Buffer.from(credential, "utf8");
  const inspect = (item: unknown): boolean => {
    if (typeof item === "string") return stringContainsCredential(item, credentialBytes);
    if (Array.isArray(item)) return item.some(inspect);
    if (item !== null && typeof item === "object") return Object.entries(item).some(([key, part]) =>
      stringContainsCredential(key, credentialBytes) || inspect(part));
    return false;
  };
  return inspect(value);
}
