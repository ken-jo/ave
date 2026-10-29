// Only genuinely isolated executions receive sandbox relaxation; process-global shell capability must never relax unwrapped plugin/server or in-process tool effects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  isWeakSandbox,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  type SandboxCapability,
} from "../sandbox-capability.js";
import {
  LlmRiskClassifier,
  type LlmReviewerProvider,
} from "../reviewer/risk-classifier.js";
import { makeRiskClassifierContext as ctx } from "./test-helpers.js";

describe("resolveReviewerSandboxCapability — execution-substrate awareness", () => {
  // The host-shell view of the capability exists only while the shell sandbox was requested at boot.
  beforeEach(() => setShellSandboxRequestedAtBoot(true));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("returns the genuine asrt capability for the ASRT-wrapped host-shell tools when the gate is ON", () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });

    for (const toolName of ["bash", "powershell"]) {
      const cap = resolveReviewerSandboxCapability("builtin", toolName);
      expect(cap.kind).toBe("asrt");
      // The host-shell substrate genuinely runs wrapped → NOT weak → reviewer may relax for these calls.
      expect(isWeakSandbox(cap)).toBe(false);
    }
  });

  it("forces kind=none (weak) for plugin/MCP tools EVEN WHEN the global capability is asrt", () => {
    // Gate ON: the process-global capability is asrt…
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active — fs+process+network contained",
      confines: { filesystem: true, process: true, network: true },
    });

    // …but plugin/MCP effects run in the unwrapped long-lived worker.
    for (const source of ["plugin", "mcp"] as const) {
      const cap = resolveReviewerSandboxCapability(source, "any_tool");
      expect(cap.kind).toBe("none");
      expect(cap.confidence).toBe("verified");
      expect(cap.reason).toMatch(/worker not ASRT-wrapped/i);
      // Machine-checkable: nothing is confined for this substrate.
      expect(cap.confines).toEqual({ filesystem: false, process: false, network: false });
      // WEAK → the reviewer CANNOT relax (no MEDIUM/HIGH → LOW downgrade).
      expect(isWeakSandbox(cap)).toBe(true);
    }
  });

  it("forces kind=none (weak) for in-process builtin tools (not bash/powershell) even when gate is ON", () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active",
      confines: { filesystem: true, process: true, network: true },
    });

    // A non-shell builtin (e.g. write_file/read_file) runs in-process — no OS jail.
    const cap = resolveReviewerSandboxCapability("builtin", "write_file");
    expect(cap.kind).toBe("none");
    expect(cap.reason).toMatch(/in-process builtin/i);
    expect(isWeakSandbox(cap)).toBe(true);
  });

  it("reports the active asrt capability for terminal_run only while the sandbox contains shells", () => {
    // A workspace terminal exists only under a shell-containing sandbox and keeps its wrap for life, so a command typed into it lands confined.
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active",
      confines: { filesystem: true, process: true, network: true },
    });
    const contained = resolveReviewerSandboxCapability("builtin", "terminal_run");
    expect(contained.kind).toBe("asrt");
    expect(contained.reason).toMatch(/workspace terminal shell ASRT-wrapped/);
    expect(isWeakSandbox(contained)).toBe(false);
    // Only the builtin: a plugin or MCP tool of the same name is not the terminal.
    expect(resolveReviewerSandboxCapability("plugin", "terminal_run").kind).toBe("none");
    expect(resolveReviewerSandboxCapability("mcp", "terminal_run").kind).toBe("none");

    // A sandbox that no longer confines processes proves nothing about the terminal now.
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "ASRT partial",
      confines: { filesystem: true, process: false, network: true },
    });
    expect(resolveReviewerSandboxCapability("builtin", "terminal_run").kind).toBe("none");
    __resetActiveSandboxCapabilityForTest();
    setShellSandboxRequestedAtBoot(false);
    expect(resolveReviewerSandboxCapability("builtin", "terminal_run").kind).toBe("none");
  });

  it("host-shell tools stay none when the gate is OFF (no over-grant)", () => {
    // No setActiveSandboxCapability call → global capability is none.
    const cap = resolveReviewerSandboxCapability("builtin", "bash");
    expect(cap.kind).toBe("none");
    expect(isWeakSandbox(cap)).toBe(true);
  });
});

