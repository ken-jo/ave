// External callers must clear both the public-channel allowlist and the gesture gate.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createTmpDirTracker } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  createLocalApi,
  LOCAL_API_GESTURE_REQUIRED,
  LOCAL_API_CHANNEL_NOT_PUBLIC,
  LOCAL_API_ORIGIN_UNSUPPORTED,
  type LocalApiDeps,
  type ExternalMutationApprover,
} from "../local-api.js";
import type { ConversationCommandPort } from "../../main/conversation-command-port.js";
import type { IpcDeps } from "../../ipc/types.js";
import {
  CHANNELS,
  PERMISSIONS,
  EXTERNAL_MUTATION_DENIED,
} from "../../contract/app-contract.js";

const temporaryDirectories = createTmpDirTracker();

beforeEach(() => {
  const root = temporaryDirectories.track(mkdtempSync(join(tmpdir(), "local-api-home-")));
  vi.stubEnv("AVE_HOME", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await temporaryDirectories.cleanup();
});

// Stub command entrypoint — chat send is exercised in its own port tests.
const conversationCommandPort: ConversationCommandPort = {
  execute: async () => ({ ok: false, error: "not-exercised" }),
};

function makeDeps(overrides: Partial<Record<string, unknown>> = {}): LocalApiDeps {
  const ipc = {
    conversationLoop: {
      getSessionId: () => "session-1",
      permissionManager: { getMode: () => "acceptEdits" },
    },
    memoryManager: {
      listSessionsPage: () => [],
    },
    ...overrides,
  } as unknown as IpcDeps;
  return { ipc, conversationCommandPort };
}

describe("local-api dispatch — public read routing", () => {
  it("routes a public read channel (permission get-mode) to its handler", async () => {
    const getMode = vi.fn(() => "plan");
    const api = createLocalApi(
      makeDeps({ conversationLoop: { getSessionId: () => "s", permissionManager: { getMode } } }),
    );
    const result = await api.dispatch({ channel: PERMISSIONS.getMode, origin: "local-api" });
    expect(getMode).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { mode: "plan" } });
  });

  it("flushes audit writes before routing external usage reads", async () => {
    const flush = vi.fn(async () => undefined);
    const api = createLocalApi(makeDeps({ auditLogger: { flush } }));

    const result = await api.dispatch({ channel: CHANNELS.usage.summary, origin: "local-api" });

    expect(result.ok).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("routes chat sessions (read) to its handler", async () => {
    const listSessionsPage = vi.fn(() => []);
    const api = createLocalApi(
      makeDeps({
        conversationLoop: { getSessionId: () => "session-1", permissionManager: { getMode: () => "default" } },
        memoryManager: { listSessionsPage },
      }),
    );
    const result = await api.dispatch({ channel: CHANNELS.chat.sessions, origin: "local-api" });
    expect(listSessionsPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: { current: "session-1", sessions: [] } });
  });

  it("keeps usage daily summary internal because it can trigger an LLM call", async () => {
    const generateText = vi.fn(async () => "요약 완료");
    const api = createLocalApi(
      makeDeps({
        conversationLoop: {
          getSessionId: () => "session-1",
          permissionManager: { getMode: () => "default" },
          generateText,
        },
      }),
    );

    const result = await api.dispatch({
      channel: CHANNELS.usage.dailySummary,
      origin: "local-api",
      args: { date: "2026-07-04", locale: "ko-KR", usage: { totalTokens: 120 } },
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
  });
});

describe("local-api dispatch — gesture-gated mutating channels are blocked", () => {
  it("rejects permission set-mode for origin 'local-api' with the gated error", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: PERMISSIONS.setMode, args: { mode: "auto" }, origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });

  it("rejects permission set-mode for origin 'cli' with the gated error", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: PERMISSIONS.setMode, args: { mode: "auto" }, origin: "cli" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });

  it("blocks every gesture:required channel for both external origins", async () => {
    const api = createLocalApi(makeDeps());
    const gated = [
      PERMISSIONS.setMode,
      PERMISSIONS.addRule,
      PERMISSIONS.removeRule,
      PERMISSIONS.policySet,
      PERMISSIONS.sandboxWindowsInstall,
      PERMISSIONS.approveExtensionsWithoutIsolation,
    ];
    for (const channel of gated) {
      for (const origin of ["local-api", "cli"] as const) {
        const result = await api.dispatch({ channel, origin });
        expect(result, `${channel} @ ${origin}`).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
      }
    }
  });
});

