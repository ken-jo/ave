import { win32 as winPath } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { MxcProcessContractError } from "./mxc-extension-errors.js";

/** Admission and ancestor-query synthesis belong to the plan owner. This boundary never expands it. */
export function assertMxcExtensionRequest(value: unknown): asserts value is ContainerRequest {
  const fail = (): never => { throw new MxcProcessContractError("Invalid extension container request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const request = value as ContainerRequest;
  const allowed = new Set(["command", "containment", "workingDirectory", "environment", "inheritDefaultEnvironment", "filesystem", "network", "ui", "timeoutMs"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) || typeof request.command !== "string" || !request.command.trim()
    || request.command.includes("\0") || typeof request.workingDirectory !== "string" || !winPath.isAbsolute(request.workingDirectory)
    || request.inheritDefaultEnvironment !== false || request.containment?.type !== "processcontainer"
    || request.filesystem?.clearPolicyOnExit !== true || request.ui?.disable !== false
    || request.ui.clipboard !== "none" || request.ui.allowInputInjection !== false) fail();
  const config = request.containment?.type === "processcontainer" ? request.containment.config : undefined;
  if (!config || Object.keys(config).some((key) => key !== "filesystem")
    || !config.filesystem || Object.keys(config.filesystem).some((key) => key !== "enumeratePaths")
    || !Array.isArray(config.filesystem.enumeratePaths)) fail();
  const filesystem = request.filesystem!;
  if (Object.keys(filesystem).some((key) => !["readwritePaths", "readonlyPaths", "deniedPaths", "clearPolicyOnExit"].includes(key))) fail();
  for (const paths of [filesystem.readwritePaths, filesystem.readonlyPaths, filesystem.deniedPaths, config!.filesystem!.enumeratePaths]) {
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string" || !/^[a-z]:\\/i.test(entry) || entry.includes("\0"))) fail();
  }
  const roots = [...filesystem.readwritePaths!, ...filesystem.readonlyPaths!];
  if (roots.some((root) => winPath.normalize(root).toLowerCase() === winPath.parse(root).root.toLowerCase())) fail();
  if (!roots.some((root) => {
    const relative = winPath.relative(root, request.workingDirectory!);
    return relative === "" || (!winPath.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
  })) fail();
  const environment = request.environment;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) fail();
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(environment!)) {
    const normalized = key.toUpperCase();
    if (keys.has(normalized) || /^(MXC_FFI_DIR|MXC_BIN_DIR|NODE_OPTIONS|NODE_PATH|AVE_MXC_.*)$/.test(normalized)
      || typeof entry !== "string" || key.includes("=") || key.includes("\0") || entry.includes("\0")) fail();
    if (normalized === "ELECTRON_RUN_AS_NODE" && entry !== "1") fail();
    keys.add(normalized);
  }
  for (const key of ["SYSTEMROOT", "LOCALAPPDATA", "HOME", "TEMP", "TMP"]) {
    if (!Object.entries(environment!).some(([name, entry]) => name.toUpperCase() === key && entry && winPath.isAbsolute(entry))) fail();
  }
  const network = request.network;
  if (!network || Object.keys(network).some((key) => !["egress", "ingress", "runtimeConfig"].includes(key))
    || JSON.stringify(network.egress) !== '{"default":"deny"}'
    || !network.ingress || Object.keys(network.ingress).length !== 2 || network.ingress.default !== "allow" || network.ingress.hostLoopback !== "allow"
    || !network.runtimeConfig || Object.keys(network.runtimeConfig).length !== 1) fail();
  try {
    const proxy = new URL(network!.runtimeConfig!.networkProxy!);
    if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !proxy.port || proxy.username || proxy.password
      || proxy.pathname !== "/" || proxy.search || proxy.hash) fail();
  } catch { fail(); }
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) fail();
  if (Object.keys(request.ui!).length !== 3) fail();
}
