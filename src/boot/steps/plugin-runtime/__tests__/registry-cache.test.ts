import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createRegistryEntryCache } from "../registry-cache.js";

describe("plugin runtime registry-entry cache", () => {
  it("fails closed for pending replacements while retaining normal host-owned metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-entry-cache-"));
    try {
      const registryPath = join(dir, "registry.json");
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pending",
            manifestPath: "pending/plugin.json",
            installSource: "admin",
            manifestSha256: "a".repeat(64),
            pendingUpdate: {
              kind: "marketplace",
              previousManifestFileSha256: "b".repeat(64),
              previousReceiptRaw: null,
            },
          },
          {
            id: "ready",
            manifestPath: "ready/plugin.json",
            installSource: "admin",
            manifestSha256: "c".repeat(64),
          },
        ],
      }));
      const cache = createRegistryEntryCache({ registryPath, log: { warn: vi.fn() } });

      await cache.refreshRegistryEntryCache();

      expect(cache.getRegistryEntry("pending")).toBeUndefined();
      expect(cache.getRegistryEntry("ready")).toEqual({
        installSource: "admin",
        manifestSha256: "c".repeat(64),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-reads the registry when another writer changed it, and only then", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-entry-cache-"));
    try {
      const registryPath = join(dir, "registry.json");
      const origin = (sourceId: string) => ({
        sourceId,
        sourceOrigin: "official",
        commit: "c".repeat(40),
        packagePath: "plugins/meeting",
        version: "1.0.0",
        rung: "legacy",
        artifactSha256: null,
        installedAt: "2026-09-24T00:00:00.000Z",
      });
      const write = (sourceId: string | null) =>
        writeFile(registryPath, JSON.stringify({
          version: 1,
          plugins: [{ id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user", ...(sourceId ? { origin: origin(sourceId) } : {}) }],
        }));
      await write(null);
      const cache = createRegistryEntryCache({ registryPath, log: { warn: vi.fn() } });
      await cache.refreshRegistryEntryCache();
      expect(cache.getRegistryEntry("meeting")?.origin).toBeUndefined();

      // The §16.3 migration binds the entry without an install event.
      const pinned = new Date("2026-09-24T00:00:00.000Z");
      await write("ave");
      await utimes(registryPath, pinned, pinned);
      await cache.refreshRegistryEntryCacheIfChanged();
      expect(cache.getRegistryEntry("meeting")?.origin?.sourceId).toBe("ave");

      // Same identity (inode, size, mtime): the cache is not read again.
      await write("lviz");
      await utimes(registryPath, pinned, pinned);
      await cache.refreshRegistryEntryCacheIfChanged();
      expect(cache.getRegistryEntry("meeting")?.origin?.sourceId).toBe("ave");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
