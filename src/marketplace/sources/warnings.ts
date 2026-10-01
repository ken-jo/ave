/**
 * The confirmations a source can hold (design §18.2, §18.5). Each names a
 * risk the user accepted once, for one source: a warning that applied when
 * the source was added, or a class its target moved into later (*Allow…*).
 * A confirmation is per class, never per address, and never implied by
 * another:
 *
 *   - `unencrypted`: the source is read over plain http;
 *   - `token-unencrypted`: a credential (a stored token, an OS credential
 *     helper's answer) may be sent over that http connection; no policy
 *     listing implies it;
 *   - `internal-network`: the source's own server is on an internal network;
 *   - `this-computer`: the source's own server is this computer;
 *   - `internal-downloads`: the source's catalog may name other internal hosts
 *     to download from; `internal-network` does not imply it;
 *   - `network-folder`: the source is a folder on another computer, so
 *     reading it signs in to that server as the user (§18.4.6); a managed
 *     folder source holds it through its policy entry.
 *
 * Free of imports, so the renderer reads the same list main validates.
 */
const SOURCE_WARNINGS = ["unencrypted", "token-unencrypted", "internal-network", "this-computer", "internal-downloads", "network-folder"] as const;

export type SourceWarning = (typeof SOURCE_WARNINGS)[number];

export function isSourceWarning(value: unknown): value is SourceWarning {
  return typeof value === "string" && (SOURCE_WARNINGS as readonly string[]).includes(value);
}

/**
 * One warning a target needs: the host and address it was found at, when one
 * applies. For `network-folder` the host is the server the folder lives on
 * (null when the drive's mapping names none) and the address is the folder's
 * path.
 */
export interface SourceWarningView {
  warning: SourceWarning;
  host: string | null;
  address: string | null;
}
