export interface WindowsPathKindCompiler {
  toolchain: string;
  compiler: string;
  target: string;
  profile: string;
  rustflags: string;
}

export const WINDOWS_PATH_KIND_PROFILE: string;
export const WINDOWS_PATH_KIND_RUSTFLAGS: string;
export function windowsPathKindToolchain(root: string): string;
export function windowsPathKindTarget(arch: string): string;
export function windowsPathKindCompiler(root: string, arch: string): { executable: string; identity: WindowsPathKindCompiler };
export function windowsPathKindPath(arch: string): string;
export function windowsPathKindReceiptPath(arch: string): string;
export function windowsPathKindSourceDigest(root: string): string;
export function assertWindowsPathKindMachine(bytes: Buffer, arch: string): void;
export function windowsPathKindReceipt(root: string, arch: string, identity: WindowsPathKindCompiler, binary: Buffer): {
  identity: WindowsPathKindCompiler;
  sourceSha256: string;
  binarySha256: string;
};
export function verifyWindowsPathKindBuild(root: string, arch: string): void;
