/** User settings, managed policy, and a catalog pin must stop refresh before network access. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../../data/settings-store.js";
import { configureHostResources } from "../../../main/host-resources.js";

const hooks: Array<() => void> = [];
vi.mock("../../../main/app-shutdown.js", () => ({
  registerShutdownHook: (_name: string, stop: () => void) => hooks.push(stop),
}));
vi.mock("node:dns", () => ({ promises: { lookup: async () => [{ address: "93.184.215.14", family: 4 }] } }));

const { wireModelCatalogRefresh } = await import("../model-catalog-refresh.js");

let dir: string;
let calls: string[];
const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
  calls.push(String(input));
  return new Response("unavailable", { status: 503 });
}) as typeof fetch;

function settings(refresh?: "auto" | "off") {
  const llm = { modelCatalogRefresh: refresh } as unknown as AppSettings["llm"];
  return { get: ((key: keyof AppSettings) => (key === "llm" ? llm : undefined)) as never };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-catalog-wire-"));
  calls = [];
  // The win32 managed-policy read consults host resources before the policy file; without a
  // configured resource root getHostResources() throws, the policy read is treated as
  // untrusted, and refresh fails closed to "off" so the default-on test sees no fetch. Point
  // the resources root at the repo tree (packaged=false) as the native-executable fixtures do.
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  vi.stubEnv("AVE_MODEL_CATALOG", "");
  vi.stubEnv("AVE_HOME", dir);
});
afterEach(() => {
  for (const stop of hooks.splice(0)) stop();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const absentPolicy = () => join(dir, "no-policy.json");

describe("wireModelCatalogRefresh", () => {
  it("asks models.dev once at boot by default", async () => {
    await wireModelCatalogRefresh({ settingsService: settings(), fetchImpl, policyPath: absentPolicy() });
    expect(calls).toEqual(["https://models.dev/api.json"]);
  });

  it("sends nothing when the user turned it off", async () => {
    await wireModelCatalogRefresh({ settingsService: settings("off"), fetchImpl, policyPath: absentPolicy() });
    expect(calls).toEqual([]);
  });

  it("sends nothing under a AVE_MODEL_CATALOG pin", async () => {
    vi.stubEnv("AVE_MODEL_CATALOG", "bundled");
    await wireModelCatalogRefresh({ settingsService: settings("auto"), fetchImpl, policyPath: absentPolicy() });
    expect(calls).toEqual([]);
  });

  it("sends nothing when the managed policy turns it off", async () => {
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ modelCatalog: { refresh: "off" } }));
    await wireModelCatalogRefresh({ settingsService: settings("auto"), fetchImpl, policyPath });
    expect(calls).toEqual([]);
  });
});
