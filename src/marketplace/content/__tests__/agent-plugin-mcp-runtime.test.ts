import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMcpTrustStore } from "../../../mcp/plugin-mcp-projection.js";
import { boundBundledCredential, bundledCredentialDeclaration, readBoundBundledCredential } from "../../../mcp/bundled-credential.js";
import type { InstalledAgentPluginRuntime } from "../service.js";
import { AgentPluginMcpRuntime } from "../agent-plugin-mcp-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function packageFixture(): { item: InstalledAgentPluginRuntime; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "installed-agent-mcp-"));
  roots.push(root);
  const dir = join(root, "package");
  const dataDir = join(root, "data");
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(dir, "server", "run"), "server payload");
  const item = {
    name: "meeting-kit", version: "1.0.0", generationId: "a".repeat(64), dir,
    content: { kind: "agent-plugin", files: [{ path: "server/run", data: Buffer.from("server payload") }], components: {
      skills: [], prompts: [], agents: [], routineTemplates: [], hooks: [],
      mcpServers: { notes: { transport: "stdio", command: "./server/run", cwd: "${PLUGIN_ROOT}", digest: "b".repeat(64) } },
    } },
  } as InstalledAgentPluginRuntime;
  return { item, dataDir };
}

function credentialFixture() {
  const { item, dataDir } = packageFixture();
  const withCredential = (version: string, envName: string, digest: string): InstalledAgentPluginRuntime => ({
    ...item, version, generationId: digest,
    content: { ...item.content, components: { ...item.content.components, mcpServers: {
      notes: { transport: "stdio", command: "./server/run", cwd: "${PLUGIN_ROOT}", auth: "api-key", apiKeyEnv: envName, digest },
    } } },
  });
  return { item, dataDir, withCredential };
}

