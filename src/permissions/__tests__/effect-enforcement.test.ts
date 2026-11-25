// Actual effects retain descriptor scope, common policy ordering and effect-before-execution enforcement.
import { registerRunSession, __resetRunGrantsForTest } from "../run-grants.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, type ReviewerDispatchResult } from "../permission-manager.js";
let permissionManager: PermissionManager;

import type { ApprovalChoice, ApprovalDecision, ApprovalGate, ApprovalRequest, ApprovalRequestInput,
} from "../approval-gate.js";
import {
  enforceMutatingEffects,
  gateMutatingEffect,
  snapshotEffectArguments,
  runWithEffectGateContext,
  currentEffectGateContext,
  GATED_EFFECT_PATHS,
  ENFORCEMENT_EXCLUSIONS,
  EffectBoundaryDeniedError,
  type EffectGateContext,
  sameEffectAuthority,
  __resetEffectGrantsForTest,
} from "../effect-enforcement.js";
import { aveHome } from "../../shared/ave-home.js";
import { declaredBackgroundEffects, withinBackgroundScope } from "../../plugins/plugin-background-effects.js";
import {
  writeClassifiedPaths,
  CHOKEPOINT_EFFECT,
  HOSTAPI_EFFECT_BY_PATH,
} from "../effect-kind.js";
import {
  instrumentEffectsByPath,
  INSTRUMENTED,
} from "../hostapi-effect-recorder.js";
import {
  createEffectLedger,
  runWithEffectLedger } from "../effect-ledger.js";

beforeEach(() => {
  __resetEffectGrantsForTest();
  permissionManager = new PermissionManager(join(tmpdir(), `effect-policy-${randomUUID()}.json`));
  permissionManager.setMode("strict");
});

// A stub ApprovalGate that records every request and answers with a fixed choice.
function makeGate(choice: ApprovalChoice | ApprovalChoice[]): {
  gate: ApprovalGate;
  requests: Array<ApprovalRequestInput>;
} {
  const requests: Array<ApprovalRequestInput> = [];
  const answers = Array.isArray(choice) ? [...choice] : null;
  const gate = {
    requestAndWait: async (
      req: ApprovalRequestInput,
    ): Promise<ApprovalDecision> => {
      requests.push(req);
      const next = answers ? (answers.shift() ?? "deny-once") : (choice as ApprovalChoice);
      return { requestId: req.id, choice: next };
    },
  } as unknown as ApprovalGate;
  return { gate, requests };
}

// A fake per-plugin hostApi whose real impls only log the method they ran.
function makeApi(log: string[]) {
  return {
    // gated async writes
    triggerConversation: async (_spec: unknown,
    ): Promise<{ accepted: boolean }> => {
      log.push("trigger");
      return { accepted: true };
    },
    callLlm: async (_prompt: unknown): Promise<string> => {
      log.push("llm");
      return "resp";
    },
    spawnWorker: async (_spec: unknown,
    ): Promise<{ pid: number; socketPath: null }> => {
      log.push("spawnWorker");
      return { pid: 123, socketPath: null };
    },
    storage: {
      write: async (_rel: string, _data?: unknown): Promise<void> => {
        log.push("write");
      },
      // gated path but a READ — never prompts (effect from SOT).
      read: async (_rel: string): Promise<string> => {
        log.push("read");
        return "data";
      },
    },
  };
}

const deps = (
  gate: ApprovalGate,
  assertActive: () => void = () => {},
) => ({
  pluginId: "p1",
  approvalGate: gate,
  permissionManager,
  resolveStoragePath: (relativePath: string) => join(tmpdir(), "effect-storage", relativePath),
  assertActive,
});

describe("mandatory effect policy and standalone lifecycle", () => {
  it("each active mutating chokepoint receives its own permission", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    let writeResult: unknown = "sentinel";
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.triggerConversation({ source: "s" });
      writeResult = await api.storage.write("a.txt", "x");
      await api.callLlm("hello");
    },
    );

    expect(requests).toHaveLength(3);
    expect(log).toEqual(["trigger", "write", "llm"]); // every impl ran in order
    expect(writeResult).toBeUndefined(); // identical return value (void)
  });

  it("standalone lifecycle storage remains outside the tool policy", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await api.storage.write("a.txt", "x"); // outside any invocation scope
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["write"]);
  });
});

describe("standalone frames run only the approved background scope", () => {
  const standalone = { headless: false, standalone: true, toolName: "storage.write" } as const;

  it("runs an in-scope effect without asking or reviewing", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const reviewer = vi.spyOn(permissionManager, "dispatchReviewer");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: (path: string) => path === "storage.write" });
    await runWithEffectGateContext(standalone, () => api.storage.write("a.txt", "x"));
    expect(log).toEqual(["write"]);
    expect(requests).toHaveLength(0);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it.each([
    ["no approved scope", undefined],
    ["a path outside the scope", (path: string) => path === "storage.write"],
  ])("denies with %s, without asking", async (_label, standaloneScope) => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), ...(standaloneScope ? { standaloneScope } : {}) });
    await expect(runWithEffectGateContext(standalone, () => api.callLlm("hello"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("writes its own storage with no approved scope, but never a path just outside it", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const storage = join(tmpdir(), "effect-storage");
    const resolveStoragePath = (rel: string) => join(storage, rel);
    const unapproved = enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath, standaloneScope: () => false });
    await runWithEffectGateContext(standalone, () => unapproved.storage.write("a.txt", "x"));
    const approved = enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath, standaloneScope: () => true });
    for (const outside of ["../effect-storage-other/a.txt", "../a.txt"]) {
      await expect(runWithEffectGateContext(standalone, () => approved.storage.write(outside, "x"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    }
    expect(log).toEqual(["write"]);
    expect(requests).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("follows a junction out of its own storage, and matches the storage root in any case", async () => {
    const root = mkdtempSync(join(tmpdir(), "effect-storage-links-"));
    try {
      const storage = join(root, "storage");
      mkdirSync(storage);
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(storage, "link"), "junction");
      const log: string[] = [];
      const { gate, requests } = makeGate("allow-once");
      const own = (resolveStoragePath: (rel: string) => string) =>
        enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath, standaloneScope: () => true });
      await expect(runWithEffectGateContext(standalone, () => own((rel) => join(storage, rel)).storage.write("link/a.txt", "x")))
        .rejects.toBeInstanceOf(EffectBoundaryDeniedError);
      await runWithEffectGateContext(standalone, () => own((rel) => rel === "." ? storage : join(storage.toUpperCase(), rel)).storage.write("a.txt", "x"));
      // A root not created yet keeps the spelling it was given.
      const fresh = (rel: string) => rel === "." ? join(root, "fresh-storage") : join(root, "FRESH-STORAGE", rel);
      await runWithEffectGateContext(standalone, () => own(fresh).storage.write("a.txt", "x"));
      expect(log).toEqual(["write", "write"]);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a policy deny inside the scope", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const real = permissionManager.checkDetailed.bind(permissionManager);
    vi.spyOn(permissionManager, "checkDetailed").mockImplementation((...args) => ({ ...real(...args), decision: "deny", reason: "denied by rule" }));
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => true });
    await expect(runWithEffectGateContext(standalone, () => api.storage.write("a.txt", "x"))).rejects.toThrow("denied by rule");
    expect(log).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("never widens the scope with a grant remembered inside a tool call", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => false });
    await runWithEffectGateContext({ headless: false, toolName: "t" }, () => api.callLlm("hello"));
    await expect(runWithEffectGateContext(standalone, () => api.callLlm("hello"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual(["llm"]);
    expect(requests).toHaveLength(1);
  });
});

