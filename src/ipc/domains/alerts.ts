/**
 * Alerts IPC handlers — `ave:alerts:*`, host renderer only.
 *
 * The renderer reads registered kinds and changes their switches through the
 * service. It also reports what the user did with an alert card — accepted or
 * dismissed, after which the identity stays closed for its lifetime — and a
 * window that appeared or reloaded after an alert was raised pulls the cards
 * already staged. Nothing here raises an alert: that is a plugin's HostApi
 * call, and a renderer frame is never one.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { ALERTS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import type { AlertCard, AlertCardClosedReason, AlertKindRow, SetAlertKindResult, SetAlertOsNotificationsResult } from "../../shared/alerts-types.js";

import { AlertPredecessorAccess } from "./alert-predecessor.js";
import type { GitMarketplacePort } from "./git-marketplace.js";

function isClosedReason(value: unknown): value is AlertCardClosedReason {
  return value === "accepted" || value === "dismissed";
}

export function registerAlertsHandlers(deps: IpcDeps, marketplace: () => Promise<Pick<GitMarketplacePort, "catalog" | "getRetirementEntry" | "uninstall" | "asOneOperation">>): void {
  const { alertsService, auditLogger } = deps;
  const predecessors = new AlertPredecessorAccess(deps, marketplace);

  ipcMain.handle(ALERTS.removePredecessor, (e, kindKey: unknown, ...extra: unknown[]) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.removePredecessor, e);
      return { ...UNAUTHORIZED_FRAME, ok: false };
    }
    if (extra.length > 0) return { ok: false, error: "invalid-arguments" };
    return predecessors.remove(kindKey);
  });

  ipcMain.handle(ALERTS.listKinds, async (e): Promise<AlertKindRow[] | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.listKinds, e);
      return UNAUTHORIZED_FRAME;
    }
    return predecessors.present(await alertsService?.listKinds() ?? []);
  });

  ipcMain.handle(ALERTS.setKind, async (e, kindKey: unknown, patch: unknown): Promise<SetAlertKindResult> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.setKind, e);
      return { ...UNAUTHORIZED_FRAME, ok: false };
    }
    if (!alertsService) return { ok: false, error: "no-alerts-service" };
    const result = await alertsService.setKind(kindKey, patch);
    return "error" in result ? result : (await predecessors.present([result]))[0]!;
  });

  ipcMain.handle(ALERTS.setOsNotificationsEnabled, async (e, enabled: unknown): Promise<SetAlertOsNotificationsResult> => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.setOsNotificationsEnabled, e);
      return { ...UNAUTHORIZED_FRAME, ok: false };
    }
    if (!alertsService) return { ok: false, error: "no-alerts-service" };
    return alertsService.setOsNotificationsEnabled(enabled);
  });

  ipcMain.handle(ALERTS.cardClosed, (e, alertId: unknown, reason: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.cardClosed, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof alertId !== "string" || !isClosedReason(reason)) return { ok: false, error: "invalid-arguments" };
    if (!alertsService) return { ok: false, error: "no-alerts-service" };
    return { ok: alertsService.cardClosed(alertId, reason) };
  });

  ipcMain.handle(ALERTS.listOpen, (e): AlertCard[] | typeof UNAUTHORIZED_FRAME => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.listOpen, e);
      return UNAUTHORIZED_FRAME;
    }
    return alertsService?.listOpen() ?? [];
  });
}
