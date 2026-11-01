vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, describe, expect, it, vi } from "vitest";

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

import {
  __resetActiveSandboxCapabilityForTest,
  detectSandboxCapability,
  disposableContainerCapability,
  formatSandboxCapabilityForPrompt,
  isDisposableSubstrateCapability,
  resolveReviewerSandboxCacheState,
  __resetSandboxRequestedAtBootForTest,
  isActiveSandboxFilesystemContained,
  isActiveSandboxFilesystemContainedForPluginEffects,
  getHostShellExecutionPlan,
  resolveReviewerSandboxCapability,
  isActiveSandboxShellContained,
  isWeakSandbox,
  markPluginWorkerWrapped,
  sandboxRelaxesCategory,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setPluginWorkerConfinementRequestedAtBoot,
  isShellSandboxRequestedAtBoot,
  isPluginWorkerConfinementRequestedAtBoot,
  detectShellSandboxCapability,
  unmarkPluginWorkerWrapped,
  setWindowsSandboxSubstrate,
  getWindowsSandboxSubstrate,
  getWindowsExtensionBackendPlan,
  detectMxcShellCapability,
  detectPluginWorkerSandboxCapability,
  __resetWindowsSandboxSubstrateForTest,
  type SandboxCapability,
} from "../sandbox-capability.js";
import {
  mxcShellCapability,
  planWindowsSandbox,
  windowsProxyOnlyCapability,
  windowsSubstrateFor,
} from "../../boot/steps/windows-sandbox-plan.js";
import type { ToolCategory } from "../../tools/types.js";

describe("sandbox-capability", () => {
  it("detectSandboxCapability returns kind=none/confidence=verified for the current host", () => {
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("none");
    expect(cap.confidence).toBe("verified");
    expect(cap.platform).toBe(process.platform);
    expect(cap.reason).toMatch(/no OS sandbox/i);
  });

  it("formatSandboxCapabilityForPrompt produces a grep-stable single-line string", () => {
    const cap: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
    };
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process",
    );
  });

  it("isWeakSandbox treats kind=none as weak regardless of confidence", () => {
    expect(
      isWeakSandbox({
        kind: "none",
        confidence: "verified",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox treats assumed confidence as weak even for non-none kinds", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "assumed",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox returns false for a verified non-none capability", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "ASRT (bwrap) active",
      }),
    ).toBe(false);
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "ASRT (Seatbelt) active",
      }),
    ).toBe(false);
  });

  it("formatSandboxCapabilityForPrompt emits the 'asrt' kind label", () => {
    const cap: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
    };
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=asrt (verified, darwin) — ASRT (Seatbelt) active — fs+process+network contained",
    );
  });
});

// Active capability publish (boot ASRT-init path)

describe("sandbox-capability — setActiveSandboxCapability publish", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("publishes kind='asrt' (verified) so detectSandboxCapability + the reviewer strong-relaxation become reachable when the gate is ON", () => {
    // Mirrors boot.ts: when the gate is ON and initializeAsrtSandbox succeeds, boot publishes the active capability to the SOT.
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("asrt");
    expect(cap.confidence).toBe("verified");
    // The 'asrt'-strong branch in isWeakSandbox is now reachable: a verified ASRT capability is NOT weak, so the reviewer's strong relaxation applies.
    expect(isWeakSandbox(cap)).toBe(false);
  });

  it("falls back to kind='none' (verified) when no capability was published (gate OFF / Linux deps-missing)", () => {
    // No setActiveSandboxCapability call — the SOT reports the absence of OS isolation, matching the default-OFF posture and the non-initialized paths.
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("none");
    expect(cap.confidence).toBe("verified");
    expect(isWeakSandbox(cap)).toBe(true);
  });

  it("keeps generic Windows filesystem containment separate from plugin-effect containment", () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });

    expect(isActiveSandboxFilesystemContained()).toBe(true);
    expect(isActiveSandboxFilesystemContainedForPluginEffects()).toBe(false);
    expect(isActiveSandboxShellContained()).toBe(false);
  });

  it("reports plugin effect containment only for a matching wrapped worker", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    });

    expect(
      isActiveSandboxFilesystemContainedForPluginEffects({
        source: "plugin",
        name: "index_search",
        pluginId: "local-indexer",
        workerId: "embed",
      }),
    ).toBe(false);

    markPluginWorkerWrapped("local-indexer", "embed");
    try {
      expect(
        isActiveSandboxFilesystemContainedForPluginEffects({
          source: "plugin",
          name: "index_search",
          pluginId: "local-indexer",
          workerId: "embed",
        }),
      ).toBe(true);
      expect(
        isActiveSandboxFilesystemContainedForPluginEffects({
          source: "plugin",
          name: "index_search",
          pluginId: "local-indexer",
          workerId: "other",
        }),
      ).toBe(false);
    } finally {
      unmarkPluginWorkerWrapped("local-indexer", "embed");
    }
  });
});

