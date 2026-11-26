import { vi } from "vitest";

/**
 * Test double for git-repository-inspection-client.js: the same synchronous inspection,
 * run in the test's own thread so its filesystem spies and fixture stabilisation apply.
 * The worker transport itself is covered by git-repository-inspection-client.test.ts.
 */
export async function inProcessRepositoryInspectionModule() {
  const { inspectGitRepository } = await import("../../permissions/rules/git-repository-inputs.js");
  return {
    inspectGitRepositoryAsync: vi.fn(async (cwd: string) => inspectGitRepository(cwd)),
  };
}
