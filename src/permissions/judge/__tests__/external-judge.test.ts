import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSensitiveData } from "../../../audit/dlp-filter.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { JudgeFailure } from "../judge-contract.js";
import { ExternalJudge, parseJudgeResponse, type JudgeFetch } from "../external-judge.js";
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

  it("abort kills the process", async () => {
    const slow = script("cat >/dev/null\nsleep 30");
    const controller = new AbortController();
    const pending = new ExternalJudge({ command: [slow.path] }).judge(judgeRequest(), controller.signal);
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await expect(pending).rejects.toThrow("stop");
  });
});
