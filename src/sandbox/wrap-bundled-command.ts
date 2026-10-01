import { shellQuote } from "../lib/shell-resolver.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  sandboxTempEnvLaunch,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
  allowWrite: readonly string[];
  /** Whose temp directory the process gets: its plugin for a hook, its server for an MCP stdio server. */
  tempPrincipal: SandboxTempPrincipal;
}

/** Apply the same sensitive-path floors and egress policy to bundled processes. */
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  if (process.platform === "win32") {
    throw new Error("ASRT-wrapped bundled processes on Windows cannot apply per-exec allowRead/allowWrite grants");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  // The principal's own temp directory, set as its TMPDIR inside the wrap
  // (ASRT's own assignment would otherwise name the shared root) and granted
  // alone; the read floor denies the shared temp and HOME roots, so no other
  // principal's temp files or HOME can be read either, and the process HOME
  // re-allowed here is its own — as `confined-child.ts` does for its children.
  const temp = ensureSandboxTempPrincipalDir(input.tempPrincipal);
  const launch = sandboxTempEnvLaunch(temp.dir, input.command, input.args);
  const cmdline = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const result = await wrapWorkerCommand(cmdline, {
    filesystem: {
      allowWrite: [temp.dir, input.sandboxHome.path, ...input.allowWrite],
      allowRead: [temp.dir, input.sandboxHome.path, ...input.allowWrite, ...(tmpDir ? [tmpDir] : [])],
      denyRead: getDefaultSensitiveReadDenyPaths(),
      denyWrite: getDefaultSensitiveWriteDenyPaths(),
      // Bundled hooks and MCP stdio servers are plugin-owned (or third-party)
      // code, and every root they write into is one the host created: a
      // plugin's data root, a server's sandbox root, the process HOME.
      pinWriteRoots: true,
    },
  });
  if (!result.argv[0]) {
    await cleanupAsrtSandboxAfterCommand();
    throw new Error("ASRT returned an empty argv for a bundled process");
  }
  return result;
}

/** Preserve only ASRT's changed proxy keys over the caller's stripped environment. */
export function bundledWrappedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  sandboxHomeEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const composed = buildSandboxedChildEnv(wrappedEnv);
  const baseline = buildSandboxedChildEnv(process.env);
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(composed)) {
    if (value !== undefined && baseline[key] !== value) overlay[key] = value;
  }
  return { ...baseEnv, ...overlay, ...sandboxHomeEnv };
}
