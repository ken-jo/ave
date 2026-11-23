import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../../lib/shell-resolver.js";
import { _closeProcessGroupReaperPipeForTest, __resetManagedChildProcessesForTest } from "../../../main/managed-child-processes.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } from "../../../permissions/sandbox-capability.js";
import { aveHome, ensureAveHomePrivate } from "../../../shared/ave-home.js";
import { resolvePluginSocketDir } from "../../plugin-storage-layout.js";
import { type ConfinedPluginChild, derivePluginChildEnvelope, spawnConfinedPluginChild } from "../out-of-process-plugin.js";

const HEARTBEAT = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [role, outsidePath] = process.argv.slice(2);
const path = (name) => join(process.env.PLUGIN_DATA, name);
function child(nextRole, detached) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), nextRole, outsidePath], { detached, stdio: "ignore" });
}

function requestThroughProxy() {
  const proxy = new URL(process.env.HTTP_PROXY);
  return new Promise((resolve) => {
    const req = request({
      hostname: proxy.hostname, port: proxy.port, path: "http://example.invalid/",
      headers: { Host: "example.invalid", "Proxy-Authorization": "Basic " + Buffer.from(
        decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password),
      ).toString("base64") },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(1000, () => req.destroy());
    req.on("error", (error) => resolve(error.code));
    req.end();
  });
}

if (role === "leader") {
  process.stdin.on("end", () => writeFileSync(path("stdin-eof"), ""));
  process.stdin.resume();
  child("same-group", false);
} else if (role === "same-group") {
  child("new-session", true);
} else {
  writeFileSync(path("new-session-pid"), String(process.pid));
  if (process.platform === "darwin") {
    writeFileSync(path("proxy-before"), String(await requestThroughProxy()));
    const probe = setInterval(async () => {
      if (!existsSync(path("probe-after"))) return;
      clearInterval(probe);
      let write = "succeeded";
      try { writeFileSync(outsidePath, "changed"); } catch (error) { write = error.code; }
      writeFileSync(path("probe-result"), JSON.stringify({ write, proxy: await requestThroughProxy() }));
    }, 50);
  }
}

setInterval(() => appendFileSync(path(role), "."), 50);
setTimeout(() => process.exit(1), 15_000);
`;

const ROLES = ["leader", "same-group", "new-session"] as const;
const PLUGIN_ID = "heartbeat";

describe.runIf(process.platform === "linux" || process.platform === "darwin")("process plugin host death", () => {
  it("reaps the confined group on host EOF and measures the new session", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-plugin-heartbeat-")));
    const pluginRoot = join(aveHome(), "plugins", PLUGIN_ID);
    const pluginDataDir = join(pluginRoot, "data");
    const path = (name: string): string => join(pluginDataDir, name);
    const outsidePath = join(root, "host-owned");
    const mac = process.platform === "darwin";
    let child: ConfinedPluginChild | undefined;
    const heartbeat = (name: string): number => statSync(path(name), { throwIfNoEntry: false })?.size ?? 0;
    try {
      expect(ensureAveHomePrivate(aveHome()).enforcement).not.toBe("none");
      mkdirSync(pluginDataDir, { recursive: true });
      writeFileSync(outsidePath, "original");
      const script = join(pluginRoot, "heartbeat.mjs");
      const launcher = join(pluginRoot, "launch");
      const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
      writeFileSync(script, HEARTBEAT);
      writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} leader ${shellQuote(outsidePath)}\n`);
      chmodSync(launcher, 0o700);
      setPluginWorkerConfinementRequestedAtBoot(true);
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      child = await spawnConfinedPluginChild({
        pluginId: PLUGIN_ID,
        socketDir: resolvePluginSocketDir(pluginDataDir),
        envelope: derivePluginChildEnvelope({ pluginId: PLUGIN_ID, pluginRoot, pluginDataDir, configValue: () => undefined }),
        launch: { kind: "process", command: launcher, args: [], env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: pluginDataDir } },
      });
      expect(child.confinement).toBe(mac ? "macos-sandbox" : "linux-bubblewrap");
      await vi.waitFor(() => {
        for (const role of ROLES) expect(heartbeat(role), role).toBeGreaterThan(1);
      }, { timeout: 2_000 });
      if (mac) expect(readFileSync(path("proxy-before"), "utf8")).toBe("403");

      child.link.output.end();
      await vi.waitFor(() => expect(existsSync(path("stdin-eof"))).toBe(true), { timeout: 2_000 });
      const beforeClose = ROLES.map(heartbeat);
      await vi.waitFor(() => {
        ROLES.forEach((role, index) => expect(heartbeat(role), role).toBeGreaterThan(beforeClose[index]!));
      }, { timeout: 2_000 });

      const reaped = mac ? ROLES.slice(0, 2) : ROLES;
      let last = reaped.map(heartbeat);
      let lastChangeAt = performance.now();
      let leaderExited = false;
      void child.waitForExit?.().then(() => { leaderExited = true; });
      _closeProcessGroupReaperPipeForTest();
      await vi.waitFor(() => {
        const current = reaped.map(heartbeat);
        if (current.some((count, index) => count !== last[index])) lastChangeAt = performance.now();
        last = current;
        expect(leaderExited).toBe(true);
        expect(performance.now() - lastChangeAt).toBeGreaterThanOrEqual(300);
      }, { timeout: 2_000, interval: 50 });
      await delay(100);
      expect(reaped.map(heartbeat)).toEqual(last);
      if (!mac) return;

      // The host owns the proxy listeners. Close them as host exit would, then exercise the surviving child.
      await resetAsrtSandbox();
      const surviving = heartbeat("new-session");
      writeFileSync(path("probe-after"), "");
      await vi.waitFor(() => {
        expect(heartbeat("new-session")).toBeGreaterThan(surviving);
        const result = JSON.parse(readFileSync(path("probe-result"), "utf8")) as { write: string; proxy: string };
        expect(result.write).toMatch(/^(EPERM|EACCES)$/);
        expect(result.proxy).toBe("ECONNREFUSED");
      }, { timeout: 2_000 });
      expect(readFileSync(outsidePath, "utf8")).toBe("original");
      expect(reaped.map(heartbeat)).toEqual(last);
    } finally {
      if (mac && existsSync(path("new-session-pid"))) {
        const pid = Number(readFileSync(path("new-session-pid"), "utf8"));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      if (child?.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await child.waitForExit?.();
      }
      __resetManagedChildProcessesForTest();
      await resetAsrtSandbox();
      __resetSandboxRequestedAtBootForTest();
      await cleanupTmpDir(root);
    }
  });
});
