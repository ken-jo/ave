import { resolveVerifiedExecutable, type VerifiedExecutableCandidate } from "../../shared/verified-executable.js";
import type { VerifiedNativePlan } from "./verified-native-plan.js";

interface LauncherRecipe {
  readonly prefix: readonly string[];
  readonly installations: Readonly<Partial<Record<NodeJS.Platform, readonly VerifiedExecutableCandidate[]>>>;
  readonly environment: Readonly<Record<string, string>>;
}

const LAUNCHER_RECIPES: readonly LauncherRecipe[] = Object.freeze([
  Object.freeze({
    prefix: Object.freeze(["bash", "--noprofile", "--norc", "-p", "-c"]),
    installations: Object.freeze({
      darwin: Object.freeze([{ executable: "/bin/bash", installationRoots: ["/bin/bash"] }]),
      linux: Object.freeze([{ executable: "/usr/bin/bash", installationRoots: ["/usr/bin/bash"] }]),
    }),
    environment: Object.freeze({}),
  }),
]);

/** Requires literal parsed argv; the host must bind the resulting image and retain payload inspection. */
export function proveVerifiedLauncherArgv(argv: readonly string[]): VerifiedNativePlan | null {
  for (const recipe of LAUNCHER_RECIPES) {
    const payloadIndex = recipe.prefix.length;
    if (argv.length !== payloadIndex + 1 || !recipe.prefix.every((value, index) => argv[index] === value)) continue;
    const payload = argv[payloadIndex]!;
    if (payload.length === 0 || payload.includes("\0")) return null;
    const candidates = recipe.installations[process.platform];
    if (candidates === undefined) return null;
    const verified = resolveVerifiedExecutable(candidates, process.platform);
    if (verified === null) return null;
    return Object.freeze({
      executable: verified.executable,
      args: Object.freeze(argv.slice(1)),
      environment: recipe.environment,
      proof: Object.freeze({
        kind: "literal-evaluation",
        payloadIndexes: Object.freeze([payloadIndex]),
        changesState: false,
      }),
    });
  }
  return null;
}
