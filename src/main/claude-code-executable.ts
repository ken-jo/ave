import { promises as fs } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import {
  copyNativeExecutableFile, discardCodexExecutableArtifact, hashExecutableFile, openExecutableFile,
  verifyCodexExecutableArtifact, type CodexExecutableArtifact,
} from "./codex-executable-artifact.js";
import { assertCodexExecutableLocation, assertCodexPrivateRuntimeDirectory } from "./codex-executable-location.js";
import { isNativeExecutableFile } from "./native-executable-format.js";
import { cliExecutableCandidates, type CliDiscoveryEnvironment } from "./user-cli-discovery.js";
import { copySubscriptionPackageArtifact } from "./subscription-package-artifact.js";

export interface ClaudeCodeExecutable {
  readonly executable: string;
  readonly args: readonly string[];
  readonly identity: string;
  readonly verify: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

const PACKAGE_NAME = "@anthropic-ai/claude-code";

async function contentHash(path: string): Promise<string> {
  await assertCodexExecutableLocation(path);
  const file = await openExecutableFile(path);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

async function isNativeFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  await assertCodexExecutableLocation(path);
  const file = await openExecutableFile(path);
  try { return await isNativeExecutableFile(file, platform, process.arch); } finally { await file.close(); }
}

/** The shim is only an install marker. Its batch contents are never executed. */
export function claudeCodeNpmShimTarget(shim: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : { basename, dirname, join };
  if (paths.basename(shim).toLowerCase() !== "claude.cmd") throw new Error("Invalid subscription launcher");
  return paths.join(paths.dirname(shim), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
}

/** Admit all launch inputs before the first probe and retain a content proof. */
export async function pinClaudeCodeExecutable(
  candidate: string,
  runtimeDirectory: string,
  discovery: CliDiscoveryEnvironment,
): Promise<ClaudeCodeExecutable> {
  await assertCodexExecutableLocation(candidate);
  const source = await fs.realpath(candidate);
  const launcherHash = await contentHash(source);
  const isNpmShim = discovery.platform === "win32" && source.toLowerCase().endsWith(".cmd");
  let script: string | null = isNpmShim ? claudeCodeNpmShimTarget(source) : null;
  let interpreter: string = source;
  let root: string | null = null;
  if (script === null && !await isNativeFile(source, discovery.platform)) script = source;
  if (script !== null) {
    await assertCodexExecutableLocation(script);
    script = await fs.realpath(script);
    root = dirname(script);
    if (basename(script) !== "cli.js" || basename(root) !== "claude-code"
      || basename(dirname(root)) !== "@anthropic-ai") throw new Error("Unsupported subscription launcher");
    const manifest = join(root, "package.json");
    await contentHash(manifest);
    const metadata: unknown = JSON.parse(await fs.readFile(manifest, "utf8"));
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== PACKAGE_NAME) {
      throw new Error("Invalid subscription package");
    }
    let explicitInterpreter: string | null = null;
    const input = await openExecutableFile(script);
    try {
      const header = Buffer.alloc(128);
      const { bytesRead } = await input.read(header, 0, header.length, 0);
      const shebang = /^#!(\/usr\/bin\/env node|\/[^\r\n ]*\/node)\r?\n/.exec(header.subarray(0, bytesRead).toString("utf8"));
      if (!shebang) {
        throw new Error("Unsupported subscription interpreter");
      }
      if (shebang[1] !== "/usr/bin/env node") explicitInterpreter = shebang[1]!;
    } finally { await input.close(); }
    const candidates = explicitInterpreter ? [explicitInterpreter] : [
      ...(isNpmShim ? [join(dirname(source), "node.exe")] : []),
      ...cliExecutableCandidates(discovery, [discovery.platform === "win32" ? "node.exe" : "node"], []),
    ];
    let resolved: string | null = null;
    for (const path of candidates) {
      try { await fs.lstat(path); } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      // An existing but untrusted interpreter stops discovery before execution.
      if (!await isNativeFile(path, discovery.platform)) throw new Error("Invalid subscription interpreter");
      resolved = await fs.realpath(path);
      break;
    }
    if (!resolved) throw new Error("Subscription interpreter is unavailable");
    interpreter = resolved;
  }
  const interpreterHash = await contentHash(interpreter);
  await assertCodexPrivateRuntimeDirectory(runtimeDirectory);
  const directory = await fs.mkdtemp(join(runtimeDirectory, "executable-"));
  try {
    await assertCodexPrivateRuntimeDirectory(directory);
    const primary = await copyNativeExecutableFile(interpreter,
      join(directory, discovery.platform === "win32" ? "runtime.exe" : "runtime"), discovery.platform, process.arch);
    if (primary.contentHash !== interpreterHash) throw new Error("Subscription interpreter changed");
    const packageArtifact = root === null || script === null ? null : await copySubscriptionPackageArtifact(root, script, directory);
    const artifact: CodexExecutableArtifact = Object.freeze({ ...primary, companion: null });
    const verify = async (): Promise<void> => {
      // Retain the launcher's link route as well as the canonical target.
      await assertCodexExecutableLocation(candidate);
      if (await fs.realpath(candidate) !== source || await contentHash(source) !== launcherHash
        || await contentHash(interpreter) !== interpreterHash) {
        throw new Error("Subscription executable changed");
      }
      await verifyCodexExecutableArtifact(artifact);
      await packageArtifact?.verify();
    };
    await verify();
    return Object.freeze({ executable: artifact.executable, args: packageArtifact?.args ?? Object.freeze([]),
      identity: JSON.stringify([source, launcherHash, interpreter, interpreterHash, packageArtifact?.identity ?? null]), verify,
      discard: () => discardCodexExecutableArtifact(artifact),
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
