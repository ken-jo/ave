import { win32 as winPath } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { FORWARD_ENV_KEYS, isSandboxWrapperEnvKey } from "../tools/safe-env.js";
import { quoteWindowsArgument, WINDOWS_COMMAND_LINE_LIMIT } from "../shared/windows-command-line.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";
import { synthesizeMxcAncestorQueries } from "./mxc-filesystem-policy.js";
import { isWindowsPathAtOrUnder, type MxcFilesystemGrants } from "./mxc-windows.js";

/** These roots have already passed shared admission. Environment paths never add grants. */
export interface MxcConfinedChildRequestInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly home: string;
  readonly temp: string;
  readonly grants: MxcFilesystemGrants;
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly proxyUrl: string;
}

/** Build only the SDK public contract; no shell, account mutation or compatibility retry. */
export function buildMxcConfinedChildRequest(input: MxcConfinedChildRequestInput): ContainerRequest {
  if (!/^[a-z]:\\.*\.exe$/i.test(input.command) || /[\0\r\n]/.test(input.command)) {
    throw new Error("Container executable must be an admitted absolute executable path");
  }
  const reads = [...input.grants.readonly, ...input.grants.readwrite];
  const writable = (path: string): boolean => input.grants.readwrite.some((root) => isWindowsPathAtOrUnder(path, root))
    && !input.grants.denied.some((root) => isWindowsPathAtOrUnder(path, root));
  if (!reads.some((root) => isWindowsPathAtOrUnder(input.command, root)) || !writable(input.home) || !writable(input.temp)) {
    throw new Error("Container runtime, home and temp must already be admitted");
  }
  if (input.args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("Container arguments contain a forbidden control character");
  // Contract with the row-3 plugin-child factory: `request.command` must equal the shared Windows command-line helper's
  // output for (command, args) — the same per-argument `quoteWindowsArgument` join. Never use a probe's quoting here.
  const command = [input.command, ...input.args].map(quoteWindowsArgument).join(" ");
  if (command.length + 1 > WINDOWS_COMMAND_LINE_LIMIT) throw new Error("Container command line exceeds the process limit");
  const safeKeys = new Set<string>(FORWARD_ENV_KEYS.map((key) => key.toUpperCase()));
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.baseEnv)) {
    const key = name.toUpperCase();
    if (value === undefined || isSandboxWrapperEnvKey(name) || !safeKeys.has(key)) continue;
    if (Object.hasOwn(environment, key)) throw new Error("Container environment contains duplicate keys");
    environment[key] = value;
  }
  if (input.baseEnv.ELECTRON_RUN_AS_NODE === "1") environment.ELECTRON_RUN_AS_NODE = "1";
  // Profile and working-directory hints must not point back into the host profile.
  Object.assign(environment, {
    HOME: input.home, USERPROFILE: input.home,
    HOMEDRIVE: winPath.parse(input.home).root.slice(0, 2), HOMEPATH: input.home.slice(2),
    TEMP: input.temp, TMP: input.temp, TMPDIR: input.temp, PWD: input.cwd,
  });
  const request: ContainerRequest = {
    command,
    containment: { type: "processcontainer", config: { filesystem: {
      enumeratePaths: [...synthesizeMxcAncestorQueries(input.grants, [input.cwd, winPath.dirname(input.command)])],
    } } },
    workingDirectory: input.cwd,
    environment,
    inheritDefaultEnvironment: false,
    filesystem: {
      readwritePaths: [...input.grants.readwrite], readonlyPaths: [...input.grants.readonly],
      deniedPaths: [...input.grants.denied], clearPolicyOnExit: true,
    },
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" },
      runtimeConfig: { networkProxy: input.proxyUrl } },
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
  };
  assertMxcExtensionRequest(request);
  return request;
}
