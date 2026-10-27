import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  copyNativeExecutableFile, discardCodexExecutableArtifact, hashExecutableFile, openExecutableFile,
  verifyCodexExecutableArtifact, type CodexExecutableArtifact,
} from "./codex-executable-artifact.js";
import {
  assertCodexExecutableLocation, assertCodexPrivateRuntimeDirectory, createPrivateObjects, createPrivateTempDirectory,
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

async function contentHash(path: string): Promise<string> {
  await assertCodexExecutableLocation(path, "native");
  const file = await openExecutableFile(path);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

// Only native bytes are admitted; scripts and package launchers are never probed or executed.
export async function pinClaudeCodeExecutable(
  candidate: string,
  runtimeDirectory: string,
  discovery: CliDiscoveryEnvironment,
): Promise<ClaudeCodeExecutable> {
  const source = await fs.realpath(candidate);
  if (isNpmInstallation(candidate) || isNpmInstallation(source) || /\.(?:cmd|bat|[cm]?js)$/iu.test(source)) {
    throw new ClaudeCodeNativeRequiredError();
  }
  await assertCodexExecutableLocation(candidate, "native");
  const input = await openExecutableFile(source);
  try {
    if (!await isNativeExecutableFile(input, discovery.platform, process.arch)) throw new ClaudeCodeNativeRequiredError();
  } finally { await input.close(); }
  const sourceHash = await contentHash(source);
  await assertCodexPrivateRuntimeDirectory(runtimeDirectory, "native");
  const directory = await createPrivateTempDirectory(join(runtimeDirectory, "executable-"));
  try {
    await assertCodexPrivateRuntimeDirectory(directory, "native");
    const primary = await createPrivateObjects(async (created) => {
      const copy = await copyNativeExecutableFile(source,
        join(directory, discovery.platform === "win32" ? "runtime.exe" : "runtime"), discovery.platform, process.arch, "native");
      created.push(copy.executable);
      return copy;
    });
    if (primary.contentHash !== sourceHash) throw new Error("Subscription executable changed");
    const artifact: CodexExecutableArtifact = Object.freeze({ ...primary, companion: null });
    const verify = async (): Promise<void> => {
      await assertCodexExecutableLocation(candidate, "native");
      if (await fs.realpath(candidate) !== source || await contentHash(source) !== sourceHash) {
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
