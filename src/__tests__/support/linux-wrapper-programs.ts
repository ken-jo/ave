import { afterAll, beforeAll } from "vitest";
import type { SandboxManager, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { installProgramsOnPath, type ProgramsOnPath } from "./planted-program-posix.js";

/** Supply executable placeholders for suites that simulate Linux and stub the sandbox runtime. */
export function registerLinuxWrapperProgramFixtures(): void {
  let programs: ProgramsOnPath;
  beforeAll(() => { programs = installProgramsOnPath(["bwrap", "socat", "rg"], "linux"); });
  afterAll(async () => { await programs.restore(); });
}

type ManagerConfigLifecycle = Partial<Pick<typeof SandboxManager, "initialize" | "updateConfig">> & {
  reset?: () => unknown;
};

/** Track the current configuration across the simulated manager's lifecycle. */
export function withSandboxManagerConfig<Members extends object>(members: Members & ManagerConfigLifecycle) {
  let config: SandboxRuntimeConfig | undefined;
  return {
    ...members,
    async initialize(...args: Parameters<typeof SandboxManager.initialize>) {
      await members.initialize?.(...args);
      config = args[0];
    },
    getConfig: () => config,
    updateConfig(next: SandboxRuntimeConfig) {
      members.updateConfig?.(next);
      config = next;
    },
    async reset() {
      config = undefined;
      return members.reset?.();
    },
  };
}
