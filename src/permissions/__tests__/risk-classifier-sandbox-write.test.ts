// Sandbox-write LOW requires a host-owned root and proof every resolved path stays inside it; traversal, missing declarations and self-attestation cannot qualify.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuleBasedRiskClassifier,
  type ToolInvocationContext,
} from "../reviewer/risk-classifier.js";
import { detectSandboxCapability } from "../sandbox-capability.js";
import { resolveOwnerPluginSandboxRoot, resolvePluginWritableRoot } from "../../plugins/plugin-storage-layout.js";

// Use realpath so the canonicalize step inside the classifier produces the same string on darwin (/var → /private/var).
const TMP = realpathSync(tmpdir());
const PLUGIN_ID = "ave-plugin-samplemail";
const SANDBOX_ROOT = `${TMP}/ave-sandbox-test/.ave/plugins/${PLUGIN_ID}`;
const ALLOWED = [`${TMP}/ave-sandbox-test/work`];

function ctx(overrides: Partial<ToolInvocationContext>): ToolInvocationContext {
  return {
    toolName: "samplemail_auth",
    source: "plugin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "plugin-emitted",
    finalInput: {},
    executionCwd: TMP,
    allowedDirectories: ALLOWED,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

describe("RuleBasedRiskClassifier — #664 P1 / #885 v6 host-derived sandbox-write auto-LOW", () => {
  const rb = new RuleBasedRiskClassifier();

  it("(a) ownerPluginSandboxRoot set + path inside → LOW (no self-claim needed)", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/msal-cache.bin` },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/owner plugin sandbox/);
  });

  it("(b) path-traversal `..` cannot escape → no auto-LOW (falls through)", () => {
    // `../` traversal: nominally inside SANDBOX_ROOT by string prefix but canonicalizePathForMatch collapses `..` so the prefix compare no longer matches → the auto-LOW is NOT engaged.
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${SANDBOX_ROOT}/../../sessions/sensitive.jsonl` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(c) path outside the root AND outside allowed → HIGH (write outside)", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${TMP}/outside-everything/file.bin` },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/outside allowed/);
  });

  it("(d) ownerPluginSandboxRoot ABSENT (builtin/MCP tool) → no auto-LOW", () => {
    // No host-computed sandbox root ⇒ the tool is not plugin-owned ⇒ the normal write rules apply. A sandbox-shaped path can never "accidentally" auto-LOW.
    const v = rb.classify(
      ctx({
        finalInput: { path: `${SANDBOX_ROOT}/anything.bin` },
      }),
    );
    expect(v.reason).not.toMatch(/owner plugin sandbox/);
  });

  it("(e) manifest mistake — pathFields declared but resolves to nothing → HIGH (not declared)", () => {
    // Declared-but-unresolved must NOT reach the unknown-MEDIUM below: an empty resolve is reachable from the CALL's arguments (non-string, empty string, canonicalization throw), so keying on the resolved value would let a plugin that declared its paths move off HIGH by choosing an argument.
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: {}, // path field absent
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/not declared/);
  });
});

