import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { issueHostTerminalWriteAuthority } from "../../../permissions/host-terminal-write-authority.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { canonicalizePathForMatch } from "../../../permissions/sensitive-paths.js";
import { runWithEffectGateContext } from "../../../permissions/effect-enforcement.js";
import { bindRemoteControllerToSession } from "../../../shared/chat-origin.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { TERMINAL_TEST_NONCE, terminalMarker as mark } from "../../../__tests__/support/terminal-markers.js";
import { typeLineAtPrompt } from "../pty-manager.js";
import { TerminalBlockTracker } from "../terminal-blocks.js";
import { TERMINAL_EDIT_LINE_QUERY } from "../shell-integration.js";

const COMMAND = "printf ready";
const RESET = "\u0003";
const PASTE = `\u001b[200~${COMMAND}\u001b[201~`;
const CWD = canonicalizePathForMatch("/example");

function editor(editFailure?: { at: "echo" | "acknowledgement"; deny(): void }, canClear = true) {
  const blocks = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
  let prompts = 0;
  let token = "";
  let line = "";
  const prompt = () => {
    token = (++prompts).toString(16).padStart(2, "0").repeat(16);
    blocks.recordOutput(`\r\n${mark("D;0")}${mark(`P;Cwd=/example;Keys=emacs;Paste=1;NotFound=0;Edit=1;B=${token}`)}${mark("A")}% \u001b]133;B;${token}\u0007`);
  };
  prompt();
  const bytes: string[] = [];
  const order: string[] = [];
  const write = (data: string) => {
    bytes.push(data);
    order.push(`write:${data}`);
    if (data === RESET) {
      line = "";
      queueMicrotask(prompt);
    } else if (data === PASTE) {
      line = COMMAND;
      queueMicrotask(() => {
        if (editFailure?.at === "echo") {
          editFailure.deny();
          blocks.recordOutput("different line");
        } else blocks.recordOutput(line);
      });
    } else if (data === TERMINAL_EDIT_LINE_QUERY) {
      queueMicrotask(() => {
        let reported = line;
        if (reported !== "" && editFailure?.at === "acknowledgement") {
          editFailure.deny();
          reported = "different line";
        }
        blocks.recordOutput(mark(`E;Line=${encodeURIComponent(reported)};B=${token}`));
      });
    }
  };
  const onBeforeEnter = vi.fn(() => { order.push("disclose"); });
  const run = (fence: () => string | undefined, refresh: () => void = () => {}, signal?: AbortSignal) => {
    const pairedShare = { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" };
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller", actorId: "tailnet:owner", pairedShare,
      pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => {
        await Promise.resolve();
        order.push("refresh");
        refresh();
        return true;
      } },
    }, "alice");
    const target = {
      blocks, signal, write, onBeforeEnter, missing: "no terminal",
      isLive: () => true,
      verify: async () => ({ ok: true as const, cwd: CWD }),
      fence: () => { order.push("fence"); return fence(); },
      clearAfterAbort: () => {
        if (!canClear) return false;
        write(RESET);
        return true;
      },
    };
    return runWithEffectGateContext({ headless: false, toolName: "terminal_run", sessionId: "alice", permissionContext: { remoteControllerAuthority } },
      () => typeLineAtPrompt(target, COMMAND));
  };
  return { bytes, order, onBeforeEnter, run };
}