// SandboxKind union members

describe("sandbox-capability — disposable substrate", () => {
  const substrate = { authority: "workload-broker" as const, id: "1".repeat(64) };

  it("resolves a routed builtin shell to the disposable guest, ahead of the host-shell plan", () => {
    const plan = getHostShellExecutionPlan();
    expect(plan.capability.kind).toBe("none");
    const cap = resolveReviewerSandboxCapability("builtin", "bash", undefined, undefined, undefined, plan, substrate);
    expect(cap.kind).toBe("disposable-container");
    expect(cap.confidence).toBe("verified");
    expect(cap.confines).toEqual({ filesystem: true, process: true, network: false });
    expect(cap.reason).toContain(substrate.id.slice(0, 12));
    expect(isDisposableSubstrateCapability(cap)).toBe(true);
    expect(isWeakSandbox(cap)).toBe(false);
  });

  it("resolves a routed canonical file tool to the disposable guest instead of the in-process default", () => {
    const cap = resolveReviewerSandboxCapability("builtin", "read_file", undefined, undefined, undefined, undefined, substrate);
    expect(cap.kind).toBe("disposable-container");
    expect(resolveReviewerSandboxCapability("builtin", "read_file").kind).toBe("none");
  });

  it("relaxes filesystem and process categories but never network", () => {
    const cap = disposableContainerCapability(substrate);
    expect(sandboxRelaxesCategory(cap, "shell")).toBe(true);
    expect(sandboxRelaxesCategory(cap, "write")).toBe(true);
    expect(sandboxRelaxesCategory(cap, "read")).toBe(true);
    expect(sandboxRelaxesCategory(cap, "network")).toBe(false);
  });

  it("keys the reviewer cache by the guest so a host verdict never serves a guest call", () => {
    const state = resolveReviewerSandboxCacheState("builtin", "bash", undefined, undefined, undefined, undefined, substrate);
    expect(state.substrate).toBe("disposable-container");
    expect(state.disposableSubstrate).toEqual(substrate);
    expect(state.capability.kind).toBe("disposable-container");
    const host = resolveReviewerSandboxCacheState("builtin", "bash");
    expect(host.substrate).toBe("host-shell");
    expect(host.disposableSubstrate).toBeUndefined();
  });

  it("is not a disposable substrate without verified full filesystem + process confinement", () => {
    expect(isDisposableSubstrateCapability(undefined)).toBe(false);
    expect(isDisposableSubstrateCapability({
      kind: "disposable-container", confidence: "assumed", platform: "linux", reason: "x",
      confines: { filesystem: true, process: true, network: false },
    })).toBe(false);
    expect(isDisposableSubstrateCapability({
      kind: "disposable-container", confidence: "verified", platform: "linux", reason: "x",
      confines: { filesystem: true, process: false, network: false },
    })).toBe(false);
  });

  it("labels the guest in the reviewer prompt", () => {
    expect(formatSandboxCapabilityForPrompt(disposableContainerCapability(substrate))).toMatch(
      /^executionSandbox=disposable-container \(verified, linux\) confines\[net:✗ fs:✓ proc:✓\]/,
    );
  });
});

