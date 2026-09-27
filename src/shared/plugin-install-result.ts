import type { PluginInstallResultPayload } from "../contract/app-contract.js";
import {
  IncompatibleAppVersionError,
  INCOMPATIBLE_APP_VERSION_CODE,
} from "../plugins/public-contract.js";
import { ProcessEntryUnsupportedError, PROCESS_ENTRY_UNSUPPORTED_CODE } from "../plugins/process-entry-support.js";

/**
 * Uninstall refused because the package is not installed (plugin, agent, skill).
 *
 * Deliberately NOT the existing `not-found` code. This condition is reached from
 * a catalog entry the user is looking at: the package exists and is listed, it
 * simply has no local installation. `not-found` renders "The requested item
 * could not be found", which is a false statement about a package the user can
 * see, and it points at the wrong remedy (search again, rather than install).
 *
 * One code for all three families rather than three: the toast already names
 * the family in its `{target}` half (`useStatusBarInstall.labelAgent` etc.), so
 * per-family codes would only duplicate that noun in every locale.
 */
export const PACKAGE_NOT_INSTALLED_CODE = "package-not-installed";

/**
 * Uninstall refused because an administrator deployed the plugin.
 *
 * Kept apart from {@link PACKAGE_NOT_INSTALLED_CODE} and from the generic
 * `managed` code because the user's next step differs: nothing they do in the
 * app will remove this plugin, so the copy has to send them to their
 * administrator rather than suggest a retry. `managed` reads "blocked by an
 * administrator policy, or an error occurred while saving" — that "or" makes a
 * permanent refusal look like it might be a transient save failure.
 */
export const ADMIN_PLUGIN_UNINSTALL_DENIED_CODE = "admin-plugin-uninstall-denied";

/**
 * Producer for the install/uninstall failure payload on all three package
 * families — `plugins.*`, `agents.*` and `skills.*`. Sole constructor of the
 * shape, so the code/message pairing cannot drift between the IPC handlers, the
 * dev local-install handler and the `ave://` deep link.
 *
 * A recognised failure sends its stable English code in `error` and keeps the
 * concrete English text (which carries the version numbers) in `message`.
 * `formatIpcError(error, message)` on the renderer turns that pair into
 * localized copy; an unrecognised failure has no code, so the plain message
 * goes in `error` and the renderer's fallback surfaces it verbatim.
 *
 * This lives outside `public-contract.ts` deliberately: plugins vendor that
 * import-free module unchanged from an app release tag.
 */
export function buildInstallFailureResult(
  slug: string,
  error: unknown,
  fallbackMessage: string,
): PluginInstallResultPayload {
  const message = (error instanceof Error ? error.message : "") || fallbackMessage;
  const code = error instanceof IncompatibleAppVersionError
    ? INCOMPATIBLE_APP_VERSION_CODE
    : error instanceof ProcessEntryUnsupportedError
      ? PROCESS_ENTRY_UNSUPPORTED_CODE
    : undefined;
  return {
    slug,
    success: false,
    error: code ?? message,
    ...(code ? { message } : {}),
  };
}
