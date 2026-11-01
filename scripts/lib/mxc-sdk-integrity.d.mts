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

export function assertMxcSdkInventory(nodeModules: string, pins: MxcSdkPins, arch?: string): void;

export function verifyMxcSdkSource(nodeModules: string, arch: string, pins: MxcSdkPins, environment?: NodeJS.ProcessEnv): ReturnType<typeof verifyMxcSdk>;

export const SDK_INSTALLATION_AUXILIARIES: ReadonlySet<string>;

export const PACKAGE_RUNTIME_FIELDS: readonly string[];

export const PTY_SOURCE_BUILD_DIRECTORIES: readonly string[];