describe("sandbox-capability — SandboxKind union members", () => {
  it("SandboxKind type includes 'asrt', 'partial' and 'fs-only' (compile-time check via assignment)", () => {
    // If SandboxKind did not include these values, this block would fail to compile (caught by typecheck). Runtime assertion confirms the value round-trips through the type.
    const asrt: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
    };
    const partial: SandboxCapability = {
      kind: "partial",
      confidence: "verified",
      platform: "darwin",
      reason: "partial profile active",
    };
    const fsOnly: SandboxCapability = {
      kind: "fs-only",
      confidence: "verified",
      platform: "linux",
      reason: "landlock filesystem isolation only",
    };
    expect(asrt.kind).toBe("asrt");
    expect(partial.kind).toBe("partial");
    expect(fsOnly.kind).toBe("fs-only");
  });

  // isWeakSandbox (canonical)

  it("isWeakSandbox returns true for kind='partial' (D5: partial evidence → weak)", () => {
    expect(
      isWeakSandbox({
        kind: "partial",
        confidence: "verified",
        platform: "darwin",
        reason: "partial OS isolation profile",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox returns false for kind='fs-only' (strong-for-fs, not weak)", () => {
    expect(
      isWeakSandbox({
        kind: "fs-only",
        confidence: "verified",
        platform: "linux",
        reason: "landlock active",
      }),
    ).toBe(false);
  });

  it("isWeakSandbox returns false for verified asrt (strong)", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "ASRT (bwrap) active",
      }),
    ).toBe(false);
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "ASRT (Seatbelt) active",
      }),
    ).toBe(false);
  });

  // formatSandboxCapabilityForPrompt — new kind labels

  it("formatSandboxCapabilityForPrompt includes Korean label for kind='partial'", () => {
    const cap: SandboxCapability = {
      kind: "partial",
      confidence: "assumed",
      platform: "darwin",
      reason: "partial OS isolation",
    };
    const result = formatSandboxCapabilityForPrompt(cap);
    expect(result).toContain("partial");
    expect(result).toContain("OS 격리 부분적");
    expect(result).toContain("(assumed, darwin)");
  });

  it("formatSandboxCapabilityForPrompt includes Korean label for kind='fs-only'", () => {
    const cap: SandboxCapability = {
      kind: "fs-only",
      confidence: "verified",
      platform: "linux",
      reason: "landlock only",
    };
    const result = formatSandboxCapabilityForPrompt(cap);
    expect(result).toContain("fs-only");
    expect(result).toContain("파일시스템만 격리");
    expect(result).toContain("(verified, linux)");
  });

  it("formatSandboxCapabilityForPrompt preserves original stable format for kind='none'", () => {
    const cap: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
    };
    // Existing tests rely on this exact format — must not regress.
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process",
    );
  });
});

// sandboxRelaxesCategory — per-category relaxation truth table

describe("sandboxRelaxesCategory — per-category, confines-gated relaxation", () => {
  const ALL_CATEGORIES: ToolCategory[] = ["read", "write", "shell", "network", "meta"];
  const FS_CATEGORIES: ToolCategory[] = ["read", "write", "meta"];

  it("full-confine asrt relaxes ALL 5 categories (mac/linux dormancy — identical to isWeakSandbox=false)", () => {
    const fullConfine: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    };
    // Behaviour invariant: isWeakSandbox is false AND every category relaxes — exactly today's all-or-nothing relax-all behaviour, so no mac/linux change.
    expect(isWeakSandbox(fullConfine)).toBe(false);
    for (const category of ALL_CATEGORIES) {
      expect(sandboxRelaxesCategory(fullConfine, category)).toBe(true);
    }
  });

  it("synthetic network-only asrt relaxes network but not filesystem/process categories", () => {
    const networkOnly: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — network egress contained, no fs jail",
      confines: { filesystem: false, process: false, network: true },
    };
    expect(sandboxRelaxesCategory(networkOnly, "network")).toBe(true);
    for (const category of FS_CATEGORIES) {
      expect(sandboxRelaxesCategory(networkOnly, category)).toBe(false);
    }
    expect(sandboxRelaxesCategory(networkOnly, "shell")).toBe(false);
  });

  it("Windows ASRT fs+network partial relaxes fs/network categories but not shell", () => {
    const windowsPartial: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    };
    expect(sandboxRelaxesCategory(windowsPartial, "network")).toBe(true);
    for (const category of FS_CATEGORIES) {
      expect(sandboxRelaxesCategory(windowsPartial, category)).toBe(true);
    }
    expect(sandboxRelaxesCategory(windowsPartial, "shell")).toBe(false);
  });

  it("none capability relaxes NOTHING", () => {
    const none: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
      confines: { filesystem: false, process: false, network: false },
    };
    for (const category of ALL_CATEGORIES) {
      expect(sandboxRelaxesCategory(none, category)).toBe(false);
    }
  });

  it("partial capability relaxes NOTHING (weak)", () => {
    const partial: SandboxCapability = {
      kind: "partial",
      confidence: "verified",
      platform: "darwin",
      reason: "partial OS isolation profile",
      confines: { filesystem: true, process: false, network: true },
    };
    for (const category of ALL_CATEGORIES) {
      expect(sandboxRelaxesCategory(partial, category)).toBe(false);
    }
  });

  it("assumed-confidence asrt relaxes NOTHING (weak)", () => {
    const assumed: SandboxCapability = {
      kind: "asrt",
      confidence: "assumed",
      platform: "linux",
      reason: "ASRT presumed active",
      confines: { filesystem: true, process: true, network: true },
    };
    for (const category of ALL_CATEGORIES) {
      expect(sandboxRelaxesCategory(assumed, category)).toBe(false);
    }
  });

  it("no-confines (legacy) verified asrt relaxes ALL categories (back-compat)", () => {
    // A verified non-none capability WITHOUT a declared confines field keeps the old all-or-nothing behaviour, so mac/linux-verified asrt published without confines (and existing fixtures) are unaffected.
    const legacy: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
    };
    expect(legacy.confines).toBeUndefined();
    for (const category of ALL_CATEGORIES) {
      expect(sandboxRelaxesCategory(legacy, category)).toBe(true);
    }
  });
});

