import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../../scripts/lib/ts7-ast.mjs";
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
  const run = (
    fence: () => string | undefined,
    refresh: () => void = () => {},
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ) => {
    const pairedShare = { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" };
    const remoteControllerAuthority = bindRemoteControllerToSession({
      kind: "tailnet-controller", actorId: "tailnet:owner", pairedShare,
      pairedShareGuard: { isCurrent, refreshCurrent: async () => {
        await Promise.resolve();
        order.push("refresh");
        refresh();
        return true;
      } },
    }, "alice");
    const target = {
      blocks, signal, onBeforeEnter, missing: "no terminal",
      write: (data: string, withdrawPaste?: true) => {
        if (withdrawPaste && !canClear) return false;
        write(data);
        return true;
      },
      canWithdrawAfterCancellation: true,
      isLive: () => true,
      verify: async () => ({ ok: true as const, cwd: CWD }),
      fence: () => { order.push("fence"); return fence(); },
    };
    return runWithEffectGateContext({ headless: false, toolName: "terminal_run", sessionId: "alice", permissionContext: { remoteControllerAuthority } },
      () => typeLineAtPrompt(target, COMMAND));
  };
  return { blocks, bytes, order, onBeforeEnter, run };
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

  it("stops at the final send check when cancellation follows a successful pre-paste check", async () => {
    const terminal = editor();
    const cancel = new AbortController();
    const editLineReport = terminal.blocks.editLineReport.bind(terminal.blocks);
    vi.spyOn(terminal.blocks, "editLineReport").mockImplementation(() => {
      const report = editLineReport();
      if (terminal.bytes.at(-1) === TERMINAL_EDIT_LINE_QUERY && terminal.order.at(-1) === "fence") {
        cancel.abort();
      }
      return report;
    });
    const fence = () => {
      expect(cancel.signal.aborted).toBe(false);
      return undefined;
    };
    expect(await terminal.run(fence, undefined, cancel.signal)).toMatchObject({ ok: false, reason: "aborted" });
    expect(cancel.signal.aborted).toBe(true);
    expect(terminal.bytes).toEqual([RESET, TERMINAL_EDIT_LINE_QUERY]);
    expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
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

  it.each([
    { changeReport: true, revoke: false },
    { changeReport: true, revoke: true },
    { changeReport: false, revoke: true },
  ])("preserves a concurrent deny at the Enter boundary ($changeReport, $revoke)", async ({ changeReport, revoke }) => {
    const directory = mkdtempSync(join(tmpdir(), "ave-terminal-fence-"));
    try {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setMode("allow");
      const check = () => manager.checkDetailed("terminal_run", "builtin", "shell");
      const authority = issueHostTerminalWriteAuthority({
        manager, human: false, cardForced: false, reviewed: false, settled: check(), decidedBackend: "host",
        check, backendIdentity: () => "host",
      });
      const terminal = editor();
      let finalProof = false;
      let controllerRevoked = false;
      const editLineReport = terminal.blocks.editLineReport.bind(terminal.blocks);
      vi.spyOn(terminal.blocks, "editLineReport").mockImplementation(() => {
        const report = editLineReport();
        if (report && terminal.bytes.includes(PASTE) && terminal.bytes.at(-1) === TERMINAL_EDIT_LINE_QUERY
          && (finalProof || terminal.order.at(-1) === "fence")) {
          if (!finalProof) manager.setRules([{ pattern: "terminal_run", action: "deny" }]);
          finalProof = true;
          if (changeReport) return { ...report, generation: report.generation + 1 };
        }
        return report;
      });

      const result = await terminal.run(authority.refusal, undefined, undefined, () => {
        controllerRevoked ||= revoke && finalProof;
        return !controllerRevoked;
      });
      expect(finalProof).toBe(true);
      expect(controllerRevoked).toBe(revoke);
      const deny = check();
      expect(deny.decision).toBe("deny");
      const writes = [RESET, TERMINAL_EDIT_LINE_QUERY, PASTE, TERMINAL_EDIT_LINE_QUERY];
      if (revoke) {
        expect(result).toEqual({ ok: false, reason: "effect-refused", pasteUncleared: true,
          message: `${deny.reason}\nThe pasted line could not be cleared. Enter was not pressed.` });
      } else {
        writes.push(RESET);
        expect(result).toEqual({ ok: false, reason: "effect-refused", message: deny.reason });
      }
      expect(terminal.bytes).toEqual(writes);
      expect(terminal.onBeforeEnter).not.toHaveBeenCalled();
    } finally {
      await cleanupTmpDir(directory);
    }
  });

  it("routes every post-paste exit through the finalizer", () => {
    const path = "pty-manager.ts";
    const text = readFileSync(new URL("../pty-manager.ts", import.meta.url), "utf8");
    const source = parseSourceTexts(new Map([[path, text]])).get(path) as ts.SourceFile | undefined;
    const typing = source?.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "typeLineAtPrompt");
    if (!typing?.body) throw new Error("Terminal typing protocol not found.");
    const statements = typing.body.statements;
    const pasteIndex = statements.findIndex((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((declaration) => declaration.name.getText() === "pasteRefusal"));
    expect(pasteIndex).toBeGreaterThanOrEqual(0);
    const pasteGuard = statements[pasteIndex + 1];
    expect(ts.isIfStatement(pasteGuard) && pasteGuard.expression.getText()).toBe("pasteRefusal !== undefined");
    const exits: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
        const expression = node.expression;
        if (ts.isReturnStatement(node) && expression && ts.isCallExpression(expression)
          && expression.expression.getText() === "finalizeAfterPaste") {
          exits.push(expression.arguments.map((argument) => argument.getText()).join(", "));
        } else {
          exits.push(node.getText());
        }
      }
      node.forEachChild(visit);
    };
    const postPaste = statements.slice(pasteIndex + 2);
    expect(postPaste.map((node) => node.kind)).toEqual([ts.SyntaxKind.TryStatement, ts.SyntaxKind.ReturnStatement]);
    const guarded = postPaste[0];
    expect(ts.isTryStatement(guarded) && guarded.catchClause).toBeTruthy();
    postPaste.forEach(visit);
    expect(exits).toEqual([
      'notTyped("aborted", "terminal command preparation was cancelled; Enter was not pressed")',
      'notTyped("edit-line-mismatch", "the terminal\'s line editor did not show exactly the approved line after it was pasted, so Enter was not pressed")',
      "beforeQuery",
      'notTyped("aborted", "terminal command preparation was cancelled; Enter was not pressed")',
      "effectRefused(confirmed)",
      'notTyped("edit-line-mismatch", "the terminal\'s editable command buffer did not match the approved line; Enter was not pressed")',
      "beforeEnter",
      'notTyped("edit-line-mismatch", "the terminal prompt or editor acknowledgement changed before Enter; no further input was sent")',
      "interrupted() ?? effectRefused(enterRefusal)",
      "failure",
      "{ ok: true, firstBlockId }",
    ]);
  });

  it("routes every protocol write, including host cleanup, through send", () => {
    const source = readFileSync(new URL("../pty-manager.ts", import.meta.url), "utf8");
    const host = source.slice(source.indexOf("export async function typeHostTerminalCommand("), source.indexOf("export interface HostTerminalTypingRequest"));
    const typing = source.slice(source.indexOf("export async function typeLineAtPrompt("), source.indexOf("const TERMINAL_NOT_READY_MESSAGES"));
    const writeSites = /\b(?:\w+\.)+write\(/g;
    expect(host.match(writeSites)).toEqual(["session.pty.write("]);
    expect(host).toMatch(/write: \(data, withdrawPaste\) => \{[^}]*session\.pty\.write\(data\)/);
    expect(typing.match(writeSites)).toEqual(["target.write("]);
    const sendBody = typing.slice(typing.indexOf("const send: SendPromptInput"), typing.indexOf("if (!hasOnlyTypeableCharacters("));
    expect(sendBody).toContain("target.write(data, withdrawPaste)");
    expect(typing).toContain('send("\\u0003", { beforeBytes:');
    expect(typing).toContain("send(TERMINAL_EDIT_LINE_QUERY)");
    expect(typing).toContain("send(`\\u001b[200~");
    expect(typing).toContain('send("\\r", { beforeBytes:');
    expect(typing).toContain('send("\\u0003")');
    expect(typing).toContain('send("\\u0003", { withdrawPaste: true })');
  });
});
