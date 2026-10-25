export const PLUGIN_INSTALL_FAILURE_KINDS = [
  "manifest-validation-error",
  "incompatible-app-version",
  "incompatible-host-protocol",
  "process-entry-unconfined",
  "process-entry-requires-pinned-artifact",
  "sandbox-grant-outside-ceiling",
  "plugin-revoked",
  "untrusted-manifest-path",
  "load-crash",
] as const;

export type PluginInstallFailureKind = (typeof PLUGIN_INSTALL_FAILURE_KINDS)[number];

export function isPluginInstallFailureKind(value: unknown): value is PluginInstallFailureKind {
  return typeof value === "string" && PLUGIN_INSTALL_FAILURE_KINDS.includes(value as PluginInstallFailureKind);
}

/** Reinstall cannot change app/protocol compatibility, sandbox activation, artifact provenance, grant ceilings, or revocation. Diagnose these instead of retrying. */
const REINSTALL_NOT_FIXABLE_KINDS: ReadonlySet<PluginInstallFailureKind> = new Set([
  "incompatible-app-version",
  "incompatible-host-protocol",
  "process-entry-unconfined",
  "process-entry-requires-pinned-artifact",
  "sandbox-grant-outside-ceiling",
  "plugin-revoked",
]);

/** A reinstall repairs payload and manifest-path failures; an unclassified failure gets one attempt before diagnosis and removal. */
export function isReinstallFixableFailureKind(kind: PluginInstallFailureKind | undefined): boolean {
  if (kind === undefined) return true;
  return !REINSTALL_NOT_FIXABLE_KINDS.has(kind);
}
