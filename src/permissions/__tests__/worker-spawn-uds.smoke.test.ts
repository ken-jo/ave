// Native worker isolation must preserve inbound UDS health, declared-only egress, private socket modes and the write jail. Skip when the native backend is unavailable.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { writeFileSync, mkdtempSync, statSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  isAsrtSandboxActive,
  initializeAsrtSandbox,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";
import { spawnWorker, type SpawnedWorker } from "../worker-spawn.js";
import {
  __resetSandboxRequestedAtBootForTest,
  __resetWrappedPluginWorkersForTest,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../sandbox-capability.js";
import { asrtCanInitialize } from "./test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// GET over a UDS from the HOST (outside the sandbox).
function udsGet(
  socketPath: string,
  path: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "GET", timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("uds request timeout")));
    req.end();
  });
}

// Poll the UDS until /health answers (the worker may take a beat to bind).
async function waitForHealth(socketPath: string, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await udsGet(socketPath, "/health");
      if (r.status === 200) return true;
    } catch {
      // not bound yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// The fake HTTP worker, written verbatim to a temp file and spawned through spawnWorker. Binds the UDS at `--uds <path>` (0o600) and serves: - /health → 200 {"ok":true} - /echo?msg=… → 200 {"echo":"…"} - /egress?url=… → 200 {"status":N} on success, {"error":"…"} on denial - /fswrite?path=… → 200 {"wrote":true} | {"error":"…"} (jail probe)
const WORKER_SOURCE = `
const http = require("node:http");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const args = process.argv.slice(2);
const udsIdx = args.indexOf("--uds");
const sock = udsIdx >= 0 ? args[udsIdx + 1] : null;
if (!sock) { console.error("no --uds"); process.exit(2); }
// Egress probe uses curl so it picks up the proxy ASRT bakes into the wrapped
// command on mac/linux (the same egress path asrt-sandbox.test.ts proves);
// node's undici fetch does not inherit that proxy in a plain child.
function curlCode(url, cb) {
  execFile("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", url],
    { timeout: 12000 }, (err, stdout) => cb(err ? null : (stdout || "").trim()));
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === "/health") return send(200, { ok: true });
  if (u.pathname === "/echo") return send(200, { echo: u.searchParams.get("msg") });
  if (u.pathname === "/egress") {
    return curlCode(u.searchParams.get("url"), (code) => {
      if (code && /^[23]\\d\\d$/.test(code)) return send(200, { httpCode: code });
      return send(200, { denied: true, httpCode: code });
    });
  }
  if (u.pathname === "/fswrite") {
    try { fs.writeFileSync(u.searchParams.get("path"), "x"); return send(200, { wrote: true }); }
    catch (e) { return send(200, { error: String(e && e.code || e.message || e) }); }
  }
  send(404, { notFound: true });
});
server.listen(sock, () => {
  try { fs.chmodSync(sock, 0o600); } catch {}
  console.log("worker listening on " + sock);
});
`;

let tmpRoot: string | undefined;
let worker: SpawnedWorker | undefined;

// A worker is wrapped only while plugin-worker confinement was requested at boot.
beforeEach(() => setPluginWorkerConfinementRequestedAtBoot(true));

afterEach(async () => {
  try {
    __resetSandboxRequestedAtBootForTest();
    worker?.stop();
    worker = undefined;
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    __resetWrappedPluginWorkersForTest();
  } finally {
    vi.unstubAllEnvs();
    if (tmpRoot) await cleanupTmpDir(tmpRoot);
    tmpRoot = undefined;
  }
});

// The UDS control channel and the Seatbelt write-jail are the macOS worker path; other platforms confine workers differently and are covered elsewhere.
describe.runIf(process.platform === "darwin")("worker-spawn UDS smoke (macOS, real ASRT)", () => {
  it("host drives the wrapped worker over the UDS; egress allow/deny enforced; perms correct", async (test) => {
    if (!(await asrtCanInitialize())) {
      // A confinement job asks for real sandbox cases; there a missing sandbox is a failure, not a skip.
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return test.skip("ASRT cannot initialize (sandbox dependencies missing)");
    }

    // Keep the complete plugin socket path within the Unix socket limit.
    const temporaryBase = process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp";
    tmpRoot = mkdtempSync(join(temporaryBase, "ave-uds-"));
    vi.stubEnv("AVE_HOME", tmpRoot);
    const workerFile = join(tmpRoot, "worker.cjs");
    writeFileSync(workerFile, WORKER_SOURCE, "utf8");
    // GENUINELY outside the write-jail (jail = [socketDir, tmpRoot]). A path in HOME is covered by neither, so the seatbelt write-deny must reject it.
    const outsideJail = join(homedir(), `.uds-smoke-denied-${process.pid}-${Date.now()}.txt`);

    // Shared config: example.com is in the union (allow), example.org is NOT (hard-deny). strictAllowlist → no askCb fallthrough.
    await initializeAsrtSandbox(
      { allowedDomains: ["example.com"], strictAllowlist: true },
      undefined,
    );

    // Spawn the worker WRAPPED. allowWritePaths includes the temp worker dir so the node worker can read its own script + the host injects the UDS path. RunAsNode makes process.execPath the Electron binary; the wrapper retains its host Node path so this smoke still exercises a standalone Node worker.
    const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    worker = await spawnWorker({
      pluginId: "uds-smoke-plugin",
      workerId: "uds-smoke-worker",
      command: nodeCommand,
      args: [workerFile],
      allowWritePaths: [tmpRoot],
      udsArgName: "--uds",
    });

    const socketPath = worker.socketPath;
    console.log(`[uds-smoke] socketPath=${socketPath} pid=${worker.pid}`);
    expect(socketPath).not.toBeNull();
    if (socketPath === null) return;

    // Surface worker stderr for diagnosis if anything goes wrong.
    worker.onStderr((c) => console.log(`[uds-smoke][worker-stderr] ${c.trim()}`));

    const healthy = await waitForHealth(socketPath);
    console.log(`[uds-smoke] /health reachable over UDS = ${healthy}`);
    expect(healthy).toBe(true);

    const echo = await udsGet(socketPath, "/echo?msg=hello");
    console.log(`[uds-smoke] /echo status=${echo.status} body=${echo.body}`);
    expect(echo.status).toBe(200);
    expect(echo.body).toContain("hello");

    const socketMode = statSync(socketPath).mode & 0o777;
    const dirMode = statSync(join(socketPath, "..")).mode & 0o777;
    console.log(`[uds-smoke] socket mode=0o${socketMode.toString(8)} dir mode=0o${dirMode.toString(8)}`);
    expect(socketMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    // 2) Egress from INSIDE the wrapped worker: allow-listed succeeds, the non-allowed host is hard-denied. The in-union host must be reachable for the deny side to be a meaningful contrast — if offline, skip the egress asserts but keep the UDS + perms proof.
    const allowRes = await udsGet(socketPath, "/egress?url=" + encodeURIComponent("https://example.com"));
    const denyRes = await udsGet(socketPath, "/egress?url=" + encodeURIComponent("https://example.org"));
    console.log(`[uds-smoke] egress ALLOW(example.com)=${allowRes.body}`);
    console.log(`[uds-smoke] egress DENY(example.org)=${denyRes.body}`);
    const allowParsed = JSON.parse(allowRes.body) as { httpCode?: string; denied?: boolean };
    const denyParsed = JSON.parse(denyRes.body) as { httpCode?: string; denied?: boolean };
    const allowOk = !allowParsed.denied && /^[23]\d\d$/.test(allowParsed.httpCode ?? "");
    if (allowOk) {
      // Online + allow side proven → the deny side MUST be hard-denied (the ASRT egress proxy returns no 2xx/3xx for an out-of-union host under strict).
      console.log(`[uds-smoke] egress contrast proven: allow=${allowParsed.httpCode} deny=${JSON.stringify(denyParsed)}`);
      expect(denyParsed.denied).toBe(true);
    } else {
      console.log("[uds-smoke] egress allow side not reachable (offline) — egress contrast skipped");
    }

    const fsRes = await udsGet(socketPath, "/fswrite?path=" + encodeURIComponent(outsideJail));
    console.log(`[uds-smoke] fswrite OUTSIDE jail = ${fsRes.body}`);
    const fsParsed = JSON.parse(fsRes.body) as { wrote?: boolean; error?: string };
    expect(fsParsed.wrote).not.toBe(true);
    expect(existsSync(outsideJail)).toBe(false);
  }, 90_000);
});
