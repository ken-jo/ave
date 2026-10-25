/** Default audit writers must use isolated test homes; missing test homes fail before directory creation. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});

import { AuditLogger } from "../audit-logger.js";
import { AuditService } from "../../main/audit-service.js";
import { defaultAveHome } from "../../shared/ave-home.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";

const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
const fileEnv = {
  AVE_HOME: process.env.AVE_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
const refusal = /refusing to resolve AVE_HOME to .* from a test process/;
const scratch = useTempDirs("audit-home-account-");

afterEach(() => {
  vi.mocked(userInfo).mockImplementation(actualOs.userInfo);
  for (const [name, value] of Object.entries(fileEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function homelessOnScratchAccount(): string {
  const home = scratch();
  mkdirSync(join(home, ".ave"));
  vi.mocked(userInfo).mockReturnValue({ ...actualOs.userInfo(), homedir: home });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.AVE_HOME;
  return join(home, ".ave");
}

describe("audit writers under the test runner", () => {
  it("start in this file's own home under test-tmp", () => {
    expect(fileEnv.AVE_HOME).toBeDefined();
    expect(dirname(dirname(fileEnv.AVE_HOME!))).toBe(join(defaultAveHome(), "test-tmp"));
  });

  it("write a default AuditLogger's log into this file's home", async () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const logger = new AuditLogger(undefined, { now: () => now });
    try {
      logger.log({ timestamp: now.toISOString(), sessionId: "audit-home-isolation", type: "turn" });
      await logger.flush();
      const file = join(fileEnv.AVE_HOME!, "audit", "2026-10-02.jsonl");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("audit-home-isolation");
    } finally {
      await logger.close();
    }
  });

  it("refuse a default AuditLogger when the test has no home, before creating its directory", () => {
    const accountAve = homelessOnScratchAccount();
    expect(() => new AuditLogger()).toThrow(refusal);
    expect(existsSync(join(accountAve, "audit"))).toBe(false);
  });

  it("refuse a default AuditService when the test has no home", () => {
    homelessOnScratchAccount();
    expect(() => new AuditService()).toThrow(refusal);
  });
});
