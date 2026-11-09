import { useEffect } from "react";
import type { AveApi } from "../../types.js";
import type { StatusBarSeverity, NotificationToastMeta } from "./types.js";
import { sanitizeToastField } from "./toast-field.js";

interface Options {
  api: AveApi;
  receiveToast: (id: string, input: {
    createdAt: number;
    severity: StatusBarSeverity;
    message: string;
    ttlMs?: number;
    sticky?: boolean;
    notification?: NotificationToastMeta;
  }) => string;
}

export function useStatusBarNotifications({ api, receiveToast }: Options): void {
  useEffect(() => {
    if (typeof api.onNotificationToast !== "function") return;
    const unsub = api.onNotificationToast((p) => {
      if (p.kind === "approval" || p.kind === "ask-user") return;
      if (typeof p.id !== "string" || p.id.length === 0 || !Number.isFinite(p.createdAt)) return;
      const severity: StatusBarSeverity = p.kind === "routine" ? "success" : "info";
      receiveToast(`notification:${p.id}`, {
        createdAt: p.createdAt,
        severity,
        message: `${sanitizeToastField(p.title, 64)}: ${sanitizeToastField(p.body, 80)}`,
        ttlMs: 5_000,
        ...(p.sticky === true ? { sticky: true } : {}),
        notification: { kind: p.kind, contextRef: p.contextRef },
      });
    });
    return () => {
      unsub();
    };
  }, [api, receiveToast]);
}
