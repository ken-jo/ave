/**
 * A missing vendored `apply-seccomp` helper must not fail ASRT initialization:
 * the default mode degrades a failed init to isolation=none, which would cost
 * the session its filesystem confinement to lose only seccomp. The resolver
 * warns once and pins nothing, so ASRT resolves the helper itself as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../../lib/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/logger.js")>();
  return {
    ...original,
    createLogger: (name: string) => {
      const real = original.createLogger(name);
      return name === "asrt-sandbox"
        ? new Proxy(real, { get: (target, key) => (key === "warn" ? (message: string) => warnings.push(message) : Reflect.get(target, key)) })
        : real;
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const realpathSync = ((path: Parameters<typeof original.realpathSync>[0], options?: never) => {
    if (/[\\/]apply-seccomp$/.test(String(path))) {
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
    }
    return original.realpathSync(path, options);
  }) as typeof original.realpathSync;
  realpathSync.native = original.realpathSync.native;
  return { ...original, default: { ...original, realpathSync }, realpathSync };
});

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { buildPerCommandSandboxCustomConfig, buildSandboxConfig, getVendoredApplySeccompPath } from "../asrt-sandbox.js";

describe("asrt-sandbox — a missing Linux seccomp helper", () => {
  const hostPlatform = process.platform;
  afterEach(() => setProcessPlatform(hostPlatform));

  it("warns once and pins or grants nothing, without throwing", () => {
    setProcessPlatform("linux");
    expect(getVendoredApplySeccompPath()).toBeUndefined();
    expect(buildSandboxConfig({ allowedDomains: [] }).seccomp).toBeUndefined();
    // A deny over the whole filesystem would cover the helper wherever it lives.
    expect(buildPerCommandSandboxCustomConfig({ denyRead: ["/"], allowRead: [] })?.filesystem?.allowRead).toEqual([]);
    expect(buildPerCommandSandboxCustomConfig({ denyRead: ["/"] })?.filesystem?.allowRead).toBeUndefined();
    const seccompWarnings = warnings.filter((message) => message.includes("[sandbox-seccomp-unavailable]"));
    expect(seccompWarnings).toHaveLength(1);
    expect(seccompWarnings[0]).toMatch(/apply-seccomp/);
  });
});
