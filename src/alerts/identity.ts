/**
 * The identity an alert is known by everywhere past the raise.
 *
 * A plugin's dedupe key can be guessable — a subject and a sender — and a
 * plain hash of a guessable key is reversible by trying candidates. The
 * alert id is instead an HMAC under a secret this install creates once, so
 * the card, the audit log, bus events and `open.json` carry an id that names
 * the alert without revealing its key. The raw key never leaves the call.
 */
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { isRecord } from "../shared/is-record.js";
import { readJsonFileOrEmpty, writeJsonAtomic } from "../main/storage/feature-namespace.js";

const SECRET_FILE = "install-secret.json";
const SECRET_BYTES = 32;
/** Characters of the base64url digest kept: 192 bits. */
const ALERT_ID_LENGTH = 32;

/**
 * The install secret, created on first use. A damaged file is moved aside by
 * the reader and a new secret is made: identities then change once, which
 * reopens nothing the user closed only if the plugin raises it again.
 */
export async function loadInstallSecret(dir: string): Promise<Buffer> {
  const stored = await readJsonFileOrEmpty<Buffer | null>(
    join(dir, SECRET_FILE),
    () => null,
    (parsed) => {
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.secret !== "string") return null;
      const secret = Buffer.from(parsed.secret, "base64url");
      return secret.length === SECRET_BYTES ? secret : null;
    },
  );
  if (stored) return stored;
  const secret = randomBytes(SECRET_BYTES);
  await writeJsonAtomic(dir, SECRET_FILE, { version: 1, secret: secret.toString("base64url") });
  return secret;
}

/** `base64url(HMAC-SHA256(secret, pluginId \0 kind \0 key))`, cut to 32 characters. */
export function alertIdFor(secret: Buffer, pluginId: string, kindId: string, key: string): string {
  return createHmac("sha256", secret)
    .update(`${pluginId}\0${kindId}\0${key}`)
    .digest("base64url")
    .slice(0, ALERT_ID_LENGTH);
}
