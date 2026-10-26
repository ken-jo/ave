import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStdioSpawnCommand } from "../mcp/mcp-client.js";
import { configureHostResources, type HostResources } from "./host-resources.js";
import { resolveBundledUvBinaryPath } from "./uv-runtime.js";

// Exercise the same packaged resource resolvers without starting host services.
export function probeHostRuntimeResources(resources: HostResources) {
  configureHostResources(resources);
  const uvRuntimeDir = mkdtempSync(join(tmpdir(), "ave-runtime-check-"));
  try {
    const executable = resolveBundledUvBinaryPath({ uvRuntimeDir });
    const version = execFileSync(executable, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 10_000 }).trim();
    const uvx = resolveStdioSpawnCommand("uvx", ["--help"], { uvRuntimeDir });
    execFileSync(uvx.command, uvx.args, { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    return {
      uv: { executable, version, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") },
      uvx: { executable: uvx.command, args: uvx.args, ok: true },
      temporaryCacheRemoved: true,
    };
  } finally {
    rmSync(uvRuntimeDir, { recursive: true, force: true });
  }
}
