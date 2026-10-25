import { t } from "../../../i18n/runtime.js";
import { stagedOriginForInput } from "../../../shared/staged-origins.js";

/** Resolve staged labels through the registry; show unknown origins as raw strings rather than silently blank. */
export function trustOriginLabel(origin: string | undefined): string {
  const staged = stagedOriginForInput(origin);
  if (staged) return t(staged.labelKey);
  switch (origin) {
    case "user-keyboard":
      return t("trustOriginLabel.userKeyboard");
    case "llm-tool-arg":
      return t("trustOriginLabel.llmToolArg");
    case "file-content":
      return t("trustOriginLabel.fileContent");
    case "surface-user":
      return t("trustOriginLabel.surfaceUser");
    case "tailnet-surface":
      return t("trustOriginLabel.tailnetSurface");
    case "platform-bridge":
      return t("trustOriginLabel.platformBridge");
    case undefined:
      return t("trustOriginLabel.unknown");
    default:
      return origin;
  }
}

export function isNonUserTrustOrigin(origin: string | undefined): boolean {
  return origin !== "user-keyboard";
}