describe("standalone frames take only the asks the enable card answers", () => {
  const standalone = (toolName: string) => ({ headless: false, standalone: true, toolName }) as const;
  const asking = (result: Record<string, unknown>) => {
    const real = permissionManager.checkDetailed.bind(permissionManager);
    vi.spyOn(permissionManager, "checkDetailed").mockImplementation((...args) => ({ ...real(...args), ...result }) as never);
  };

  it.each([
    ["a forced floor", { decision: "ask", reasonCode: "other-principal", forceModal: true }],
    ["the app-home floor off own storage", { decision: "ask", reasonCode: "protected-path", reason: "application-home", forceModal: true }],
    ["the exfiltration guardrail", { decision: "ask", reasonCode: "exfiltration-guardrail" }],
    ["a secret read", { decision: "ask", reasonCode: "secret-read" }],
    ["an ask rule", { decision: "ask", reasonCode: "rule-ask" }],
    ["a manual rerun", { decision: "ask", reasonCode: "manual-rerun" }],
    ["an unknown reason", { decision: "ask", reasonCode: "something-new" }],
    ["no reason code", { decision: "ask", reasonCode: undefined }],
  ])("denies %s inside the approved scope, without asking", async (_label, result) => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    asking(result);
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => true });
    await expect(runWithEffectGateContext(standalone("callLlm"), () => api.callLlm("hello"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it.each(["file-write", "shell-approval", "network-approval", "review-required"])("runs an ordinary %s ask inside the approved scope", async (reasonCode) => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    asking({ decision: "ask", reasonCode });
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => true });
    await runWithEffectGateContext(standalone("callLlm"), () => api.callLlm("hello"));
    expect(log).toEqual(["llm"]);
    expect(requests).toHaveLength(0);
  });

  it.each(["auto", "default", "strict"] as const)("in %s mode denies a user ask rule even where automatic review would carry it", async (mode) => {
    permissionManager.setMode(mode);
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => true });
    await runWithEffectGateContext(standalone("callLlm"), () => api.callLlm("hello"));
    permissionManager.setRules([{ pattern: "effect_callLlm", source: "plugin", action: "ask" }]);
    await expect(runWithEffectGateContext(standalone("callLlm"), () => api.callLlm("hello"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual(["llm"]);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["the exfiltration guardrail", { exfiltration: { reason: "sends a secret" } }],
    ["a secret read", { secretRead: true }],
  ])("denies an automatic review that stands for %s", async (_label, evidence) => {
    permissionManager.setMode("auto");
    const real = permissionManager.checkDetailed.bind(permissionManager);
    vi.spyOn(permissionManager, "checkDetailed").mockImplementation((...args) => {
      const result = real(...args);
      return { ...result, decision: "ask", reasonCode: "review-required", pipelineRequest: { ...result.pipelineRequest, ...evidence } } as never;
    });
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => true });
    await expect(runWithEffectGateContext(standalone("callLlm"), () => api.callLlm("hello"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it.each(["auto", "default", "strict"] as const)("in %s mode denies a user ask rule on own storage that the app-home floor would hide", async (mode) => {
    permissionManager.setMode(mode);
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const storage = join(aveHome(), "plugins", "p1", "data", "storage");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath: (rel: string) => join(storage, rel), standaloneScope: () => true });
    await runWithEffectGateContext(standalone("storage.write"), () => api.storage.write("state.json", "x"));
    permissionManager.setRules([{ pattern: "effect_storage_write", source: "plugin", action: "ask" }]);
    await expect(runWithEffectGateContext(standalone("storage.write"), () => api.storage.write("state.json", "x")))
      .rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual(["write"]);
    expect(requests).toHaveLength(0);
  });

  it("writes the plugin storage in the app home with or without an approval, but not a protected entry inside it", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const storage = join(aveHome(), "plugins", "p1", "data", "storage");
    const approved = enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath: (rel: string) => join(storage, rel), standaloneScope: () => true });
    await runWithEffectGateContext(standalone("storage.write"), () => approved.storage.write("state.json", "x"));
    await expect(runWithEffectGateContext(standalone("storage.write"), () => approved.storage.write(".git/config", "x")))
      .rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    const unapproved = enforceMutatingEffects(makeApi(log), { ...deps(gate), resolveStoragePath: (rel: string) => join(storage, rel), standaloneScope: () => false });
    await runWithEffectGateContext(standalone("storage.write"), () => unapproved.storage.write("state.json", "x"));
    expect(log).toEqual(["write", "write"]);
    expect(requests).toHaveLength(0);
  });

  it("reads storage without an approved scope, but never past a deny or an ask", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), { ...deps(gate), standaloneScope: () => false });
    await expect(runWithEffectGateContext(standalone("storage.read"), () => api.storage.read("a.txt"))).resolves.toBe("data");
    asking({ decision: "deny", reason: "denied by rule" });
    await expect(runWithEffectGateContext(standalone("storage.read"), () => api.storage.read("a.txt"))).rejects.toThrow("denied by rule");
    vi.restoreAllMocks();
    asking({ decision: "ask", reasonCode: "file-write" });
    await expect(runWithEffectGateContext(standalone("storage.read"), () => api.storage.read("a.txt"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(log).toEqual(["read"]);
    expect(requests).toHaveLength(0);
  });

  it.each(["strict", "default", "auto"] as const)("in %s mode fetches a declared loopback target the policy would ask for, and no undeclared one", async (mode) => {
    permissionManager.setMode(mode);
    const { gate, requests } = makeGate("allow-once");
    const effects = declaredBackgroundEffects({
      id: "p1", name: "P", version: "1.0.0", entry: "plugin.mjs", description: "p", tools: [],
      networkAccess: { allowedDomains: ["127.0.0.1", "[::1]"] },
    } as never);
    const fetchFrom = (url: string) => runWithEffectGateContext(standalone("hostFetch"), () => gateMutatingEffect({
      pluginId: "p1", methodPath: "hostFetch", effect: "read", target: new URL(url).origin,
      input: [url, { method: "GET", headers: [], credentialAttached: false }], approvalGate: gate, permissionManager,
      standaloneScope: (path, target) => withinBackgroundScope(effects, path, target),
    }));
    await expect(fetchFrom("http://127.0.0.1:8080/x")).resolves.toBeUndefined();
    await expect(fetchFrom("http://[::1]:8080/x")).resolves.toBeUndefined();
    await expect(fetchFrom("http://localhost:8080/x")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    await expect(fetchFrom("https://api.example.test/x")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(requests).toHaveLength(0);
  });
});

describe("effect authority across live calls compares values, not per-call objects", () => {
  const bridge = (guard: object, chatId: string) => ({
    kind: "platform-bridge", actorId: "actor-1", bridgeGuard: guard, bridgeBinding: { platform: "example", chatId },
  });
  const frame = (permissionContext: Record<string, unknown>) =>
    ({ headless: false, toolName: "t", permissionContext }) as unknown as EffectGateContext;

  it("treats rebuilt but equal remote controllers alike and tells different ones apart", () => {
    const guard = { isCurrent: () => true };
    expect(sameEffectAuthority(frame({ remoteControllerAuthority: bridge(guard, "c1") }), frame({ remoteControllerAuthority: bridge(guard, "c1") }))).toBe(true);
    expect(sameEffectAuthority(frame({ remoteControllerAuthority: bridge(guard, "c1") }), frame({ remoteControllerAuthority: bridge(guard, "c2") }))).toBe(false);
    expect(sameEffectAuthority(frame({ remoteControllerAuthority: bridge(guard, "c1") }), frame({ remoteControllerAuthority: bridge({ isCurrent: () => true }, "c1") }))).toBe(false);
    expect(sameEffectAuthority(frame({ remoteControllerAuthority: bridge(guard, "c1") }), frame({}))).toBe(false);
  });

  it("compares floors and admission denials by code and the guardrail by presence, since their text is display", () => {
    const floor = (code: string, reason: string) => frame({ floor: { code, reason } });
    expect(sameEffectAuthority(floor("other-principal", "a"), floor("other-principal", "b"))).toBe(true);
    expect(sameEffectAuthority(floor("other-principal", "a"), floor("protected-path", "a"))).toBe(false);
    expect(sameEffectAuthority(frame({ exfiltration: { reason: "a" } }), frame({ exfiltration: { reason: "b" } }))).toBe(true);
    expect(sameEffectAuthority(frame({ exfiltration: { reason: "a" } }), frame({}))).toBe(false);
    expect(sameEffectAuthority(frame({ permissionStoreError: "x" }), frame({ permissionStoreError: "x" }))).toBe(true);
  });
});

describe("foreground write permission at the actual effect", () => {
  it("ALLOW → the real impl proceeds and returns its value", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    let llmResult: unknown;
    await runWithEffectGateContext({ headless: false, toolName: "meeting_start" }, async () => {
      llmResult = await api.callLlm("hi");
    },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      source: "plugin",
      sourcePluginId: "p1",
      toolName: "meeting_start",
      approvalScope: expect.stringMatching(/^[a-f0-9]{64}$/u),
      args: { effect: "write", methodPath: "callLlm" },
    });
    expect(log).toEqual(["llm"]);
    expect(llmResult).toBe("resp");
  });

  it("DENY → throws EffectBoundaryDeniedError and the mutation NEVER executes", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.storage.write("secret.json", "x"),
        ).rejects.toBeInstanceOf(
        EffectBoundaryDeniedError);
    },
    );

    expect(requests).toHaveLength(1); // it DID ask
    expect(requests[0].args).toMatchObject({ methodPath: "storage.write", target: "secret.json",
    });
    expect(log).toEqual([]); // ... and the real write never ran
  });

  it("a nested-namespace WRITE is gated under its dotted PATH", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("notes/a.md", "x");
    },
    );
    expect(requests[0]?.approvalScope).toMatch(/^[a-f0-9]{64}$/u);
    expect(log).toEqual(["write"]);
  });

  it("revalidates the HostApi incarnation after approval and before the effect", async () => {
    const log: string[] = [];
    let approve!: (decision: ApprovalDecision) => void;
    const gate = {
      requestAndWait: (request: ApprovalRequestInput) =>
        new Promise<ApprovalDecision>((resolve) => {
          approve = resolve;
        }).then((decision) => ({ ...decision, requestId: request.id })),
    } as unknown as ApprovalGate;
    let active = true;
    const api = enforceMutatingEffects(
      makeApi(log),
      deps(gate, () => {
        if (!active) throw new Error("stale HostApi incarnation");
      }),
    );

    const call = runWithEffectGateContext(
      { headless: false, toolName: "t" },
      () => api.storage.write("stale.txt", "x"),
    );
    await vi.waitFor(() => expect(approve).toBeTypeOf("function"));
    active = false;
    approve({ requestId: "ignored", choice: "allow-once" });

    await expect(call).rejects.toThrow("stale HostApi incarnation");
    expect(log).toEqual([]);
  });
});

