import type { execFileSync } from "node:child_process";

export type LinuxPackageArch = "x64" | "arm64";

export interface LinuxArchSpec {
  readonly machine: number;
  readonly filePattern: RegExp;
  readonly debArch: string;
  readonly rpmArch: string;
  readonly uvDir: string;
}

export interface ElfHeader {
  readonly valid: boolean;
  readonly elfClass: 32 | 64 | null;
  readonly littleEndian: boolean | null;
  readonly machine: number | null;
}

export interface ArchAuditResult {
  readonly violations: string[];
  readonly checked: { path: string; file: string }[];
}

export function archSpec(arch: string): LinuxArchSpec;
export function parseElfHeader(bytes: Uint8Array): ElfHeader | null;
export function describeMachine(header: ElfHeader | null): string;
export function auditTree(
  root: string,
  arch: LinuxPackageArch,
  options?: { fileCommand?: (path: string) => string; label?: string },
): ArchAuditResult;
export function auditLinuxRelease(
  releaseDir: string,
  arch: LinuxPackageArch,
  options?: { requireInstallers?: boolean; fileCommand?: (path: string) => string; exec?: typeof execFileSync },
): ArchAuditResult;
