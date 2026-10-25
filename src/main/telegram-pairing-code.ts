// Minting and redemption share one digest derivation. Pairing codes must not start with slash: ingress refuses all slash commands.
import { createHash, randomBytes } from "node:crypto";
import { TELEGRAM_PAIRING_CODE } from "../shared/telegram-connection.js";

const CODE_PREFIX = "ave-tg-v1.";
const CODE_ENTROPY_BYTES = 32;
const DIGEST_DOMAIN = "ave/telegram-bridge/pairing-code/v1\0";

// Mint one single-use pairing code. The caller persists only its digest.
export function mintTelegramPairingCode(): string {
  const code = CODE_PREFIX + randomBytes(CODE_ENTROPY_BYTES).toString("base64url");
  if (!TELEGRAM_PAIRING_CODE.test(code)) {
    throw new Error("telegram-pairing-code-generation-invalid");
  }
  return code;
}

// Digest a candidate for constant-time comparison in the durable store. Anything that is not a well-formed code returns `null` rather than a digest of
// arbitrary user text, so an ordinary message can never consume a pairing attempt or reach the comparison at all.
export function telegramPairingCodeDigest(candidate: string): string | null {
  if (typeof candidate !== "string" || !TELEGRAM_PAIRING_CODE.test(candidate)) return null;
  return createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update(candidate, "utf8")
    .digest("hex");
}

// Whether a message looks like a pairing code at all. The ingress consumes and drops every match, correct or not, so that a near-miss credential never
// lands in the conversation transcript.
export function looksLikeTelegramPairingCode(text: string): boolean {
  return typeof text === "string" && TELEGRAM_PAIRING_CODE.test(text.trim());
}