describe("enforceMutatingEffects — openExternalUrl is now GATED (moved out of the exclusions)", () => {
  // A hostApi exposing openExternalUrl as a real async write impl.
  function makeUrlApi(log: string[]) {
    return {
      openExternalUrl: async (_url: string): Promise<void> => {
        log.push("open");
      },
    };
  }

  it("foreground external actions ask before opening their URL", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeUrlApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.openExternalUrl("https://evil.example/exfil?d=secret"),
        ).rejects.toBeInstanceOf(
        EffectBoundaryDeniedError);
    },
    );
    expect(requests).toHaveLength(1); // the effect-gate fired
    expect(requests[0]).toMatchObject({
      category: "agent-action",
      args: { effect: "write", methodPath: "openExternalUrl", target: "https://evil.example",
      },
    });
    expect(log).toEqual([]); // DENY → the browser was never opened
  });

  it("standalone lifecycle URL opening remains outside the tool pipeline", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeUrlApi(log), deps(gate));
    await api.openExternalUrl("https://example.com");
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["open"]);
  });

});

describe("enforceMutatingEffects — reads never prompt", () => {
  it("a gated-namespace READ method passes through with no approval", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    let v: unknown;
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      v = await api.storage.read("a.txt");
    },
    );
    expect(requests).toHaveLength(0);
    expect(v).toBe("data");
    expect(log).toEqual(["read"]);
  });
});

describe("enforceMutatingEffects — headless = NO modal (fail-closed)", () => {
  it("a write in a headless invocation throws WITHOUT asking and does not execute", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    let caught: unknown;
    await runWithEffectGateContext({ headless: true, toolName: "routine_tool" }, async () => {
      try {
        await api.storage.write("a.txt", "x");
      } catch (err) {
        caught = err;
      }
    },
    );

    expect(requests).toHaveLength(0); // a modal is impossible headless — never asked
    expect(caught).toBeInstanceOf(EffectBoundaryDeniedError);
    expect((caught as EffectBoundaryDeniedError).reason).toBe("headless");
    expect(log).toEqual([]); // fail-closed: the mutation did NOT run
  });
});

describe("enforceMutatingEffects — dedup (one grant ends repeats, never widened)", () => {
  it("allow-always suppresses repeat modals for the SAME descriptor", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("a.txt", "1");
      await api.storage.write("a.txt", "1");
    },
    );
    expect(requests).toHaveLength(1); // one "always" ended the repeats
    expect(log).toEqual(["write", "write", "write"]);
  });

  it("allow-once dedups N writes to one target WITHIN a single invocation", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("a.txt", "1");
    },
    );
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write", "write"]);
  });

  it("allow-once ends when its invocation returns, including for work the invocation left running", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    let late!: () => Promise<void>;
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      late = AsyncResource.bind(() => api.storage.write("a.txt", "1"));
    });
    await late();
    await late();
    expect(requests).toHaveLength(3);
    expect(log).toEqual(["write", "write", "write"]);
  });

  it("a DIFFERENT target re-prompts — the grant is not widened beyond its descriptor", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await api.storage.write("a.txt", "1");
      await api.storage.write("b.txt", "2"); // different target → fresh approval
    },
    );
    expect(requests).toHaveLength(2);
    expect(log).toEqual(["write", "write"]);
  });

  it("deny-always short-circuits a repeat to a throw without re-prompting", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.storage.write("a.txt", "1")).rejects.toBeInstanceOf(EffectBoundaryDeniedError,
        );
      await expect(api.storage.write("a.txt", "1")).rejects.toBeInstanceOf(EffectBoundaryDeniedError,
        );
    },
    );
    expect(requests).toHaveLength(1); // remembered the deny, did not re-ask
    expect(log).toEqual([]);
  });
});

describe("invalid effect arguments fail before mutation", () => {
  it("a throwing getter cannot gain a broader descriptor grant", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    const hostileSpec = { get source(): never { throw new Error("hostile getter"); }, prompt: "p" };
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(api.triggerConversation(hostileSpec)).rejects.toThrow("hostile getter");
    });
    expect(requests).toHaveLength(0);
    expect(log).toEqual([]);
  });
});

