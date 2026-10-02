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

/** Both the displayed action and the click resolve against main-owned state. */
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
    // The installed-only catalog lists each installed package once, under the id its view carries (a
    // credential-shaped stored id goes out as a handle, §18.8), so it is matched by name, not by the stored id.
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
      // Lock order (§18.6): the marketplace operation, then both packages' locks, then the plugin locks.
      // Every service call below is part of this one operation, so none waits for a policy change while
      // these plugin locks are held; and the uninstall below runs under the lease of its package's lock,
      // so it never waits for an install that holds that package and waits for one of these plugin locks.
      const packages = [row.pluginId, predecessorId].map((name) => ({ kind: "plugin" as const, name }));
      return await market.asOneOperation((lease) => withResolvedPluginInstallLocks(() => [row.pluginId, predecessorId].flatMap((id) => {
        const canonical = this.deps.pluginRuntime.resolvePluginId(id);
        const installed = this.deps.pluginRuntime.resolvePluginInstallIdIfKnown(id);
        return [id, canonical, ...(installed ? [installed] : [])];
      }), async (): Promise<RemoveAlertPredecessorResult> => {
        // Installation and removal share these locks: read authority only after
        // admission and hold both bindings until retaining uninstall finishes.
        const current = (await this.deps.alertsService!.listKinds()).find((entry) => entry.kindKey === kindKey);
        if (!current || current.pluginId !== row.pluginId || current.blockedByPredecessor !== predecessorId
          || current.declaration.inherits?.[0]?.pluginId !== predecessorId) {
          return { ok: false, error: "predecessor-not-removable" };
        }
        const resolved = await this.resolve(current, market);
        if (resolved?.state.locked) return { ok: false, error: "predecessor-policy-locked" };
        if (!resolved?.state.removable || !resolved.predecessor) return { ok: false, error: "predecessor-not-removable" };
        // The registry's record carries the stored identity: removed by it, never resolved as a view id (§18.8).
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
