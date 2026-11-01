import { writePermissionSettingsFixture } from "../../../__tests__/support/permission-settings-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime, createNoopHostApiForTests } from "../../runtime.js";
import { derivePluginChildEnvelope } from "../../isolation/out-of-process-plugin.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import { initializeAveHomeFixture } from "../../../__tests__/support/ave-home-privacy.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";
import { _resetAveHomePrivacyForTest } from "../../../shared/ave-home.js";

const PLUGIN_ID = "sandbox-candidate";
let root: string;
let previousHome: string | undefined;

function setApproved(directories: string[]): void {
  writePermissionSettingsFixture(join(root, "home"), JSON.stringify({
    permissions: { additionalDirectories: directories },
  }));
}

class WithdrawalRuntime extends PluginRuntime {
  register(path: string, pluginRoot: string, pluginDataDir: string, pluginId = PLUGIN_ID) {
    return this.registerSandboxEnvelope(pluginId, [path], pluginRoot, pluginDataDir);
  }

  attach(stop: () => Promise<void>, retire: () => Error[] = () => [], pluginId = PLUGIN_ID): void {
    this.plugins.set(pluginId, {
      manifest: { id: pluginId, name: "Sandbox Candidate", version: "1.0.0", entry: "index.js", description: "test", tools: [] },
      instance: { handlers: {}, stop },
      methods: new Map(),
      hostEffects: { retire },
    } as never);
  }

  failureKind(pluginId = PLUGIN_ID): string | undefined {
    return this.loadFailureInfo.get(pluginId)?.installFailureKind;
  }

  running(pluginId = PLUGIN_ID): boolean {
    return this.plugins.has(pluginId);
  }

  lifecycleAvailable(pluginId = PLUGIN_ID): void {
    this.assertPluginLifecycleAvailable(pluginId);
  }
}