describe("gateMutatingEffect — direct unit behaviour", () => {
  it("an active direct storage effect cannot bypass permission", async () => {
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await expect(gateMutatingEffect({ pluginId: "p1", methodPath: "storage.write", effect: "write", target: "a", input: ["a", "value"], approvalGate: gate, permissionManager, resolveStoragePath: (relativePath) => join(tmpdir(), "effect-storage", relativePath) })).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1);
  });

  it("ordinary metadata reads do not ask", async () => {
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
      await gateMutatingEffect({
        pluginId: "p1",
        methodPath: "getSecret",
        effect: "read",
        target: "https://x",
        approvalGate: gate,
        permissionManager,
        resolveStoragePath: (relativePath: string) => join(tmpdir(), "effect-storage", relativePath),

      });
    },
    );
    expect(requests).toHaveLength(0);
  });

  it("no gate context bound → returns without asking (out-of-invocation hostApi call)", async () => {
    const { gate, requests } = makeGate("deny-once");
    expect(currentEffectGateContext()).toBeUndefined();
    await gateMutatingEffect({
      pluginId: "p1",
      methodPath: "hostFetch",
      effect: "write",
      target: "https://x",
      approvalGate: gate,
      permissionManager,
      resolveStoragePath: (relativePath: string) => join(tmpdir(), "effect-storage", relativePath),

    });
    expect(requests).toHaveLength(0);
  });

  it("keeps unavailable routine execution on the existing headless denial lane", async () => {
    const { gate, requests } = makeGate("allow-once");
    const onAuthorizationRequired = vi.fn();
    let caught: unknown;

    await runWithEffectGateContext(
      {
        headless: true,
        approvalSurface: "unavailable",
        toolName: "routine_tool",
      },
      async () => {
        try {
          await gateMutatingEffect({
            pluginId: "routine-plugin",
            methodPath: "storage.write",
            effect: "write",
            target: "routine.txt",
            input: ["routine.txt"],
            approvalGate: gate,
            permissionManager,
            resolveStoragePath: (relativePath: string) => join(tmpdir(), "effect-storage", relativePath),

          });
        } catch (error) {
          caught = error;
        }
      },
      onAuthorizationRequired,
    );

    expect(caught).toBeInstanceOf(EffectBoundaryDeniedError);
    expect((caught as EffectBoundaryDeniedError).reason).toBe("headless");
    expect(onAuthorizationRequired).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("keeps the windowless terminal latch private until a write chokepoint trips it", async () => {
    const { gate, requests } = makeGate("allow-once");
    const onAuthorizationRequired = vi.fn();
    let caught: unknown;

    await runWithEffectGateContext(
      {
        headless: false,
        approvalSurface: "unavailable",
        toolName: "plugin_tool",
      },
      async () => {
        const ambient = currentEffectGateContext() as
          | (EffectGateContext & { onAuthorizationRequired?: unknown })
          | undefined;
        expect(ambient).toBeDefined();
        expect(ambient).not.toHaveProperty("onAuthorizationRequired");
        try {
          await gateMutatingEffect({
            pluginId: "windowless-plugin",
            methodPath: "storage.write",
            effect: "write",
            target: "windowless.txt",
            input: ["windowless.txt"],
            approvalGate: gate,
            permissionManager,
            resolveStoragePath: (relativePath: string) => join(tmpdir(), "effect-storage", relativePath),

          });
        } catch (error) {
          caught = error;
        }
      },
      onAuthorizationRequired,
    );

    expect(caught).toBeInstanceOf(EffectBoundaryDeniedError);
    expect((caught as EffectBoundaryDeniedError).reason).toBe("approval-unavailable");
    expect(onAuthorizationRequired).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });
});

describe("GATED_EFFECT_PATHS — SOT-derived async-only membership", () => {
  it("contains the design's async write chokepoints (incl. openExternalUrl) and EXCLUDES the verb-derived hostFetch + sync/circular writes", () => {
    for (const p of [
      "storage.write",
      "config.set",
      "storage.writeJson",
      "storage.rm",
      "storage.mkdir",
      "openAuthWindow",
      "openAuthPartitionViewer",
      "clearAuthPartition",
      "callLlm",
      "spawnWorker",
      "triggerConversation",
      // openExternalUrl is now GATED (egress/exfil-class) — moved out of the exclusions; it is async so the await-based wrapper can gate it.
      "openExternalUrl",
    ]) {
      expect(GATED_EFFECT_PATHS.has(p)).toBe(true);
    }
    // Network effects self-gate inline.
    for (const p of ["hostFetch"]) {
      expect(GATED_EFFECT_PATHS.has(p)).toBe(false);
    }
  });
});

