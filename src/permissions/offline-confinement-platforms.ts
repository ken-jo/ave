const OFFLINE_CONFINEMENT_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);

/**
 * The one place that names the platforms with an offline execution confinement implementation (macOS Seatbelt,
 * Linux bubblewrap). Installation offers and engine admission use this answer; a platform outside it is
 * unsupported, never a download that cannot run. On a supported platform an unavailable runtime capability still
 * fails execution clearly with `engine-confinement-unavailable`.
 */
export function offlineProcessConfinementImplemented(platform: NodeJS.Platform = process.platform): boolean {
  return OFFLINE_CONFINEMENT_PLATFORMS.has(platform);
}
