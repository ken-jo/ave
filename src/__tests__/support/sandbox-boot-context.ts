import { vi } from "vitest";
import type { BootContext } from "../../boot/context.js";
import { createBootHostFixture } from "./host-runtime.js";
import { DEFAULT_UPSTREAM_PROXY } from "../../shared/upstream-proxy.js";

export interface SandboxBootHarness {
  readonly logSandboxGate: ReturnType<typeof vi.fn>;
  readonly flush: ReturnType<typeof vi.fn>;
  context(settingOn: boolean, pluginWorkerConfinement?: boolean): BootContext;
}

/** Build a fresh boot context per test so audit spies cannot leak between cases. */
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
              : key === "upstreamProxy"
                ? { ...DEFAULT_UPSTREAM_PROXY }
                : undefined,
          ),
          getSecret: vi.fn(() => null),
          onChanged: vi.fn(() => () => {}),
        },
        bootAuditLogger: { logSandboxGate, flush },
        approvalGate: { requestAndWait: vi.fn(async () => ({ choice: "deny-once" })) },
        buildWorkerEgressAllowlists: vi.fn(async () => ({ byExtension: new Map(), modelEndpointHosts: [] })),
      }) as unknown as BootContext,
  };
}