describe("MAJOR-1 — the gated set is SOT-DERIVED + FAIL-CLOSED (not hand-curated)", () => {
  it("every gated path is WRITE-classified + ASYNC in the SOT (never a read, never sync)", () => {
    for (const p of GATED_EFFECT_PATHS) {
      const spec = HOSTAPI_EFFECT_BY_PATH[p];
      expect(spec, `gated path ${p} must exist in the SOT`).toBeDefined();
      // write-classified: a static write (selfRecorded hostFetch is never gated here)
      expect(
        CHOKEPOINT_EFFECT[spec.kind as keyof typeof CHOKEPOINT_EFFECT],
      ).toBe("write");
      // async: the await-based wrapper can only gate an already-async method
      expect(spec.async, `gated path ${p} must be declared async`).toBe(true);
    }
  });

  it("COMPLETENESS — gated ∪ exclusions PARTITIONS every write-classified path (fail-closed)", () => {
    const writeClassified = new Set(writeClassifiedPaths());
    const accountedFor = new Set<string>([
      ...GATED_EFFECT_PATHS,
      ...ENFORCEMENT_EXCLUSIONS.keys(),
    ]);

    // (a) Every write-classified path is either gated or explicitly excluded — a NEW write chokepoint added to the SOT can never silently ship un-enforced.
    const unaccounted = [...writeClassified].filter(
      (p) => !accountedFor.has(p),
    );
    expect(
      unaccounted,
      `write-classified path(s) that are NEITHER gated NOR explicitly excluded — gate them (async) or add to ENFORCEMENT_EXCLUSIONS: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    // (b) No exclusion (or gated path) is fabricated — every accounted path is actually write-classified in the SOT (you cannot exclude a read / unknown).
    const overReaching = [...accountedFor].filter(
      (p) => !writeClassified.has(p),
    );
    expect(
      overReaching,
      `gated/excluded path(s) that are NOT write-classified in the SOT (stale entry?): ${overReaching.join(", ")}`,
    ).toEqual([]);

    // (c) The two sets are DISJOINT — a path is gated XOR excluded, never both.
    const both = [...GATED_EFFECT_PATHS].filter((p) =>
      ENFORCEMENT_EXCLUSIONS.has(p),
    );
    expect(both, `path(s) both gated AND excluded: ${both.join(", ")}`).toEqual(
      [],
    );
  });

  it("each exclusion carries a documented one-line reason", () => {
    for (const [path, reason] of ENFORCEMENT_EXCLUSIONS) {
      expect(reason, `exclusion ${path} must document a reason`).toBeTruthy();
      expect(reason.length).toBeGreaterThan(10);
    }
    // Network effects authorize inline at their own boundary.
    expect([...ENFORCEMENT_EXCLUSIONS.keys()].sort()).toEqual(
      ["hostFetch"].sort(),
    );
    // openExternalUrl is NO LONGER an exclusion — it is effect-gated.
    expect(ENFORCEMENT_EXCLUSIONS.has("openExternalUrl")).toBe(false);
  });
});

describe("headless effects use explicit grants before human fallback", () => {
  it("a remembered exact effect grant can authorize the same headless effect", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "fg" }, () => api.storage.write("a.txt", "1"));
    await runWithEffectGateContext({ headless: true, toolName: "routine" }, () => api.storage.write("a.txt", "1"));
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write", "write"]);
  });

  it("a foreground allow-once does not leak into a headless invocation either", async () => {
    const log: string[] = [];
    const { gate } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext(
      { headless: false, toolName: "fg" },
      async () => {
        await api.storage.write("a.txt", "1");
      },
    );
    // onceGrants are invocation-scoped, so they cannot reach the headless call, but assert headless fails closed regardless.
    await runWithEffectGateContext(
      { headless: true, toolName: "routine" },
      async () => {
        await expect(api.storage.write("a.txt", "2")).rejects.toBeInstanceOf(
          EffectBoundaryDeniedError,
        );
      },
    );
    expect(log).toEqual(["write"]); // only the foreground write ran
  });
});

describe("effect arguments are sealed before approval", () => {
  it("the modal and implementation share the first getter value", async () => {
    const { gate, requests } = makeGate("allow-once");
    // The implementation receives the sealed value used by the card and grant identity.
    const implSawSource: string[] = [];
    const api = enforceMutatingEffects(
      {
        triggerConversation: async (spec: {
          source: string;
        }): Promise<{ accepted: boolean }> => {
          implSawSource.push(spec.source); // Reads the sealed data property.
          return { accepted: true };
        },
      },
      deps(gate),
    );

    let reads = 0;
    const statefulSpec = {
      get source(): string {
        reads += 1;
        return `src-${reads}`; // a different value on every read
      },
    };

    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await api.triggerConversation(statefulSpec);
      },
    );

    // The gate read the getter EXACTLY ONCE for its descriptor (the first read)…
    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({
      methodPath: "triggerConversation",
      target: "src-1",
    });
    // Execution sees the same value, without invoking the caller getter again.
    expect(implSawSource).toEqual(["src-1"]);
    expect(reads).toBe(1);
  });
});

describe("exact action grants avoid method-wide approval", () => {
  it("target-less and target-scoped writes both omit method-wide approval", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await api.callLlm("hi"); // The complete input still has an exact grant identity.
        await api.storage.write("a.txt", "x"); // target → scoped grant
      },
    );
    expect(requests[0].args).toMatchObject({
      methodPath: "callLlm",
    });
    expect((requests[0].args as { target?: unknown }).target).toBeUndefined();
    expect(requests[0].args).not.toHaveProperty("methodWide");
    expect(requests[1].args).toMatchObject({
      methodPath: "storage.write",
      target: "a.txt",
    });
    expect(
      (requests[1].args as { methodWide?: unknown }).methodWide,
    ).toBeUndefined();
  });

  it("spawnWorker approvals are scoped to worker command and filesystem grants", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate(["allow-session", "allow-session"]);
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    const base = {
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index-a"],
    };

    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await api.spawnWorker(base);
        await api.spawnWorker({ ...base, allowWritePaths: ["C:/index-a"] });
        await api.spawnWorker({ ...base, allowWritePaths: ["C:/index-b"] });
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect(
      (requests[0].args as { methodWide?: unknown }).methodWide,
    ).toBeUndefined();
    expect(
      JSON.parse((requests[0].args as { target: string }).target),
    ).toMatchObject({
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowRead: ["C:/worker.py"],
      allowWrite: ["C:/index-a"],
    });
    expect(
      JSON.parse((requests[1].args as { target: string }).target),
    ).toMatchObject({
      allowWrite: ["C:/index-b"],
    });
    expect(log).toEqual(["spawnWorker", "spawnWorker", "spawnWorker"]);
  });

  it("spawnWorker grants remain scoped by the host-bound plugin id", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate(["allow-session", "allow-session"]);
    const apiA = enforceMutatingEffects(makeApi(log), deps(gate));
    const apiB = enforceMutatingEffects(makeApi(log), {
      ...deps(gate),
      pluginId: "p2",
    });
    const spec = {
      workerId: "embed",
      command: "C:/Python/python.exe",
      allowReadPaths: ["C:/worker.py"],
      allowWritePaths: ["C:/index"],
    };

    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await apiA.spawnWorker(spec);
        await apiB.spawnWorker(spec);
      },
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].sourcePluginId).toBe("p1");
    expect(requests[1].sourcePluginId).toBe("p2");
    expect(requests[0].args).toEqual(requests[1].args);
    expect(log).toEqual(["spawnWorker", "spawnWorker"]);
  });

  it("spawnWorker malformed object specs do not become method-wide approvals", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-session");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await api.spawnWorker({});
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect(
      (requests[0].args as { methodWide?: unknown }).methodWide,
    ).toBeUndefined();
    expect(JSON.parse((requests[0].args as { target: string }).target)).toEqual(
      {
        workerId: "",
        command: "",
        allowRead: [],
        allowWrite: [],
      },
    );
    expect(log).toEqual(["spawnWorker"]);
  });

  it("spawnWorker non-object specs do not become method-wide approvals", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-session");
    const api = enforceMutatingEffects(makeApi(log), deps(gate));

    await runWithEffectGateContext(
      { headless: false, toolName: "t" },
      async () => {
        await (api.spawnWorker as (spec: unknown) => Promise<unknown>)(
          "not-a-spec",
        );
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].args).toMatchObject({ methodPath: "spawnWorker" });
    expect(
      (requests[0].args as { methodWide?: unknown }).methodWide,
    ).toBeUndefined();
    expect(JSON.parse((requests[0].args as { target: string }).target)).toEqual(
      {
        workerId: "",
        command: "",
        allowRead: [],
        allowWrite: [],
        invalidSpec: true,
      },
    );
    expect(log).toEqual(["spawnWorker"]);
  });
});

describe("composed stack — enforceMutatingEffects(instrumentEffectsByPath(raw))", () => {
  // A raw hostApi-shaped object whose impls read `this` so we can prove binding.
  function makeRawApi(log: string[]) {
    return {
      marker: "ROOT",
      callLlm: async function (
        this: { marker: string },
        _p: unknown,
      ): Promise<string> {
        log.push(`llm:${this.marker}`);
        return "resp";
      },
      // a READ — never gated, always recorded
      getSecret: function (this: { marker: string }): string[] {
        log.push(`ids:${this.marker}`);
        return [];
      },
      storage: {
        marker: "STORAGE",
        write: async function (
          this: { marker: string },
          _rel: string,
        ): Promise<void> {
          log.push(`write:${this.marker}`);
        },
      },
    };
  }

  function composed(log: string[], gate: ApprovalGate) {
    return enforceMutatingEffects(
      instrumentEffectsByPath(
        makeRawApi(log) as unknown as Record<string, unknown>,
      ),
      deps(gate),
    ) as unknown as ReturnType<typeof makeRawApi>;
  }

  it("approved calls keep recorder order and implementation binding", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = composed(log, gate);
    const ledger = createEffectLedger("cid-off");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await api.callLlm("x");
        await api.storage.write("a.txt");
      }),
    );
    expect(requests).toHaveLength(2);
    // `this` reached the RAW namespace objects through BOTH layers
    expect(log).toEqual(["llm:ROOT", "write:STORAGE"]);
    // The recorder observes both authorized writes.
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual([
      "callLlm",
      "storageWrite",
    ]);
  });

  it("allowed effects authorize before recording and implementation", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("allow-once");
    const api = composed(log, gate);
    const ledger = createEffectLedger("cid-allow");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await api.callLlm("x");
      }),
    );
    expect(requests).toHaveLength(1); // gated
    expect(log).toEqual(["llm:ROOT"]); // impl ran after the allow
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual(["callLlm"]); // recorded
  });

  it("denied writes neither execute nor become observed effects", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = composed(log, gate);
    const ledger = createEffectLedger("cid-deny");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        await expect(api.callLlm("x")).rejects.toBeInstanceOf(
          EffectBoundaryDeniedError,
        );
      }),
    );
    expect(requests).toHaveLength(1); // it asked
    expect(log).toEqual([]); // the impl never ran
    // OUTER composition: the recorder sits INSIDE the gate, so a denied effect is
    // never recorded — no phantom mutation row in the shadow dataset.
    expect(ledger.summary().effects).toEqual([]);
  });

  it("a READ flows through both layers ungated and recorded", async () => {
    const log: string[] = [];
    const { gate, requests } = makeGate("deny-once");
    const api = composed(log, gate);
    const ledger = createEffectLedger("cid-read");
    await runWithEffectLedger(ledger, () =>
      runWithEffectGateContext({ headless: false, toolName: "t" }, async () => {
        api.getSecret();
      }),
    );
    expect(requests).toHaveLength(0); // reads never prompt
    expect(log).toEqual(["ids:ROOT"]);
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual([
      "getSecret",
    ]);
  });
});

describe("INSTRUMENTED idempotence symbol is PROPAGATED through the enforced wrapper", () => {
  it("the enforced output keeps INSTRUMENTED so a later instrument is a no-op (no double-wrap)", () => {
    const { gate } = makeGate("deny-once");
    const raw = {
      callLlm: async (): Promise<string> => "x",
      storage: { write: async (): Promise<void> => {} },
    };
    const instrumented = instrumentEffectsByPath(
      raw as unknown as Record<string, unknown>,
    );
    const enforced = enforceMutatingEffects(instrumented, deps(gate));

    // the fresh enforced object still carries the recorder's idempotence symbol…
    expect((enforced as Record<symbol, unknown>)[INSTRUMENTED]).toBe(true);
    // …including nested namespaces…
    expect(
      (enforced as { storage: Record<symbol, unknown> }).storage[INSTRUMENTED],
    ).toBe(true);
    // …so re-instrumenting it is a no-op (returns the SAME object — no re-wrap).
    expect(instrumentEffectsByPath(enforced)).toBe(enforced);
  });
});

describe("common policy at each actual effect", () => {
  function reviewerEvidence(level: "low" | "medium" | "high", outcome: "fresh" | "error" = "fresh"): ReviewerDispatchResult {
    return { verdict: { level, reason: "Effect review." }, outcome, cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } };
  }

  it("redacts host authorization material from review while binding grants to the complete payload", async () => {
    permissionManager.setMode("auto");
    const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("low"));
    const { gate } = makeGate("deny-once");
    const url = "https://issuer.example.test/token";
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      for (const token of ["first-private-refresh", "second-private-refresh"]) {
        await gateMutatingEffect({ pluginId: "p1", methodPath: "hostFetch", effect: "write", target: "https://issuer.example.test",
          input: [url, { method: "POST", body: `refresh_token=${token}` }],
          reviewInput: [url, { method: "POST", body: "[host authorization material]" }],
          approvalGate: gate, permissionManager });
      }
      await gateMutatingEffect({ pluginId: "p1", methodPath: "hostFetch", effect: "write", target: "https://issuer.example.test",
        input: [url, { method: "POST", body: "ordinary-resource-payload" }], approvalGate: gate, permissionManager });
    });
    expect(review).toHaveBeenCalledTimes(3);
    const first = review.mock.calls[0]?.[1];
    const second = review.mock.calls[1]?.[1];
    expect(first?.approvalCacheKey).not.toBe(second?.approvalCacheKey);
    expect(first?.finalInput).toMatchObject({ body: "[host authorization material]" });
    expect(second?.finalInput).toMatchObject({ body: "[host authorization material]" });
    expect(JSON.stringify(review.mock.calls)).not.toContain("private-refresh");
    expect(review.mock.calls[2]?.[1].finalInput).toMatchObject({ body: "ordinary-resource-payload" });
  });

  it.each([false, true])("uses the normal fallback for an unanchored nested HIGH effect with headless=%s", async (headless) => {
    permissionManager.setMode("auto");
    const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("high"));
    const resolve = vi.spyOn(permissionManager, "resolveReviewedPermission");
    const { gate, requests } = makeGate("allow-once");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless, toolName: "already-running-outer", sessionId: "nested-session" }, async () => {
      if (headless) await expect(api.storage.write("a.txt", "payload")).rejects.toThrow("Nobody can approve this request; do not retry.");
      else await api.storage.write("a.txt", "payload");
    });
    expect(review).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    const decision = resolve.mock.results[0]?.value;
    expect(decision).toMatchObject({ decision: headless ? "deny" : "ask" });
    expect(decision.pipelineRequest.rationaleAvailable).not.toBe(true);
    expect(decision.forceModal).not.toBe(true);
    expect(requests).toHaveLength(headless ? 0 : 1);
    if (!headless) {
      expect(requests[0]).toMatchObject({ kind: "agent-action", reviewerVerdict: { level: "high" } });
      expect(requests[0].forceExplicit).not.toBe(true);
    }
    expect(log).toEqual(headless ? [] : ["write"]);
  });

  it("reviews an exact headless effect before allowing it", async () => {
    permissionManager.setMode("auto");
    const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("low"));
    const { gate, requests } = makeGate("deny-once");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: true, toolName: "outer" }, async () => {
      await api.storage.write("a.txt", "first payload");
      await api.storage.write("b.txt", "second payload");
    });
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[0][1].finalInput).toMatchObject({ pluginId: "p1", methodPath: "storage.write", target: "a.txt", input: ["a.txt", "first payload"] });
    expect(review.mock.calls[1][1].finalInput).toMatchObject({ target: "b.txt", input: ["b.txt", "second payload"] });
    expect(review.mock.calls[0][3]?.lane).toBe("headless");
    expect(requests).toHaveLength(0);
    expect(log).toEqual(["write", "write"]);
  });

  for (const outcome of ["high", "error"] as const) {
    it(`denies headless ${outcome} reviewer fallback without retry`, async () => {
      permissionManager.setMode("auto");
      const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("high", outcome === "error" ? "error" : "fresh"));
      const { gate, requests } = makeGate("allow-once");
      const log: string[] = [];
      const api = enforceMutatingEffects(makeApi(log), deps(gate));
      await runWithEffectGateContext({ headless: true, toolName: "outer" }, async () => {
        await expect(api.storage.write("a.txt")).rejects.toThrow("Nobody can approve this request; do not retry.");
      });
      expect(review).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(0);
      expect(log).toEqual([]);
    });
  }

  it("allow mode permits a headless ordinary effect through common policy", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: true, toolName: "outer" }, () => api.storage.write("a.txt"));
    expect(log).toEqual(["write"]);
    expect(requests).toHaveLength(0);
  });

  it("an explicit deny beats allow mode and the reviewer", async () => {
    permissionManager.setMode("allow");
    permissionManager.setRules([{ pattern: "effect_storage_write", source: "plugin", action: "deny" }]);
    const review = vi.spyOn(permissionManager, "dispatchReviewer");
    const { gate, requests } = makeGate("allow-once");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(api.storage.write("a.txt")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(review).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it("a mandatory floor stays fresh and cannot become remembered", async () => {
    permissionManager.setMode("allow");
    const review = vi.spyOn(permissionManager, "dispatchReviewer");
    const { gate, requests } = makeGate("allow-always");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer", permissionContext: { floor: { code: "other-principal", reason: "A different principal owns this surface." } } }, async () => {
      await api.storage.write("a.txt");
      await api.storage.write("a.txt");
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((value) => value.forceExplicit)).toBe(true);
    expect(review).not.toHaveBeenCalled();
  });

  it("rechecks live policy before reusing an invocation grant", async () => {
    const { gate, requests } = makeGate("allow-once");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await api.storage.write("a.txt");
      permissionManager.setRules([{ pattern: "effect_storage_write", source: "plugin", action: "deny" }]);
      await expect(api.storage.write("a.txt")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write"]);
  });

  it("an explicit ask still overrides a remembered exact descriptor", async () => {
    const { gate, requests } = makeGate("allow-always");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, () => api.storage.write("a.txt"));
    permissionManager.setRules([{ pattern: "effect_storage_write", source: "plugin", action: "ask" }]);
    await runWithEffectGateContext({ headless: true, toolName: "outer" }, async () => {
      await expect(api.storage.write("a.txt")).rejects.toThrow("Nobody can approve this request; do not retry.");
    });
    expect(requests).toHaveLength(1);
    expect(log).toEqual(["write"]);
  });

  for (const methodPath of ["openExternalUrl", "openAuthWindow", "openAuthPartitionViewer", "clearAuthPartition"] as const) {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
      it(`${methodPath} uses ordinary ${mode} effect policy without an invented principal floor`, async () => {
        permissionManager.setMode(mode);
        const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("low"));
        const { gate, requests } = makeGate("allow-once");
        const input = methodPath === "openExternalUrl" ? ["https://service.example/resource"]
          : methodPath === "clearAuthPartition" ? ["persist:plugin-auth:p1"] : [{ url: "https://service.example/login" }];
        await runWithEffectGateContext({ headless: false, toolName: "outer" }, () => gateMutatingEffect({
          pluginId: "p1", methodPath, effect: "write", target: "https://service.example", input, approvalGate: gate, permissionManager,
        }));
        expect(requests).toHaveLength(mode === "strict" || mode === "default" ? 1 : 0);
        expect(requests.every((request) => !request.forceExplicit)).toBe(true);
        expect(review).toHaveBeenCalledTimes(mode === "auto" ? 1 : 0);
      });
    }
  }

  for (const methodPath of ["openExternalUrl", "openAuthWindow", "openAuthPartitionViewer", "hostFetch"] as const) {
    for (const mode of ["strict", "default", "auto", "allow"] as const) {
    for (const headless of [false, true]) {
      it(`${methodPath} uses the ${mode} exfil guardrail with headless=${headless}`, async () => {
        permissionManager.setMode(mode);
        const { gate, requests } = makeGate("deny-once");
        const decisions = vi.spyOn(permissionManager, "checkDetailed");
        const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(reviewerEvidence("low"));
        const url = `https://service.example/?payload=${"a".repeat(600)}`;
        const input = methodPath === "openExternalUrl" ? [url]
          : methodPath === "hostFetch" ? [url, { method: "GET" }]
          : [{ url }];
        await runWithEffectGateContext({ headless, toolName: "outer" }, async () => {
          const decision = gateMutatingEffect({ pluginId: "p1", methodPath,
            effect: methodPath === "hostFetch" ? "read" : "write", target: "https://service.example",
            input, approvalGate: gate, permissionManager });
          if (headless || mode === "strict" || mode === "default") {
            await expect(decision).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
          } else {
            await expect(decision).resolves.toBeUndefined();
          }
        });
        expect(review).toHaveBeenCalledTimes(!headless && mode === "auto" ? 1 : 0);
        expect(requests).toHaveLength(!headless && (mode === "strict" || mode === "default") ? 1 : 0);
        expect(decisions).toHaveBeenCalledTimes(1);
        expect(decisions.mock.results[0]!.value).toMatchObject({
          reasonCode: headless ? "no-approver" : mode === "auto" ? "review-required"
            : mode === "allow" ? "allow-mode" : "exfiltration-guardrail",
        });
        for (const request of requests) {
          expect(request.forceExplicit).not.toBe(true);
          expect(request.reason).toContain(methodPath);
        }
      });
    }
    }
  }

  it("an active tool effect without policy dependencies fails clearly", async () => {
    const { gate } = makeGate("allow-once");
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(gateMutatingEffect({ pluginId: "p1", methodPath: "storage.write", effect: "write", target: "a.txt", approvalGate: gate })).rejects.toThrow("Effect enforcement requires a permission manager");
    });
  });
});

