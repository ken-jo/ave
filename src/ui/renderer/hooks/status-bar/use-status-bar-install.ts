import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import type { PluginInstallResultPayload } from "../../../../contract/app-contract.js";
import { formatIpcError } from "../../format-ipc-error.js";
import type { AveApi } from "../../types.js";
import type { StatusBarSeverity } from "./types.js";
import { sanitizeToastField } from "./toast-field.js";
import { formatBytes } from "../../../../lib/turn-summary-format.js";

interface Options {
  api: AveApi;
  pushToast: (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => string;
  upsertToast: (
    id: string,
    input: { severity: StatusBarSeverity; message: string; ttlMs?: number },
  ) => string;
}

type InstallProgressPayload =
  | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" | "preparing" }
  | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null };

/**
 * The channel's own declaration. `preparing` used to be re-spelled here and in
 * the renderer API type; no producer ever set it - it had drifted in from the
 * install-PROGRESS channel, which has a `phase: "preparing"`.
 */
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
    const handleProgress = (payload: InstallProgressPayload) => {
      const safeSlug = sanitizeToastField(payload.slug, 64);
      const target = safeSlug;
      let message: string;
      if (payload.phase === "downloading") {
        const { bytesDownloaded, bytesTotal } = payload;
        if (bytesTotal !== null) {
          message = t("useStatusBarInstall.downloadingWithProgress", {
            progress: `${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)}`,
            target,
          });
        } else {
          message = t("useStatusBarInstall.downloadingNoTotal", { target });
        }
      } else if (payload.phase === "verifying") {
        message = t("useStatusBarInstall.verifying", { target });
      } else if (payload.phase === "registering") {
        message = t("useStatusBarInstall.registering", { target });
      } else if (payload.phase === "restarting") {
        message = t("useStatusBarInstall.restarting", { target });
      } else if (payload.phase === "preparing") {
        message = t("useStatusBarInstall.preparingRuntime", { target });
      } else {
        message = t("useStatusBarInstall.installing", { target });
      }
      upsertToast(installToastId(safeSlug), { severity: "info", message, ttlMs: 8000 });
    };
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
          // The producer sends a stable English code plus its human detail
          // precisely so this maps to localized copy. Rendering `error` raw
          // showed the user the literal string `incompatible-app-version`.
          //
          // `message` is the documented fallback for a code with no i18n
          // entry. It changes nothing today — the only code this producer
          // emits is mapped — so do not read a behavioural guarantee into it;
          // it is here so the next unmapped code degrades to readable text
          // instead of a bare identifier.
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

    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(api.onPluginInstallProgress(handleProgress));
    }
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