describe("RuleBasedRiskClassifier — OS-confined no-declared-write-path LOW", () => {
  const rb = new RuleBasedRiskClassifier();
  const ASRT_FULL = {
    kind: "asrt",
    confidence: "verified",
    platform: "darwin",
    reason: "ASRT (Seatbelt) active",
    confines: { filesystem: true, process: true, network: true },
  } as const;

  it("write + owner root + NO resolvable path + asrt-full substrate → LOW", () => {
    const v = rb.classify(
      ctx({
        toolName: "sampleassistant_list_detectors",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: [],
        finalInput: {},
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    expect(v.level).toBe("low");
    expect(v.reason).toContain("OS-confined to owner plugin sandbox");
  });

  it("same call with substrate none (in-process plugin) drops to MEDIUM, not LOW", () => {
    // The LOW above is earned by kernel confinement. Without it there is no containment fact to state, so the verdict must NOT be LOW — but it is not HIGH either, because nothing here observed a write. MEDIUM is what "we do not know" looks like, and unlike HIGH it can be answered once.
    const v = rb.classify(
      ctx({
        toolName: "sampleassistant_list_detectors",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: [],
        finalInput: {},
        // detectSandboxCapability default in tests — kind none
      }),
    );
    expect(v.level).toBe("medium");
    expect(v.reason).toMatch(/strict default, not an observation/);
    // The explicit approval requirement is independent of the displayed risk level.
    expect(v.requiresExplicitApproval).toBe(true);
  });

  it("a non-plugin source cannot reach the unknown-MEDIUM even carrying an owner root", () => {
    // The rule keys on `source`, not merely on the presence of a plugin-shaped root, so a future builtin that gains a `pluginId` for ownership reasons cannot silently inherit it.
    const v = rb.classify(
      ctx({
        toolName: "some_builtin",
        source: "builtin",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: [],
        finalInput: {},
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write path not declared");
  });

  it("a builtin tool with no declared path is untouched — still HIGH", () => {
    // `ownerPluginSandboxRoot` is host-set for plugin-owned tools only, so the new MEDIUM cannot reach a builtin or MCP tool. This is the guard that keeps the change from widening past the plugin lane.
    const v = rb.classify(
      ctx({ toolName: "file_write", source: "builtin", pathFields: [], finalInput: {} }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write path not declared");
  });

  it("a plugin call that NAMES a target keeps its lexical write verdict", () => {
    // The multiplexed-tool case: `index_folders` with action=list declares no folder and lands on MEDIUM above, but the same tool with action=add names one — and then the path rules decide, exactly as before.
    const v = rb.classify(
      ctx({
        toolName: "index_folders",
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        pathFields: ["folder"],
        finalInput: { folder: `${TMP}/somewhere-else/docs` },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write outside allowed dirs");
  });

  it("declared path OUTSIDE the owner root stays on the lexical rules even under asrt", () => {
    const v = rb.classify(
      ctx({
        ownerPluginSandboxRoot: SANDBOX_ROOT,
        finalInput: { path: `${TMP}/somewhere-else/x.txt` },
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    // The confined-LOW rule must NOT swallow a resolvable declared path — the path either proves containment lexically or escalates.
    expect(v.reason).not.toContain("OS-confined to owner plugin sandbox");
  });

  it("builtin tool without owner root cannot reach the confined LOW", () => {
    const v = rb.classify(
      ctx({
        source: "builtin",
        toolName: "write_file",
        pathFields: [],
        finalInput: {},
        sandboxCapability: { ...ASRT_FULL },
      }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("write path not declared");
  });
});

// The owner sandbox root is host-derived, and the derivation is what must not be steerable: a confined plugin that replaced its data root with a link would otherwise make the link's target its "own" sandbox, since the classifier canonicalises the root.
describe("the owner plugin sandbox root of a replaced data root", () => {
  const rb = new RuleBasedRiskClassifier();

  it.runIf(process.platform !== "win32")("derives no owner sandbox, so a write under the link target is not auto-LOW", () => {
    const home = mkdtempSync(join(TMP, "ave-owner-root-"));
    const previous = process.env.AVE_HOME;
    process.env.AVE_HOME = join(home, ".ave");
    try {
      const outside = join(home, "outside");
      mkdirSync(outside);
      mkdirSync(join(home, ".ave", "plugins", PLUGIN_ID), { recursive: true });
      symlinkSync(outside, resolvePluginWritableRoot(PLUGIN_ID));
      const write = { finalInput: { path: join(outside, "token.bin") } };
      // The hazard, measured: the lexical root alone canonicalises to the target.
      expect(rb.classify(ctx({ ...write, ownerPluginSandboxRoot: resolvePluginWritableRoot(PLUGIN_ID) })).reason)
        .toMatch(/owner plugin sandbox/);
      // What the invocation sites now pass: the host-checked root, or nothing.
      const owner = resolveOwnerPluginSandboxRoot(PLUGIN_ID);
      expect(owner).toBeUndefined();
      const verdict = rb.classify(ctx({ ...write, ...(owner !== undefined ? { ownerPluginSandboxRoot: owner } : {}) }));
      expect(verdict.reason).not.toMatch(/owner plugin sandbox/);
      expect(verdict.level).not.toBe("low");
    } finally {
      if (previous === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the lexical root for a real directory, and for one not created yet", () => {
    const home = mkdtempSync(join(TMP, "ave-owner-root-"));
    const previous = process.env.AVE_HOME;
    process.env.AVE_HOME = join(home, ".ave");
    try {
      expect(resolveOwnerPluginSandboxRoot(PLUGIN_ID)).toBe(resolvePluginWritableRoot(PLUGIN_ID));
      mkdirSync(resolvePluginWritableRoot(PLUGIN_ID), { recursive: true });
      expect(resolveOwnerPluginSandboxRoot(PLUGIN_ID)).toBe(resolvePluginWritableRoot(PLUGIN_ID));
    } finally {
      if (previous === undefined) delete process.env.AVE_HOME;
      else process.env.AVE_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
