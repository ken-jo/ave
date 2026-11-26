import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { normalizePathForSandbox } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { expandWindowsFsPaths } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const hostPlatform = process.platform;

// A drive spelling keeps Windows path rules on every host; a POSIX host's own rules read it as relative.
describe("Windows spellings under the host path module", () => {
  const profile = win32.join("D:\\", `ave-absent-${randomBytes(6).toString("hex")}`, "profile");
  const target = win32.join(profile, ".ave", "browser-downloads");

  beforeEach(() => {
    setProcessPlatform("win32");
    vi.spyOn(process, "cwd").mockReturnValue(profile);
  });

  afterEach(() => {
    setProcessPlatform(hostPlatform);
    vi.restoreAllMocks();
  });

  it("keeps an absolute drive literal without a working-directory prefix", () => {
    expect(normalizePathForSandbox(target, { literal: true })).toBe(target);
    expect(normalizePathForSandbox(target)).toBe(target);
  });

  it("keeps an absent drive deny exactly as spelled", () => {
    expect(expandWindowsFsPaths([target], { mode: "deny" })).toEqual([target]);
    expect(expandWindowsFsPaths([{ path: target, literal: true }], { mode: "deny" })).toEqual([target]);
  });
});
