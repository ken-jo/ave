/**
 * Alerts IPC handlers — `ave:alerts:*`, host renderer only.
 *
 * The renderer reports what the user did with an alert card — accepted or
 * dismissed, after which the identity stays closed for its lifetime — and a
 * window that appeared or reloaded after an alert was raised pulls the cards
 * already staged. Nothing here raises an alert: that is a plugin's HostApi
 * call, and a renderer frame is never one.
 */
import { ipcMain } from "electron";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { ALERTS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import type { AlertCard, AlertCardClosedReason } from "../../shared/alerts-types.js";

function isClosedReason(value: unknown): value is AlertCardClosedReason {
  return value === "accepted" || value === "dismissed";
}

export function registerAlertsHandlers(deps: IpcDeps): void {
  const { alertsService, auditLogger } = deps;

  ipcMain.handle(ALERTS.cardClosed, (e, alertId: unknown, reason: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.cardClosed, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof alertId !== "string" || !isClosedReason(reason)) return { ok: false, error: "invalid-arguments" };
    if (!alertsService) return { ok: false, error: "no-alerts-service" };
    return { ok: alertsService.cardClosed(alertId, reason) };
  });

  ipcMain.handle(ALERTS.openCards, (e): AlertCard[] | typeof UNAUTHORIZED_FRAME => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, ALERTS.openCards, e);
      return UNAUTHORIZED_FRAME;
    }
    return alertsService?.openCards() ?? [];
  });
}
