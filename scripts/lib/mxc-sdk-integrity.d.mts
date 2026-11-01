export class MxcIntegrityError extends Error {}
export interface MxcSdkPins {
  sdk: {
    versions: Record<string, string>;
    packages: Record<string, string>;
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