// formatSandboxCapabilityForPrompt — confines surfacing

describe("formatSandboxCapabilityForPrompt — per-dimension confines", () => {
  it("surfaces confines[net/fs/proc] for Windows partial ASRT so the LLM sees honest confinement", () => {
    const windowsPartial: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT (srt-win) active — filesystem + network contained, process isolation unavailable",
      confines: { filesystem: true, process: false, network: true },
    };
    const result = formatSandboxCapabilityForPrompt(windowsPartial);
    expect(result).toContain("executionSandbox=asrt (verified, win32)");
    expect(result).toContain("confines[net:✓ fs:✓ proc:✗]");
  });

describe("sandbox-capability — boot-sealed host shell plan", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(originalPlatform);
  });

  it("reports Windows requested partial host shells as effective none to the reviewer", () => {
    setProcessPlatform("win32");
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "srt-win active",
      confines: { filesystem: true, process: false, network: true },
    });

    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(resolveReviewerSandboxCapability("builtin", "bash")).toMatchObject({
      kind: "none",
      confines: { filesystem: false, process: false, network: false },
    });
  });

  it("does not turn explicit sandbox-off into the Windows one-shot fallback", () => {
    setProcessPlatform("win32");
    setShellSandboxRequestedAtBoot(false);

    const plan = getHostShellExecutionPlan();
    expect(plan.mode).toBe("plain");
    expect(plan.fallbackReason).toBe("disabled-by-setting");
    expect(plan.requiresExplicitUserApproval).toBe(false);
  });
});

describe("sandbox-capability — shell sandbox and plugin-worker confinement are separate scopes", () => {
  const originalPlatform = process.platform;
  const fullAsrt = (platform: NodeJS.Platform): SandboxCapability => ({
    kind: "asrt",
    confidence: "verified",
    platform,
    reason: "ASRT active",
    confines: { filesystem: true, process: true, network: true },
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(originalPlatform);
  });

  it("worker confinement alone (ASRT active for workers) leaves host shells unsandboxed", () => {
    setProcessPlatform("linux");
    setPluginWorkerConfinementRequestedAtBoot(true);
    setActiveSandboxCapability(fullAsrt("linux"));

    expect(isShellSandboxRequestedAtBoot()).toBe(false);
    expect(detectShellSandboxCapability().kind).toBe("none");
    expect(isActiveSandboxShellContained()).toBe(false);
    expect(isActiveSandboxFilesystemContained()).toBe(false);
    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ mode: "plain", requestedSandbox: false, fallbackReason: "disabled-by-setting" });
    expect(plan.requiresExplicitUserApproval).toBe(false);
    expect(resolveReviewerSandboxCapability("builtin", "bash").kind).toBe("none");
    // ASRT itself is live: a wrapped worker still reports the real capability.
    expect(detectSandboxCapability().kind).toBe("asrt");
  });

  it("the shell sandbox alone sandboxes host shells and does not request worker confinement", () => {
    setProcessPlatform("linux");
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability(fullAsrt("linux"));

    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(false);
    expect(detectShellSandboxCapability().kind).toBe("asrt");
    expect(isActiveSandboxShellContained()).toBe(true);
    expect(getHostShellExecutionPlan()).toMatchObject({ mode: "asrt", requestedSandbox: true });
    expect(resolveReviewerSandboxCapability("builtin", "bash").kind).toBe("asrt");
  });

  it("each seal changes only its own scope", () => {
    setPluginWorkerConfinementRequestedAtBoot(true);
    expect(isShellSandboxRequestedAtBoot()).toBe(false);
    setShellSandboxRequestedAtBoot(true);
    setPluginWorkerConfinementRequestedAtBoot(false);
    expect(isShellSandboxRequestedAtBoot()).toBe(true);
    expect(isPluginWorkerConfinementRequestedAtBoot()).toBe(false);
  });
});

  it("surfaces all-✓ confines for a full-confine asrt", () => {
    const full: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active",
      confines: { filesystem: true, process: true, network: true },
    };
    expect(formatSandboxCapabilityForPrompt(full)).toContain("confines[net:✓ fs:✓ proc:✓]");
  });

  it("omits the confines suffix when confines is absent (preserves legacy grep-stable string)", () => {
    const noConfines: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
    };
    const result = formatSandboxCapabilityForPrompt(noConfines);
    expect(result).not.toContain("confines[");
    expect(result).toBe(
      "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process",
    );
  });
});

