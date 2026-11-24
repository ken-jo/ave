// Generic argv uses the legacy runner's fail-closed, environment and timeout gates; interpreter-dependent cases skip when unavailable (docs/architecture/hook-runtime-expansion-design.md).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  runOneHookScript,
  type RunnableHook,
} from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";
import { hasExecutable, repoCommandHook } from "./test-helpers.js";
import { withPlantedProgram } from "../../__tests__/support/planted-program.js";

const FIXTURE_ROOT = resolve(__dirname, "..", "..", "..", "test", "fixtures", "hooks");

const HAS_NODE = hasExecutable("node");

function cmdHook(over: Partial<RunnableHook> & Pick<RunnableHook, "command">): RunnableHook {
  return {
    id: "config:PreToolUse#0.0",
    hookType: "pre",
    hookPath: over.command[0],
    configDir: FIXTURE_ROOT,
    ...over,
  };
}

const samplePayload: ScriptHookStdin = {
  hookType: "pre",
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  input: { path: "/tmp/x" },
  sessionId: "sess-1",
  trustOrigin: "user-keyboard",
};

describe("generalized hook command runner", () => {
  it("runs a configured script and parses allow", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: repoCommandHook("policy") }),
      samplePayload,
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("command policy ok");
  });

  it("a configured script can deny", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: repoCommandHook("policy") }),
      { ...samplePayload, toolName: "blocked_tool" },
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("blocked_tool");
  });

  it("nonzero exit fails closed → deny", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: repoCommandHook("exit-fail") }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.exitCode).toBe(3);
    expect(r.reason).toMatch(/non-zero/);
  });

  it("malformed stdout fails closed → deny", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: repoCommandHook("bad-json") }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/not valid/);
  });

  it("timeout fails closed → deny (per-runnable budget)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: repoCommandHook("slow"), timeoutMs: 200 }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.timedOut).toBe(true);
    expect(r.reason).toMatch(/timed out/);
  });

  it("forwards only allowlisted environment variables", async () => {
    const prev = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      AVE_SECRET_PROBE: process.env.AVE_SECRET_PROBE,
    };
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.GITHUB_TOKEN = "ghp-should-not-leak";
    process.env.AVE_SECRET_PROBE = "ave-internal-should-not-leak";
    try {
      const r = await runOneHookScript(
        cmdHook({ command: repoCommandHook("noenv") }),
        samplePayload,
      );
      expect(r.decision).toBe("allow");
      expect(r.reason).toBe("no secret env");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("#811 generalized runner — node command hook", () => {
  it.skipIf(!HAS_NODE)("runs a node <script> command and round-trips stdin", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["node", resolve(FIXTURE_ROOT, "cmd-node.js")] }),
      { ...samplePayload, trustOrigin: "llm-tool-arg" },
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("origin=llm-tool-arg");
  });
});

describe("#811 generalized runner — spawn error fails closed", () => {
  it("an unresolvable program → deny (spawn error)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: ["this-binary-does-not-exist-xyz", "./x.py"] }),
      samplePayload,
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/spawn error/);
  });
});

describe("#811 generalized runner — legacy .sh path preserved", () => {
  it("a single .sh argv still runs through the shell (back-compat)", async () => {
    const r = await runOneHookScript(
      cmdHook({ command: [resolve(FIXTURE_ROOT, "pre-allow.sh")], hookType: "pre" }),
      samplePayload,
      process.platform === "win32" ? { timeoutMs: 20_000 } : undefined,
    );
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("fixture allow");
  });
});

describe("command hook program lookup", () => {
  it("never runs a bare program planted in the hook cwd or reached through an empty or relative PATH entry", async () => {
    await withPlantedProgram(["ave-planted-hook"], async (planted) => {
      // The hook runs in its configuration directory, which a bare-name lookup would search first.
      const r = await runOneHookScript(cmdHook({ command: ["ave-planted-hook"], configDir: planted.dir }), samplePayload);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/'ave-planted-hook' was not found on PATH/u);
      expect(planted.ran()).toBe(false);
    });
  });
});
