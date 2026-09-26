import type { AlertKindRow, AlertPredecessorState, RemoveAlertPredecessorResult } from "../../shared/alerts-types.js";
import { isAlertKindKey } from "../../shared/alerts-types.js";
import type { GitMarketplacePort } from "./git-marketplace.js";
import type { IpcDeps } from "../types.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("alert-predecessor");
type Marketplace = Pick<GitMarketplacePort, "catalog" | "getRetirementEntry" | "uninstall">;

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
    const catalogEntry = predecessor && catalog.entries.find((entry) => entry.key.kind === "plugin"
      && entry.key.name === pluginId && entry.key.sourceId === predecessor.sourceId);
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
      const resolved = await this.resolve(row, market);
      if (resolved?.state.locked) return { ok: false, error: "predecessor-policy-locked" };
      if (!resolved?.state.removable || !resolved.predecessor) return { ok: false, error: "predecessor-not-removable" };
      // Do not remove for a declaration that changed while metadata was read.
      const current = (await this.deps.alertsService.listKinds()).find((entry) => entry.kindKey === kindKey);
      if (current?.blockedByPredecessor !== row.blockedByPredecessor
        || current?.declaration.inherits?.[0]?.pluginId !== row.blockedByPredecessor) {
        return { ok: false, error: "predecessor-not-removable" };
      }
      const value = await market.uninstall({ kind: "plugin", name: resolved.predecessor.name, sourceId: resolved.predecessor.sourceId },
        { retain: { reason: "superseded" } });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof MarketplaceError && error.code === "PACKAGE_REQUIRED_BY_POLICY") {
        return { ok: false, error: "predecessor-policy-locked" };
      }
      log.warn({ error }, "alert predecessor removal failed");
      return { ok: false, error: "predecessor-removal-failed" };
    }
  }
}
