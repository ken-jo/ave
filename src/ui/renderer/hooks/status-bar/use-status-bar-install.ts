import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import type { PluginInstallResultPayload } from "../../../../contract/app-contract.js";
import { formatIpcError } from "../../format-ipc-error.js";
import type { AveApi } from "../../types.js";
import type { StatusBarSeverity } from "./types.js";
import { sanitizeToastField } from "./toast-field.js";

interface Options {
  api: AveApi;
  pushToast: (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => string;
  upsertToast: (
    id: string,
    input: { severity: StatusBarSeverity; message: string; ttlMs?: number },
  ) => string;
}

/** Use the channel's shared result type; preparing belongs to install-progress, not install-result. */
type InstallResultPayload = PluginInstallResultPayload;

function targetLabel(slug: string, label: string): string {
  return label ? `${slug} ${label}` : slug;
}

function installToastId(slug: string): string {
  return `install:plugin:${slug}`;
}

export function useStatusBarInstall({ api, pushToast, upsertToast }: Options): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const handleInstallResult = ({ slug, success, error, message }: InstallResultPayload) => {
      const safeSlug = sanitizeToastField(slug, 64);
      const target = safeSlug;
      if (success) {
        upsertToast(installToastId(safeSlug), {
          severity: "success",
          message: t("useStatusBarInstall.installSuccess", { target }),
        });
      } else {
        upsertToast(installToastId(safeSlug), {
          severity: "error",
          // Localize stable install error codes; message is the readable fallback for unmapped codes, never the raw identifier.
          message: t("useStatusBarInstall.installFailure", {
            target,
            error: sanitizeToastField(formatIpcError(error, message)),
          }),
          ttlMs: 10000,
        });
      }
    };
    const handleUninstallResult = (
      { slug, success, error, message }: InstallResultPayload,
      label = "",
    ) => {
      const target = targetLabel(sanitizeToastField(slug, 64), label);
      if (success) pushToast({ severity: "success", message: t("useStatusBarInstall.uninstallSuccess", { target }) });
      else pushToast({
        severity: "error",
        message: t("useStatusBarInstall.uninstallFailure", {
          target,
          error: sanitizeToastField(formatIpcError(error, message)),
        }),
        ttlMs: 10000,
      });
    };

    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(api.onPluginInstallResult(handleInstallResult));
    }
    if (typeof api.onPluginUninstallResult === "function") unsubs.push(api.onPluginUninstallResult((payload) => handleUninstallResult(payload)));
    if (typeof api.onAgentUninstallResult === "function") unsubs.push(api.onAgentUninstallResult((payload) => handleUninstallResult(payload, t("useStatusBarInstall.labelAgent"))));
    if (typeof api.onSkillUninstallResult === "function") unsubs.push(api.onSkillUninstallResult((payload) => handleUninstallResult(payload, t("useStatusBarInstall.labelSkill"))));
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, pushToast, upsertToast]);
}
