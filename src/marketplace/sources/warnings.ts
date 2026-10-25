/** Source consent is specific to each risk class; network access never implies credential or update consent.
 * Plaintext automatic-update consent is recorded only by main when the user enables it. */
const SOURCE_WARNINGS = ["unencrypted", "token-unencrypted", "internal-network", "this-computer", "internal-downloads", "network-folder", "unencrypted-updates"] as const;

export type SourceWarning = (typeof SOURCE_WARNINGS)[number];

export function isSourceWarning(value: unknown): value is SourceWarning {
  return typeof value === "string" && (SOURCE_WARNINGS as readonly string[]).includes(value);
}

/** Network-folder warnings may lack a server name when drive mappings do not identify one. */
export interface SourceWarningView {
  warning: SourceWarning;
  host: string | null;
  address: string | null;
}
