import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";
import { hasMarketplaceInstallInFlight } from "../../app/install-lifecycle.js";
import * as storeModule from "../store.js";
import * as ledgerModule from "../ledger.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../sources/policy.js";

const { ContentStore, stageLocalAgentPlugin } = storeModule;
const { ContentLedger } = ledgerModule;

function members(type: { prototype: object }, instance: object): string[] {
  return [...Object.getOwnPropertyNames(type), ...Object.getOwnPropertyNames(type.prototype), ...Object.getOwnPropertyNames(instance)]
    .filter((name) => !["length", "name", "prototype", "constructor"].includes(name)).sort();
}

const STORE_INTERNALS = ["queue", "options", "ledger", "serialize", "mutate", "removeWhenRetired", "assertClaimFree", "loadOne"];
const LEDGER_INTERNALS = ["path", "entries", "write"];

describe("installed content mutation admission", () => {
  let root: string;
  let store: storeModule.ContentStore;
  const activation = { activate: vi.fn(async () => ({ retired: Promise.resolve() })),
    deactivate: vi.fn(async () => undefined), approveComponents: vi.fn(async () => undefined) };
  const staged = () => stageLocalAgentPlugin([
    { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "team-kit", version: "1.0.0", description: "Team tools" })) },
    { path: "skills/review/SKILL.md", data: Buffer.from("---\nname: review\ndescription: Review changes\n---\nReview changes.\n") },
  ]);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ave-mutation-admission-"));
    vi.clearAllMocks();
    store = await ContentStore.open({ root: join(root, "packages"), english: {}, activation });
  });
  afterEach(async () => {
    setAppRelaunchRequested(false);
    await rm(root, { recursive: true, force: true });
  });

  it("classifies every exported store and ledger member", async () => {
    const storeReads = ["open", "list", "installed", "packageDir", "installedConsent", "load"];
    const storeWrites = ["install", "uninstall", "sweep", "approveComponents"];
    const ledgerReads = ["open", "get", "list"];
    const ledgerWrites = ["put", "remove"];
    const ledger = await ContentLedger.open(join(root, "packages", "ledger.json"));
    expect(members(ContentStore, store)).toEqual([...storeReads, ...storeWrites, ...STORE_INTERNALS].sort());
    expect(members(ContentLedger, ledger)).toEqual([...ledgerReads, ...ledgerWrites, ...LEDGER_INTERNALS].sort());
    expect(Object.keys(storeModule).sort()).toEqual(["ContentStore", "stageContentPackage", "stageLocalAgentPlugin", "stagedConsent"].sort());
    expect(Object.keys(ledgerModule).sort()).toEqual(["ContentLedger", "contentLedgerOrigins", "installPayloadDir"].sort());
  });

  it("refuses every public content mutator before any filesystem or activation change", async () => {
    const entry = (await store.install(staged())).entry;
    const before = readFileSync(join(root, "packages", "ledger.json"), "utf8");
    const files = await readdir(join(root, "packages"), { recursive: true });
    vi.clearAllMocks();
    setAppRelaunchRequested(true);
    const mutators: Record<string, () => Promise<unknown>> = {
      install: () => store.install(staged()),
      uninstall: () => store.uninstall("agent-plugin", "team-kit", EMPTY_MARKETPLACE_POLICY),
      sweep: () => store.sweep(),
      approveComponents: () => store.approveComponents("team-kit", entry.origin.installId!, []),
    };
    const reads = ["open", "list", "installed", "packageDir", "installedConsent", "load"];
    expect(members(ContentStore, store)).toEqual([...reads, ...Object.keys(mutators), ...STORE_INTERNALS].sort());
    for (const mutate of Object.values(mutators)) {
      await expect(mutate()).rejects.toMatchObject({ code: "relaunch-in-progress" });
      expect(readFileSync(join(root, "packages", "ledger.json"), "utf8")).toBe(before);
      expect(await readdir(join(root, "packages"), { recursive: true })).toEqual(files);
      expect(store.list()).toEqual([entry]);
    }
    expect(activation.activate).not.toHaveBeenCalled();
    expect(activation.deactivate).not.toHaveBeenCalled();
    expect(activation.approveComponents).not.toHaveBeenCalled();
  });

  it("refuses every public ledger mutator without changing memory or disk", async () => {
    const entry = (await store.install(staged())).entry;
    const path = join(root, "packages", "ledger.json");
    const ledger = await ContentLedger.open(path);
    const before = readFileSync(path, "utf8");
    setAppRelaunchRequested(true);
    const mutators: Record<string, () => Promise<unknown>> = {
      put: () => ledger.put({ ...entry, version: "2.0.0" }),
      remove: () => ledger.remove(entry.kind, entry.name),
    };
    expect(members(ContentLedger, ledger)).toEqual(["open", "get", "list", ...Object.keys(mutators), ...LEDGER_INTERNALS].sort());
    for (const mutate of Object.values(mutators)) {
      await expect(mutate()).rejects.toMatchObject({ code: "relaunch-in-progress" });
      expect(ledger.list()).toEqual([entry]);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("counts queued installs synchronously and keeps admission through activation rollback", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    activation.activate.mockImplementationOnce(async () => { entered(); await held; throw new Error("activation-failed"); });
    const pending = store.install(staged());
    const failed = expect(pending).rejects.toThrow("activation-failed");
    try {
      expect(hasMarketplaceInstallInFlight()).toBe(true);
      await started;
      expect(hasMarketplaceInstallInFlight()).toBe(true);
    } finally {
      release();
      await failed;
    }
    expect(store.list()).toEqual([]);
    expect(hasMarketplaceInstallInFlight()).toBe(false);
  });
});
