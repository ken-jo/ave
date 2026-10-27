import { promises as fs } from "node:fs";
import { join } from "node:path";
import { authenticateClaudeCodeExecutable } from "./claude-code-authenticity.js";
import {
  copyNativeExecutableFile, discardCodexExecutableArtifact, hashExecutableFile, openExecutableFile,
  verifyCodexExecutableArtifact, type CodexExecutableArtifact,
} from "./codex-executable-artifact.js";
import {
  assertCodexExecutableLocation, assertCodexPrivateRuntimeDirectory, createPrivateObjects, createPrivateTempDirectory,
  type CodexLocationTrustInputs,
} from "./codex-executable-location.js";
import { isNativeExecutableFile } from "./native-executable-format.js";
import type { CliDiscoveryEnvironment } from "./user-cli-discovery.js";

export interface ClaudeCodeExecutable {
  readonly executable: string;
  readonly identity: string;
  readonly verify: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

export class ClaudeCodeNativeRequiredError extends Error {
  constructor() {
    super("Native subscription runtime installation required");
    this.name = "ClaudeCodeNativeRequiredError";
  }
}

// Package-managed launchers and platform packages belong to the unsupported install route.
function isNpmInstallation(path: string): boolean {
  return /(?:^|\/)node_modules\/@anthropic-ai\/claude-code(?:-[^/]+)?(?:\/|$)/iu.test(path.replaceAll("\\", "/"));
}

// Only the default cask launcher and its versioned payload share the package manager's group-writable directories.
function sourceLocationTrust(candidate: string, source: string, platform: NodeJS.Platform): CodexLocationTrustInputs {
  const prefixes = platform === "darwin" ? ["/opt/homebrew", "/usr/local"]
    : platform === "linux" ? ["/home/linuxbrew/.linuxbrew"] : [];
  for (const prefix of prefixes) {
    const payload = source.slice(prefix.length).match(/^\/Caskroom\/(claude-code(?:@latest)?)\/(\d+\.\d+\.\d+)\/claude$/u);
    if (!source.startsWith(`${prefix}/`) || !payload
      || candidate !== `${prefix}/bin/claude` && candidate !== source) continue;
    const packageDirectory = `${prefix}/Caskroom/${payload[1]}`;
    return { groupWritableSourceDirectories: new Set([
      prefix, `${prefix}/bin`, `${prefix}/Caskroom`, packageDirectory, `${packageDirectory}/${payload[2]}`,
    ]) };
  }
  return {};
}

async function contentHash(path: string, trustInputs: CodexLocationTrustInputs): Promise<string> {
  await assertCodexExecutableLocation(path, "native", trustInputs);
  const file = await openExecutableFile(path);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

// Only native bytes are admitted; scripts and package launchers are never probed or executed. `releaseFetch` carries Linux release-metadata requests.
export async function pinClaudeCodeExecutable(
  candidate: string,
  runtimeDirectory: string,
  discovery: CliDiscoveryEnvironment,
  releaseFetch: typeof fetch,
): Promise<ClaudeCodeExecutable> {
  const source = await fs.realpath(candidate);
  if (isNpmInstallation(candidate) || isNpmInstallation(source) || /\.(?:cmd|bat|[cm]?js)$/iu.test(source)) {
    throw new ClaudeCodeNativeRequiredError();
  }
  const trustInputs = sourceLocationTrust(candidate, source, discovery.platform);
  await assertCodexExecutableLocation(candidate, "native", trustInputs);
  const input = await openExecutableFile(source);
  try {
    if (!await isNativeExecutableFile(input, discovery.platform, process.arch)) throw new ClaudeCodeNativeRequiredError();
  } finally { await input.close(); }
  const sourceHash = await contentHash(source, trustInputs);
  await assertCodexPrivateRuntimeDirectory(runtimeDirectory, "native");
  const directory = await createPrivateTempDirectory(join(runtimeDirectory, "executable-"));
  try {
    await assertCodexPrivateRuntimeDirectory(directory, "native");
    const primary = await createPrivateObjects(async (created) => {
      const copy = await copyNativeExecutableFile(source,
        join(directory, discovery.platform === "win32" ? "runtime.exe" : "runtime"), discovery.platform, process.arch, "native", trustInputs);
      created.push(copy.executable);
      return copy;
    });
    if (primary.contentHash !== sourceHash) throw new Error("Subscription executable changed");
    const artifact: CodexExecutableArtifact = Object.freeze({ ...primary, companion: null });
    await authenticateClaudeCodeExecutable(artifact.executable, source, sourceHash, discovery.platform, process.arch, releaseFetch);
    const verify = async (): Promise<void> => {
      await assertCodexExecutableLocation(candidate, "native", trustInputs);
      if (await fs.realpath(candidate) !== source || await contentHash(source, trustInputs) !== sourceHash) {
        throw new Error("Subscription executable changed");
      }
      await verifyCodexExecutableArtifact(artifact, "native");
    };
    await verify();
    return Object.freeze({ executable: artifact.executable,
      identity: JSON.stringify([source, sourceHash]), verify,
      discard: () => discardCodexExecutableArtifact(artifact),
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
