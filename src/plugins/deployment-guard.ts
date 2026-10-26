/** Only system-policy requiredInstalls can prevent uninstall or disable, matching both plugin and bound source. */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lockedByPolicy, requiredByPolicyReason } from "../marketplace/boot-installs/run.js";
import type { PackageKey } from "../marketplace/sources/policy.js";
import { readPluginRegistry } from "./registry.js";

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/** Distinguish policy denials with instanceof, never message prefixes; IPC maps the error separately. */
export class PluginDeploymentDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PluginDeploymentDeniedError";
  }
}

export interface DeploymentGuardOptions {
  registryPath: string;
  pluginsRoot: string;
  /** Read requiredInstalls afresh for every check. */
  requiredInstalls(): Promise<readonly PackageKey[]>;
}

export class PluginDeploymentGuard {
  private readonly registryPath: string;
  private readonly pluginsRoot: string;
  private readonly requiredInstalls: () => Promise<readonly PackageKey[]>;

  constructor(options: DeploymentGuardOptions) {
    this.registryPath = resolve(options.registryPath);
    this.pluginsRoot = resolve(options.pluginsRoot);
    this.requiredInstalls = options.requiredInstalls;
  }

  canUninstall(pluginId: string): Promise<GuardResult> {
    return this.check(pluginId, "uninstall");
  }

  canDisable(pluginId: string): Promise<GuardResult> {
    return this.check(pluginId, "disable");
  }

  private async check(pluginId: string, action: "uninstall" | "disable"): Promise<GuardResult> {
    const registry = await readPluginRegistry(this.registryPath);
    const entry = registry.plugins.find((p) => p.id === pluginId);
    if (!entry) {
      return { allowed: false, reason: `Plugin not found: ${pluginId}` };
    }

    const manifestAbs = isAbsolute(entry.manifestPath)
      ? resolve(entry.manifestPath)
      : resolve(dirname(this.registryPath), entry.manifestPath);
    // Only entries installed under pluginsRoot are owned by this uninstall path.
    if (!this.isUnderPluginsRoot(manifestAbs)) {
      return {
        allowed: false,
        reason: `Plugin ${pluginId} cannot be changed here: its manifest is outside the plugins directory`,
      };
    }

    const key = lockedByPolicy({ requiredInstalls: await this.requiredInstalls() }, "plugin", pluginId, entry.origin?.sourceId ?? null);
    if (key) return { allowed: false, reason: requiredByPolicyReason("plugin", pluginId, key, action) };
    return { allowed: true };
  }

  private isUnderPluginsRoot(absolutePath: string): boolean {
    const rel = relative(this.pluginsRoot, absolutePath);
    if (rel === "" || rel === ".") return false;
    if (rel.startsWith("..")) return false;
    if (isAbsolute(rel)) return false;
    return true;
  }
}

// installClaim is the registry row ID, not the canonical manifest ID.
// A null claim is static and its enabled toggle persists no registry state.
export async function assertDisableAllowed(
  enabled: boolean,
  installClaim: string | null,
  pluginId: string,
  deploymentGuard: Pick<PluginDeploymentGuard, "canDisable"> | undefined,
): Promise<void> {
  if (enabled || !deploymentGuard || installClaim === null) return;
  const guardResult = await deploymentGuard.canDisable(installClaim);
  if (!guardResult.allowed) {
    throw new PluginDeploymentDeniedError(
      guardResult.reason ?? `Plugin disable denied: ${pluginId}`,
    );
  }
}
