import { shellQuote } from "../lib/shell-resolver.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  cleanupAsrtSandboxAfterCommand,
  wrapWorkerCommand,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
  allowWrite: readonly string[];
}

/** Apply the same sensitive-path floors and egress policy to bundled processes. */
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  if (process.platform === "win32") {
    throw new Error("ASRT-wrapped bundled processes on Windows cannot apply per-exec allowRead/allowWrite grants");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const cmdline = [input.command, ...input.args].map(shellQuote).join(" ");
  const result = await wrapWorkerCommand(cmdline, {
    filesystem: {
      allowWrite: [input.sandboxHome.path, ...input.allowWrite],
      allowRead: [input.sandboxHome.path, ...input.allowWrite, ...(tmpDir ? [tmpDir] : [])],
      denyRead: getDefaultSensitiveReadDenyPaths(),
      denyWrite: getDefaultSensitiveWriteDenyPaths(),
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