describe("substrate-aware capability — end-to-end reviewer prompt + downgrade guard", () => {
  // The host-shell view of the capability exists only while the shell sandbox was requested at boot.
  beforeEach(() => setShellSandboxRequestedAtBoot(true));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  // Capture the userPrompt the reviewer hands the LLM so we can prove which executionSandbox value reaches the model per substrate.
  const capturingProvider = (): { provider: LlmReviewerProvider; complete: ReturnType<typeof vi.fn> } => {
    const complete = vi.fn(async () => ({
      text: '{"level":"low","reason":"looks fine"}',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    return { provider: { complete }, complete };
  };

  it("a plugin-sourced tool presents executionSandbox=none to the reviewer EVEN WHEN the global cap is asrt", async () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
      confines: { filesystem: true, process: true, network: true },
    });

    const { provider, complete } = capturingProvider();
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await classifier.classify(
      ctx({
        toolName: "plugin_run",
        source: "plugin",
        category: "shell",
        finalInput: { command: "make build" },
        // The substrate resolver is what production threads in — a plugin call resolves to none even though the global capability is asrt.
        sandboxCapability: resolveReviewerSandboxCapability("plugin", "plugin_run"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    const userPrompt = complete.mock.calls[0]![0].userPrompt as string;
    // PROOF: the worker-routed (unwrapped) substrate is reported as none — the reviewer is told NOT to relax for this unsandboxed effect.
    expect(userPrompt).toContain("executionSandbox=none");
    expect(userPrompt).not.toContain("executionSandbox=asrt");
  });

  it("an ASRT-wrapped host bash tool presents executionSandbox=asrt to the reviewer when the gate is ON", async () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
      confines: { filesystem: true, process: true, network: true },
    });

    const { provider, complete } = capturingProvider();
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await classifier.classify(
      ctx({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        finalInput: { command: "make build" },
        sandboxCapability: resolveReviewerSandboxCapability("builtin", "bash"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    const userPrompt = complete.mock.calls[0]![0].userPrompt as string;
    // The genuinely-wrapped host-shell substrate earns the asrt report.
    expect(userPrompt).toContain("executionSandbox=asrt");
  });

  it("the weak-sandbox no-downgrade guard fires for the plugin substrate (rule MEDIUM not downgraded to LOW)", async () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
      confines: { filesystem: true, process: true, network: true },
    });

    const { provider } = capturingProvider(); // always returns LLM LOW
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "plugin_run",
        source: "plugin",
        category: "shell",
        finalInput: { command: "make build" }, // rule → MEDIUM
        sandboxCapability: resolveReviewerSandboxCapability("plugin", "plugin_run"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    // weak substrate → LLM LOW cannot pull the MEDIUM rule verdict down.
    expect(verdict.level).toBe("medium");
  });
});

describe("synthetic network-only asrt — per-category relaxation gating", () => {
  // Network-only isolation cannot relax filesystem risk. Where the category is unconfined, reject model downgrades and keep the rule floor; otherwise normal max(rule, model) composition still honors escalation.
  const networkOnlyAsrt = (): SandboxCapability => ({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "ASRT (srt-win) active — network egress contained, no fs jail",
    confines: { filesystem: false, process: false, network: true },
  });

  const llmProvider = (level: "low" | "high"): LlmReviewerProvider => ({
    complete: vi.fn(async () => ({
      text: `{"level":"${level}","reason":"llm opinion"}`,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    })),
  });

  it("guard FIRES for a shell-category rule-MEDIUM (no fs jail → LLM LOW cannot downgrade)", async () => {
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        finalInput: { command: "make build" }, // rule → MEDIUM (shell unclassified)
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    // confines.filesystem === false → sandboxRelaxesCategory('shell') === false → guard fires → MEDIUM rule verdict survives the LLM LOW.
    expect(verdict.level).toBe("medium");
  });

  it("allowed writes remain LOW without filesystem confinement regardless of depth", async () => {
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "write_file",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        // Path depth does not change the write verdict.
        finalInput: { path: "/Users/example/work/nested/dir/output.txt" },
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please write the output file for me" },
      }),
    );
    expect(verdict.level).toBe("low");
  });

  it("relaxation IS allowed for the network category — guard does NOT fire, max(rule, llm) applies (LLM escalation honoured)", async () => {
    // Network egress IS jailed → sandboxRelaxesCategory('network') === true → the no-downgrade guard does NOT short-circuit; the standard max(rule, llm) composition runs. An escalating LLM (HIGH) is still honoured.
    const classifier = new LlmRiskClassifier(llmProvider("high"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "http_request",
        source: "builtin",
        category: "network",
        finalInput: { url: "http://localhost:8080/build" }, // rule → MEDIUM (localhost)
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please fetch the local build status for me" },
      }),
    );
    expect(verdict.level).toBe("high");
  });

  it("network confinement cannot lower an outside-directory write verdict", async () => {
    // An outside-directory write is HIGH regardless of a network-only jail or a lower model verdict.
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "write_file",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        finalInput: { path: "/outside/output.txt" }, // rule → HIGH
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please write the output file for me" },
      }),
    );
    expect(verdict.level).toBe("high");
  });
});
