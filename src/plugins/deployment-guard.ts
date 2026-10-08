/**
 * Which plugins the user may not uninstall or disable (design §10.1, §10.2).
 *
 * No package locks itself: there are no managed packages, and neither a
 * manifest field nor the registry's `installSource` protects a plugin. Only
 * the machine's system policy file can, through `marketplaces.requiredInstalls`:
 * a plugin an entry there names, installed from the source the entry names,
 * cannot be uninstalled or disabled. The same rule guards the marketplace's
 * own uninstall (`assertNotRequiredByPolicy`), so the Plugins tab and the
 * marketplace answer alike.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lockedByPolicy, requiredByPolicyReason } from "../marketplace/boot-installs/run.js";
import type { PackageKey } from "../marketplace/sources/policy.js";
import { readPluginRegistry } from "./registry.js";

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Thrown when a {@link PluginDeploymentGuard} decision denies a lifecycle
 * mutation. Callers that need to distinguish a policy denial from an
 * operational failure (the IPC layer maps it to its own error code) must use
 * `instanceof` — never a message-prefix match, so the denial wording stays a
 * single authority here.
 */
export class PluginDeploymentDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PluginDeploymentDeniedError";
  }
}

export interface DeploymentGuardOptions {
  /** Absolute path to plugin registry (plugins/registry.json) */
  registryPath: string;
  /** The single plugin root, `~/.ave/plugins/`. */
  pluginsRoot: string;
  /** The system policy file's `requiredInstalls`, read at each check. */
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
    // Uninstall removes `pluginsRoot/<id>`; an entry whose manifest lives
    // elsewhere is not one this app installed there.
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

/**
 * Deployment policy for the LIVE disable writer.
 *
 * Two methods mutate the registry `enabled` field. `disable()` consults this
 * guard; `setPluginEnabled()` is what the renderer toggle reaches through
 * `CHANNELS.plugins.setEnabled`, and it checks here too, so a required plugin
 * cannot be switched off from the settings tab.
 *
 * `installClaim` is the registry row id this guard looks entries up by, NOT the
 * canonical manifest id, which it would fail to find. A static manifest
 * (`installClaim === null`) has no registry row to classify, and its toggle is
 * session-local and persists nothing.
 */
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
