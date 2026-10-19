import { vi } from "vitest";
import type { BootContext } from "../../boot/context.js";
import { createBootHostFixture } from "./host-runtime.js";

export interface SandboxBootHarness {
  /** The gate's audit sink, for asserting outcome and call ordering. */
  readonly logSandboxGate: ReturnType<typeof vi.fn>;
  /** The audit drain the abort paths must await before throwing. */
  readonly flush: ReturnType<typeof vi.fn>;
  /**
   * A boot context whose knobs are the shell sandbox setting and, optionally,
   * the plugin-worker confinement setting (off unless given).
   */
  context(settingOn: boolean, pluginWorkerConfinement?: boolean): BootContext;
}

/**
 * The minimal host `initSandboxGate` needs, with its audit spies.
 *
 * Both sandbox boot suites drive the same gate from the same two inputs (this
 * setting and `AVE_SANDBOX_ENABLED`). A copy per suite is a second place for
 * the context to fall behind `BootContext`, after which the two suites are
 * testing subtly different hosts and neither one says so.
 *
 * Build it fresh per test — it owns the spies, so a shared instance would carry
 * one test's calls into the next.
 */
export function createSandboxBootHarness(): SandboxBootHarness {
  const logSandboxGate = vi.fn();
  const flush = vi.fn(async () => undefined);
  return {
    logSandboxGate,
    flush,
    context: (settingOn: boolean, pluginWorkerConfinement = false): BootContext =>
      ({
        host: createBootHostFixture(),
        settingsService: {
          get: vi.fn((key: string) =>
            key === "features"
              ? { osToolSandbox: settingOn, pluginWorkerConfinement, hostClassifiesRisk: false }
              : undefined,
          ),
        },
        bootAuditLogger: { logSandboxGate, flush },
        pluginRuntime: {
          listPluginIds: vi.fn(() => []),
          getPluginManifest: vi.fn(() => undefined),
        },
        buildSandboxUnionDomains: vi.fn(async () => []),
      }) as unknown as BootContext,
  };
}
