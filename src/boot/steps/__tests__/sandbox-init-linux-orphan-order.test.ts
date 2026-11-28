import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Design 3 rule 4: the boot stop of holders an exited Ave left running runs before any listener opens. On Linux the
// first listener is the container canary's, opened by the shell support detection.
describe("Linux boot orphan holder stop", () => {
  it("runs in the boot sweep, before the container canary opens its listener", () => {
    const source = readFileSync(new URL("../sandbox-init.ts", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function recordLinuxShellSupport"));
    const sweep = body.indexOf("stopOrphanHolders: true");
    const canary = body.indexOf("detectHostMxcLinuxShellSupport(getHostResources()");
    expect(sweep).toBeGreaterThan(0);
    expect(canary).toBeGreaterThan(sweep);
  });
});
