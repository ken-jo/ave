import type { UvTarget } from "../uv-targets.mjs";

interface VerifyPinnedAttestationsOptions {
  loadArchive: (target: UvTarget) => Promise<Buffer>;
  run?: (
    file: string,
    args: string[],
    options: { stdio: "inherit"; windowsHide: boolean },
  ) => { status: number | null; signal?: NodeJS.Signals | null; error?: NodeJS.ErrnoException };
}

export function verifyPinnedAttestations(options: VerifyPinnedAttestationsOptions): Promise<void>;