// Fixture snapshot: sandbox-eval-verdicts.json

describe("sandbox-eval-verdicts fixture", () => {
  it("fixture file has all 6 expected cases (per-OS runner kinds replaced by 'asrt')", async () => {
    const fixture = (await import("./__fixtures__/sandbox-eval-verdicts.json", {
      with: { type: "json" },
    })).default as Record<string, { rule: string; llm: string; final: string }>;

    expect(Object.keys(fixture)).toHaveLength(6);
    expect(fixture["kind=none + benign tool"]).toEqual({ rule: "low", llm: "low", final: "low" });
    expect(fixture["kind=none + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=asrt + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=partial + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=fs-only + high-risk write"]).toEqual({ rule: "high", llm: "medium", final: "high" });
    expect(fixture["weak context + benign tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
  });
});

describe("sandbox-capability — Windows MXC substrate", () => {
  const hostPlatform = process.platform;
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    setProcessPlatform(hostPlatform);
  });

  function bootProxyOnly(): void {
    setProcessPlatform("win32");
    setShellSandboxRequestedAtBoot(true);
    setPluginWorkerConfinementRequestedAtBoot(true);
    const plan = planWindowsSandbox({
      shellRequested: true,
      workerRequested: true,
      mxc: { state: "available" },
      windowsBuild: "10.0.26300.9711",
      srtWinReady: false,
    });
    setActiveSandboxCapability(windowsProxyOnlyCapability());
    setWindowsSandboxSubstrate(plan.substrate, mxcShellCapability());
  }

  it("issues MXC shell plans while the process-wide capability confines nothing", () => {
    bootProxyOnly();
    const plan = getHostShellExecutionPlan();
    expect(plan).toMatchObject({ mode: "asrt", substrate: "mxc", requiresExplicitUserApproval: false });
    // The workspace terminal reads the process-wide capability, which must not inherit the containers' confinement.
    expect(detectShellSandboxCapability().confines).toEqual({ filesystem: false, process: false, network: false });
    expect(isActiveSandboxShellContained()).toBe(false);
  });

  it("reports extensions unconfined when ASRT runs only as the containers' proxy", () => {
    bootProxyOnly();
    expect(detectPluginWorkerSandboxCapability().kind).toBe("none");
    expect(getWindowsSandboxSubstrate()).toMatchObject({ shells: "mxc", extensions: "none" });
  });

  it("drops the MXC route once the ASRT runtime (the containers' proxy) is gone", () => {
    bootProxyOnly();
    expect(detectMxcShellCapability()).toBeDefined();
    __resetActiveSandboxCapabilityForTest();
    expect(detectMxcShellCapability()).toBeUndefined();
    expect(getHostShellExecutionPlan().substrate).not.toBe("mxc");
  });

  it("rejects a substrate record that contradicts its MXC capability", () => {
    const { substrate } = planWindowsSandbox({
      shellRequested: true,
      workerRequested: false,
      mxc: { state: "unavailable", reason: "tier-unsupported" },
      windowsBuild: null,
      srtWinReady: true,
    });
    expect(() => setWindowsSandboxSubstrate(substrate, mxcShellCapability())).toThrow(/needs shells/);
    expect(() => setWindowsSandboxSubstrate({ ...substrate, shells: "mxc" })).toThrow(/no MXC shell capability/);
  });

  it("keeps the srt-win plan when MXC is unavailable: approved host route, no MXC substrate", () => {
    setProcessPlatform("win32");
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "srt-win",
      confines: { filesystem: true, process: false, network: true },
    });
    const { substrate } = planWindowsSandbox({
      shellRequested: true,
      workerRequested: false,
      mxc: { state: "unavailable", reason: "request-rejected" },
      windowsBuild: "10.0.22631.1",
      srtWinReady: true,
    });
    setWindowsSandboxSubstrate(substrate);
    const plan = getHostShellExecutionPlan();
    expect(plan.substrate).toBe("none");
    expect(plan.requiresExplicitUserApproval).toBe(true);
  });
});

