/**
 * The audit writers a test builds with their defaults stay inside that test's
 * Ave home.
 *
 * `ConversationLoop` and the tool executor build an `AuditLogger` when their
 * caller passes none, and its directory defaults to `<aveHome()>/audit`. A
 * test that relied on that default once wrote the developer's real
 * `~/.ave/audit` and contended for its lock with the running app
 * (`ECOMPROMISED` on `<date>.jsonl.lock`). These pin both halves of the fix:
 * the default lands in the test file's own home, and a test with no home is
 * refused when the directory is named.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuditLogger } from "../audit-logger.js";
import { AuditService } from "../../main/audit-service.js";
import { defaultAveHome } from "../../shared/ave-home.js";

const fileHome = process.env.AVE_HOME;
const refusal = /refusing to resolve AVE_HOME to .* from a test process/;

afterEach(() => {
  if (fileHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = fileHome;
});

describe("audit writers under the test runner", () => {
  it("start in this file's own home under test-tmp", () => {
    expect(fileHome).toBeDefined();
    expect(dirname(dirname(fileHome!))).toBe(join(defaultAveHome(), "test-tmp"));
  });

  it("write a default AuditLogger's log into this file's home", async () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const logger = new AuditLogger(undefined, { now: () => now });
    try {
      logger.log({ timestamp: now.toISOString(), sessionId: "audit-home-isolation", type: "turn" });
      await logger.flush();
      const file = join(fileHome!, "audit", "2026-10-02.jsonl");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("audit-home-isolation");
    } finally {
      await logger.close();
    }
  });

  // AuditService only names its directory when built, so a regressed guard
  // here resolves a path and creates nothing. An AuditLogger creates its
  // directory in the constructor; its refusal is the same `aveHome()` call,
  // pinned without side effects in ave-home.test.ts.
  it("refuse a default AuditService when the test has no home", () => {
    delete process.env.AVE_HOME;
    expect(() => new AuditService()).toThrow(refusal);
  });
});
