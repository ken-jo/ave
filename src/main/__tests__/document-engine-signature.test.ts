import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyDocumentEnginePlatformSignature, _verifyDocumentEngineReleaseSignatureForTest as verifyWithKey } from "../document-engine-signature.js";
import { DOCUMENT_ENGINE_RELEASE_KEY } from "../document-engine-release-pins.js";
import { runDocumentEngineSystemCommand } from "../document-engine-system-command.js";

vi.mock("../document-engine-system-command.js", () => ({ runDocumentEngineSystemCommand: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function mpi(bytes: Buffer): Buffer {
  const value = bytes.subarray(bytes.findIndex((byte) => byte !== 0));
  const bits = (value.length - 1) * 8 + Math.floor(Math.log2(value[0]!)) + 1;
  const length = Buffer.alloc(2); length.writeUInt16BE(bits);
  return Buffer.concat([length, value]);
}

function signedFixture(message: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const packet = Buffer.concat([Buffer.from([4, 0x65, 0, 0, 0, 1]), mpi(Buffer.from(jwk.n!, "base64url")), mpi(Buffer.from(jwk.e!, "base64url"))]);
  const frame = Buffer.alloc(3); frame[0] = 0x99; frame.writeUInt16BE(packet.length, 1);
  const fingerprint = createHash("sha1").update(frame).update(packet).digest("hex").toUpperCase();
  const subpackets = Buffer.concat([Buffer.from([22, 33, 4]), Buffer.from(fingerprint, "hex"), Buffer.from([5, 2, 0x65, 0, 0, 1])]);
  const header = Buffer.from([4, 0, 1, 8, subpackets.length >> 8, subpackets.length & 255]);
  const signed = Buffer.concat([header, subpackets]);
  const trailer = Buffer.alloc(6); trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(signed.length, 2);
  const signature = createSign("RSA-SHA256").update(message).update(signed).update(trailer).sign(privateKey);
  const digest = createHash("sha256").update(message).update(signed).update(trailer).digest().subarray(0, 2);
  const body = Buffer.concat([signed, Buffer.from([0, 10, 9, 16]), Buffer.from(fingerprint.slice(-16), "hex"), digest, mpi(signature)]);
  const packetHeader = Buffer.alloc(3); packetHeader[0] = 0x89; packetHeader.writeUInt16BE(body.length, 1);
  const armored = (data: Buffer) => `-----BEGIN PGP SIGNATURE-----\n\n${data.toString("base64")}\n-----END PGP SIGNATURE-----\n`;
  return { key: { fingerprint, packet: packet.toString("base64") }, body, packetHeader,
    armored, signature: armored(Buffer.concat([packetHeader, body])) };
}

async function source(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "ave-release-signature-")); roots.push(root);
  const path = join(root, "archive"); await writeFile(path, bytes); return path;
}

describe("document engine release signatures", () => {
  it("verifies a detached signature over streamed bytes using its exact pinned key", async () => {
    const bytes = Buffer.from("authenticated release bytes\n");
    const fixture = signedFixture(bytes);
    await expect(verifyWithKey(await source(bytes), fixture.signature, new AbortController().signal, fixture.key)).resolves.toBeUndefined();
  });

  it("rejects changed body bytes despite matching signature issuer metadata", async () => {
    const fixture = signedFixture(Buffer.from("original"));
    await expect(verifyWithKey(await source(Buffer.from("modified")), fixture.signature, new AbortController().signal, fixture.key)).rejects.toThrow("signature is invalid");
  });

  it("rejects a signature made by a different pinned key", async () => {
    const bytes = Buffer.from("same content"); const fixture = signedFixture(bytes); const other = signedFixture(bytes);
    await expect(verifyWithKey(await source(bytes), fixture.signature, new AbortController().signal, other.key)).rejects.toThrow("signature is invalid");
  });

  it.each(["hash", "fingerprint", "trailing", "partial"] as const)("rejects unsupported or inconsistent %s framing", async (kind) => {
    const bytes = Buffer.from("release"); const fixture = signedFixture(bytes); const body = Buffer.from(fixture.body);
    if (kind === "hash") body[3] = 2;
    if (kind === "fingerprint") body[9] = body[9]! ^ 1;
    const framed = kind === "partial" ? Buffer.concat([Buffer.from([0xc2, 224]), body])
      : Buffer.concat([fixture.packetHeader, body, ...(kind === "trailing" ? [Buffer.from([0])] : [])]);
    await expect(verifyWithKey(await source(bytes), fixture.armored(framed), new AbortController().signal, fixture.key)).rejects.toThrow("signature is invalid");
  });

  it("pins the release public-key packet independently of its name", () => {
    const packet = Buffer.from(DOCUMENT_ENGINE_RELEASE_KEY.packet, "base64");
    const framing = Buffer.alloc(3); framing[0] = 0x99; framing.writeUInt16BE(packet.length, 1);
    expect(createHash("sha1").update(framing).update(packet).digest("hex").toUpperCase()).toBe(DOCUMENT_ENGINE_RELEASE_KEY.fingerprint);
  });

  it("requires valid native signatures and the exact developer identity", async () => {
    vi.mocked(runDocumentEngineSystemCommand).mockResolvedValueOnce("").mockResolvedValueOnce(
      "Identifier=org.libreoffice.script\nTeamIdentifier=7P5S3ZLCN7\nAuthority=Developer ID Application: The Document Foundation (7P5S3ZLCN7)\n",
    ).mockResolvedValueOnce("accepted");
    await expect(verifyDocumentEnginePlatformSignature("/engine/soffice", "darwin", new AbortController().signal)).resolves.toBeUndefined();
    expect(vi.mocked(runDocumentEngineSystemCommand).mock.calls.map(([command]) => command)).toEqual(["/usr/bin/codesign", "/usr/bin/codesign", "/usr/sbin/spctl"]);
    vi.mocked(runDocumentEngineSystemCommand).mockResolvedValueOnce("").mockResolvedValueOnce("Identifier=org.libreoffice.script\nTeamIdentifier=OTHER\n");
    await expect(verifyDocumentEnginePlatformSignature("/engine/soffice", "darwin", new AbortController().signal)).rejects.toThrow("signature is invalid");
  });
});
