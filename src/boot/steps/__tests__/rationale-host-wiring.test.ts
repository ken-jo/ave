import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../__tests__/test-helpers.js";
import { watchPermissionEvents } from "../../../__tests__/support/permission-events.js";
import type { BootContext } from "../../context.js";
import { wireRationaleHost } from "../rationale-host-wiring.js";

const temp = useTempDirs("ave-rationale-boot-");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeContext() {
  const home = temp();
  vi.stubEnv("AVE_HOME", home);
  const encryption = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }),
  };
  const ctx = {
    host: { encryption },
    approvalGate: {},
    permissionManager: {},
    toolRegistry: { getGeneration: vi.fn(() => "registry-1") },
    get rationaleScopeReviewer() {
      throw new Error("Reviewer must be resolved at invocation");
    },
  } as unknown as BootContext;
  return { ctx, home };
}

describe("wireRationaleHost", () => {
  it("opens new execution state while leaving a corrupt previous journal in place", async () => {
    const { ctx, home } = makeContext();
    const oldDir = join(home, "rationale");
    mkdirSync(oldDir);
    const legacy = join(oldDir, "invocation-journal-v1.json");
    writeFileSync(legacy, "corrupt");
    const events: Record<string, unknown>[] = [];
    watchPermissionEvents((event) => events.push(event));

    await wireRationaleHost(ctx);
    expect(ctx.rationaleHostService).toBeDefined();
    expect(events).toContainEqual(expect.objectContaining({ event: "rationale_recovery", recovered: 0 }));
    expect(readFileSync(legacy, "utf8")).toBe("corrupt");
  });

  it("leaves rationale authority unavailable when execution recovery fails", async () => {
    const { ctx } = makeContext();
    const createHostService = vi.fn();

    await wireRationaleHost(ctx, {
      createInvocationJournal: () => ({
        commitStart: vi.fn(),
        commitTerminal: vi.fn(),
        recoverAfterCrash: vi.fn(async () => { throw new Error("Corrupt state"); }),
      }),
      createHostService,
    });

    expect(ctx.rationaleHostService).toBeUndefined();
    expect(createHostService).not.toHaveBeenCalled();
  });
});
