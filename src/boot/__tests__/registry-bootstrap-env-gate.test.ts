import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  admissionInit: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/admission/admission-registry.js", () => ({
  admissionRegistry: { init: registryMocks.admissionInit },
}));

import { _resetForTest } from "../dev-flags.js";
import { wireAdmissionRegistry } from "../steps/admission-bootstrap.js";

const OFFLINE_NAMES = ["AVE_ADMISSION_OFFLINE"] as const;

const savedValues = new Map<string, string | undefined>();

async function wireAll(packaged: boolean): Promise<void> {
  await wireAdmissionRegistry({
    userDataPath: "/tmp/ave-registry-env-gate",
    bootAuditLogger: { log: vi.fn() } as never,
    networkFetch: vi.fn() as unknown as typeof fetch,
    packaged,
  });
}

describe("registry bootstrap development env gate", () => {
  beforeEach(() => {
    _resetForTest();
    registryMocks.admissionInit.mockClear();
    for (const name of OFFLINE_NAMES) {
      savedValues.set(name, process.env[name]);
      process.env[name] = "1";
    }
  });

  afterEach(() => {
    _resetForTest();
    for (const name of OFFLINE_NAMES) {
      const saved = savedValues.get(name);
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
    savedValues.clear();
  });

  it("ignores the offline flag in packaged mode even without an env scrub", async () => {
    await wireAll(true);

    expect(registryMocks.admissionInit).toHaveBeenCalledWith(expect.objectContaining({ online: true }));
  });

  it("retains the offline flag for unpackaged source and E2E runs", async () => {
    await wireAll(false);

    expect(registryMocks.admissionInit).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
  });
});
