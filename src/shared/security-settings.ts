/** Security controls have one user-consented write boundary. */
export const SECURITY_FEATURE_KEYS = [
  "osToolSandbox", "pluginWorkerConfinement", "shellEgressAsk",
  "a2aLoopbackServer", "a2aRemoteRouting", "a2aRemoteReceiver",
] as const;
type SecurityFeatureKey = (typeof SECURITY_FEATURE_KEYS)[number];
export type SecuritySettingsPatch = { features?: Partial<Record<SecurityFeatureKey, boolean>>; system?: { localApiServer?: boolean } };
export function containsSecuritySettings(patch: unknown): boolean {
  if (typeof patch !== "object" || patch === null) return false;
  const body = patch as Record<string, unknown>;
  const features = body.features;
  const system = body.system;
  return (typeof features === "object" && features !== null && SECURITY_FEATURE_KEYS.some((key) => Object.hasOwn(features, key)))
    || (typeof system === "object" && system !== null && Object.hasOwn(system, "localApiServer"));
}
export function isSecuritySettingsPatch(patch: unknown): patch is SecuritySettingsPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const entries = Object.entries(patch);
  if (entries.length === 0) return false;
  return entries.every(([group, values]) => {
    if (group !== "features" && group !== "system") return false;
    if (!values || typeof values !== "object" || Array.isArray(values)) return false;
    const fields = Object.entries(values);
    return fields.length > 0 && fields.every(([key, value]) => typeof value === "boolean"
      && (group === "features" ? (SECURITY_FEATURE_KEYS as readonly string[]).includes(key) : key === "localApiServer"));
  });
}
