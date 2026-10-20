import { describe, expect, it } from "vitest";
import { fileIdentityKey, sameFileIdentity, type FileIdentity } from "../file-identity.js";

describe("exact file identity", () => {
  const original = { dev: 7n, ino: 2n ** 60n };

  it("refuses adjacent identifiers beyond numeric precision", () => {
    const replaced = { ...original, ino: original.ino + 1n };
    expect(Number(original.ino)).toBe(Number(replaced.ino));
    expect(sameFileIdentity(original, replaced)).toBe(false);
    expect(fileIdentityKey(original)).not.toBe(fileIdentityKey(replaced));
  });

  it("accepts equal exact identifiers", () => {
    expect(sameFileIdentity(original, { ...original })).toBe(true);
    expect(fileIdentityKey(original)).toBe("7:1152921504606846976");
  });

  it("refuses identifiers on different devices", () => {
    expect(sameFileIdentity(original, { ...original, dev: 8n })).toBe(false);
    expect(fileIdentityKey(original)).not.toBe(fileIdentityKey({ ...original, dev: 8n }));
  });

  it("never treats legacy numeric identifiers as exact", () => {
    const legacy = { dev: 7, ino: Number(original.ino) } as unknown as FileIdentity;
    expect(sameFileIdentity(legacy, legacy)).toBe(false);
    expect(sameFileIdentity(original, legacy)).toBe(false);
    expect(() => fileIdentityKey(legacy)).toThrow("bigint identifiers");
  });
});