describe("local-api dispatch — non-public channels are rejected", () => {
  it("rejects a non-public channel (settings get)", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: CHANNELS.settings.get, origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
  });

  it("rejects an unknown channel", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({ channel: "ave:not:a:real:channel", origin: "local-api" });
    expect(result).toEqual({ ok: false, error: LOCAL_API_CHANNEL_NOT_PUBLIC });
  });
});

describe("local-api dispatch — origin is fail-closed", () => {
  it("rejects a smuggled non-external origin (bad cast)", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({
      channel: PERMISSIONS.getMode,
      origin: "renderer" as unknown as "local-api",
    });
    expect(result).toEqual({ ok: false, error: LOCAL_API_ORIGIN_UNSUPPORTED });
  });
});

function makeFakeWindow() {
  const send = vi.fn();
  return {
    send,
    win: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    },
  };
}

// The external approval already grants consent; requestAndWait must not open a second modal.
function makeMutationDeps(
  approver: ExternalMutationApprover | undefined,
  fakeWin: ReturnType<typeof makeFakeWindow>,
): LocalApiDeps {
  let mode = "default";
  const setModePersist = vi.fn(async (next: string) => {
    mode = next;
  });
  const gateRequestAndWait = vi.fn(async () => ({ requestId: "x", choice: "allow-once" as const }));
  const appendPermissionAuditEntry = vi.fn(async () => undefined);
  const ipc = {
    conversationLoop: {
      getSessionId: () => "s",
      permissionManager: {
        getMode: () => mode,
        setMode: (next: string) => {
          mode = next;
        },
        setModePersist,
      },
    },
    approvalGate: { requestAndWait: gateRequestAndWait },
    auditLogger: {
      isPermissionAuditChainReady: () => true,
      appendPermissionAuditEntry,
    },
    getMainWindow: () => fakeWin.win,
  } as unknown as IpcDeps;
  return { ipc, conversationCommandPort, externalMutationApprover: approver };
}

describe("local-api dispatch — external mutation default posture (no approver)", () => {
  it("set-mode is still rejected 'gesture-required-origin-unsupported' when NO approver is wired", async () => {
    const api = createLocalApi(makeDeps());
    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });
    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
  });
});

describe("local-api dispatch — external mutation with approver wired", () => {
  it("approver returns false → external-mutation-denied (mode NOT changed)", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => false);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: false, error: EXTERNAL_MUTATION_DENIED });
    expect(approver).toHaveBeenCalledWith({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });
    expect(fakeWin.send).not.toHaveBeenCalled();
  });

  it("approver throws → external-mutation-denied (fail-closed, no mutation)", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => {
      throw new Error("gate blew up");
    });
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "cli",
    });

    expect(result).toEqual({ ok: false, error: EXTERNAL_MUTATION_DENIED });
    expect(fakeWin.send).not.toHaveBeenCalled();
  });

  it("approver returns true → routes to handleSetPermissionMode (mode applied + broadcast attempted) and returns ok", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => true);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: true, data: { ok: true, mode: "auto" } });
    expect(fakeWin.send).toHaveBeenCalledWith(PERMISSIONS.modeChanged, { mode: "auto" });
    // External consent must bypass the second in-app prompt.
    expect((deps.ipc.approvalGate as unknown as { requestAndWait: ReturnType<typeof vi.fn> }).requestAndWait)
      .not.toHaveBeenCalled();
  });

  it("a gesture channel NOT in the external-mutation allowlist (policy set) is STILL gesture-required even with an approver", async () => {
    const fakeWin = makeFakeWindow();
    const approver = vi.fn(async () => true);
    const deps = makeMutationDeps(approver, fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.policySet,
      args: { some: "payload" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: false, error: LOCAL_API_GESTURE_REQUIRED });
    expect(approver).not.toHaveBeenCalled();
  });
});

