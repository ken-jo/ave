import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import * as policyHome from "../../shared/policy-home.js";
import { checkAsrtDependencies, initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../asrt-sandbox.js";
import { asrtCanInitialize } from "./test-helpers.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

useVerifiedAveHomePrivacy();

describe.skipIf(process.platform !== "win32")("Windows native deny placeholder lifecycle", () => {
  let fixture: string | undefined;
  let nativeAvailable: boolean | undefined;
  let nativeFailure = "The native sandbox cannot initialize on this host";

  function skipNative(context: TestContext): never {
    Object.assign(context.task.meta, { nativeFailure });
    return context.skip(nativeFailure);
  }

  beforeEach(async context => {
    fixture = mkdtempSync(join(tmpdir(), "deny-placeholder-"));
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([fixture]);
    const initialize = SandboxManager.initialize;
    vi.spyOn(SandboxManager, "initialize").mockImplementation((...args) => {
      const config = args[0];
      const withinFixture = (entry: NonNullable<typeof config.filesystem>["denyRead"][number]): boolean => {
        const path = typeof entry === "string" ? entry : entry.path;
        const rel = relative(fixture!, path);
        return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
      };
      // Limit native ACL work to directories this test owns.
      return initialize({ ...config, filesystem: {
        ...config.filesystem,
        denyRead: (config.filesystem?.denyRead ?? []).filter(withinFixture),
        denyWrite: (config.filesystem?.denyWrite ?? []).filter(withinFixture),
      } }, args[1], args[2]);
    });
    if (nativeAvailable === true) return;
    if (nativeAvailable === false) return skipNative(context);
    nativeAvailable = false;
    const dependencies = await checkAsrtDependencies();
    if (dependencies.errors.length > 0) {
      nativeFailure = `Native dependencies unavailable: ${dependencies.errors.join("; ")}`;
      return skipNative(context);
    }
    if (!(await asrtCanInitialize())) {
      return skipNative(context);
    }
    const probe = mkdtempSync(join(fixture, "capability-"));
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowRead: [probe], allowWrite: [probe] });
      nativeAvailable = true;
    } catch (error) {
      nativeFailure = `Native initialization unavailable: ${String(error)}`;
      return skipNative(context);
    } finally {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
      await cleanupTmpDir(probe);
    }
  }, 240_000);

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    if (fixture) await cleanupTmpDir(fixture);
    fixture = undefined;
  });

  it("removes a missing deny leaf and its created intermediate directories on reset", async () => {
    const intermediate = join(fixture!, "new", "deep");
    const target = join(intermediate, "policy.json");
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyRead: [target] });
    expect(existsSync(target)).toBe(true);
    await resetAsrtSandbox();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(fixture!, "new"))).toBe(false);
  }, 60_000);

  it("removes partial placeholders after a deterministic stamp failure", async () => {
    const target = join(fixture!, "created", "deep", "secret");
    const blocker = join(fixture!, "blocker");
    writeFileSync(blocker, "fixture data");
    await expect(initializeAsrtSandbox({
      allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!],
      denyRead: [target, join(blocker, "impossible")],
    })).rejects.toMatchObject({ code: "acl_stamp_failed" });
    expect(isAsrtSandboxActive()).toBe(false);
    expect(existsSync(join(fixture!, "created"))).toBe(false);
    expect(readFileSync(blocker, "utf8")).toBe("fixture data");
  }, 60_000);

  it("preserves a placeholder containing user data and warns with its path", async () => {
    const target = join(fixture!, "new", "secret");
    const warn = vi.spyOn(console, "warn");
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyRead: [target] });
    writeFileSync(target, "user data");
    await resetAsrtSandbox();
    expect(readFileSync(target, "utf8")).toBe("user data");
    expect(warn.mock.calls.filter(call => call.some(value => String(value).includes(target)))).toHaveLength(1);
  }, 60_000);

  it("preserves a directory placeholder that gained a child directory", async () => {
    const target = join(fixture!, "new", "directory");
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyWrite: [target + "/"] });
    expect(existsSync(target)).toBe(true);
    mkdirSync(join(target, "user-directory"));
    await resetAsrtSandbox();
    expect(existsSync(join(target, "user-directory"))).toBe(true);
  }, 60_000);

  it("releases native denies before the exit hook removes placeholders", async () => {
    const target = join(fixture!, "new", "exit-secret");
    const prepend = vi.spyOn(process, "prependOnceListener");
    await initializeAsrtSandbox({ allowedDomains: [], allowRead: [fixture!], allowWrite: [fixture!], denyRead: [target] });
    expect(existsSync(target)).toBe(true);
    const exits = prepend.mock.calls.filter(([event]) => event === "exit");
    expect(exits).toHaveLength(1);
    exits[0]![1](0);
    expect(existsSync(join(fixture!, "new"))).toBe(false);
  }, 60_000);
});
