/** Scan IPC handlers and forwarded result contracts so every returned error code has a localized renderer message. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMON_IPC_ERROR_MESSAGES,
  formatIpcError,
  resolveIpcErrorKey,
} from "../format-ipc-error.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const IPC_DOMAIN_DIR = resolve(__dirname, "../../../ipc/domains");
const ALERT_SERVICE_DIR = resolve(__dirname, "../../../alerts");
const ALERT_RESULT_CONTRACT = resolve(__dirname, "../../../shared/alerts-types.ts");
// A card's rule save returns its refusals through the record handler unchanged, built by helpers rather than inline `{ ok: false }` literals.
const APPROVAL_RULE_SAVE = resolve(__dirname, "../../../permissions/approval-rule-save.ts");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue; // test fixtures may quote codes
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function extractErrorCodes(source: string): Set<string> {
  // Match literal error codes across as-const and intermediate fields; dynamic template errors remain caller-handled.
  const codes = new Set<string>();
  const re = /\{\s*ok:\s*false\b[^}]*?\berror:\s*"([a-zA-Z][a-zA-Z0-9_-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    codes.add(m[1]);
  }
  return codes;
}

/** The codes a result helper returns: `fail("code", ...)` and a refusal helper's `return "code"`. */
function extractHelperErrorCodes(source: string): Set<string> {
  const codes = new Set<string>();
  for (const m of source.matchAll(/\bfail\(\s*"([a-zA-Z][a-zA-Z0-9_-]+)"/g)) codes.add(m[1]!);
  for (const m of source.matchAll(/\breturn\s+"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g)) codes.add(m[1]!);
  for (const m of source.matchAll(/\?\s*undefined\s*:\s*"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g)) codes.add(m[1]!);
  return codes;
}

/** Also scan declared error unions: handlers returning computed denial codes have no inline error literal to extract. */
function extractDeclaredErrorUnionCodes(source: string): Set<string> {
  const codes = new Set<string>();
  const union = /\berror\??:\s*((?:"[a-zA-Z][a-zA-Z0-9_-]+"\s*\|\s*)+"[a-zA-Z][a-zA-Z0-9_-]+")/g;
  let m: RegExpExecArray | null;
  while ((m = union.exec(source)) !== null) {
    for (const member of m[1].matchAll(/"([^"]+)"/g)) codes.add(member[1]);
  }
  return codes;
}

describe("formatIpcError — full IPC error code coverage", () => {
  it.each([
    { surface: "IPC handlers", files: listTsFiles(IPC_DOMAIN_DIR) },
    { surface: "alert service results", files: listTsFiles(ALERT_SERVICE_DIR) },
    { surface: "shared alert results", files: [ALERT_RESULT_CONTRACT] },
    { surface: "approval card rule saves", files: [APPROVAL_RULE_SAVE] },
  ])("every error code from $surface has a Korean mapping", ({ surface, files }) => {
    expect(files.length).toBeGreaterThan(0);

    const allCodes = new Set<string>();
    const unionCodes = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const code of extractErrorCodes(src)) allCodes.add(code);
      if (surface === "approval card rule saves") for (const code of extractHelperErrorCodes(src)) allCodes.add(code);
      for (const code of extractDeclaredErrorUnionCodes(src)) {
        allCodes.add(code);
        unionCodes.add(code);
      }
    }

    // Non-vacuity floor for the union extractor specifically: if its regex ever stops matching, the codes it is here to catch
    // would silently drop out of `allCodes` and this suite would go green while the leak returned.
    if (surface === "IPC handlers") {
      expect(
        unionCodes.size,
        "declared-error-union regex captured zero codes — the blind spot it closes is back",
      ).toBeGreaterThan(5);
      for (const code of ["path-not-allowed", "sensitive-path"]) {
        expect(unionCodes.has(code), `"${code}" is no longer discovered by the union extractor`).toBe(true);
      }
    } else if (surface === "approval card rule saves") {
      for (const code of ["invalid-rule", "rule-does-not-match", "rule-required", "scope-not-offered", "one-shot-not-recordable", "rule-save-failed", "missing-session"]) {
        expect(allCodes.has(code), `"${code}" is no longer discovered in approval-rule-save.ts`).toBe(true);
      }
    } else {
      // Each source must independently discover the failure that can reach the renderer through an unchanged service result,
      // without a handler literal.
      expect(allCodes.has("kind-not-registered")).toBe(true);
      if (surface === "shared alert results") expect(unionCodes.has("kind-not-registered")).toBe(true);
    }

    const missing = [...allCodes]
      .filter((code) => !(code in COMMON_IPC_ERROR_MESSAGES))
      .sort();

    if (missing.length > 0) {
      throw new Error(
        `Unmapped IPC error codes (add to COMMON_IPC_ERROR_MESSAGES in src/ui/renderer/format-ipc-error.ts):\n  ${missing.join("\n  ")}`,
      );
    }

    // Sanity floor — guards against future regex regression that silently matches zero codes (and would otherwise pass with
    // empty `allCodes`). Skeptic Multi-Perspective from round-2 critic.
    expect(allCodes.size, "error-code discovery must not be empty").toBeGreaterThan(surface === "IPC handlers" ? 50 : 0);
  });

  it("every common IPC error code resolves to a non-empty localized message", () => {
    // After the i18n migration, COMMON_IPC_ERROR_MESSAGES maps each code to a
    // translation KEY; formatIpcError resolves it through t(). This suite runs
    // under the Korean test locale (see vitest-ambient-intl setup), so every code
    // must resolve to a non-empty Korean message — the same invariant the old
    // "values are Korean" assertion enforced, now through the translation layer.
    for (const code of Object.keys(COMMON_IPC_ERROR_MESSAGES)) {
      const message = formatIpcError(code, undefined);
      expect(message.length, `code "${code}" has empty message`).toBeGreaterThan(0);
      // Korean range: U+AC00–U+D7A3 (Hangul syllables). A resolved message lacking Hangul means the key is missing from the
      // Korean catalog and fell through to the raw key/English.
      expect(
        /[가-힣]/.test(message),
        `code "${code}" did not resolve to a Korean message: "${message}"`,
      ).toBe(true);
    }
  });
});

describe("resolveIpcErrorKey — own-property lookup", () => {
  // The table is a plain object literal, and callers now pass an arbitrary
  // `Error.message` as the code (a rejected `invoke` carries its code there). A bare
  // index resolved `toString` to `Object.prototype.toString` — truthy, and handed to
  // `t()` as a FUNCTION. This guards the guard, not the symptom.
  it("does not resolve prototype members as error codes", () => {
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(resolveIpcErrorKey(name)).toBeUndefined();
      // …and the formatter falls through to its message/unknown handling instead of rendering whatever the prototype held.
      expect(typeof formatIpcError(name, undefined)).toBe("string");
    }
  });

  it("resolves a real code and ignores an empty one", () => {
    expect(resolveIpcErrorKey("rate-limited")).toBe(COMMON_IPC_ERROR_MESSAGES["rate-limited"]);
    expect(resolveIpcErrorKey("")).toBeUndefined();
    expect(resolveIpcErrorKey(undefined)).toBeUndefined();
    expect(resolveIpcErrorKey("no-such-code-here")).toBeUndefined();
  });
});
