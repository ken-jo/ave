import type { PluginInstallResultPayload } from "../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../plugins/public-contract.js";
import {
  ProcessEntryRequiresPinnedArtifactError,
  ProcessEntryUnconfinedError,
  PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
  PROCESS_ENTRY_UNCONFINED_CODE,
} from "../plugins/process-entry.js";

/** A visible catalog package without a local installation needs an install remedy, so it uses a distinct error code. */
export const PACKAGE_NOT_INSTALLED_CODE = "package-not-installed";

/** Administrator-deployed plugins require administrator removal; do not present the refusal as a transient save failure. */
export const ADMIN_PLUGIN_UNINSTALL_DENIED_CODE = "admin-plugin-uninstall-denied";

/** Keep code/message pairing consistent across package families and entry points. Recognized codes localize in the renderer; unrecognized messages use its plain-text fallback. */
export function buildInstallFailureResult(
  slug: string,
  error: unknown,
  fallbackMessage: string,
): PluginInstallResultPayload {
  const message = (error instanceof Error ? error.message : "") || fallbackMessage;
  const code = error instanceof IncompatibleAppVersionError
    ? INCOMPATIBLE_APP_VERSION_CODE
    : error instanceof ProcessEntryUnconfinedError
      ? PROCESS_ENTRY_UNCONFINED_CODE
    : error instanceof ProcessEntryRequiresPinnedArtifactError
      ? PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE
    : undefined;
  return {
    slug,
    success: false,
    error: code ?? message,
    ...(code ? { message } : {}),
  };
}
