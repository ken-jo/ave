import { afterEach, describe, expect, it, vi } from "vitest";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => { throw new Error("deprecated sync safeStorage method called"); }),
  encryptString: vi.fn(() => { throw new Error("deprecated sync safeStorage method called"); }),
  decryptString: vi.fn(() => { throw new Error("deprecated sync safeStorage method called"); }),
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
  decryptStringAsync: vi.fn(async (value: Buffer) => ({ shouldReEncrypt: false, result: value.toString() })),
  getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
}));
vi.mock("electron", () => ({ safeStorage }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("desktop encryption capability", () => {
  it("does not call the Linux-only backend API on macOS or Windows", async () => {
    for (const platform of ["darwin", "win32"]) {
      vi.stubGlobal("process", { ...process, platform });
      const { desktopSecretEncryption } = await import("../desktop-secret-encryption.js");
      expect(desktopSecretEncryption.getSelectedStorageBackend()).toBe("unknown");
      expect(safeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
    }
  });

  it("uses only the async safeStorage API and forwards shouldReEncrypt", async () => {
    const { desktopSecretEncryption } = await import("../desktop-secret-encryption.js");
    await expect(desktopSecretEncryption.isAsyncEncryptionAvailable()).resolves.toBe(true);
    const ciphertext = await desktopSecretEncryption.encryptStringAsync("fixture");
    await expect(desktopSecretEncryption.decryptStringAsync(ciphertext))
      .resolves.toEqual({ shouldReEncrypt: false, result: "fixture" });
    safeStorage.decryptStringAsync.mockResolvedValueOnce({ shouldReEncrypt: true, result: "rotated" });
    await expect(desktopSecretEncryption.decryptStringAsync(ciphertext))
      .resolves.toEqual({ shouldReEncrypt: true, result: "rotated" });
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });
});