// Separate runtime and persisted modes to prove one external approval grants only a session-scoped change.
function makeDurabilityDeps(fakeWin: ReturnType<typeof makeFakeWindow>) {
  let persistedMode = "default";
  let runtimeMode = "default";
  const setMode = vi.fn((next: string) => {
    runtimeMode = next;
  });
  const setModePersist = vi.fn(async (next: string) => {
    persistedMode = next;
    runtimeMode = next;
  });
  const ipc = {
    conversationLoop: {
      getSessionId: () => "s",
      permissionManager: { getMode: () => runtimeMode, setMode, setModePersist },
    },
    approvalGate: {
      requestAndWait: vi.fn(async () => ({ requestId: "x", choice: "allow-once" as const })),
    },
    auditLogger: {
      isPermissionAuditChainReady: () => true,
      appendPermissionAuditEntry: vi.fn(async () => undefined),
    },
    getMainWindow: () => fakeWin.win,
  } as unknown as IpcDeps;
  return {
    deps: { ipc, conversationCommandPort, externalMutationApprover: async () => true } as LocalApiDeps,
    setMode,
    setModePersist,
    reload: () => {
      runtimeMode = persistedMode;
      return runtimeMode;
    },
  };
}

describe("local-api dispatch — external set-mode is session-scoped", () => {
  it("an approved external mode change applies now but does NOT survive a restart", async () => {
    const fakeWin = makeFakeWindow();
    const { deps, setMode, setModePersist, reload } = makeDurabilityDeps(fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto" },
      origin: "local-api",
    });

    expect(result).toEqual({ ok: true, data: { ok: true, mode: "auto" } });
    expect(setMode).toHaveBeenCalledWith("auto");
    expect(fakeWin.send).toHaveBeenCalledWith(PERMISSIONS.modeChanged, { mode: "auto" });
    expect(setModePersist).not.toHaveBeenCalled();
    expect(reload()).toBe("default");
  });

  it("refuses the `allow` mode outright — the one mode that would end prompting for good", async () => {
    const fakeWin = makeFakeWindow();
    const { deps, setMode, setModePersist } = makeDurabilityDeps(fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "allow" },
      origin: "local-api",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { ok: false, error: "external-mode-forbidden" },
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(setModePersist).not.toHaveBeenCalled();
    expect(fakeWin.send).not.toHaveBeenCalled();
  });

  it("refuses a `--durable` smuggled into the mode string rather than silently honouring it", async () => {
    const fakeWin = makeFakeWindow();
    const { deps, setMode, setModePersist } = makeDurabilityDeps(fakeWin);
    const api = createLocalApi(deps);

    const result = await api.dispatch({
      channel: PERMISSIONS.setMode,
      args: { mode: "auto --durable" },
      origin: "local-api",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { ok: false, error: "external-durable-forbidden" },
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(setModePersist).not.toHaveBeenCalled();
  });
});

describe("local-api dispatch — shared conversation lease", () => {
  it("returns the normal chat busy result instead of rejecting the transport", async () => {
    const execute = vi.fn(async () => {
      throw new Error("streaming-active");
    });
    const busyConversationCommandPort: ConversationCommandPort = {
      execute,
    };
    const api = createLocalApi({
      ...makeDeps(),
      conversationCommandPort: busyConversationCommandPort,
    });

    await expect(api.dispatch({
      channel: CHANNELS.chat.send,
      args: { input: "overlap", inputOrigin: "user-keyboard", userActivation: true },
      origin: "local-api",
    })).resolves.toEqual({ ok: true, data: { error: "streaming-active" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
