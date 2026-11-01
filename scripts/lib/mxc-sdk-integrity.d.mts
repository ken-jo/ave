export class MxcIntegrityError extends Error {}
export interface MxcSdkPins {
  sdk: {
    versions: Record<string, string>;
    packages: Record<string, string>;
    packageMetadata: Record<string, {
      name: string;
      version: string;
      main?: string;
      exports?: unknown;
      type?: string;
      imports?: unknown;
    }>;
    files: Record<string, string>;
    architectures: Record<string, Record<string, string>>;
  };
}
export function verifyMxcSdk(
  nodeModules: string,
  arch: string,
  pins: MxcSdkPins,
  environment?: NodeJS.ProcessEnv,
  strictNativeDirectories?: boolean,
): { sdkRoot: string; nativeDirectories: string[]; addonPath: string };
export function verifyMxcSupervisorRuntime(executable: string, resources: string, arch: string): string[];

export function assertMxcSdkInventory(nodeModules: string, pins: MxcSdkPins): void;
