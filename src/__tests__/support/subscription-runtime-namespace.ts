import { refuseNamespaceFileCreation } from "./feature-namespace.js";
import { vi } from "vitest";
import type { FeatureNamespaceHandle } from "../../main/storage/feature-namespace.js";

export function createSubscriptionRuntimeNamespace(): FeatureNamespaceHandle {
  return {
    dir: "C:\\isolated\\subscription-runtimes",
    createFile: refuseNamespaceFileCreation,
    childDir: vi.fn(async (name: string) => `C:\\isolated\\subscription-runtimes\\${name}`),
    readJson: async <T>(_name: string, fallback: T): Promise<T> => fallback,
    writeJson: vi.fn(async () => undefined),
  } satisfies FeatureNamespaceHandle;
}

/** Record directory ownership claims without creating namespace paths. */
export const claimFakeRuntimeDirectories = vi.fn(async (_paths: readonly string[]): Promise<void> => undefined);
