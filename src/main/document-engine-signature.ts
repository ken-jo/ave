import { createHash, createPublicKey, createVerify } from "node:crypto";
import { openExecutableFile } from "./codex-executable-artifact.js";
import { DOCUMENT_ENGINE_RELEASE_KEY } from "./document-engine-release-pins.js";
import { runDocumentEngineSystemCommand } from "./document-engine-system-command.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";

interface ReleaseKey { readonly fingerprint: string; readonly packet: string }

function invalidSignature(): never { throw new Error("Document engine release signature is invalid"); }

function readMpi(bytes: Buffer, start: number): { value: Buffer; end: number } {
  if (start + 2 > bytes.length) return invalidSignature();
  const bits = bytes.readUInt16BE(start);
  const end = start + 2 + Math.ceil(bits / 8);
  if (bits === 0 || end > bytes.length) return invalidSignature();
  const value = bytes.subarray(start + 2, end);
  if (value[0] === 0 || Math.floor(Math.log2(value[0]!)) + 1 !== ((bits - 1) % 8) + 1) return invalidSignature();
  return { value, end };
}

function packetBody(bytes: Buffer): Buffer {
  if (bytes.length < 2 || (bytes[0]! & 0x80) === 0) return invalidSignature();
  if ((bytes[0]! & 0x40) === 0) {
    const kind = bytes[0]! & 3;
    const width = [1, 2, 4][kind];
    if ((bytes[0]! >> 2 & 15) !== 2 || width === undefined || bytes.length < 1 + width) return invalidSignature();
    const length = bytes.readUIntBE(1, width);
    if (1 + width + length !== bytes.length) return invalidSignature();
    return bytes.subarray(1 + width);
  }
  if ((bytes[0]! & 0x3f) !== 2) return invalidSignature();
  const size = bytes[1]!;
  let start = 2;
  let length: number;
  if (size < 192) length = size;
  else if (size < 224) {
    if (bytes.length < 3) return invalidSignature();
    length = ((size - 192) << 8) + bytes[2]! + 192;
    start = 3;
  } else if (size === 255) {
    if (bytes.length < 6) return invalidSignature();
    length = bytes.readUInt32BE(2);
    start = 6;
  } else return invalidSignature();
  if (start + length !== bytes.length) return invalidSignature();
  return bytes.subarray(start);
}

function checkSubpackets(bytes: Buffer, fingerprint: string, hashed: boolean): void {
  let offset = 0;
  let issuer = false;
  let creation = false;
  while (offset < bytes.length) {
    const length = bytes[offset++]!;
    if (length === 0 || length >= 192 || offset + length > bytes.length) return invalidSignature();
    const type = bytes[offset++]!;
    const data = bytes.subarray(offset, offset + length - 1);
    offset += length - 1;
    if (type === 33 && hashed && !issuer && data.length === 21 && data[0] === 4
      && data.subarray(1).toString("hex").toUpperCase() === fingerprint) issuer = true;
    else if (type === 2 && hashed && !creation && data.length === 4 && data.readUInt32BE(0) > 0) creation = true;
    else if (type !== 16 || hashed || data.length !== 8 || data.toString("hex").toUpperCase() !== fingerprint.slice(-16)) return invalidSignature();
  }
  if (hashed && (!issuer || !creation)) return invalidSignature();
}

