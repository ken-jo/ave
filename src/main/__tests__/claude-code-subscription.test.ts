import { describe, expect, it, vi } from "vitest";
import {
  isClaudeCodeSubscriptionProviderId,
  claudeCodeSubscriptionStatus,
} from "../../shared/claude-code-subscription.js";
import {
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  SUBSCRIPTION_RUNTIME_API_COUNTERPART,
  SUBSCRIPTION_RUNTIME_DESCRIPTORS,
} from "../../shared/subscription-runtime.js";
import {
  resolveClaudeCodeSubscriptionExecutable,
  sanitizedClaudeCodeEnvironment,
} from "../claude-code-subscription-client.js";
import { claudeCodeMcpToolNames } from "../claude-code-conversation-runtime.js";
import { claimFakeRuntimeDirectories, createSubscriptionRuntimeNamespace as namespace } from "../../__tests__/support/subscription-runtime-namespace.js";
import { SubscriptionRuntimeService } from "../subscription-runtime-service.js";
import type { CodexAppServerClient } from "../codex-app-server-client.js";
import type { AcpSubscriptionRuntimeRegistry } from "../subscription-runtime-service.js";
import type { ClaudeCodeSubscriptionClient } from "../claude-code-subscription-client.js";
import type { ClaudeCodeConversationRuntimeOptions } from "../claude-code-conversation-runtime.js";
import { claudeCodePrintArgs } from "../claude-code-stream.js";
import { catalogChatModelIds } from "../../shared/model-catalog/vendor-models.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function fakeCodexClient(): CodexAppServerClient {
  return {
    getStatus: vi.fn(async () => ({
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    })),
    getCachedStatus: vi.fn(() => ({
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    })),
    listModels: vi.fn(async () => ({ status: {
      runtime: "ready",
      connection: "connected",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    }, models: [] })),
    stop: vi.fn(),
  } as unknown as CodexAppServerClient;
}

