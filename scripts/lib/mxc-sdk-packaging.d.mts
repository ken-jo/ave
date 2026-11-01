import type { verifyMxcSdk } from "./mxc-sdk-integrity.mjs";

export function assertPackagedMxcSdk(resources: string, arch: string): ReturnType<typeof verifyMxcSdk>;
export function finalizePackagedMxcSdk(resources: string, arch: string, executable: string): void;
export function prunePackagedMxcSdk(resources: string, arch: string): void;
export function recordMxcSupervisorRuntime(resources: string, arch: string, executable: string): void;
export function pruneMxcSdkAddonArchitectures(modules: string, arch: string): void;
export function assertMxcSupervisorFuse(config: { electronFuses?: { runAsNode?: boolean } }): void;

export function pruneMxcPtyBuildPayloads(modules: string, arch: string): void;
