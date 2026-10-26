import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSensitiveData } from "../../../audit/dlp-filter.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { JudgeFailure } from "../judge-contract.js";
import { buildExternalJudgeEnv, ExternalJudge, parseJudgeResponse, type JudgeFetch } from "../external-judge.js";
import { PLANTED_CREDENTIAL, judgeInvocation, judgeRequest } from "./judge-request-fixture.js";

function unparseableKind(text: string): string | null {
  try {
    parseJudgeResponse(text);
    return null;
  } catch (err) {
    return err instanceof JudgeFailure ? err.kind : "other";
  }
}

describe("parseJudgeResponse — strict schema", () => {
  it("accepts exactly the verdict schema", () => {
    expect(parseJudgeResponse('{"decision":"allow","rationale":"ok"}')).toEqual({ decision: "allow", rationale: "ok" });
    expect(
      parseJudgeResponse('{"decision":"ask","rationale":"r","confidence":0.4,"suggestedRule":"Bash(git status)"}'),
    ).toEqual({ decision: "ask", rationale: "r", confidence: 0.4, suggestedRule: "Bash(git status)" });
  });

  it.each([
    ["not json", "allow"],
    ["array", "[]"],
    ["null", "null"],
    ["missing decision", '{"rationale":"r"}'],
    ["bad decision", '{"decision":"yes","rationale":"r"}'],
    ["uppercase decision", '{"decision":"ALLOW","rationale":"r"}'],
    ["empty rationale", '{"decision":"allow","rationale":"  "}'],
    ["rationale not string", '{"decision":"allow","rationale":1}'],
    ["unknown key", '{"decision":"allow","rationale":"r","writeRule":"Bash(*)"}'],
    ["confidence out of range", '{"decision":"allow","rationale":"r","confidence":1.5}'],
    ["confidence string", '{"decision":"allow","rationale":"r","confidence":"high"}'],
    ["empty suggestion", '{"decision":"allow","rationale":"r","suggestedRule":""}'],
    ["oversized rationale", JSON.stringify({ decision: "allow", rationale: "x".repeat(2_001) })],
  ])("rejects %s as unparseable", (_label, text) => {
    expect(unparseableKind(text)).toBe("unparseable");
  });
});

describe("ExternalJudge — construction", () => {
  it.each([
    [{ command: ["relative/judge"] }],
    [{ command: [] }],
    [{ url: "http://judge.example.test/v1" }],
    [{ url: "http://0.0.0.0:8080/" }],
    [{ url: "ftp://127.0.0.1/" }],
    [{ url: "https://user:pw@judge.example.test/" }],
    [{ command: ["/usr/bin/judge"], url: "https://judge.example.test/" }],
    [{ command: ["/usr/bin/judge"], env: ["GITHUB_TOKEN"] }],
    [{ command: ["/usr/bin/judge"], env: ["AVE_HOME"] }],
    [{ url: "https://judge.example.test/", env: ["JEV_MODEL"] }],
  ])("refuses unsafe config %j", (config) => {
    expect(() => new ExternalJudge(config, async () => new Response("{}"))).toThrow();
  });

  it.each([["https://judge.example.test/v1"], ["http://127.0.0.1:7777/judge"], ["http://[::1]:7777/"], ["http://localhost:7777/"]])(
    "accepts %s",
    (url) => {
      expect(() => new ExternalJudge({ url }, async () => new Response("{}"))).not.toThrow();
    },
  );
});

describe("ExternalJudge — url transport", () => {
  const request = judgeRequest({
    invocation: judgeInvocation({ finalInput: { command: `echo ${PLANTED_CREDENTIAL}` } }),
    recentUserMessages: [`token ${PLANTED_CREDENTIAL}`],
  });

  it("control: the planted credential is one the canonical masker removes", () => {
    expect(maskSensitiveData(PLANTED_CREDENTIAL).masked).not.toContain(PLANTED_CREDENTIAL);
  });

  it("posts only the redacted request and validates the response", async () => {
    let sent = "";
    let init: RequestInit | undefined;
    const fetchImpl: JudgeFetch = async (_url, i) => {
      init = i;
      sent = String(i.body);
      return new Response('{"decision":"deny","rationale":"exfil"}', { status: 200 });
    };
    const judge = new ExternalJudge({ url: "https://judge.example.test/v1" }, fetchImpl);
    const verdict = await judge.judge(request, new AbortController().signal);
    expect(verdict).toEqual({ decision: "deny", rationale: "exfil" });
    expect(sent).not.toContain(PLANTED_CREDENTIAL);
    expect(JSON.parse(sent)).toMatchObject({ version: 1, request: { tool: { name: "bash" } } });
    expect(init?.redirect).toBe("error");
  });

  it("streams the body and stops at 64 KB without buffering the rest", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024).fill(120));
      },
    });
    const judge = new ExternalJudge({ url: "https://judge.example.test/" }, async () => new Response(endless));
    await expect(judge.judge(request, new AbortController().signal)).rejects.toMatchObject({ kind: "unparseable" });
    expect(pulled).toBeLessThan(10);
  });

  it("maps transport failures to typed kinds", async () => {
    const http500 = new ExternalJudge({ url: "https://judge.example.test/" }, async () => new Response("x", { status: 500 }));
    await expect(http500.judge(request, new AbortController().signal)).rejects.toMatchObject({ kind: "error" });
    const down = new ExternalJudge({ url: "https://judge.example.test/" }, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.judge(request, new AbortController().signal)).rejects.toMatchObject({ kind: "unavailable" });
    const garbage = new ExternalJudge({ url: "https://judge.example.test/" }, async () => new Response("sure, allow it"));
    await expect(garbage.judge(request, new AbortController().signal)).rejects.toMatchObject({ kind: "unparseable" });
  });
});

