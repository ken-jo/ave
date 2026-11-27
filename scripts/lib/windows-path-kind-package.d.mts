import type { WindowsPathKindBuild } from "../build-windows-path-kind.mjs";

export declare function recordWindowsPathKindPackageBuild(options: {
  appOutDir: string;
  arch: string;
  receiptPath: string | undefined;
  bundleDir: string;
  skillScriptsDir: string;
  build: Pick<WindowsPathKindBuild, "binarySha256" | "imageSha256">;
}): void;
export declare function assertPackagedWindowsPathKind(appOutDir: string, arch: string): void;
export declare function assertSignedWindowsPathKind(appOutDir: string, arch: string): void;
