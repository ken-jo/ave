/** Drive the strict assignment scrubber with seeded grammar noise; verify invariants, repeat scrubbing, and credential removal. */
import { describe, expect, it } from "vitest";
import { scrubDiagnosticSecretsStrict } from "../../shared/dlp.js";

const CASES_PER_SEED = 10_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  '"', '"', '"', "'", "'", "\\", '\\"', "\\'", "\\\\", ":", ":", "=", "=", " ", " ", "\t", "\n", "\r\n", "\r",
  "token", "password", "auth", "api_key", "a", "x", "label", "[REDACTED:X]", "[REDACTED:TOKEN]", "--", "-",
  "{", "}", ",", "\\u0074", "\\uZZ", "@", "https://", "u:p@", "Bearer ", "\\n",
  '\\"', '\\"', '\\\\\\"', "\\\\", "[REDACTED:TOKEN]x", "\\\n",
];
const CANARY = "QZcanaryQZ";
const KEYS = ["token", "password", "api_key", "GH_TOKEN", "x-auth", "client_secret", "db.password"];
const SEPARATORS = [" ", "\n", " ; ", "\n\n", ", "];

function generator(seed: number) {
  const next = random(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const noise = (max: number): string => {
    let text = "";
    for (let i = Math.floor(next() * max); i > 0; i--) text += pick(ATOMS);
    return text;
  };
  const planted = (): string => {
    const key = pick(KEYS);
    switch (Math.floor(next() * 17)) {
      case 13: return `Authorization: Basic ${CANARY}`;
      case 14: return `authorization="Bearer ${CANARY}"`;
      case 15: return `Authorization=Token ${CANARY}`;
      case 16: return `Authorization: Digest username="u", response="${CANARY}"`;
      case 9: return `\\"${key}\\": \\"${CANARY}\\"`;
      case 10: return `{\\"${key}\\":\\"${CANARY}\\"}`;
      case 11: return `"{\\"${key}\\": \\"${CANARY}\\"}"`;
      case 12: return `{"body":"{\\"${key}\\":\\"${CANARY}\\"}"}`;
      case 0: return `"${key}": "${CANARY}"`;
      case 1: return `"${key}":"${CANARY}"`;
      case 2: return `'${key}': '${CANARY}'`;
      case 3: return `${key}=${CANARY}`;
      case 4: return `${key}: ${CANARY}`;
      case 5: return `"${key}"\n: "${CANARY}"`;
      case 6: return `--${key} ${CANARY}`;
      case 7: return `https://u:${CANARY}@host/r`;
      default: return `${key}="${CANARY}"`;
    }
  };
  // Keep canaries on separate lines so noise cannot absorb them legitimately.
  return { noise: () => noise(40), planted: () => `${noise(20)}\n${pick(SEPARATORS)}${planted()}${pick(SEPARATORS)}\n${noise(20)}` };
}

describe("scrubDiagnosticSecrets property (seeded grammar noise)", () => {
  it.each([1, 2])("holds every property for seed %i", (seed) => {
    const cases = generator(seed);
    for (let n = 0; n < CASES_PER_SEED; n++) {
      const raw = cases.noise();
      let once: string;
      try {
        once = scrubDiagnosticSecretsStrict(raw);
      } catch (error) {
        throw new Error(`seed ${seed} case ${n}: the scan broke its invariant on ${JSON.stringify(raw)}: ${String(error)}`);
      }
      try {
        scrubDiagnosticSecretsStrict(once);
      } catch (error) {
        throw new Error(`seed ${seed} case ${n}: scrubbing ${JSON.stringify(once)} again threw: ${String(error)}`);
      }
      const text = cases.planted();
      const scrubbed = scrubDiagnosticSecretsStrict(text);
      expect(scrubbed.includes(CANARY), `seed ${seed} case ${n}: ${JSON.stringify(text)} kept the canary`).toBe(false);
    }
  });
});
