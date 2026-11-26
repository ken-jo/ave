export interface WindowsPathKindProfileSettings {
  readonly "opt-level": number;
  readonly "codegen-units": number;
  readonly strip: string;
  readonly [setting: string]: string | number | boolean;
}

export interface WindowsPathKindToolPaths {
  rustc: string;
  cargo: string;
  linker: string;
}

interface WindowsPathKindFileIdentity {
  path: string;
  sha256: string;
}

interface WindowsPathKindInputs {
  systemRoot: string;
  sysroot: string;
  sdkImports: string;
  staticCrt: string[];
  tools: WindowsPathKindFileIdentity[];
  rustLibraries: WindowsPathKindFileIdentity[];
  libraries: WindowsPathKindFileIdentity[];
}

export interface WindowsPathKindCompiler extends WindowsPathKindToolPaths {
  toolchain: string;
  compiler: string;
  host: string;
  target: string;
  rustupRoot: string;
  inputs: WindowsPathKindInputs;
  profile: string;
  profileSettings: WindowsPathKindProfileSettings;
  rustflags: string[];
}

export interface WindowsPathKindBuild {
  identity: WindowsPathKindCompiler;
  targetDir: string;
  invocation: string;
}

export const WINDOWS_PATH_KIND_PROFILE: string;
export const WINDOWS_PATH_KIND_PROFILE_SETTINGS: WindowsPathKindProfileSettings;
export function windowsPathKindRustupRoot(): string;
export function windowsPathKindToolPaths(rustupRoot: string, toolchain: string, host: string): WindowsPathKindToolPaths;
export function windowsPathKindSystemEnvironment(systemRoot: string): NodeJS.ProcessEnv;
export function windowsPathKindRustflags(linker: string, inputs: WindowsPathKindInputs): string[];
export function windowsPathKindToolchain(root: string): string;
export function windowsPathKindTarget(arch: string): string;
export function windowsPathKindCompiler(root: string, arch: string): WindowsPathKindCompiler;
export function windowsPathKindCompilerCommand(identity: WindowsPathKindCompiler, targetDir: string, metadata: string, fixture?: boolean): string;
export function assertWindowsPathKindInvocation(build: WindowsPathKindBuild, fixture?: boolean): void;
export function windowsPathKindPath(arch: string): string;
export function windowsPathKindReceiptPath(arch: string): string;
export function windowsPathKindCrateFiles(root: string): string[];
export function assertWindowsPathKindLinkInputs(stdout: string, identity: WindowsPathKindCompiler, buildDir: string, exe: string): void;
export function assertWindowsPathKindInputDigests(inputs: WindowsPathKindInputs): void;
export function windowsPathKindSourceDigest(root: string, crateRoot?: string): string;
export function assertWindowsPathKindMachine(bytes: Buffer, arch: string): void;
export function windowsPathKindReceipt(root: string, arch: string, build: WindowsPathKindBuild, binary: Buffer): WindowsPathKindBuild & {
  sourceSha256: string;
  binarySha256: string;
};
export function assertWindowsPathKindArtifactDigests(root: string, arch: string, digests: {
  binarySha256?: string;
  receiptSha256?: string;
}): void;
export function verifyWindowsPathKindReceipt(root: string, arch: string): void;
