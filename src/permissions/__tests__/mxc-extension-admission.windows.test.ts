import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeLinkOnly } from "../../__tests__/support/tmp-dir-teardown.js";
import { useTempDirs } from "../../__tests__/test-helpers.js";
import { configureHostResources } from "../../main/host-resources.js";
import { policyHomeAnchors } from "../../shared/policy-home.js";
import { admitMxcExtensionFilesystem, initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { mxcConfinementStatePaths } from "../mxc-runtime-root.js";
import { mxcPolicyRows } from "../mxc-windows.js";

vi.mock("../../shared/policy-home.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  return { ...actual, policyHomeAnchors: () => [actual.getPolicyHome()] };
});

describe.runIf(process.platform === "win32")("Windows container holder write admission", () => {
  const makeFixture = useTempDirs("mxc-admission-");
  let fixture: string;
  let target: string;
  let local: string;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
  beforeEach(() => {
    fixture = makeFixture();
    const home = join(fixture, "alice");
    target = join(fixture, "allowed");
    local = join(home, "AppData", "Local");
    mkdirSync(target);
    mkdirSync(local, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("LOCALAPPDATA", local);
    vi.stubEnv("AVE_TEST_SANDBOX_BASE", join(fixture, "sandbox-cache"));
    expect(policyHomeAnchors().every(anchor => anchor === home), "sandbox policy homes must be fixture-scoped").toBe(true);
  });
  afterEach(async () => {
    try {
      await resetAsrtSandbox();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admits an extension output beside bracketed Documents and retains the profile deny", async () => {
    const documents = join(fixture, "Work [Archive]", "Documents");
    const profile = join(documents, "PowerShell", "profile.ps1");
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, "");
    await initializeAsrtSandbox({
      resolveWindowsDocumentsPath: () => documents,
      windows: { externalConfinement: true },
    });

    const policy = mxcPolicyRows(admitMxcExtensionFilesystem({ allowRead: [], allowWrite: [target] }, {
      readRoots: [], writeRoots: [target], hostStorageRoots: [],
    }).model);
    expect(policy.writeGrants).toEqual([target]);
    expect(policy.writeFloor).toContain(profile);
  });

  it("re-checks a container holder's pinned writes at admission, except its own staging root", async () => {
    const state = join(local, "sandbox-runtime");
    const [runtimeRoot] = mxcConfinementStatePaths();
    const staging = join(runtimeRoot, "staging", "0123456789abcdef0123456789abcdef");
    for (const directory of [state, staging]) mkdirSync(directory, { recursive: true });
    await initializeAsrtSandbox({ windows: { externalConfinement: true } });
    const link = join(fixture, "link");
    symlinkSync(state, link, "junction");

    try {
      const admit = (allowWrite: string[], stagingRoot?: string) => admitMxcExtensionFilesystem({ allowRead: [], allowWrite },
        { readRoots: [], writeRoots: allowWrite, hostStorageRoots: [] }, stagingRoot);
      expect(() => admit([link])).toThrow(expect.objectContaining({ code: "confinement-state-write-grant", reason: "helper-ledger" }));
      expect(() => admit([target, staging])).toThrow(expect.objectContaining({ code: "confinement-state-write-grant", reason: "container-runtime" }));
      expect(() => admit([dirname(staging)], staging)).toThrow(expect.objectContaining({ code: "confinement-state-write-grant", reason: "container-runtime" }));
      expect(mxcPolicyRows(admit([target, staging], staging).model).writeGrants).toEqual(expect.arrayContaining([target, staging]));
    } finally {
      removeLinkOnly(link);
    }
  });
});
