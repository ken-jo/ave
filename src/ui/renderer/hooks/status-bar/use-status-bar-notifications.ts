import { useEffect } from "react";
import type { AveApi } from "../../types.js";
import type { StatusBarSeverity, NotificationToastMeta } from "./types.js";
import { sanitizeToastField } from "./toast-field.js";

interface Options {
  api: AveApi;
  pushToast: (input: {
    severity: StatusBarSeverity;
    message: string;
    ttlMs?: number;
    sticky?: boolean;
    notification?: NotificationToastMeta;
  }) => string;
}

export function useStatusBarNotifications({ api, pushToast }: Options): void {
  useEffect(() => {
    if (typeof api.onNotificationToast !== "function") return;
    const unsub = api.onNotificationToast((p) => {
      const severity: StatusBarSeverity =
        p.kind === "approval"
          ? "warning"
          : p.kind === "ask-user"
            ? "info"
            : p.kind === "routine"
              ? "success"
              : "info";
      pushToast({
        severity,
        message: `${sanitizeToastField(p.title, 64)}: ${sanitizeToastField(p.body, 80)}`,
        ttlMs: p.kind === "approval" ? 10_000 : 5_000,
        ...(p.sticky === true ? { sticky: true } : {}),
        notification: { kind: p.kind, contextRef: p.contextRef },
      });
    });
    return () => {
      unsub();
    };
  }, [api, pushToast]);
}
