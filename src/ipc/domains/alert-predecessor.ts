import type { AlertKindRow, AlertPredecessorState, RemoveAlertPredecessorResult } from "../../shared/alerts-types.js";
import { isAlertKindKey } from "../../shared/alerts-types.js";
import type { GitMarketplacePort } from "./git-marketplace.js";
import type { IpcDeps } from "../types.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { withResolvedPluginInstallLocks } from "../../plugins/install-lifecycle.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("alert-predecessor");
type Marketplace = Pick<GitMarketplacePort, "catalog" | "getRetirementEntry" | "uninstallInstalled" | "asOneOperation">;

export class AlertPredecessorAccess {
  constructor(private readonly deps: IpcDeps, private readonly marketplace: () => Promise<Marketplace>) {}

  private async resolve(row: AlertKindRow, market: Marketplace) {
    const pluginId = row.blockedByPredecessor;
    if (!pluginId || row.declaration.inherits?.[0]?.pluginId !== pluginId) return null;
    const [installed, catalog, retirement] = await Promise.all([
      this.deps.pluginMarketplace.listInstalledPackages(),
      market.catalog({ kind: "plugin", installedOnly: true }),
      market.getRetirementEntry(pluginId),
    ]);
    const predecessor = installed.find((entry) => entry.name === pluginId);
    const successor = installed.find((entry) => entry.name === row.pluginId);
    // Catalog ids may be redacted handles; match installed packages by name rather than stored source id.
    const catalogEntry = predecessor && catalog.entries.find((entry) => entry.key.kind === "plugin" && entry.key.name === pluginId);
    const grant = retirement?.successors.plugins.find((entry) => entry.pluginId === row.pluginId);
    const authorized = !!predecessor && !!successor && !!retirement && !!grant
      && (predecessor.sourceId === null || predecessor.sourceId === retirement.sourceId)
      && (grant.anySource === true || (successor.sourceId !== null && successor.sourceId === retirement.sourceId));
    const locked = catalogEntry?.required === true;
    const revoked = predecessor?.version != null
      && revocationRegistry.evaluate("plugin", pluginId, predecessor.version).kind === "block";
    const state: AlertPredecessorState = {
      pluginId,
      label: catalogEntry?.displayName ?? this.deps.pluginRuntime.getPluginManifest(pluginId)?.name ?? pluginId,
      locked,
      restartRequired: revoked && this.deps.pluginRuntime.listPluginIds().includes(pluginId),
      removable: authorized && !!catalogEntry && !locked,
    };
    return { state, predecessor };
  }

  async present(rows: AlertKindRow[]): Promise<AlertKindRow[]> {
    if (!rows.some((row) => row.blockedByPredecessor)) return rows;
    const market = await this.marketplace();
    return Promise.all(rows.map(async (row) => ({ ...row, predecessor: (await this.resolve(row, market))?.state ?? null })));
  }

  async remove(kindKey: unknown): Promise<RemoveAlertPredecessorResult> {
    if (!isAlertKindKey(kindKey)) return { ok: false, error: "invalid-arguments" };
    if (!this.deps.alertsService) return { ok: false, error: "no-alerts-service" };
    try {
      const row = (await this.deps.alertsService.listKinds()).find((entry) => entry.kindKey === kindKey);
      if (!row) return { ok: false, error: "predecessor-not-removable" };
      const market = await this.marketplace();
      const predecessorId = row.blockedByPredecessor;
      if (!predecessorId) return { ok: false, error: "predecessor-not-removable" };
      // Acquire marketplace operation, package locks, then plugin locks; retaining uninstall uses the existing package lease.
      const packages = [row.pluginId, predecessorId].map((name) => ({ kind: "plugin" as const, name }));
      return await market.asOneOperation((lease) => withResolvedPluginInstallLocks(() => [row.pluginId, predecessorId].flatMap((id) => {
        const canonical = this.deps.pluginRuntime.resolvePluginId(id);
        const installed = this.deps.pluginRuntime.resolvePluginInstallIdIfKnown(id);
        return [id, canonical, ...(installed ? [installed] : [])];
      }), async (): Promise<RemoveAlertPredecessorResult> => {
        // Re-read authority after lock admission and retain both bindings until uninstall completes.
        const current = (await this.deps.alertsService!.listKinds()).find((entry) => entry.kindKey === kindKey);
        if (!current || current.pluginId !== row.pluginId || current.blockedByPredecessor !== predecessorId
          || current.declaration.inherits?.[0]?.pluginId !== predecessorId) {
          return { ok: false, error: "predecessor-not-removable" };
        }
        const resolved = await this.resolve(current, market);
        if (resolved?.state.locked) return { ok: false, error: "predecessor-policy-locked" };
        if (!resolved?.state.removable || !resolved.predecessor) return { ok: false, error: "predecessor-not-removable" };
        // Remove by the registry's stored identity, never by a catalog view id.
        const value = await market.uninstallInstalled({ kind: "plugin", name: resolved.predecessor.name, sourceId: resolved.predecessor.sourceId },
          { retain: { reason: "superseded" }, lease });
        return { ok: true, value };
      }), packages);
    } catch (error) {
      if (error instanceof MarketplaceError && error.code === "PACKAGE_REQUIRED_BY_POLICY") {
        return { ok: false, error: "predecessor-policy-locked" };
      }
      log.warn({ error }, "alert predecessor removal failed");
      return { ok: false, error: "predecessor-removal-failed" };
    }
  }
}
