/** What confines a container child on each OS. */
export type ContainerBackend = "process-container" | "seatbelt" | "bubblewrap";

export type ContainerArch = "x64" | "arm64";

/** Also the key of the launcher pins. */
export type ContainerTarget = "win32-x64" | "win32-arm64" | "darwin-arm64" | "linux-x64" | "linux-arm64";

export interface ContainerPlatform {
  readonly backend: ContainerBackend;
  /** Whether boot may publish a container shell or extension route on this OS. */
  readonly routeEnabled: boolean;
  readonly arches: readonly ContainerArch[];
  /** The launcher's file name under `<resources>/mxc/<arch>/`. */
  readonly launcherFile: string;
}

const CONTAINER_PLATFORMS: Readonly<Partial<Record<NodeJS.Platform, ContainerPlatform>>> = Object.freeze({
  win32: { backend: "process-container", routeEnabled: true, arches: ["x64", "arm64"], launcherFile: "wxc-exec.exe" },
  darwin: { backend: "seatbelt", routeEnabled: false, arches: ["arm64"], launcherFile: "mxc-exec-mac" },
  linux: { backend: "bubblewrap", routeEnabled: false, arches: ["x64", "arm64"], launcherFile: "lxc-exec" },
});

export function containerPlatform(platform: NodeJS.Platform): ContainerPlatform | undefined {
  return CONTAINER_PLATFORMS[platform];
}

export function isContainerRouteEnabled(platform: NodeJS.Platform): boolean {
  return containerPlatform(platform)?.routeEnabled === true;
}

/** Undefined for an OS or architecture with no container target. */
export function containerTarget(platform: NodeJS.Platform, arch: string): ContainerTarget | undefined {
  const supported = containerPlatform(platform)?.arches.find((candidate) => candidate === arch);
  return supported === undefined ? undefined : `${platform}-${supported}` as ContainerTarget;
}

/** Targets that must have a launcher pin. */
export function containerTargets(): ContainerTarget[] {
  return (Object.keys(CONTAINER_PLATFORMS) as NodeJS.Platform[]).flatMap((platform) =>
    containerPlatform(platform)?.arches.map((arch) => `${platform}-${arch}` as ContainerTarget) ?? []);
}