describe("installed agent plugin MCP publication", () => {
  it("keeps data across an update, skips unchanged reloads, and retires removal", async () => {
    const { item, dataDir } = packageFixture();
    const prepare = vi.fn(async (_owner, projections) => ({ projections }));
    const publish = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const manager = { prepareBundledGeneration: prepare, publishBundledGeneration: publish,
      discardBundledGeneration: vi.fn(), disconnectBundledGeneration: disconnect,
      stageBundledCredentialDrop: vi.fn(async () => async () => undefined), registerGenerationLeaseSource: vi.fn() };
    const runtime = new AgentPluginMcpRuntime(manager as never, {
      trust: new PluginMcpTrustStore(), dataDirForPackage: async () => dataDir,
    });
    await runtime.sync([item]);
    expect(prepare).toHaveBeenCalledTimes(1);
    const first = prepare.mock.calls[0]![1][0];
    expect(first.config.pluginDataDir).toBe(realpathSync(dataDir));
    expect(first.config.env.PLUGIN_DATA).toBe(realpathSync(dataDir));
    const marker = join(dataDir, "marker");
    writeFileSync(marker, "retained");
    await runtime.sync([item]);
    expect(prepare).toHaveBeenCalledTimes(1);

    const updated = { ...item, version: "1.1.0", generationId: "c".repeat(64) };
    await runtime.sync([updated]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]![1][0].serverId).not.toBe(first.serverId);
    expect(readFileSync(marker, "utf8")).toBe("retained");
    expect(disconnect).toHaveBeenCalledWith("agent-plugin/meeting-kit", prepare.mock.calls[0]![0].generationId);
    await runtime.sync([]);
    expect(disconnect).toHaveBeenCalledWith("agent-plugin/meeting-kit", prepare.mock.calls[1]![0].generationId);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("discards candidates when publication refuses the current policy", async () => {
    const { item, dataDir } = packageFixture();
    const prepared = { published: false };
    const discard = vi.fn(async () => undefined);
    const trust = new PluginMcpTrustStore();
    let projection: Parameters<PluginMcpTrustStore["isApproved"]>[0] | undefined;
    const runtime = new AgentPluginMcpRuntime({
      prepareBundledGeneration: vi.fn(async (_owner, projections) => { projection = projections[0]; return prepared; }),
      publishBundledGeneration: () => { throw new Error("runtime approval not admitted by policy"); },
      discardBundledGeneration: discard,
      disconnectBundledGeneration: vi.fn(async () => undefined),
      stageBundledCredentialDrop: vi.fn(async () => async () => undefined),
      registerGenerationLeaseSource: vi.fn(),
    } as never, { trust, dataDirForPackage: async () => dataDir });
    await expect(runtime.activate(item, [{ name: "notes", digest: "b".repeat(64) }])).rejects.toThrow(/not admitted/u);
    expect(discard).toHaveBeenCalledWith(prepared);
    expect(projection && trust.isApproved(projection)).toBe(false);
  });

  it("requires the reviewed digest and does not transfer consent to a new version with changed bytes", async () => {
    const { item, dataDir } = packageFixture();
    const trustPath = join(dataDir, "approvals.json");
    const trust = new PluginMcpTrustStore(trustPath);
    const admissions: boolean[] = [];
    let firstProjection: Parameters<PluginMcpTrustStore["isApproved"]>[0] | undefined;
    const prepare = vi.fn(async (_owner, projections, store: PluginMcpTrustStore) => {
      firstProjection ??= projections[0];
      admissions.push(store.isApproved(projections[0]));
      return { published: false };
    });
    const runtime = new AgentPluginMcpRuntime({
      prepareBundledGeneration: prepare,
      publishBundledGeneration: vi.fn(),
      discardBundledGeneration: vi.fn(),
      disconnectBundledGeneration: vi.fn(async () => undefined),
      stageBundledCredentialDrop: vi.fn(async () => async () => undefined),
      registerGenerationLeaseSource: vi.fn(),
    } as never, { trust, dataDirForPackage: async () => dataDir });
    await expect(runtime.activate(item, [{ name: "notes", digest: "f".repeat(64) }])).rejects.toThrow(/does not match/u);
    expect(prepare).not.toHaveBeenCalled();
    await runtime.activate(item, [{ name: "notes", digest: "b".repeat(64) }]);
    expect(firstProjection && new PluginMcpTrustStore(trustPath).isApproved(firstProjection)).toBe(true);
    await runtime.activate({ ...item, version: "1.1.0", generationId: "c".repeat(64),
      content: { ...item.content, files: [{ path: "server/run", data: Buffer.from("other server payload") }] } } as InstalledAgentPluginRuntime);
    expect(admissions).toEqual([true, false]);
  });

  it("drops a key when its declaration changes and restores it if publication fails", async () => {
    const { dataDir, withCredential } = credentialFixture();
    let saved: string | null = null;
    let refusePublication = false;
    const stageDrop = vi.fn(async (_packageRef, _serverName, declaration?: string) => {
      if (saved === null || (declaration && readBoundBundledCredential(saved)?.declaration === declaration)) {
        return async () => undefined;
      }
      const prior = saved;
      saved = null;
      return async () => { saved = prior; };
    });
    const manager = {
      prepareBundledGeneration: vi.fn(async () => ({ published: false })),
      publishBundledGeneration: vi.fn(() => { if (refusePublication) throw new Error("publication refused"); }),
      discardBundledGeneration: vi.fn(async () => undefined),
      disconnectBundledGeneration: vi.fn(async () => undefined),
      stageBundledCredentialDrop: stageDrop,
      registerGenerationLeaseSource: vi.fn(),
    };
    const runtime = new AgentPluginMcpRuntime(manager as never, { trust: new PluginMcpTrustStore(), dataDirForPackage: async () => dataDir });
    await runtime.activate(withCredential("1.0.0", "FIRST_TOKEN", "a".repeat(64)));
    saved = boundBundledCredential(bundledCredentialDeclaration({ transport: "stdio", auth: "api-key", apiKeyEnv: "FIRST_TOKEN" }), "private-value");
    refusePublication = true;
    await expect(runtime.activate(withCredential("1.1.0", "SECOND_TOKEN", "b".repeat(64)))).rejects.toThrow(/publication refused/u);
    expect(readBoundBundledCredential(saved)?.secret).toBe("private-value");
    refusePublication = false;
    await runtime.activate(withCredential("1.1.0", "SECOND_TOKEN", "b".repeat(64)));
    expect(saved).toBeNull();
    expect(stageDrop).toHaveBeenCalledWith({ kind: "agent-plugin", name: "meeting-kit" }, "notes",
      bundledCredentialDeclaration({ transport: "stdio", auth: "api-key", apiKeyEnv: "SECOND_TOKEN" }));
  });

  it("invalidates a changed credential after disable and retains a matching replacement after re-enable", async () => {
    const { item, dataDir, withCredential } = credentialFixture();
    const first = bundledCredentialDeclaration({ transport: "stdio", auth: "api-key", apiKeyEnv: "FIRST_TOKEN" });
    const second = bundledCredentialDeclaration({ transport: "stdio", auth: "api-key", apiKeyEnv: "SECOND_TOKEN" });
    let saved: string | null = null;
    const stageDrop = vi.fn(async (_packageRef: unknown, _server: string, expected?: string) => {
      if (saved === null || (expected && readBoundBundledCredential(saved)?.declaration === expected)) return async () => undefined;
      const prior = saved;
      saved = null;
      return async () => { saved = prior; };
    });
    const manager = {
      prepareBundledGeneration: vi.fn(async () => ({ published: false })),
      publishBundledGeneration: vi.fn(),
      discardBundledGeneration: vi.fn(),
      disconnectBundledGeneration: vi.fn(async () => undefined),
      stageBundledCredentialDrop: stageDrop,
      registerGenerationLeaseSource: vi.fn(),
    };
    const runtime = new AgentPluginMcpRuntime(manager as never, { trust: new PluginMcpTrustStore(), dataDirForPackage: async () => dataDir });
    await runtime.activate(withCredential("1.0.0", "FIRST_TOKEN", "a".repeat(64)));
    saved = boundBundledCredential(first, "private-value");
    await runtime.deactivate(item.name);
    await runtime.activate(withCredential("1.1.0", "SECOND_TOKEN", "b".repeat(64)));
    expect(saved).toBeNull();
    expect(stageDrop).toHaveBeenCalledWith({ kind: "agent-plugin", name: item.name }, "notes", second);
    saved = boundBundledCredential(second, "replacement-value");
    await runtime.deactivate(item.name);
    await runtime.activate(withCredential("1.1.0", "SECOND_TOKEN", "b".repeat(64)));
    expect(readBoundBundledCredential(saved)?.secret).toBe("replacement-value");
  });

  function leased(options: { trust?: PluginMcpTrustStore; dataDir: string; prepare?: (projections: unknown[], trust: PluginMcpTrustStore) => Promise<void>; publish?: () => void }) {
    let acquire!: (pluginId: string, activationId: string) => Promise<{ release(): void }>;
    const prepared: Array<{ activationId: string; projections: Array<Parameters<PluginMcpTrustStore["isApproved"]>[0]>; admitted: boolean[] }> = [];
    const disconnected: string[] = [];
    const manager = {
      prepareBundledGeneration: vi.fn(async (owner: { generationId: string }, projections: Array<Parameters<PluginMcpTrustStore["isApproved"]>[0]>, trust: PluginMcpTrustStore) => {
        prepared.push({ activationId: owner.generationId, projections, admitted: projections.map((item) => trust.isApproved(item)) });
        await options.prepare?.(projections, trust);
        return { published: false };
      }),
      publishBundledGeneration: vi.fn(() => options.publish?.()),
      discardBundledGeneration: vi.fn(async () => undefined),
      disconnectBundledGeneration: vi.fn(async (_pluginId: string, activationId: string) => { disconnected.push(activationId); }),
      stageBundledCredentialDrop: vi.fn(async () => async () => undefined),
      registerGenerationLeaseSource: vi.fn((_prefix: string, source: typeof acquire) => { acquire = source; }),
    };
    const runtime = new AgentPluginMcpRuntime(manager as never, { trust: options.trust ?? new PluginMcpTrustStore(), dataDirForPackage: async () => options.dataDir });
    expect(manager.registerGenerationLeaseSource).toHaveBeenCalledWith("agent-plugin/", expect.any(Function));
    return { runtime, manager, prepared, disconnected, acquire: (pluginId: string, activationId: string) => acquire(pluginId, activationId) };
  }

  it("an update closes admission to the replaced activation at publication and disconnects it only after its calls drain", async () => {
    const { item, dataDir } = packageFixture();
    // A call that arrives while the new activation is being published must not take the old one.
    let atPublication: Promise<unknown> | undefined;
    let first = "";
    const { runtime, prepared, disconnected, acquire } = leased({ dataDir, publish: () => {
      if (first) atPublication = acquire("agent-plugin/meeting-kit", first).then(() => "admitted", () => "refused");
    } });
    await runtime.activate(item, [{ name: "notes", digest: "b".repeat(64) }]);
    first = prepared[0]!.activationId;
    const inFlight = await acquire("agent-plugin/meeting-kit", first);
    expect(runtime.hasCallsInFlight("meeting-kit")).toBe(true);
    await expect(acquire("agent-plugin/other-kit", first)).rejects.toThrow(/is retired/u);

    const { retired } = await runtime.activate({ ...item, version: "1.1.0", generationId: "c".repeat(64) });
    const second = prepared[1]!.activationId;
    expect(second).not.toBe(first);
    expect(await atPublication).toBe("refused");
    await expect(acquire("agent-plugin/meeting-kit", first)).rejects.toThrow(/is retired/u);
    const next = await acquire("agent-plugin/meeting-kit", second);
    next.release();
    let settled = false;
    void retired.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disconnected).toEqual([]);
    expect(settled).toBe(false);

    inFlight.release();
    inFlight.release();
    await retired;
    expect(disconnected).toEqual([first]);
    expect(runtime.hasCallsInFlight("meeting-kit")).toBe(false);
  });

  it("carries a server's approval to an update whose server and package bytes are unchanged, and not to a changed one", async () => {
    const { item, dataDir } = packageFixture();
    const trust = new PluginMcpTrustStore(join(dataDir, "approvals.json"));
    const { runtime, prepared } = leased({ dataDir, trust });
    await runtime.activate(item, [{ name: "notes", digest: "b".repeat(64) }]);
    expect(prepared[0]!.admitted).toEqual([true]);
    const approvedDigest = (prepared[0]!.projections[0] as { approvalDigest: string | null }).approvalDigest;
    expect(approvedDigest).toMatch(/^[a-f0-9]{64}$/u);

    await runtime.activate({ ...item, version: "1.1.0", generationId: "c".repeat(64) });
    expect(prepared[1]!.admitted).toEqual([true]);
    const carried = trust.record(prepared[1]!.projections[0]!);
    expect(carried).toMatchObject({ pluginVersion: "1.1.0", approvalDigest: approvedDigest, carriedFrom: "a".repeat(64) });

    writeFileSync(join(item.dir, "server", "run"), "changed server payload");
    await runtime.activate({ ...item, version: "1.2.0", generationId: "d".repeat(64),
      content: { ...item.content, files: [{ path: "server/run", data: Buffer.from("changed server payload") }] } } as InstalledAgentPluginRuntime);
    expect(prepared[2]!.admitted).toEqual([false]);
  });

  it("does not undo a revocation made while an update is prepared", async () => {
    const { item, dataDir } = packageFixture();
    const trust = new PluginMcpTrustStore();
    let revokeDuringPrepare: (() => void) | undefined;
    const { runtime, prepared, manager } = leased({ dataDir, trust, prepare: async () => { revokeDuringPrepare?.(); } });
    await runtime.activate(item, [{ name: "notes", digest: "b".repeat(64) }]);
    const source = prepared[0]!.projections[0]!;
    revokeDuringPrepare = () => trust.revoke(source);
    await expect(runtime.activate({ ...item, version: "1.1.0", generationId: "c".repeat(64) })).rejects.toThrow(/was withdrawn while its update was prepared/u);
    expect(manager.publishBundledGeneration).toHaveBeenCalledTimes(1);
    expect(manager.discardBundledGeneration).toHaveBeenCalledTimes(1);
    expect(trust.isApproved(source)).toBe(false);
    expect(trust.isApproved(prepared[1]!.projections[0]!)).toBe(false);
  });
});