async function verifyRsaReleaseSignature(
  path: string, armored: string, signal: AbortSignal, key: ReleaseKey,
): Promise<void> {
  if (armored.length > 16_384 || !/^-----BEGIN PGP SIGNATURE-----\r?\n(?:[^\r\n:]+:[^\r\n]*\r?\n)*\r?\n[A-Za-z0-9+/=\r\n]+-----END PGP SIGNATURE-----\r?\n?$/.test(armored)) return invalidSignature();
  const content = armored.split(/\r?\n\r?\n/)[1]?.split("-----END PGP SIGNATURE-----")[0];
  if (!content) return invalidSignature();
  const encoded = content.split(/\r?\n/).filter((line) => line && !line.startsWith("=")).join("");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return invalidSignature();
  const packet = packetBody(Buffer.from(encoded, "base64"));
  if (packet.length < 12 || packet[0] !== 4 || packet[1] !== 0 || packet[2] !== 1 || packet[3] !== 8) return invalidSignature();
  const hashedEnd = 6 + packet.readUInt16BE(4);
  if (hashedEnd + 2 > packet.length) return invalidSignature();
  const unhashedEnd = hashedEnd + 2 + packet.readUInt16BE(hashedEnd);
  if (unhashedEnd + 4 > packet.length) return invalidSignature();
  checkSubpackets(packet.subarray(6, hashedEnd), key.fingerprint, true);
  checkSubpackets(packet.subarray(hashedEnd + 2, unhashedEnd), key.fingerprint, false);
  const signature = readMpi(packet, unhashedEnd + 2);
  if (signature.end !== packet.length) return invalidSignature();

  const publicPacket = Buffer.from(key.packet, "base64");
  if (publicPacket.length > 65_535 || publicPacket[0] !== 4 || publicPacket[5] !== 1) return invalidSignature();
  const framing = Buffer.alloc(3);
  framing[0] = 0x99;
  framing.writeUInt16BE(publicPacket.length, 1);
  if (createHash("sha1").update(framing).update(publicPacket).digest("hex").toUpperCase() !== key.fingerprint) return invalidSignature();
  const modulus = readMpi(publicPacket, 6);
  const exponent = readMpi(publicPacket, modulus.end);
  if (exponent.end !== publicPacket.length || modulus.value.length < 256 || modulus.value.length > 512
    || signature.value.length > modulus.value.length) return invalidSignature();
  const publicKey = createPublicKey({ format: "jwk", key: { kty: "RSA", n: modulus.value.toString("base64url"), e: exponent.value.toString("base64url") } });
  const padded = Buffer.alloc(modulus.value.length);
  signature.value.copy(padded, padded.length - signature.value.length);
  const verifier = createVerify("RSA-SHA256");
  const digest = createHash("sha256");
  const input = await openExecutableFile(path);
  try {
    const before = await input.stat({ bigint: true });
    const buffer = Buffer.alloc(65_536);
    let position = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      verifier.update(buffer.subarray(0, bytesRead));
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await input.stat({ bigint: true });
    if (BigInt(position) !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return invalidSignature();
  } finally { await input.close(); }
  const trailer = Buffer.alloc(6);
  trailer[0] = 4;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(hashedEnd, 2);
  const suffix = Buffer.concat([packet.subarray(0, hashedEnd), trailer]);
  verifier.update(suffix);
  digest.update(suffix);
  if (!digest.digest().subarray(0, 2).equals(packet.subarray(unhashedEnd, unhashedEnd + 2))
    || !verifier.verify(publicKey, padded)) return invalidSignature();
}

/** Admit only the pinned release's v4 RSA/SHA-256 detached binary signature. */
export function verifyDocumentEngineReleaseSignature(path: string, armored: string, signal: AbortSignal): Promise<void> {
  return verifyRsaReleaseSignature(path, armored, signal, DOCUMENT_ENGINE_RELEASE_KEY);
}

export function _verifyDocumentEngineReleaseSignatureForTest(path: string, armored: string, signal: AbortSignal, key: ReleaseKey): Promise<void> {
  return verifyRsaReleaseSignature(path, armored, signal, key);
}

export async function verifyDocumentEnginePlatformSignature(path: string, platform: NodeJS.Platform, signal: AbortSignal): Promise<void> {
  if (platform === "darwin") {
    await runDocumentEngineSystemCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], signal);
    const identity = await runDocumentEngineSystemCommand("/usr/bin/codesign", ["--display", "--verbose=4", path], signal);
    if (!/^TeamIdentifier=7P5S3ZLCN7$/m.test(identity) || !/^Identifier=org\.libreoffice\.script$/m.test(identity)
      || !/^Authority=Developer ID Application: The Document Foundation \(7P5S3ZLCN7\)$/m.test(identity)) return invalidSignature();
    await runDocumentEngineSystemCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", path], signal);
    return;
  }
  if (platform !== "win32") return;
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$s=Get-AuthenticodeSignature -LiteralPath $p",
    "if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'Invalid document engine Authenticode signature'}",
    "$c=$s.SignerCertificate",
    "if($c.Subject -notmatch '(^|,\\s*)O=\"?The Document Foundation\"?(,|$)'){throw 'Unexpected document engine signer'}",
    "$eku=@($c.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | ForEach-Object {$_.EnhancedKeyUsages} | ForEach-Object {$_.Value})",
    "if($eku -notcontains '1.3.6.1.5.5.7.3.3'){throw 'Document engine signer cannot sign code'}",
    "'verified'",
  ].join("; ");
  const result = await runDocumentEngineSystemCommand(win32SystemBinary("WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], signal);
  if (result.trim() !== "verified") return invalidSignature();
}
