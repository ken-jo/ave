export function assertNoWindowsProtocolClaim(
  executable: string,
  options?: {
    platform?: NodeJS.Platform;
    run?: (
      command: string,
      args: readonly string[],
      options: { encoding: "utf8"; env: Record<string, string | undefined>; timeout: number; windowsHide: boolean },
    ) => { status: number | null; stdout: string; stderr: string; error?: Error };
  },
): void;