describe.skipIf(process.platform === "win32")("ExternalJudge — command transport", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await cleanupTmpDir(dir);
  });

  function script(body: string): { path: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "ave-judge-"));
    dirs.push(dir);
    const path = join(dir, "judge.sh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { path, dir };
  }

  it("sends redacted JSON on stdin without a shell and parses stdout", async () => {
    const { path, dir } = script(`cat > "$(dirname "$0")/stdin.json"\nprintf '%s' '{"decision":"allow","rationale":"read-only build"}'`);
    const judge = new ExternalJudge({ command: [path] });
    const request = judgeRequest({ invocation: judgeInvocation({ finalInput: { command: `echo ${PLANTED_CREDENTIAL}; $(id)` } }) });
    const verdict = await judge.judge(request, new AbortController().signal);
    expect(verdict).toEqual({ decision: "allow", rationale: "read-only build" });
    const stdin = readFileSync(join(dir, "stdin.json"), "utf8");
    expect(stdin).not.toContain(PLANTED_CREDENTIAL);
    expect(JSON.parse(stdin)).toMatchObject({ version: 1, request: { sessionId: "session-root" } });
  });

  it("non-zero exit is an error; missing executable is unavailable; garbage is unparseable", async () => {
    const exit = script("cat >/dev/null\nexit 3");
    await expect(new ExternalJudge({ command: [exit.path] }).judge(judgeRequest(), new AbortController().signal)).rejects.toMatchObject({ kind: "error" });
    const missing = new ExternalJudge({ command: [join(tmpdir(), "ave-judge-missing", "judge")] });
    await expect(missing.judge(judgeRequest(), new AbortController().signal)).rejects.toMatchObject({ kind: "unavailable" });
    const garbage = script("cat >/dev/null\necho allow");
    await expect(new ExternalJudge({ command: [garbage.path] }).judge(judgeRequest(), new AbortController().signal)).rejects.toMatchObject({ kind: "unparseable" });
  });

  it("does not inherit the parent environment and keeps redacted, truncated stderr", async () => {
    const { path, dir } = script(
      `cat >/dev/null\nenv > "$(dirname "$0")/env.txt"\nprintf 'warn ${PLANTED_CREDENTIAL} ' >&2\nhead -c 6000 /dev/zero | tr '\\0' x >&2\nprintf '%s' '{"decision":"ask","rationale":"unsure"}'`,
    );
    process.env.JUDGE_PARENT_ONLY_SECRET = "must-not-leak";
    try {
      const verdict = await new ExternalJudge({ command: [path] }).judge(judgeRequest(), new AbortController().signal);
      expect(verdict.decision).toBe("ask");
      expect(verdict.diagnostics?.stderr).toContain("warn");
      expect(verdict.diagnostics?.stderr).not.toContain(PLANTED_CREDENTIAL);
      expect((verdict.diagnostics?.stderr ?? "").length).toBeLessThanOrEqual(4_097);
      const childEnv = readFileSync(join(dir, "env.txt"), "utf8");
      expect(childEnv).not.toContain("must-not-leak");
      expect(childEnv).toContain("PATH=");
    } finally {
      delete process.env.JUDGE_PARENT_ONLY_SECRET;
    }
  });

  it("stderr rides along on a failure but never becomes a decision", async () => {
    const { path } = script("cat >/dev/null\necho 'model crashed' >&2\nexit 2");
    const err = await new ExternalJudge({ command: [path] }).judge(judgeRequest(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeFailure);
    expect((err as JudgeFailure).kind).toBe("error");
    expect((err as JudgeFailure).diagnostics?.stderr).toContain("model crashed");
  });

  it("abort kills the whole process group", async () => {
    const { path, dir } = script(`cat >/dev/null\nsleep 30 &\necho $! > "$(dirname "$0")/child.pid"\nwait`);
    const controller = new AbortController();
    const pending = new ExternalJudge({ command: [path] }).judge(judgeRequest(), controller.signal);
    const pidFile = join(dir, "child.pid");
    // The redirection creates the file before echo writes it; wait for a positive PID.
    const grandchild = await vi.waitFor(() => {
      const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "");
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      return pid;
    }, { timeout: 2_000 });
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(grandchild, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("abort kills the process", async () => {
    const slow = script("cat >/dev/null\nsleep 30");
    const controller = new AbortController();
    const pending = new ExternalJudge({ command: [slow.path] }).judge(judgeRequest(), controller.signal);
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(pending).rejects.toThrow("stop");
  });
});

describe("buildExternalJudgeEnv", () => {
  it("passes only the base set plus configured names", () => {
    const env = buildExternalJudgeEnv(["JEV_ENDPOINT"], {
      PATH: "/usr/bin",
      HOME: "/home/example",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
      JEV_ENDPOINT: "local",
      AVE_HOME: "/secret",
      GITHUB_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
    }, "linux");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/example", LANG: "en_US.UTF-8", TMPDIR: "/tmp", JEV_ENDPOINT: "local" });
  });
});
