/** Config mutation tests use isolated temporary state and never launch real clients. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, rm, rename, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue({
  id: "test-server",
  status: "connected" as const,
  registeredTools: [],
});
const mockAuditLog = vi.fn();
const constructedConfigs: unknown[] = [];
const mockValidateServer = vi.fn(() => ({ valid: true as const }));

vi.mock("../mcp-client.js", () => ({
  McpClient: class {
    connect = mockConnect;
    disconnect = mockDisconnect;
    getState = mockGetState;
    constructor(config: unknown) {
      constructedConfigs.push(config);
    }
  },
}));

vi.mock("../mcp-governance.js", () => ({
  McpGovernance: class {
    validateServer = mockValidateServer;
  },
}));

const mockUnregisterByMcp = vi.fn();
vi.mock("../../tools/registry.js", () => ({
  ToolRegistry: class {
    unregisterByMcp = mockUnregisterByMcp;
  },
}));

import { McpManager } from "../mcp-manager.js";
import type { McpServerConfig } from "../types.js";
import { observeFileHandleSyncs } from "../../__tests__/support/fsync-observer.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { previewStudioConnector } from "../../studio/connector.js";
import { boundBundledCredential, bundledConfigId, bundledCredentialDeclaration, bundledCredentialKey } from "../bundled-credential.js";
import { studioExportFiles } from "../../studio/package.js";

const testDir = join(tmpdir(), `ave-mcp-test-${process.pid}`);
const testConfigPath = join(testDir, "mcp-servers.json");

async function makeManager(bundledSecrets?: { getSecret(key: string): string | null }) {
  const { McpGovernance } = await import("../mcp-governance.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  return new McpManager(
    new (McpGovernance as new () => InstanceType<typeof McpGovernance>)(),
    new (ToolRegistry as new () => InstanceType<typeof ToolRegistry>)(),
    unusedNetworkFetch,
    testConfigPath,
    { log: mockAuditLog } as never,
    undefined,
    undefined,
    bundledSecrets as never,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockValidateServer.mockImplementation(() => ({ valid: true as const }));
  const actualFsPromises =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rename).mockImplementation(actualFsPromises.rename);
  await rm(testDir, { recursive: true, force: true });
  await mkdir(testDir, { recursive: true });
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("McpManager — getConfigs()", () => {
  it("previews an installed plugin connector through the Studio projection", async () => {
    const mgr = await makeManager();
    const id = bundledConfigId({ kind: "agent-plugin", name: "team-kit" }, "sample");
    mgr.registerBundledCredentialSource("agent-plugin", { installedPackages: async () => undefined, list: () => [{ packageName: "team-kit", serverName: "sample",
      transport: "stdio", command: "uvx", args: ["studio-sample==1.0.0"], env: { SAMPLE: "visible-env" },
      auth: "api-key", apiKeyEnv: "SAMPLE_KEY" }], reconnect: async () => undefined });
    const settings = await mgr.getConfigs();
    expect(settings).toMatchObject([{ id, bundled: { kind: "agent-plugin", name: "team-kit", server: "sample" } }]);
    expect(settings[0]).not.toHaveProperty("args");
    expect(settings[0]).not.toHaveProperty("env");
    const preview = await previewStudioConnector(mgr, id);
    expect(preview.spec).toEqual(settings[0]);
    expect(preview.args).toMatchObject([{ index: 0, value: "studio-sample==1.0.0" }]);
    expect(preview.env).toMatchObject([{ name: "SAMPLE", value: "visible-env" }]);
  });
  it("keeps the settings DTO secret-free while Studio previews individual values without the stored key", async () => {
    await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "stdio", command: "node",
      args: ["--visible-arg"], env: { SAMPLE: "visible-env" }, auth: "api-key", apiKeyEnv: "SAMPLE_KEY",
      apiKey: "stored-key-sentinel" }] }));
    const mgr = await makeManager();
    const settings = await mgr.getConfigs();
    expect(settings[0]).not.toHaveProperty("args");
    expect(settings[0]).not.toHaveProperty("env");
    expect(settings[0]).not.toHaveProperty("apiKey");
    const preview = await previewStudioConnector(mgr, "sample");
    expect(preview.spec).toEqual(settings[0]);
    expect(preview.args).toMatchObject([{ index: 0, value: "--visible-arg" }]);
    expect(preview.env).toMatchObject([{ name: "SAMPLE", value: "visible-env" }]);
    expect(JSON.stringify(preview)).not.toContain("stored-key-sentinel");
    await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "stdio", command: "node",
      args: ["stored-key-sentinel"], apiKey: "stored-key-sentinel" }] }));
    await expect(previewStudioConnector(mgr, "sample")).rejects.toThrow("stored credential");
    await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "http", url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer hidden" } }] }));
    await expect(previewStudioConnector(mgr, "sample")).rejects.toThrow("custom headers");
  });
  it("compares decoded connector values with stored credentials before preview or write", async () => {
    const mgr = await makeManager();
    const keys = ["stored-\"-key", "stored-\\-key", "stored-\u2028-key", "stored-비밀-key"];
    for (const key of keys) {
      for (const [args, env] of [
        [[], { VALUE: key }],
        [[], { VALUE: `prefix-${key}-suffix` }],
        [[`--token=${key}`], {}],
      ] as const) {
        await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "stdio", command: "node",
          args, env, auth: "api-key", apiKeyEnv: "SAMPLE_KEY", apiKey: key }] }));
        await expect(previewStudioConnector(mgr, "sample")).rejects.toThrow("stored credential");
        await expect(mgr.assertStudioConnectorWriteSafe("sample", { spec: { id: "sample", transport: "stdio", command: "node" },
          args, env })).rejects.toThrow("stored credential");
        expect((await mgr.getConfigs())[0]).not.toHaveProperty("apiKey");
      }
    }
    const key = "stored-\"-key";
    await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "stdio", command: "node",
      args: ["--visible"], env: { SAMPLE_KEY: key, VALUE: "visible" }, auth: "api-key", apiKeyEnv: "SAMPLE_KEY", apiKey: key }] }));
    const preview = await previewStudioConnector(mgr, "sample");
    expect(preview.env).toMatchObject([{ name: "VALUE", value: "visible" }]);
    expect(preview.env).toHaveLength(1);
    expect(preview.spec.auth).toBe("api-key");
    await expect(mgr.assertStudioConnectorWriteSafe("sample", preview)).resolves.toBeUndefined();
    await writeFile(testConfigPath, JSON.stringify({ servers: [{ id: "sample", transport: "stdio", command: `tool-${key}`,
      auth: "api-key", apiKeyEnv: "SAMPLE_KEY", apiKey: key }] }));
    await expect(previewStudioConnector(mgr, "sample")).rejects.toThrow("stored credential");
    await writeFile(testConfigPath, JSON.stringify({ servers: [
      { id: "other", transport: "stdio", command: "node", auth: "api-key", apiKeyEnv: "OTHER_KEY", apiKey: key },
      { id: "sample", transport: "stdio", command: "node", args: [`--token=${key}`] },
    ] }));
    await expect(previewStudioConnector(mgr, "sample")).rejects.toThrow("stored credential");
  });
  it("keeps a bound package credential out of the Studio projection and export guard", async () => {
    const ref = { kind: "agent-plugin" as const, name: "team-kit" };
    const declaration = { packageName: "team-kit", serverName: "sample", transport: "stdio" as const,
      command: "uvx", args: ["studio-sample==1.0.0"], env: { VALUE: "stored-\"-credential" },
      auth: "api-key" as const, apiKeyEnv: "SAMPLE_KEY" };
    const key = "stored-\"-credential";
    const identity = bundledCredentialKey(ref, "sample");
    const stored = boundBundledCredential(bundledCredentialDeclaration(declaration), key);
    const mgr = await makeManager({ getSecret: (name) => name === identity ? stored : null });
    mgr.registerBundledCredentialSource("agent-plugin", { installedPackages: async () => undefined, list: () => [declaration], reconnect: async () => undefined });
    const id = bundledConfigId(ref, "sample");
    await expect(previewStudioConnector(mgr, id)).rejects.toThrow("stored credential");
    expect(await mgr.getStudioStoredCredentialValues()).toContain(key);
  });
  it("refuses percent-encoded stored keys in URLs and environment values for user and package credentials", async () => {
    const key = "stored/key?with=punct";
    const encodedUrl = encodeURIComponent(key);
    const encodedEnv = [...key].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    const twice = encodeURIComponent(encodedEnv);
    const thrice = encodeURIComponent(twice);
    const mixed = [...key].map((char, index) => `%${index % 2 ? char.charCodeAt(0).toString(16).toUpperCase()
      : char.charCodeAt(0).toString(16)}`).join("");
    const ref = { kind: "agent-plugin" as const, name: "team-kit" };
    const cases: Array<{ key: string; location: "url" | "env" | "args"; url: string;
      env: Record<string, string>; args: string[]; refuse: boolean }> = [
      { key, location: "url", url: `https://example.invalid/mcp?token=${encodedUrl}`, env: {}, args: [], refuse: true },
      { key, location: "url", url: `https://example.invalid/mcp?token=${encodedEnv}&progress=100%`, env: {}, args: [], refuse: true },
      { key, location: "url", url: `https://example.invalid/mcp?progress=100%&token=${encodedEnv}`, env: {}, args: [], refuse: true },
      { key, location: "env", url: "", env: { VALUE: `prefix-${encodedEnv}-suffix` }, args: [], refuse: true },
      { key, location: "env", url: "", env: { VALUE: `progress=100%;token=${encodedEnv}` }, args: [], refuse: true },
      { key: "alpha beta", location: "url", url: "https://example.invalid/mcp?token=alpha+beta",
        env: {}, args: [], refuse: true },
      { key, location: "env", url: "", env: { VALUE: key.slice(0, Math.floor(key.length / 2)) },
        args: [], refuse: false },
    ];
    for (const value of [`%ff${encodedEnv}`, `${encodedEnv}%ff`, `%zz${encodedEnv}`, `${encodedEnv}%zz`, twice, thrice, mixed]) {
      cases.push({ key, location: "env", url: "", env: { VALUE: value }, args: [], refuse: true });
      cases.push({ key, location: "args", url: "", env: {}, args: [`--token=${value}`], refuse: true });
      cases.push({ key, location: "url", url: `https://example.invalid/mcp#token=${value}`, env: {}, args: [], refuse: true });
    }
    for (const owner of ["user", "package"] as const) for (const item of cases) {
      const { location, url, env, args, refuse } = item;
      const declaration = location === "url"
        ? { packageName: ref.name, serverName: "sample", transport: "http" as const, url, auth: "api-key" as const, apiKeyHeader: "X-Key" }
        : { packageName: ref.name, serverName: "sample", transport: "stdio" as const, command: "node", args, env,
          auth: "api-key" as const, apiKeyEnv: "SAMPLE_KEY" };
      const secrets = new Map<string, string>();
      const mgr = await makeManager({ getSecret: (name: string) => secrets.get(name) ?? null,
        setSecret: async (name: string, value: string) => { secrets.set(name, value); } } as never);
      let id = "sample";
      if (owner === "user") {
        await writeFile(testConfigPath, JSON.stringify({ servers: [{ id, ...declaration }] }));
        await mgr.setApiKey(id, item.key);
      } else {
        await writeFile(testConfigPath, JSON.stringify({ servers: [] }));
        mgr.registerBundledCredentialSource("agent-plugin", { installedPackages: async () => undefined, list: () => [declaration], reconnect: async () => undefined });
        await mgr.setBundledApiKey(ref, "sample", item.key);
        id = bundledConfigId(ref, "sample");
      }
      const copy = { spec: { id, ...(location === "url" ? { url } : {}) }, args, env };
      const portable = location === "url" ? { type: "streamable-http", url }
        : { type: "stdio", command: "uvx", args: ["studio-sample==1.0.0", ...args], env };
      const files = [
        { path: "plugin.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "team-kit", version: "1.0.0", description: "A team plugin" })) },
        { path: "mcp.json", data: Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { sample: portable } })) },
      ];
      if (refuse) {
        await expect(previewStudioConnector(mgr, id)).rejects.toThrow("stored credential");
        await expect(mgr.assertStudioConnectorWriteSafe(id, copy)).rejects.toThrow("stored credential");
        expect(() => studioExportFiles(files, false, [item.key])).toThrow("stored credential");
      } else {
        await expect(previewStudioConnector(mgr, id)).resolves.toBeDefined();
        await expect(mgr.assertStudioConnectorWriteSafe(id, copy)).resolves.toBeUndefined();
        expect(() => studioExportFiles(files, false, [item.key])).not.toThrow();
      }
      expect(await mgr.getStudioStoredCredentialValues()).toContain(item.key);
    }
  });
  it("returns [] when config file does not exist", async () => {
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toEqual([]);
  });

  it("returns servers from config file", async () => {
    const servers: McpServerConfig[] = [
      { id: "srv-a", transport: "stdio", command: "uvx a" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("srv-a");
  });

  it("strips secret-bearing fields (apiKey, headers, env) before returning to renderer", async () => {
    const servers = [
      {
        id: "http-srv",
        transport: "http" as const,
        url: "https://example.com/mcp",
        apiKey: "super-secret",
        apiKeyHeader: "x-api-key",
        headers: { Authorization: "Bearer token" },
      },
      {
        id: "stdio-srv",
        transport: "stdio" as const,
        command: "npx tool",
        apiKey: "stdio-api-secret",
        apiKeyEnv: "OPENAI_API_KEY",
        args: ["--token=abc123", "--verbose"],
        env: { SECRET_TOKEN: "abc123", PATH: "/usr/bin" },
        cwd: "/sealed/package",
        pluginDataDir: "/private/data",
        bundledPayloadRoot: "/sealed/payload",
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();
    const result = await mgr.getConfigs();
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("apiKey");
    expect(result[0]).not.toHaveProperty("headers");
    expect(result[0]).toHaveProperty("apiKeyHeader", "x-api-key");
    expect(result[1]).not.toHaveProperty("apiKey");
    expect(result[1]).not.toHaveProperty("args");
    expect(result[1]).not.toHaveProperty("env");
    expect(result[1]).not.toHaveProperty("cwd");
    expect(result[1]).not.toHaveProperty("pluginDataDir");
    expect(result[1]).not.toHaveProperty("bundledPayloadRoot");
    expect(result[1]).toHaveProperty("apiKeyEnv", "OPENAI_API_KEY");
    expect(result[0].id).toBe("http-srv");
    expect(result[1].id).toBe("stdio-srv");
  });

  it("drops host-only filesystem roots that ride in on an external config before the client sees it", async () => {
    const server: McpServerConfig = {
      id: "external-stdio",
      transport: "stdio",
      command: "npx",
      args: ["-y", "tool@1.0.0"],
      // Reject config grants that reopen plugin roots for writing or broad reading.
      pluginDataDir: "/home/u/.ave/plugins/neighbour/data",
      bundledPayloadRoot: "/home/u/.ave/plugins/neighbour",
    };
    await writeFile(testConfigPath, JSON.stringify({ servers: [server] }), "utf-8");
    const mgr = await makeManager();
    constructedConfigs.length = 0;
    await mgr.connectServer(server);
    expect(constructedConfigs).toHaveLength(1);
    const reached = constructedConfigs[0] as Record<string, unknown>;
    expect(reached).not.toHaveProperty("pluginDataDir");
    expect(reached).not.toHaveProperty("bundledPayloadRoot");
    expect(reached.sandboxRoot).toEqual(expect.any(String));
  });

  it("falls back to a legacy .bak when the main config file exists but is corrupt", async () => {
    const backupServers: McpServerConfig[] = [
      { id: "backup-srv", transport: "http", url: "https://example.com/mcp" },
    ];
    await writeFile(testConfigPath, "{not-json", "utf-8");
    await writeFile(`${testConfigPath}.bak`, JSON.stringify({ servers: backupServers }), "utf-8");

    const mgr = await makeManager();
    const result = await mgr.getConfigs();

    expect(result).toEqual([
      { id: "backup-srv", transport: "http", url: "https://example.com/mcp" },
    ]);
  });

  it.each([
    ["unparsable JSON", "{not-json"],
    ["another app's mcpServers map", JSON.stringify({ mcpServers: { local: { command: "node" } } })],
    ["a bare array", "[]"],
  ])("refuses to add, update or remove servers over a configuration file with %s, leaving it untouched", async (_label, content) => {
    await writeFile(testConfigPath, content, "utf-8");
    // Legacy backups may be read, never used to overwrite the user primary file.
    await writeFile(`${testConfigPath}.bak`, JSON.stringify({ servers: [{ id: "backup-srv", transport: "http", url: "https://example.com/mcp", auth: "api-key" }] }), "utf-8");
    const mgr = await makeManager();
    const refused = async (write: Promise<unknown>) => {
      const error = await write.then(() => undefined, (reason: unknown) => reason);
      expect(error).toMatchObject({ name: "McpConfigFileInvalidError", code: "mcp-config-invalid" });
      expect((error as Error).message).toBe(`[mcp-manager] MCP 서버 설정 파일 ${testConfigPath}이(가) "servers" 목록을 가진 올바른 JSON이 아닙니다. 파일을 고치거나 옮기세요. Ave는 이 파일을 덮어쓰지 않습니다.`);
    };
    await refused(mgr.addConfig({ id: "new-srv", transport: "http", url: "https://example.com/new" }));
    await refused(mgr.removeConfig("backup-srv"));
    await refused(mgr.setApiKey("backup-srv", "replacement"));
    expect(await readFile(testConfigPath, "utf-8")).toBe(content);
  });

  it("returns the resolved config path for renderer empty-state messaging", async () => {
    const mgr = await makeManager();
    expect(mgr.getConfigPath()).toBe(testConfigPath);
  });
});

describe("McpManager — addConfig()", () => {
  it("saves config and attempts connection", async () => {
    const mgr = await makeManager();
    const config: McpServerConfig = { id: "new-srv", transport: "stdio", command: "npx tool" };

    await expect(mgr.addConfig(config)).resolves.toEqual({ connected: true });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("new-srv");
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ type: "mcp_connect" }));
  });

  it("throws if server id already exists", async () => {
    const servers: McpServerConfig[] = [
      { id: "dup", transport: "http", url: "https://example.com/mcp" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "dup", transport: "stdio", command: "cmd" }),
    ).rejects.toThrow("이미 존재");
  });

  it("returns warning when connection fails after save", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connect boom"));
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "warn-srv", transport: "stdio", command: "npx tool" }),
    ).resolves.toEqual({ connected: false, warning: "connect boom" });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers.map((server) => server.id)).toContain("warn-srv");
  });

  it("updates write-only API key for an existing api-key server and reconnects", async () => {
    const servers: McpServerConfig[] = [
      {
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        auth: "api-key",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(mgr.setApiKey("browser-use", "sk-test")).resolves.toEqual({ connected: true });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers[0]).toMatchObject({
      id: "browser-use",
      auth: "api-key",
      apiKey: "sk-test",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("forces reconnect when updating an already connected API key server", async () => {
    const servers: McpServerConfig[] = [
      {
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        auth: "api-key",
        apiKey: "old-key",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await mgr.connectServer(servers[0]);
    await expect(mgr.setApiKey("browser-use", "new-key")).resolves.toEqual({ connected: true });

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers[0]).toMatchObject({ apiKey: "new-key" });
    expect(mockDisconnect).toHaveBeenCalledOnce();
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("does not persist a new API key when governance rejects the updated config", async () => {
    const servers: McpServerConfig[] = [
      {
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        auth: "api-key",
        apiKey: "old-key",
        apiKeyEnv: "PATH",
      },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    mockValidateServer.mockReturnValueOnce({
      valid: false,
      reason: "apiKeyEnv는 런타임 제어 환경변수를 사용할 수 없습니다: 'PATH'",
      layer: 1,
    });
    const mgr = await makeManager();

    await expect(mgr.setApiKey("browser-use", "new-key")).rejects.toThrow("거버넌스 검증 실패");

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers[0]).toMatchObject({ apiKey: "old-key" });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects API key updates for non-api-key servers", async () => {
    const servers: McpServerConfig[] = [
      { id: "plain", transport: "stdio", command: "npx", auth: "none" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(mgr.setApiKey("plain", "secret")).rejects.toThrow("API key 인증 서버가 아닙니다");
  });

  it("cleans up failed clients after connectServer throws", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connect boom"));
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "warn-srv", transport: "stdio", command: "npx tool" }),
    ).resolves.toEqual({ connected: false, warning: "connect boom" });

    expect(mgr.listServers()).toEqual([]);
  });

  it("saveConfigs persists through the shared atomic-write authority — fsynced, no .tmp/.bak/.old debris", async () => {
    // Verify durable atomic writes leave no staging or backup files containing secrets.
    const existingServers: McpServerConfig[] = [
      { id: "existing-srv", transport: "stdio", command: "cmd" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers: existingServers }), "utf-8");

    const mgr = await makeManager();
    const observer = observeFileHandleSyncs();
    try {
      await expect(
        mgr.addConfig({ id: "new-srv", transport: "stdio", command: "npx tool" }),
      ).resolves.toEqual({ connected: true });
    } finally {
      observer.restore();
    }

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers.map((server) => server.id)).toEqual(["existing-srv", "new-srv"]);
    expect(observer.calls()).toBeGreaterThanOrEqual(1);
    expect(existsSync(`${testConfigPath}.bak`)).toBe(false);
    const dirEntries = await readdir(testDir);
    expect(
      dirEntries.filter(
        (entry) => entry.endsWith(".tmp") || entry.endsWith(".old"),
      ),
    ).toEqual([]);
  });

  it("rejects governance-invalid config before save", async () => {
    mockValidateServer.mockReturnValueOnce({
      valid: false as const,
      layer: 0,
      reason: "revoked",
    });
    const mgr = await makeManager();

    await expect(
      mgr.addConfig({ id: "blocked", transport: "stdio", command: "npx tool" }),
    ).rejects.toThrow("거버넌스 검증 실패");

    expect(existsSync(testConfigPath)).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("setApiKey — rejects CR/LF in apiKey value (HIGH-4)", async () => {
    const servers: McpServerConfig[] = [
      { id: "browser-use", transport: "stdio", command: "uvx", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(mgr.setApiKey("browser-use", "\nbad-key")).rejects.toThrow("제어 문자");
    await expect(mgr.setApiKey("browser-use", "bad\rkey")).rejects.toThrow("제어 문자");
  });

  it("setApiKey — rejects apiKey that is too long (HIGH-3)", async () => {
    const servers: McpServerConfig[] = [
      { id: "browser-use", transport: "stdio", command: "uvx", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await expect(mgr.setApiKey("browser-use", "a".repeat(5000))).rejects.toThrow("너무 깁니다");
  });

  it("setApiKey — governance.validateServer is called BEFORE saveConfigs (HIGH-3)", async () => {
    const servers: McpServerConfig[] = [
      { id: "gov-check", transport: "stdio", command: "uvx", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    const callOrder: string[] = [];
    mockValidateServer.mockImplementation(() => {
      callOrder.push("validate");
      return { valid: false as const, layer: 1, reason: "blocked" };
    });
    vi.mocked(rename).mockImplementation(async (...args) => {
      callOrder.push("rename");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return actual.rename(...args);
    });

    await expect(mgr.setApiKey("gov-check", "sk-test-key")).rejects.toThrow("거버넌스 검증 실패");
    expect(callOrder.indexOf("validate")).toBeLessThan(
      callOrder.indexOf("rename") === -1 ? Infinity : callOrder.indexOf("rename"),
    );
    expect(callOrder).not.toContain("rename");
  });

  it("setApiKey — disconnects existing client then reconnects with new key (MEDIUM-1)", async () => {
    const servers: McpServerConfig[] = [
      { id: "rotate-srv", transport: "stdio", command: "uvx", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await mgr.connectServer(servers[0]);
    const connectCallsBefore = mockConnect.mock.calls.length;

    await expect(mgr.setApiKey("rotate-srv", "sk-new-key")).resolves.toEqual({ connected: true });

    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallsBefore);
  });

  it("setApiKey — emits mcp_apikey_set audit log on success (MEDIUM-5)", async () => {
    const servers: McpServerConfig[] = [
      { id: "audit-key-srv", transport: "stdio", command: "uvx", auth: "api-key", apiKeyEnv: "MY_KEY" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");
    const mgr = await makeManager();

    await mgr.setApiKey("audit-key-srv", "sk-good-key");

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mcp_apikey_set", output: "connected" }),
    );
  });
});

describe("McpManager — removeConfig()", () => {
  it("removes server from config and disconnects", async () => {
    const servers: McpServerConfig[] = [
      { id: "to-remove", transport: "stdio", command: "cmd" },
      { id: "keep", transport: "stdio", command: "cmd2" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");

    const mgr = await makeManager();
    await mgr.connectServer(servers[0]);

    await mgr.removeConfig("to-remove");

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("keep");
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockUnregisterByMcp).toHaveBeenCalledWith("to-remove");
  });

  it("is idempotent when server not in config", async () => {
    const mgr = await makeManager();

    await expect(mgr.removeConfig("ghost")).resolves.toBeUndefined();
    expect(existsSync(testConfigPath)).toBe(false);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });

  it("does not rewrite config when removed server id is absent", async () => {
    const servers: McpServerConfig[] = [
      { id: "keep", transport: "stdio", command: "cmd" },
    ];
    await writeFile(testConfigPath, JSON.stringify({ servers }), "utf-8");

    const mgr = await makeManager();
    await expect(mgr.removeConfig("ghost")).resolves.toBeUndefined();

    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as { servers: McpServerConfig[] };
    expect(raw.servers).toEqual(servers);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });

  it("emits kill-switch audit when a connected server is terminated", async () => {
    const mgr = await makeManager();
    const server = { id: "audit-srv", transport: "stdio", command: "cmd" } as const;

    await mgr.connectServer(server);
    await mgr.killSwitch(server.id);

    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ type: "kill_switch" }));
  });

  it("removes a server that exists only in the legacy .bak and writes a new primary config", async () => {
    const bakServers: McpServerConfig[] = [
      { id: "bak-only-a", transport: "http", url: "https://example.com/mcp" },
      { id: "bak-only-b", transport: "stdio", command: "cmd" },
    ];
    await writeFile(`${testConfigPath}.bak`, JSON.stringify({ servers: bakServers }), "utf-8");

    const mgr = await makeManager();
    expect(existsSync(testConfigPath)).toBe(false);

    await mgr.removeConfig("bak-only-a");

    expect(existsSync(testConfigPath)).toBe(true);
    const raw = JSON.parse(await readFile(testConfigPath, "utf-8")) as {
      servers: McpServerConfig[];
    };
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0].id).toBe("bak-only-b");

    const bak = JSON.parse(
      await readFile(`${testConfigPath}.bak`, "utf-8"),
    ) as { servers: McpServerConfig[] };
    expect(bak.servers).toHaveLength(2);
  });

  it("is idempotent when removing a server absent from bak-only config", async () => {
    const bakServers: McpServerConfig[] = [
      { id: "bak-keep", transport: "stdio", command: "cmd" },
    ];
    await writeFile(`${testConfigPath}.bak`, JSON.stringify({ servers: bakServers }), "utf-8");

    const mgr = await makeManager();
    await expect(mgr.removeConfig("ghost")).resolves.toBeUndefined();

    expect(existsSync(testConfigPath)).toBe(false);
    expect(vi.mocked(rename)).not.toHaveBeenCalled();
  });
});
