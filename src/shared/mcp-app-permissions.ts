/** Main derives both iframe delegation and session grants from resource metadata; absent or unknown features deny. */
import type { McpUiResourcePermissions } from "../mcp/types.js";

export interface McpAppPermissionFeature {
  readonly key: keyof McpUiResourcePermissions;
  readonly allowToken: string;
  /** Session handlers must distinguish media kinds; same-origin iframe allow attributes alone do not separate camera and microphone. */
  readonly electronPermission: string;
  /** Media kinds disambiguate collapsed audio/video permissions; uniquely named features need none. */
  readonly electronMediaKind?: "video" | "audio";
}

/** Advertise only features verified end to end. Clipboard writing stays excluded because delegation cannot grant it without activation. */
export const MCP_APP_PERMISSION_FEATURES: readonly McpAppPermissionFeature[] = [
  { key: "camera", allowToken: "camera", electronPermission: "media", electronMediaKind: "video" },
  { key: "microphone", allowToken: "microphone", electronPermission: "media", electronMediaKind: "audio" },
  { key: "geolocation", allowToken: "geolocation", electronPermission: "geolocation" },
];

export function declaredFeatures(
  permissions?: McpUiResourcePermissions,
): McpAppPermissionFeature[] {
  if (!permissions || typeof permissions !== "object") return [];
  return MCP_APP_PERMISSION_FEATURES.filter((feature) => permissions[feature.key] !== undefined);
}

/** No declaration yields an empty delegation string. */
export function buildMcpAppAllowAttr(permissions?: McpUiResourcePermissions): string {
  return declaredFeatures(permissions)
    .map((feature) => feature.allowToken)
    .join("; ");
}

/** Grant only declared features; unknown permissions and indeterminate media kinds deny. */
export function isElectronPermissionGranted(
  permissions: McpUiResourcePermissions | undefined,
  permission: string,
  mediaKinds?: readonly ("video" | "audio")[],
): boolean {
  const matching = declaredFeatures(permissions).filter(
    (feature) => feature.electronPermission === permission,
  );
  if (matching.length === 0) return false;
  const kindAware = matching.some((feature) => feature.electronMediaKind !== undefined);
  if (kindAware) {
    // For media, require every requested kind to be declared; never fall back to a coarse media grant.
    if (!mediaKinds || mediaKinds.length === 0) return false;
    return mediaKinds.every((kind) =>
      matching.some((feature) => feature.electronMediaKind === kind),
    );
  }
  return true;
}