describe("exact effect authority and sealed execution", () => {
  it("different worker args and environment cannot share an approval", async () => {
    const { gate, requests } = makeGate("allow-always");
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    const base = { workerId: "worker", command: "/bin/echo", args: ["first"], env: { TASK: "first" } };
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await api.spawnWorker(base);
      await api.spawnWorker({ ...base, args: ["second"] });
      await api.spawnWorker({ ...base, env: { TASK: "second" } });
    });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((value) => value.approvalScope)).size).toBe(3);
  });

  it("mutating caller arguments during the card cannot change the executed worker", async () => {
    let answer!: (decision: ApprovalDecision) => void;
    const gate = { requestAndWait: vi.fn((request: ApprovalRequest) => new Promise<ApprovalDecision>((resolve) => {
      answer = (decision) => resolve({ ...decision, requestId: request.id });
    })) } as unknown as ApprovalGate;
    const executed: unknown[] = [];
    const api = enforceMutatingEffects({ spawnWorker: async (spec: unknown) => { executed.push(spec); } }, deps(gate));
    const spec = { workerId: "worker", command: "/bin/echo", args: ["approved"], env: { TASK: "approved" } };
    const pending = runWithEffectGateContext({ headless: false, toolName: "outer" }, () => api.spawnWorker(spec));
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    spec.args[0] = "changed";
    spec.env.TASK = "changed";
    answer({ requestId: "ignored", choice: "allow-once" });
    await pending;
    expect(executed).toEqual([{ workerId: "worker", command: "/bin/echo", args: ["approved"], env: { TASK: "approved" } }]);
  });

  // One rule for every card a person answers (pending-answer-policy.ts): a sibling stage's "Allow for this run" leaves the answer
  // standing; any other policy change refuses it.
  it.each(["sibling run rule", "other policy change"] as const)("an effect card answered across a policy change: %s", async (change) => {
    let answer!: (decision: ApprovalDecision) => void;
    const gate = { requestAndWait: vi.fn((request: ApprovalRequest) => new Promise<ApprovalDecision>((resolve) => {
      answer = (decision) => resolve({ ...decision, requestId: request.id });
    })) } as unknown as ApprovalGate;
    const executed: unknown[] = [];
    const api = enforceMutatingEffects({ spawnWorker: async (spec: unknown) => { executed.push(spec); } }, deps(gate));
    const pending = runWithEffectGateContext({ headless: false, toolName: "outer" }, () => api.spawnWorker({ workerId: "worker", command: "/bin/echo", args: ["approved"] }));
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    try {
      if (change === "sibling run rule") {
        registerRunSession("work-board:7#run-a", "sibling-stage-session", { stageId: "build", stageName: "Build", lane: "attended" });
        permissionManager.addRunRule("sibling-stage-session", "Bash(npm test)");
      } else permissionManager.setRules([{ pattern: "Bash(npm test)", action: "allow" }]);
      answer({ requestId: "ignored", choice: "allow-once" });
      if (change === "sibling run rule") {
        await pending;
        expect(executed).toHaveLength(1);
      } else {
        await expect(pending).rejects.toThrow("Permission policy changed during effect approval");
        expect(executed).toEqual([]);
      }
    } finally {
      __resetRunGrantsForTest();
    }
  });

  it("different write contents cannot reuse a prior exact-path approval", async () => {
    const { gate, requests } = makeGate("allow-always");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await api.storage.write("a.txt", "first");
      await api.storage.write("a.txt", "second");
    });
    expect(requests).toHaveLength(2);
  });

  it("protected storage targets keep their mandatory floor in allow mode", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, () => api.storage.write(".git/config", "value"));
    expect(requests).toHaveLength(1);
    expect(requests[0].forceExplicit).toBe(true);
    expect(requests[0].allowedChoices).toEqual(["allow-once", "deny-once"]);
  });

  it("ordinary storage reads of protected paths remain allowed", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(api.storage.read(".git/config")).resolves.toBe("data");
    });
    expect(requests).toHaveLength(0);
  });

  for (const method of ["GET", "HEAD", "OPTIONS"] as const) {
    it(`${method} is an independent network permission even though its recorded effect is read`, async () => {
      const { gate, requests } = makeGate("deny-once");
      const check = vi.spyOn(permissionManager, "checkDetailed");
      await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
        await expect(gateMutatingEffect({ pluginId: "p1", methodPath: "hostFetch", effect: "read", target: "https://service.example", input: ["https://service.example/resource", { method }], approvalGate: gate, permissionManager })).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
      });
      expect(check).toHaveBeenCalledWith("effect_hostFetch", "plugin", "network", undefined, expect.objectContaining({ ruleSubject: { kind: "webfetch", url: "https://service.example/resource" } }));
      expect(requests).toHaveLength(1);
    });
  }

  it("network URL, method and body are all part of exact grant identity", async () => {
    const { gate, requests } = makeGate("allow-always");
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      for (const [url, method, body] of [["https://service.example/a", "POST", "first"], ["https://service.example/b", "POST", "first"], ["https://service.example/a", "DELETE", "first"], ["https://service.example/a", "POST", "second"]]) {
        await gateMutatingEffect({ pluginId: "p1", methodPath: "hostFetch", effect: "write", target: "https://service.example", input: [url, { method, body }], approvalGate: gate, permissionManager });
      }
    });
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((value) => value.approvalScope)).size).toBe(4);
  });

  it("owner-away effect cards carry their unlimited-wait policy marker", async () => {
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer", permissionContext: { ownerUnattended: true } }, () => api.callLlm("hello"));
    expect(requests[0].ownerUnattended).toBe(true);
  });

  it("session grants cannot authorize an identical effect in a different conversation", async () => {
    const { gate, requests } = makeGate("allow-session");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer", sessionId: "first" }, () => api.storage.write("a.txt", "same"));
    await runWithEffectGateContext({ headless: false, toolName: "outer", sessionId: "second" }, () => api.storage.write("a.txt", "same"));
    expect(requests).toHaveLength(2);
  });
});