function runtime(): WithdrawalRuntime {
  return new WithdrawalRuntime({
    childEntryPath: pluginChildEntryPath(),
    hostRoot: root,
    manifestPaths: [],
    encryption: unavailableSecretEncryption,
    createHostApi: createNoopHostApiForTests,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ave-sandbox-withdrawal-"));
  setFixtureOwner(root);
  previousHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(root, "home");
  await initializeAveHomeFixture(process.env.AVE_HOME);
});

afterEach(() => {
  _resetAveHomePrivacyForTest();
  if (previousHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe("approved-directory withdrawal", () => {
  it("waits for a spawn still starting to release its confined child", async () => {
    const approved = join(root, "approved");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(approved, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const pending = subject.register(approved, pluginRoot, dataDir);
    setApproved([]);
    let acknowledged = false;
    const retirement = subject.retireSandboxGrantsOutsideCeiling().then((value) => {
      acknowledged = true;
      return value;
    });
    await Promise.resolve();
    expect(pending.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
    expect(acknowledged).toBe(false);
    pending.dispose();
    expect(await retirement).toEqual([PLUGIN_ID]);
    expect(subject.failureKind()).toBe("sandbox-grant-outside-ceiling");
  });

  it("preserves a grant covered by an overlapping approved root", async () => {
    const approved = join(root, "approved");
    const nested = join(approved, "nested");
    const chosen = join(nested, "index");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(chosen, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved, nested]);
    const subject = runtime();
    const grant = subject.register(chosen, pluginRoot, dataDir);
    setApproved([nested]);
    expect(await subject.retireSandboxGrantsOutsideCeiling()).toEqual([]);
    expect(grant.assertCurrent).not.toThrow();
    grant.dispose();
  });

  it("retires a replaced directory even when its path remains under an approved root", async () => {
    const approved = join(root, "approved");
    const chosen = join(approved, "index");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(approved, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const grant = subject.register(chosen, pluginRoot, dataDir);
    expect(grant.assertCurrent).not.toThrow();
    mkdirSync(chosen);
    expect(grant.assertCurrent).not.toThrow();
    renameSync(chosen, join(approved, "held"));
    mkdirSync(chosen);
    expect(grant.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
    const retirement = subject.retireSandboxGrantsOutsideCeiling();
    grant.dispose();
    expect(await retirement).toEqual([PLUGIN_ID]);
  });

  it("waits for incarnation retirement and reports the withdrawn grant", async () => {
    const approved = join(root, "approved");
    const chosen = join(approved, "index");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(chosen, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const grant = subject.register(chosen, pluginRoot, dataDir);
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.fn(async () => { await stopped; grant.dispose(); });
    const retireEffects = vi.fn(() => []);
    subject.attach(stop, retireEffects);
    setApproved([]);
    let acknowledged = false;
    const retirement = subject.retireSandboxGrantsOutsideCeiling().then((value) => {
      acknowledged = true;
      return value;
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(retireEffects).toHaveBeenCalledOnce();
    expect(grant.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
    release();
    expect(await retirement).toEqual([PLUGIN_ID]);
    expect(subject.running()).toBe(false);
    expect(subject.failureKind()).toBe("sandbox-grant-outside-ceiling");
    const nextSpawn = () => derivePluginChildEnvelope({
      pluginId: PLUGIN_ID,
      sandbox: { write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }] },
      pluginRoot,
      pluginDataDir: dataDir,
      configValue: () => chosen,
    });
    expect(nextSpawn).toThrow(/no workspace root the user approved covers it/);
    setApproved([approved]);
    expect(nextSpawn).not.toThrow();
  });

  it("keeps an in-flight retirement discoverable until the incarnation stops", async () => {
    const approved = join(root, "approved");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(approved, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const grant = subject.register(approved, pluginRoot, dataDir);
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const stop = vi.fn(async () => { await stopped; grant.dispose(); });
    subject.attach(stop);
    setApproved([]);
    const first = subject.retireSandboxGrantsOutsideCeiling();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    let secondFinished = false;
    const second = subject.retireSandboxGrantsOutsideCeiling().then((value) => {
      secondFinished = true;
      return value;
    });
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    release();
    expect(await Promise.all([first, second])).toEqual([[PLUGIN_ID], [PLUGIN_ID]]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("still stops the incarnation when effect retirement reports an error", async () => {
    const approved = join(root, "approved");
    const pluginRoot = join(root, "home", "plugins", PLUGIN_ID);
    const dataDir = join(pluginRoot, "data");
    mkdirSync(approved, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const grant = subject.register(approved, pluginRoot, dataDir);
    const stop = vi.fn(async () => { grant.dispose(); });
    subject.attach(stop, () => [new Error("effect cleanup failed")]);
    setApproved([]);
    await expect(subject.retireSandboxGrantsOutsideCeiling()).rejects.toThrow(/sandbox grant retirement failed/);
    expect(stop).toHaveBeenCalledOnce();
    expect(subject.running()).toBe(false);
    expect(subject.failureKind()).toBe("sandbox-grant-outside-ceiling");
  });

  it("reports a quarantined incarnation without waiting for it and keeps retiring the others", async () => {
    const approved = join(root, "approved");
    mkdirSync(approved, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const grants = new Map<string, ReturnType<WithdrawalRuntime["register"]>>();
    for (const pluginId of ["unverified-plugin", "verified-plugin"]) {
      const pluginRoot = join(root, "home", "plugins", pluginId);
      const dataDir = join(pluginRoot, "data");
      mkdirSync(dataDir, { recursive: true });
      const grant = subject.register(approved, pluginRoot, dataDir, pluginId);
      grants.set(pluginId, grant);
      subject.attach(async () => {
        if (pluginId === "verified-plugin") { grant.dispose(); return; }
        // The owner could not establish termination: the grant stays, and stop reports it.
        grant.quarantine("Plugin child termination is unverified: unverified-plugin");
        throw new Error("Plugin child termination is unverified: unverified-plugin");
      }, () => [], pluginId);
    }
    setApproved([]);
    const failure = await subject.retireSandboxGrantsOutsideCeiling().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(((failure as AggregateError).errors as AggregateError[]).flatMap((error) => error.errors.map(String))))
      .toContain("sandbox grant incarnation is quarantined; its grants stay in place: unverified-plugin");
    expect(subject.running("verified-plugin")).toBe(false);
    expect(subject.failureKind("verified-plugin")).toBe("sandbox-grant-outside-ceiling");
    // Fail closed: the quarantined grant stays registered and refuses every later check and replacement.
    expect(grants.get("unverified-plugin")!.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
    expect(() => subject.lifecycleAvailable("unverified-plugin")).toThrow(/quarantined until host restart/);
    // A later withdrawal settles at once and reports the same quarantine again rather than hanging.
    await expect(subject.retireSandboxGrantsOutsideCeiling()).rejects.toThrow(/sandbox grant retirement failed/);
    // Restoring the ceiling does not reopen the quarantined grant.
    setApproved([approved]);
    expect(grants.get("unverified-plugin")!.assertCurrent).toThrow(/sandbox-grant-outside-ceiling/);
    expect(await subject.retireSandboxGrantsOutsideCeiling()).toEqual([]);
  });

  it("retires every affected plugin even when an earlier cleanup fails", async () => {
    const approved = join(root, "approved");
    mkdirSync(approved, { recursive: true });
    setApproved([approved]);
    const subject = runtime();
    const stops = [vi.fn(), vi.fn()];
    for (const [index, pluginId] of ["first-plugin", "second-plugin"].entries()) {
      const pluginRoot = join(root, "home", "plugins", pluginId);
      const dataDir = join(pluginRoot, "data");
      mkdirSync(dataDir, { recursive: true });
      const grant = subject.register(approved, pluginRoot, dataDir, pluginId);
      subject.attach(async () => {
        stops[index]!();
        grant.dispose();
      }, () => index === 0 ? [new Error("effect cleanup failed")] : [], pluginId);
    }
    setApproved([]);
    await expect(subject.retireSandboxGrantsOutsideCeiling()).rejects.toThrow(/sandbox grant retirement failed/);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(subject.running("first-plugin")).toBe(false);
    expect(subject.running("second-plugin")).toBe(false);
    expect(subject.failureKind("second-plugin")).toBe("sandbox-grant-outside-ceiling");
    expect(await subject.retireSandboxGrantsOutsideCeiling()).toEqual([]);
  });
});
