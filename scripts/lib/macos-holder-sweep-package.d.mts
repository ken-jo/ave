export declare const MACOS_HOLDER_SWEEP_BUNDLE_PIN: string;
export declare function macosHolderSweepBundlePinDeclaration(imageSha256: string): string;
export declare function packagedMacosHolderSweep(resourcesDir: string, arch: string): string;
export declare function recordMacosHolderSweepPackageBuild(input: {
  appOutDir: string; arch: string; build: { binarySha256: string; imageSha256: string }; bundleDir: string;
}): void;
export declare function assertPackagedMacosHolderSweep(appOutDir: string, resourcesDir: string, arch: string): void;
export declare function assertSignedMacosHolderSweep(appOutDir: string, resourcesDir: string, appBundle: string, arch: string,
  run?: typeof import("node:child_process").spawnSync): void;