describe("materialized data and admission evidence", () => {
  it("typed identities distinguish class values from similarly shaped plain data", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(snapshotEffectArguments([date]).identity).not.toEqual(snapshotEffectArguments([{ date: date.toISOString() }]).identity);
    expect(snapshotEffectArguments([undefined]).identity).not.toEqual(snapshotEffectArguments([null]).identity);
  });

  it("shared byte storage cannot change the copied payload", () => {
    const original = new Uint8Array(new SharedArrayBuffer(2));
    original.set([1, 2]);
    const snapshot = snapshotEffectArguments([original]);
    original.set([3, 4]);
    expect(Array.from(snapshot.args[0] as Uint8Array)).toEqual([1, 2]);
  });

  it("different serialized date and record values cannot share a JSON write grant", async () => {
    const { gate, requests } = makeGate("allow-always");
    const written: string[] = [];
    const api = enforceMutatingEffects({ storage: { writeJson: async (_path: string, value: unknown) => { written.push(JSON.stringify(value)); } } }, deps(gate));
    const date = new Date("2026-01-01T00:00:00.000Z");
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await api.storage.writeJson("data.json", date);
      await api.storage.writeJson("data.json", { date: date.toISOString() });
    });
    expect(written).toEqual(['"2026-01-01T00:00:00.000Z"', '{"date":"2026-01-01T00:00:00.000Z"}']);
    expect(requests).toHaveLength(2);
    expect(requests[0].approvalScope).not.toBe(requests[1].approvalScope);
  });

  it("a JSON serializer cannot change the bytes while the card waits", async () => {
    let answer!: (decision: ApprovalDecision) => void;
    const gate = { requestAndWait: vi.fn((request: ApprovalRequest) => new Promise<ApprovalDecision>((resolve) => {
      answer = (decision) => resolve({ ...decision, requestId: request.id });
    })) } as unknown as ApprovalGate;
    const written: string[] = [];
    const api = enforceMutatingEffects({ storage: { writeJson: async (_path: string, value: unknown) => { written.push(JSON.stringify(value)); } } }, deps(gate));
    let value = "approved";
    const pending = runWithEffectGateContext({ headless: false, toolName: "outer" }, () => api.storage.writeJson("data.json", { toJSON: () => ({ value }) }));
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    value = "changed";
    answer({ requestId: "ignored", choice: "allow-once" });
    await pending;
    expect(written).toEqual(['{"value":"approved"}']);
  });

  it("a credential-store path cannot pass admission in allow mode", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("allow-once");
    const api = enforceMutatingEffects(makeApi([]), { ...deps(gate), resolveStoragePath: () => join(tmpdir(), ".ave", "secrets", "master.key") });
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(api.storage.write("ignored", "payload")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(0);
  });

  it("a genuine floor still forces a card alongside URL exfiltration evidence", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "outer", permissionContext: {
      floor: { code: "other-principal", reason: "A different principal owns this request." },
    } }, async () => {
      await expect(gateMutatingEffect({ pluginId: "p1", methodPath: "hostFetch", effect: "read", target: "https://service.example", input: [`https://service.example/?payload=${"a".repeat(600)}`, { method: "GET" }], approvalGate: gate, permissionManager })).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].forceExplicit).toBe(true);
    expect(requests[0].allowedChoices).toEqual(["allow-once", "deny-once"]);
  });
});