describe("terminal write fence", () => {
  it.each(["before paste", "before Enter"] as const)("blocks the next write when a deny lands during remote refresh %s", async (when) => {
    const directory = mkdtempSync(join(tmpdir(), "ave-terminal-fence-"));
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("allow");
    const check = () => manager.checkDetailed("terminal_run", "builtin", "shell");
    const authority = issueHostTerminalWriteAuthority({
      manager, human: false, cardForced: false, reviewed: false, settled: check(), decidedBackend: "host",
      check, backendIdentity: () => "host",
    });
    const terminal = editor();
    let result: Awaited<ReturnType<typeof terminal.run>>;
    try {
      result = await terminal.run(authority.refusal, () => {
        if (terminal.bytes.at(-1) === TERMINAL_EDIT_LINE_QUERY && (when === "before Enter") === terminal.bytes.includes(PASTE)) {
          manager.setRules([{ pattern: "terminal_run", action: "deny" }]);
        }
      });
    } finally {
      await cleanupTmpDir(directory);
    }
    expect(result).toMatchObject({ ok: false, reason: "effect-refused" });
    expect(terminal.bytes).toEqual(when === "before paste"
      ? [RESET, TERMINAL_EDIT_LINE_QUERY]
      : [RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY, RESET]);
    expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
  });

  it("clears the paste when approval is lost before Enter", async () => {
    const terminal = editor();
    let refused = false;
    const result = await terminal.run(() => refused ? "permission changed" : undefined, () => {
      refused ||= terminal.bytes.includes(PASTE) && terminal.bytes.at(-1) === TERMINAL_EDIT_LINE_QUERY;
    });
    expect(result).toMatchObject({ ok: false, reason: "effect-refused", message: "permission changed" });
    expect(terminal.bytes).toEqual([RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY, RESET]);
    expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
  });

  it.each(["echo", "acknowledgement"] as const)("withdraws the pasted line and returns a deny after a failed %s", async (at) => {
    const directory = mkdtempSync(join(tmpdir(), "ave-terminal-fence-"));
    try {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("allow");
      const check = () => manager.checkDetailed("terminal_run", "builtin", "shell");
      const authority = issueHostTerminalWriteAuthority({
        manager, human: false, cardForced: false, reviewed: false, settled: check(), decidedBackend: "host",
        check, backendIdentity: () => "host",
      });
      const terminal = editor({ at, deny: () => manager.setRules([{ pattern: "terminal_run", action: "deny" }]) });
      const result = await terminal.run(authority.refusal);
      expect(check()).toMatchObject({ decision: "deny" });
      expect(result).toMatchObject({ ok: false, reason: "effect-refused", message: check().reason });
      expect(terminal.bytes).toEqual(at === "echo" ? [RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, RESET]
        : [RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY, RESET]);
      expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("reports an effect refusal when the pasted line cannot be cleared", async () => {
    let denied = false;
    const terminal = editor({ at: "acknowledgement", deny: () => { denied = true; } }, false);
    const result = await terminal.run(() => denied ? "permission changed" : undefined);
    expect(result).toEqual({
      ok: false, reason: "effect-refused", pasteUncleared: true,
      message: "permission changed\nThe pasted line could not be cleared. Enter was not pressed.",
    });
    expect(terminal.bytes).toEqual([RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY]);
    expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
  });

  it("sends no reset when the first write is refused", async () => {
    const terminal = editor();
    expect(await terminal.run(() => "permission changed")).toMatchObject({ ok: false, reason: "effect-refused" });
    expect(terminal.bytes).toEqual([]);
  });

  it("checks after refresh and synchronously before every write", async () => {
    const terminal = editor();
    expect(await terminal.run(() => undefined)).toMatchObject({ ok: true });
    expect(terminal.bytes).toEqual([RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY, "\r"]);
    expect(terminal.onBeforeEnter).toHaveBeenCalledOnce();
    expect(terminal.order).toEqual([
      "refresh",
      "refresh", "fence", "fence", `write:${RESET}`,
      "refresh", "fence", "fence", `write:${TERMINAL_EDIT_LINE_QUERY}`,
      "refresh", "fence", "fence", `write:${PASTE}`,
      "refresh", "fence", "fence", `write:${TERMINAL_EDIT_LINE_QUERY}`,
      "refresh", "fence", "fence", "disclose", "write:\r",
    ]);
  });

  it("stops before typing when the call is cancelled during refresh", async () => {
    const terminal = editor();
    const cancel = new AbortController();
    expect(await terminal.run(() => undefined, () => cancel.abort(), cancel.signal)).toMatchObject({ ok: false, reason: "aborted" });
    expect(terminal.bytes).toEqual([]);
  });

  it("stops at the final send check when cancellation follows a successful pre-Enter check", async () => {
    const terminal = editor();
    const cancel = new AbortController();
    let queued = false;
    const fence = () => {
      if (!queued && terminal.bytes.includes(PASTE) && terminal.bytes.at(-1) === TERMINAL_EDIT_LINE_QUERY) {
        queued = true;
        queueMicrotask(() => cancel.abort());
      }
      expect(cancel.signal.aborted).toBe(false);
      return undefined;
    };
    expect(await terminal.run(fence, undefined, cancel.signal)).toMatchObject({ ok: false, reason: "aborted" });
    expect(cancel.signal.aborted).toBe(true);
    expect(terminal.bytes).toEqual([RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY, RESET]);
    expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
  });

  it("routes the reset, query, paste and Enter through send", () => {
    const source = readFileSync(new URL("../pty-manager.ts", import.meta.url), "utf8");
    const typing = source.slice(source.indexOf("export async function typeLineAtPrompt("), source.indexOf("const TERMINAL_NOT_READY_MESSAGES"));
    expect(typing.match(/\b\w+\.write\(/g)).toEqual(["originalTarget.write(", "originalTarget.write("]);
    expect(typing).toContain('send("\\u0003",');
    expect(typing).toContain("send(TERMINAL_EDIT_LINE_QUERY)");
    expect(typing).toContain("send(`\\u001b[200~");
    expect(typing).toContain('send("\\r",');
  });
});
