import { vi } from "vitest";
import type { FeatureNamespaceHandle } from "../../main/storage/feature-namespace.js";

export function createSubscriptionRuntimeNamespace(): FeatureNamespaceHandle {
  return {
    dir: "C:\\isolated\\subscription-runtimes",
    childDir: vi.fn(async (name: string) => `C:\\isolated\\subscription-runtimes\\${name}`),
    readJson: vi.fn(async (_name: string, fallback: unknown) => fallback),
    writeJson: vi.fn(async () => undefined),
  } as unknown as FeatureNamespaceHandle;
}

/**
 * The service's ownership claim for this namespace's directories, which do
 * not exist. It records the paths so a test can see which were claimed.
 */
export const claimFakeRuntimeDirectories = vi.fn(async (_paths: readonly string[]): Promise<void> => undefined);
