import { homedir } from "node:os";

/** Resolve policy roots without changing the environment passed to children. */
export function getPolicyHome(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (environment.HOME) return environment.HOME;
  if (platform === "win32") {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) return environment.HOMEDRIVE + environment.HOMEPATH;
  }
  const home = homedir();
  if (!home) throw new Error("Cannot resolve home for path policy");
  return home;
}
