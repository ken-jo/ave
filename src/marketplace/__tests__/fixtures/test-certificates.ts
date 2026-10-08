/**
 * Test fixture: a throwaway certificate authority and the server
 * certificates it signs, generated when a test asks for them.
 *
 * No private key is committed: each run makes ECDSA P-256 keys with
 * node:crypto and writes the X.509 structure by hand (DER), so the TLS
 * tests need no openssl binary and no dependency. Only what Node's TLS
 * verification reads is written: version 3, serial, validity, names, the
 * key, basicConstraints for the authority and subjectAltName for a server.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isIP } from "node:net";

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octets = (body: Buffer) => tlv(0x04, body);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const TRUE = tlv(0x01, Buffer.from([0xff]));

function integer(value: Buffer): Buffer {
  // A positive integer: a leading zero when the high bit is set.
  return tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [TRUE] : []), octets(value));
}

function ipBytes(address: string): Buffer {
  if (isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
  const halves = address.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  return Buffer.concat(groups.map((group) => Buffer.from(group.padStart(4, "0"), "hex")));
}

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function pem(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * A random positive serial in minimal DER: a zero first byte would make the
 * encoding non-minimal (or the value shorter), which BoringSSL rejects as
 * INVALID_INTEGER — about one certificate in 256 failed before this.
 */
function serialNumber(): Buffer {
  const serial = randomBytes(12);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  return serial;
}

function certificate(options: { subject: string; issuer: string; publicKey: KeyObject; signer: KeyObject; extensions: Buffer[] }): string {
  const now = Date.now();
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    ECDSA_WITH_SHA256,
    name(options.issuer),
    sequence(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + 24 * 60 * 60 * 1000))),
    name(options.subject),
    options.publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, sequence(...options.extensions)),
  );
  const signature = sign("sha256", tbs, options.signer);
  return pem(sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))));
}

export interface TestServerCertificate {
  cert: string;
  key: string;
}

export interface TestAuthority {
  /** The authority's certificate, to trust. */
  caPem: string;
  /** A server certificate for these names and IP addresses, signed by the authority. */
  issue(names: readonly string[]): TestServerCertificate;
}

export function createTestAuthority(commonName = "Ave Test Root"): TestAuthority {
  const authority = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caPem = certificate({
    subject: commonName,
    issuer: commonName,
    publicKey: authority.publicKey,
    signer: authority.privateKey,
    extensions: [
      extension("2.5.29.19", true, sequence(TRUE)),
      // keyCertSign and cRLSign.
      extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x01, 0x06]))),
    ],
  });
  return {
    caPem,
    issue(names) {
      const server = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const alternatives = names.map((entry) => (isIP(entry) !== 0 ? tlv(0x87, ipBytes(entry)) : tlv(0x82, Buffer.from(entry, "ascii"))));
      const cert = certificate({
        subject: names[0] ?? "server",
        issuer: commonName,
        publicKey: server.publicKey,
        signer: authority.privateKey,
        extensions: [extension("2.5.29.17", false, sequence(...alternatives))],
      });
      return { cert, key: server.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    },
  };
}