describe("claude-code subscription contract", () => {
  it("registers claude-code as a browser-login CLI subscription runtime", () => {
    expect(isSubscriptionRuntimeId("claude-code")).toBe(true);
    expect(isClaudeCodeSubscriptionProviderId("claude-code")).toBe(true);
    expect(isClaudeCodeSubscriptionProviderId("codex")).toBe(false);
    const descriptor = subscriptionRuntimeDescriptor("claude-code");
    expect(descriptor.transport).toBe("claude-cli");
    // Ave finds the user's own `claude`; there is no path to pick.
    expect(descriptor.executable).toBe("discovered");
    expect(descriptor.installGuidance?.documentationUrl).toBe("https://code.claude.com/docs/en/setup");
    // One company, one row: the Claude plan is Anthropic's other way in.
    expect(SUBSCRIPTION_RUNTIME_API_COUNTERPART["claude-code"]).toBe("claude");
    expect(descriptor.loginMethods).toEqual(["browser"]);
    expect(descriptor.supportsManagedLogout).toBe(true);
    expect(descriptor.supportsModelSelection).toBe(true);
    expect(descriptor.offersCliDefaultModel).toBe(true);
    expect(SUBSCRIPTION_RUNTIME_DESCRIPTORS.some((entry) => entry.id === "claude-code")).toBe(true);
  });

  it("builds host MCP tool names from bridge schemas", () => {
    expect(claudeCodeMcpToolNames([
      {
        name: "read_project_file",
        description: "Read one project file",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ])).toEqual(["mcp__ave-host-tools__read_project_file"]);
  });

  it("isolates CLAUDE_CONFIG_DIR and strips foreign auth environment", () => {
    const env = sanitizedClaudeCodeEnvironment(
      "C:\\isolated\\claude-home",
      {
        PATH: "C:\\Windows\\System32",
        ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
        CLAUDE_CONFIG_DIR: "C:\\Users\\example\\.claude",
        ENABLE_TOOL_SEARCH: "true",
        ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        LANG: "en_US.UTF-8",
      },
      "win32",
      "C:\\isolated\\claude-tmp",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\isolated\\claude-home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TEMP).toBe("C:\\isolated\\claude-tmp");
  });

  it("rejects relative executable paths", async () => {
    await expect(resolveClaudeCodeSubscriptionExecutable("claude.exe", "win32"))
      .rejects.toMatchObject({ code: "claude-code-runtime-invalid-executable" });
  });

  it.each(["ready", "unverified"] as const)("drops chat trust when a verified account signs out (%s)", async (runtime) => {
    let status = claudeCodeSubscriptionStatus("ready", "connected", "2.1.0");
    const client = {
      getStatus: vi.fn(async () => status),
      verify: vi.fn(async () => status),
      stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
      codexClient: fakeCodexClient(),
      acpRegistry: { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry,
      claudeCodeClient: client,
    });
    try {
      expect((await service.verify("claude-code")).capabilities.chat).toBe(true);
      status = claudeCodeSubscriptionStatus(runtime, "signed-out", "2.1.0");
      expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
      expect((await service.verify("claude-code")).capabilities.chat).toBe(false);
      await expect(service.openTextSession({ kind: "subscription", provider: "claude-code" }))
        .rejects.toMatchObject({ code: "subscription-chat-unavailable" });
    } finally {
      await service.stop();
    }
  });

  it("projects connected Claude Code status only after verify", async () => {
    const claudeCodeClient = {
      getStatus: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
      verify: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
      getRuntimePaths: vi.fn(() => ({
        runtimeHome: "C:\\isolated\\claude-home",
        workspaceDir: "C:\\isolated\\claude-workspace",
        runtimeTempDir: "C:\\isolated\\claude-tmp",
      })),
      stop: vi.fn(async () => undefined),
    } as unknown as ClaudeCodeSubscriptionClient;
    const registry = {
      stopAll: vi.fn(async () => undefined),
    } as unknown as AcpSubscriptionRuntimeRegistry;
    const service = await SubscriptionRuntimeService.create(async () => undefined, {
      namespace: namespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
      codexClient: fakeCodexClient(),
      acpRegistry: registry,
      claudeCodeClient,
    });

    expect((await service.getStatus("claude-code")).capabilities.chat).toBe(false);
    expect((await service.verify("claude-code")).capabilities).toMatchObject({
      chat: true,
      tools: true,
      images: false,
    });
  });
});

function connectedClaudeClient(): ClaudeCodeSubscriptionClient {
  return {
    getStatus: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
    verify: vi.fn(async () => claudeCodeSubscriptionStatus("ready", "connected", "2.1.0")),
    verifiedRuntime: vi.fn(async () => ({
      executable: "/approved/claude", identity: "approved-runtime",
      verify: vi.fn(async () => undefined), discard: vi.fn(async () => undefined),
    })),
    getRuntimePaths: vi.fn(() => ({
      runtimeHome: "/isolated/claude-home",
      workspaceDir: "/isolated/claude-workspace",
      runtimeTempDir: "/isolated/claude-tmp",
    })),
    stop: vi.fn(async () => undefined),
  } as unknown as ClaudeCodeSubscriptionClient;
}

async function claudeService() {
  const opened: ClaudeCodeConversationRuntimeOptions[] = [];
  const service = await SubscriptionRuntimeService.create(async () => undefined, {
    namespace: namespace(), claimRuntimeDirectories: claimFakeRuntimeDirectories,
    codexClient: fakeCodexClient(),
    acpRegistry: { stopAll: vi.fn(async () => undefined) } as unknown as AcpSubscriptionRuntimeRegistry,
    claudeCodeClient: connectedClaudeClient(),
    createClaudeCodeConversationRuntime: (options) => {
      opened.push(options);
      return { provider: "claude-code", streamTurn: vi.fn(), stop: vi.fn(async () => undefined) } as never;
    },
  });
  return { service, opened };
}

describe("subscription model choice through the installed CLI", () => {
  it("offers only chat models listed by the catalog", async () => {
    const { service } = await claudeService();
    const { models } = await service.listModels("claude-code");
    expect(models.map((model) => model.id)).toEqual(catalogChatModelIds("claude"));
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5"]));
    expect(models.some((model) => model.isDefault)).toBe(false);
  });

  it("passes a listed model to the CLI and leaves an unselected session on the CLI default", async () => {
    const { service, opened } = await claudeService();
    await service.openTextSession({ kind: "subscription", provider: "claude-code", model: "claude-sonnet-5-5" });
    await service.openTextSession({ kind: "subscription", provider: "claude-code" });
    expect(opened[0]!.model).toBe("claude-sonnet-5-5");
    expect(opened[1]).not.toHaveProperty("model");
  });

  it("refuses a persisted model the catalog does not list", async () => {
    const { service, opened } = await claudeService();
    await expect(service.openTextSession({ kind: "subscription", provider: "claude-code", model: "claude-imaginary-9" }))
      .rejects.toMatchObject({ code: "subscription-model-not-supported" });
    expect(opened).toHaveLength(0);
  });

  it("puts --model <id> on the print command only when a model was chosen, and only a plain id", () => {
    const withModel = claudeCodePrintArgs("/tmp/mcp.json", [], "claude-sonnet-5-5");
    expect(withModel.slice(withModel.indexOf("--model"), withModel.indexOf("--model") + 2)).toEqual(["--model", "claude-sonnet-5-5"]);
    expect(claudeCodePrintArgs("/tmp/mcp.json", [])).not.toContain("--model");
    expect(() => claudeCodePrintArgs("/tmp/mcp.json", [], "--dangerously-skip-permissions")).toThrow();
    expect(() => claudeCodePrintArgs("/tmp/mcp.json", [], "claude sonnet")).toThrow();
  });
});

describe("subscription credentials remain owned by the CLI", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
  const modules = ["claude-code-subscription-client.ts", "claude-code-conversation-runtime.ts", "claude-code-stream.ts"];

  it("never names a credentials file, keychain entry or token store", () => {
    for (const file of modules) {
      const text = source(file);
      for (const forbidden of [
        ".credentials.json", "Claude Code-credentials", "find-generic-password", "oauthAccount",
        "accessToken", "refreshToken", "apiKeyHelper",
      ]) {
        expect(text.includes(forbidden), `${file} names ${forbidden}`).toBe(false);
      }
    }
  });

  it("signs in only with `claude auth login`: no other login, token or key path is spawned", () => {
    const text = modules.map(source).join("\n");
    // Trusted launcher arguments precede auth commands; capability probes read help without opening another authentication path.
    const authCommands = [...text.matchAll(/"auth",\s*"([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(authCommands)).toEqual(new Set(["login", "logout", "status", "--help"]));
    expect(text).not.toMatch(/setup-token|--api-key|ANTHROPIC_API_KEY\s*[:=]|CLAUDE_CODE_OAUTH_TOKEN\s*[:=]/u);
  });

  it.each(["linux", "darwin", "win32"] as const)("drops every inherited ANTHROPIC_* and CLAUDE_* variable on %s", (platform) => {
    const home = platform === "win32" ? "C:\\isolated\\claude-home" : "/isolated/claude-home";
    const env = sanitizedClaudeCodeEnvironment(home, {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_AUTH_TOKEN: "fixture-token",
      ANTHROPIC_BASE_URL: "https://proxy.example.test",
      anthropic_model: "lowercase-variant",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/home/example/.claude",
    }, platform, platform === "win32" ? "C:\\isolated\\claude-tmp" : "/isolated/claude-tmp");
    const leaked = Object.keys(env).filter((key) => /^(ANTHROPIC_|CLAUDE_)/iu.test(key) && key !== "CLAUDE_CONFIG_DIR");
    expect(leaked).toEqual([]);
    // The one CLAUDE_ variable present is Ave's own: the isolated config dir, never the user's real one.
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(env.HOME).toBe(home);
  });
});
