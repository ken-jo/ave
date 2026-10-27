import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { shellQuote } from "../lib/shell-resolver.js";
import { noteConfinedProcessesMayRun } from "../lib/confined-process-phase.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { assertCodexExecutableLocation } from "../main/codex-executable-location.js";
import {
  buildPerCommandSandboxCustomConfig, getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths, isOfflineProcessConfinementActive,
} from "./asrt-sandbox.js";
import { detectSandboxCapability } from "./sandbox-capability.js";
import { hardenLinuxSandboxWrap } from "./linux-sandbox-wrap.js";
import { hardenMacSandboxGitMetadata } from "./macos-sandbox-wrap.js";
import { offlineProcessConfinementImplemented } from "./offline-confinement-platforms.js";
import type { FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";

interface OfflineProcessInput {
  command: string;
  args: readonly string[];
  /** Caller-authenticated immutable runtime closure; never renderer supplied. */
  runtimeDirectories: readonly string[];
  inputDirectory: string;
  outputDirectory: string;
  ipcDirectory: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface OfflineProcessWrap {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Release only after the process tree has ended. */
  release(): void;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep || /[\0*?\[\]]/u.test(path)) {
    throw new Error("Invalid offline process directory.");
  }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("Offline process directory identity is invalid.");
  }
  return path;
}

function literalLists(entries: readonly FilesystemPathEntry[] | undefined): { patterns: string[]; literals: string[] } {
  const patterns: string[] = [];
  const literals: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry === "string") patterns.push(entry);
    else if (entry.literal === true) literals.push(entry.path);
    else throw new Error("Offline process policy contains an unsupported path entry.");
  }
  return { patterns, literals };
}

/** Kernel-denied IP networking has no proxy exception; private local IPC remains usable. */
export async function wrapOfflineProcess(input: OfflineProcessInput): Promise<OfflineProcessWrap> {
  input.signal.throwIfAborted();
  const capability = detectSandboxCapability();
  if (!offlineProcessConfinementImplemented() || !isOfflineProcessConfinementActive() || capability.confidence !== "verified"
    || capability.confines?.filesystem !== true || capability.confines.process !== true || capability.confines.network !== true) {
    throw new TableDocumentError("engine-confinement-unavailable", "Offline document engine confinement is unavailable.");
  }
  const output = await canonicalDirectory(input.outputDirectory);
  const source = await canonicalDirectory(input.inputDirectory);
  const ipc = await canonicalDirectory(input.ipcDirectory);
  const runtimes = await Promise.all(input.runtimeDirectories.map(canonicalDirectory));
  if (!within(output, ipc) || within(source, output) || within(output, source)
    || runtimes.length === 0 || runtimes.some(path => within(path, output) || within(output, path) || within(path, source))) {
    throw new Error("Offline process filesystem roots overlap.");
  }
  if (!runtimes.some(root => within(root, input.command))) throw new Error("Offline executable is outside its authenticated runtime.");
  await assertCodexExecutableLocation(input.command);
  const systemReads = process.platform === "darwin"
    ? ["/bin/sh", "/usr/bin/env", "/private/var/select/sh", "/usr/lib", "/System/Library", "/Library/Fonts", "/dev/null", "/dev/random", "/dev/urandom"]
    : ["/bin/sh", "/usr/bin/env", "/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/share/fonts", "/usr/share/fontconfig", "/etc/fonts", "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/dev/null", "/dev/random", "/dev/urandom"];
  const policy = buildPerCommandSandboxCustomConfig({
    allowWrite: [output], allowRead: [source, output, ...systemReads],
    denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths(),
    pinWriteRoots: true,
  });
  if (!policy?.filesystem || !(policy.filesystem.allowWrite ?? []).some(entry => entry === output)) {
    throw new TableDocumentError("engine-confinement-unavailable", "Offline output directory was not admitted.");
  }
  const reads = literalLists(policy.filesystem.allowRead);
  const denies = literalLists(policy.filesystem.denyRead);
  const writes = literalLists(policy.filesystem.allowWrite);
  const writeDenies = literalLists(policy.filesystem.denyWrite);
  // Only the authenticated runtime closure may reopen its installed private namespace.
  const readConfig = {
    denyOnly: ["/", ...denies.patterns], literalDenyOnly: denies.literals,
    allowWithinDeny: reads.patterns, literalAllowWithinDeny: [...reads.literals, ...runtimes],
  };
  const writeConfig = {
    allowOnly: writes.patterns, literalAllowOnly: [...writes.literals, "/dev/null"],
    denyWithinAllow: writeDenies.patterns, literalDenyWithinAllow: writeDenies.literals,
  };
  const env = buildSafeChildEnv(Object.fromEntries(Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const command = ["/usr/bin/env", `TMPDIR=${output}`, `TMP=${output}`, `TEMP=${output}`,
    input.command, ...input.args].map(shellQuote).join(" ");
  input.signal.throwIfAborted();
  noteConfinedProcessesMayRun();
  if (process.platform === "darwin") {
    const { wrapCommandWithSandboxMacOS } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js");
    const wrapped = wrapCommandWithSandboxMacOS({
      command, needsNetworkRestriction: true, readConfig, writeConfig,
      allowUnixSockets: [ipc], allowAllUnixSockets: false, allowLocalBinding: false,
      allowAppleEvents: false, allowPty: false, enableWeakerNetworkIsolation: false, binShell: "/bin/sh",
      unsetEnvVars: ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"],
    });
    input.signal.throwIfAborted();
    return { ...hardenMacSandboxGitMetadata({ argv: ["/bin/sh", "-c", wrapped], env }), release: () => {} };
  }
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const config = SandboxManager.getConfig();
  const bwrap = config?.bwrapPath ?? "/usr/bin/bwrap";
  await assertCodexExecutableLocation(bwrap);
  const { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js");
  const wrapped = await wrapCommandWithSandboxLinux({
    command, needsNetworkRestriction: true, readConfig, writeConfig,
    allowAllUnixSockets: true, allowNestedUserNamespaces: false, enableWeakerNestedSandbox: false,
    binShell: "/bin/sh", bwrapPath: bwrap, ripgrepConfig: config?.ripgrep,
    abortSignal: input.signal, unsetEnvVars: ["JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"],
  });
  let released = false;
  const release = (): void => { if (!released) { released = true; cleanupBwrapMountPoints(); } };
  try {
    // Local IPC needs AF_UNIX; nested namespaces must therefore be refused by the native wrapper itself.
    if (!wrapped.includes("--disable-userns")) {
      throw new TableDocumentError("engine-confinement-unavailable", "Offline local IPC requires namespace creation to be disabled.");
    }
    input.signal.throwIfAborted();
    return { ...hardenLinuxSandboxWrap({ argv: ["/bin/sh", "-c", wrapped], env }, {
      allowRead: [...reads.patterns, ...reads.literals, ...runtimes], denyWrite: [...writeDenies.patterns, ...writeDenies.literals],
    }), release };
  } catch (error) { release(); throw error; }
}
