import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../tools/registry.js";

class StoredSecretUnreadable extends Error {
  readonly code = "decrypt-failed";
  constructor() {
    super("could not decrypt sk-live-do-not-leak");
    this.name = "StoredSecretUnreadable";
  }
}

async function loadLoop() {
  let built = 0;
  const createProvider = vi.fn(() => ({ vendor: "openai", id: ++built, streamTurn: async function* () {} }));
  vi.doMock("../llm/provider-factory.js", () => ({
    createProvider,
    secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
  }));
  const { ConversationLoop } = await import("../conversation-loop.js");
  // Imported after resetModules so the authority comes from the same module instance runTurn checks.
  const { issueUnattendedTurnAuthority } = await import("../../shared/authorization-required.js");
  let getSecret: () => Promise<string | null> = async () => "test-key";
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings({ provider: "openai", model: "gpt-5.4-mini" }),
      getSecret: () => getSecret(),
    },
    systemPromptBuilder: { build: () => "system" },
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  return { loop, issueUnattendedTurnAuthority, setSecret: (next: () => Promise<string | null>) => { getSecret = next; } };
}

describe("ConversationLoop provider builds", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../llm/provider-factory.js");
  });

  it("records a failed build's kind without its message and names it in the turn error", async () => {
    const { loop, setSecret, issueUnattendedTurnAuthority } = await loadLoop();
    await loop.whenProviderReady();
    setSecret(async () => { throw new StoredSecretUnreadable(); });
    await expect(loop.refreshProvider()).rejects.toThrow(StoredSecretUnreadable);

    expect(loop.provider).toBeNull();
    expect(loop.providerBuildError).toBe("StoredSecretUnreadable:decrypt-failed");
    const onError = vi.fn();
    const turn = loop.runTurn("hello", { onError }, undefined, { inputOrigin: "user-keyboard", unattendedAuthority: issueUnattendedTurnAuthority() });
    await expect(turn).rejects.toThrow(/\(StoredSecretUnreadable:decrypt-failed\)$/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/\(StoredSecretUnreadable:decrypt-failed\)$/);
    expect(onError.mock.calls[0]![0]).not.toContain("sk-live");

    setSecret(async () => "test-key");
    await loop.refreshProvider();
    expect(loop.providerBuildError).toBeNull();
    expect(loop.provider).not.toBeNull();
  });

  it("keeps serving the previous provider until a rebuild settles", async () => {
    const { loop, setSecret } = await loadLoop();
    await loop.whenProviderReady();
    const previous = loop.provider;
    let release!: (value: string) => void;
    setSecret(() => new Promise((resolve) => { release = resolve; }));
    const rebuild = loop.refreshProvider();
    expect(loop.providerPending).toBe(true);
    expect(loop.provider).toBe(previous);
    release("test-key");
    await rebuild;
    expect(loop.provider).not.toBe(previous);
    expect(loop.provider).not.toBeNull();
  });

  it("waits for a rebuild that starts while an earlier one is awaited", async () => {
    const { loop, setSecret } = await loadLoop();
    await loop.whenProviderReady();
    const releases: Array<(value: string) => void> = [];
    setSecret(() => new Promise((resolve) => { releases.push(resolve); }));
    void loop.refreshProvider();
    let settled = false;
    const waiting = loop.whenProviderReady().then(() => { settled = true; });
    void loop.refreshProvider();
    releases[0]!("test-key");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(loop.providerPending).toBe(true);
    releases[1]!("test-key");
    await waiting;
    expect(loop.providerPending).toBe(false);
  });
});
