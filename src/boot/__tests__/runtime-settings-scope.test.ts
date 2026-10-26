import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBootHost } from "../node-host-runtime.js";
import type { BootHost } from "../host-runtime.js";
import { settingsFilePath } from "../../data/settings-store.js";
import { ensureFileAccess } from "../../tools/file-access-policy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";

const runtime = vi.hoisted(() => ({ closeFailed: false }));
vi.mock("../../data/node-secret-encryption.js", () => ({ createNodeSecretEncryption: () => unavailableSecretEncryption }));
vi.mock("../../main/corp-ca-runtime.js", () => ({ ensureCorporateCaInjected: async () => {} }));
vi.mock("undici", async (original) => ({
  ...await original<typeof import("undici")>(),
  EnvHttpProxyAgent: class {
    compose() { return this; }
    async destroy() { if (runtime.closeFailed) throw new Error("Dispatcher close failed"); }
  },
  setGlobalDispatcher: () => {},
}));

let directory: string;
const hosts: BootHost[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "runtime-settings-scope-")); });
afterEach(async () => {
  runtime.closeFailed = false;
  for (const host of hosts.splice(0)) await host.close();
  await cleanupTmpDir(directory);
});

describe("host-owned settings write protection", () => {
  it("releases protection even when host teardown fails", async () => {
    const host = await createNodeBootHost({ userDataPath: join(directory, "profile"), resourcePath: directory, isPackaged: false });
    hosts.push(host);
    runtime.closeFailed = true;
    await expect(host.close()).rejects.toThrow("Dispatcher close failed");
    expect(ensureFileAccess(settingsFilePath(host.userDataPath),
      { cwd: directory, extraAllowedDirectories: [], metadata: {} }, "write")).toBeNull();
  });
  it("protects overlapping live hosts until the final owner closes", async () => {
    const userDataPath = join(directory, "profile");
    const context = { cwd: directory, extraAllowedDirectories: [], metadata: {} };
    const settingsPath = settingsFilePath(userDataPath);
    const options = { userDataPath, resourcePath: directory, isPackaged: false };
    const first = await createNodeBootHost(options);
    hosts.push(first);
    const second = await createNodeBootHost(options);
    hosts.push(second);
    expect(ensureFileAccess(settingsPath, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(userDataPath, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(directory, context, "write")).toBeNull();
    await first.close();
    await first.close();
    expect(ensureFileAccess(settingsPath, context, "write")).toMatchObject({ isError: true });
    await second.close();
    expect(ensureFileAccess(settingsPath, context, "write")).toBeNull();
    expect(ensureFileAccess(userDataPath, context, "write")).toBeNull();
  });
});