describe("extension selection is not per-process confinement evidence", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
  });

  it("does not borrow the account backend's dimensions for selected container extensions", () => {
    setPluginWorkerConfinementRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: "win32",
      reason: "account backend active", confines: { filesystem: true, process: false, network: true } });
    const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
      mxc: { state: "available" }, extensionMxc: { state: "available" },
      windowsBuild: null, srtWinReady: true });
    setWindowsSandboxSubstrate(substrate);
    expect(detectPluginWorkerSandboxCapability()).toMatchObject({ kind: "none", confines: { filesystem: false, process: false, network: false } });
    markPluginWorkerWrapped("sample", "worker");
    try {
      expect(resolveReviewerSandboxCapability("plugin", "query", undefined, "worker", "sample").kind).toBe("none");
    } finally { unmarkPluginWorkerWrapped("sample", "worker"); }
  });

  it("keeps an identical extension plan's identity when the shell probe settles, and replaces it on a content change", () => {
    const inputs = { shellRequested: true, workerRequested: true, mxc: { state: "checking" },
      extensionMxc: { state: "available" }, windowsBuild: null, srtWinReady: false } as const;
    setWindowsSandboxSubstrate(windowsSubstrateFor(inputs, "proxy-only"));
    const recorded = getWindowsSandboxSubstrate();
    const plan = getWindowsExtensionBackendPlan();
    const settled = windowsSubstrateFor({ ...inputs, mxc: { state: "available" } }, "proxy-only");
    setWindowsSandboxSubstrate(settled, mxcShellCapability());
    expect(getWindowsSandboxSubstrate()).not.toBe(recorded);
    expect(getWindowsExtensionBackendPlan()).toBe(plan);
    setWindowsSandboxSubstrate(windowsSubstrateFor({ ...inputs, extensionMxc: { state: "unavailable", reason: "runtime-start-failed" } }, "proxy-only"));
    expect(getWindowsExtensionBackendPlan()).not.toBe(plan);
    expect(getWindowsExtensionBackendPlan()).toMatchObject({ readiness: "unavailable" });
  });

  it("rejects a container extension claim without dedicated ready evidence", () => {
    const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
      mxc: { state: "available" }, windowsBuild: null, srtWinReady: true });
    expect(() => setWindowsSandboxSubstrate({ ...substrate, extensions: "mxc" })).toThrow(/dedicated ready request evidence/);
  });
});

it("rejects serialized extension posture and outer egress contradictions at publication", () => {
  const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true,
    mxc: { state: "available" }, extensionMxc: { state: "available" },
    windowsBuild: null, srtWinReady: false });
  expect(() => setWindowsSandboxSubstrate({ ...substrate, extensionEgressIdentity: "shared" })).toThrow(/extension egress identity/);
  expect(() => setWindowsSandboxSubstrate({ ...substrate, shellEgressIdentity: "kernel-channel" })).toThrow(/shell egress identity/);
  const malformed = JSON.parse(JSON.stringify(substrate)) as typeof substrate;
  Object.assign(malformed.extensionPlan!, { proxyOwnerVerified: true });
  expect(() => setWindowsSandboxSubstrate(malformed)).toThrow(/Invalid Windows extension backend plan/);
});
