export declare function linuxExecutablePreferenceSuffixes(arch: string, separator: string): string[];

export declare function pickBestByExactSuffix(
  paths: readonly string[],
  preferredSuffixes: readonly string[],
): string | null;
