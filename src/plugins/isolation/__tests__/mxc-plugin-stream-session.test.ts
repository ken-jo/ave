import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { probePluginStreams } from "../../../../tools/mxc-probes/plugin-stream-session.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import { spawnManaged, getManagedChildProcessCount } from "../../../main/managed-child-processes.js";
import { buildSafeChildEnv } from "../../../tools/safe-env.js";
import type { OwnedMxcExtensionProcess } from "../../../permissions/mxc-extension-process.js";

describe("plugin acceptance fixture over portable process pipes", () => {
  for (const overflow of [false, true]) {
    it(overflow ? "rejects oversized native-fixture traffic" : "preserves handshake, subscriptions, slow output, identity and revocation", async () => {
      const directory = mkdtempSync(join(tmpdir(), "plugin-streams-"));
      const baseline = getManagedChildProcessCount();
      const child = spawnManaged(process.execPath, [await pluginChildEntryPath()], {
        env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }), stdio: ["pipe", "pipe", "pipe"],
      });
      const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ exitCode: code ?? 1, timedOut: false }));
      });
      const owned: OwnedMxcExtensionProcess = {
        id: child.pid!, stdin: child.stdin!, stdout: child.stdout as PassThrough, stderr: child.stderr as PassThrough,
        completion, diagnostics: { nodeVersion: process.version, nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" },
        dispose: async () => {
          child.stdout!.resume(); child.stderr!.resume();
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await completion;
        },
      };
      try {
        copyFileSync(new URL("../../../../tools/mxc-probes/plugin-stream-fixture.mjs", import.meta.url), join(directory, "plugin.mjs"));
        const result = await probePluginStreams(owned, directory, overflow);
        expect(result).toMatchObject({ passed: true, releases: 1, activeWatchers: 0 });
        expect(getManagedChildProcessCount()).toBe(baseline);
      } finally { await owned.dispose(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