describe("configuration control effects", () => {
  it("configuration writes cannot use a namespace-only bypass in allow mode", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    const write = vi.fn(async (_key: string, _value: unknown) => {});
    const api = enforceMutatingEffects({ config: { set: write } }, deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(api.config.set("setting", "value")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].forceExplicit).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("human fallback termination", () => {
  it("preserves the no-retry result when the approval surface disappears or owner-away skips", async () => {
    const gate = { requestAndWait: vi.fn(async (request: ApprovalRequest) => ({ requestId: request.id, choice: "deny-once", rememberPattern: "Nobody can approve this request; do not retry." })) } as unknown as ApprovalGate;
    const log: string[] = [];
    const api = enforceMutatingEffects(makeApi(log), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer", permissionContext: { ownerUnattended: true } }, async () => {
      await expect(api.callLlm("hello")).rejects.toThrow("Nobody can approve this request; do not retry.");
    });
    expect(log).toEqual([]);
  });
});

it.each(["allow", "strict"] as const)("refreshes controller identity at a nested host effect in %s", async mode => {
  const { bindRemoteControllerToSession } = await import("../../shared/chat-origin.js");
  let current = true;
  let ownerAvailable = true;
  const refresh = vi.fn(async () => { current = ownerAvailable; return current; });
  const authority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:effect-owner", pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" }, pairedShareGuard: { isCurrent: () => current, refreshCurrent: refresh } }, "effect-session");
  permissionManager.setMode(mode);
  const { gate, requests } = makeGate("allow-once");
  ownerAvailable = false;
  await expect(runWithEffectGateContext({ headless: false, toolName: "outer", sessionId: "effect-session", permissionContext: { remoteControllerAuthority: authority } }, () => gateMutatingEffect({ pluginId: "p1", methodPath: "storage.write", effect: "write", target: "effect.txt", input: ["effect.txt", "body"], approvalGate: gate, permissionManager, resolveStoragePath: relativePath => join(tmpdir(), "effect-storage", relativePath) }))).rejects.toThrow("remote-controller-revoked");
  expect(refresh).toHaveBeenCalledOnce();
  if (mode === "strict") expect(requests[0]).toMatchObject({ remoteControllerAuthority: authority, remoteControllerOrigin: "tailnet-controller" });
});
