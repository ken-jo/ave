import type { WindowsPathKindBuild } from "../build-windows-path-kind.mjs";

export declare function recordWindowsPathKindPackageBuild(options: {
  appOutDir: string;
  arch: string;
  manifest: { windowsPathKind?: { arch: string; imageSha256: string; bundleSha256: Record<string, string> } | null };
  bundleDir: string;
  build: Pick<WindowsPathKindBuild, "binarySha256" | "imageSha256">;
}): void;
export declare function assertPackagedWindowsPathKind(appOutDir: string, arch: string): void;
export declare function assertSignedWindowsPathKind(appOutDir: string, arch: string): void;
