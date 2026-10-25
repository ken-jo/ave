/** HMAC hides guessable dedupe keys; raw keys must never leave the raise call. */
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { isRecord } from "../shared/is-record.js";
import { readJsonFileOrEmpty, writeJsonAtomic } from "../main/storage/feature-namespace.js";

const SECRET_FILE = "install-secret.json";
const SECRET_BYTES = 32;
const ALERT_ID_LENGTH = 32;

/** A damaged install secret is replaced, changing identities on the next raise. */
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
