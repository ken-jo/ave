import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { backgroundShellManager, BashTool, controlShellTask, listShellTasks } from "../shell-tools.js";

describe.skipIf(process.platform === "win32")("running shell task handoff", () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-task-"))); });
  afterEach(async () => {
    backgroundShellManager.disposeSession(dir);
    await backgroundShellManager.waitForLocalCleanup(dir);
    await cleanupTmpDir(dir);
  });

  function start(command: string, timeoutSeconds = 5, signal?: AbortSignal) {
    return new BashTool().execute({ command, timeoutSeconds }, {
      cwd: dir, extraAllowedDirectories: [], metadata: { sessionId: dir }, abortSignal: signal,
    });
  }

  it("adopts the running process once and lists output without consuming the model cursor", async () => {
    const controller = new AbortController();
    const pending = start("printf x >> count; printf before; sleep 0.3; printf after", 5, controller.signal);
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("before"));
    const task = listShellTasks(dir)[0];
    expect(controlShellTask(`${dir}-other`, "background", task.shellId)).toEqual({ ok: false, error: "shell-not-found" });
    expect(controlShellTask(dir, "background", task.shellId).ok).toBe(true);
    const result = await pending;
    expect(result.metadata?.backgrounded).toBe(true);
    const shellId = result.metadata?.shellId as string;
    controller.abort();
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.status).toBe("exited"));
    expect(readFileSync(join(dir, "count"), "utf8")).toBe("x");
    expect(listShellTasks(dir)[0]?.output).toContain("beforeafter");
    expect(listShellTasks(dir)[0]?.output).toContain("beforeafter");
    expect(backgroundShellManager.read(dir, shellId)?.output).toContain("beforeafter");
    expect(backgroundShellManager.read(dir, shellId)?.output).toBe("");
    expect(listShellTasks(dir)[0]?.output).not.toContain("AVE_CWD");
  });

  it("retains the original deadline after the foreground result settles", async () => {
    const pending = start("printf ready; sleep 8", 1);
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("ready"));
    expect(controlShellTask(dir, "background").ok).toBe(true);
    await pending;
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.status).toBe("killed"), { timeout: 2_000 });
  });

  it("retains raw output across handoff while bounding non-consuming UI previews", async () => {
    const pending = start("yes x | head -c 20000; printf ready; sleep 0.5; printf tail");
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("ready"));
    expect(listShellTasks(dir)[0]?.output.length).toBeLessThanOrEqual(4_000);
    expect(listShellTasks(dir)[0]?.outputTruncated).toBe(true);
    const transfer = controlShellTask(dir, "background");
    expect(transfer.ok).toBe(true);
    await pending;
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.status).toBe("exited"));
    if (!transfer.ok) throw new Error("handoff refused");
    const output = backgroundShellManager.read(dir, transfer.shellId)?.output;
    expect(output).toBe("x\n".repeat(10_000) + "readytail");
    expect(listShellTasks(dir)[0]?.output).toContain("readytail");
  });

  it("keeps split multibyte output independent across stdout and stderr", async () => {
    const pending = start("printf '\\360\\237'; sleep 0.05; printf err >&2; sleep 0.05; printf '\\230\\200ready'; sleep 0.4; printf done");
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("ready"));
    const result = controlShellTask(dir, "background");
    await pending;
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.status).toBe("exited"));
    if (!result.ok) throw new Error("handoff refused");
    expect(backgroundShellManager.read(dir, result.shellId)?.output).toBe("err😀readydone");
  });

  it("keeps stop and session disposal within their owning session", async () => {
    const pending = start("printf ready; sleep 8");
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("ready"));
    expect(controlShellTask(dir, "background").ok).toBe(true);
    const shellId = (await pending).metadata?.shellId as string;
    expect(controlShellTask(`${dir}-other`, "stop", shellId)).toEqual({ ok: false, error: "shell-not-found" });
    expect(controlShellTask(dir, "stop", shellId).ok).toBe(true);
    expect(listShellTasks(dir)[0]?.status).toBe("killed");
    expect(backgroundShellManager.read(dir, shellId)?.output).toContain("ready");
  });

  it("retains foreground cancellation if a new lifecycle owner refuses the handoff", async () => {
    const controller = new AbortController();
    const pending = start("printf ready; sleep 8", 5, controller.signal);
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.output).toContain("ready"));
    const register = vi.spyOn(backgroundShellManager, "register").mockImplementationOnce(() => { throw new Error("admission closed"); });
    try {
      expect(controlShellTask(dir, "background")).toEqual({ ok: false, error: "background-unavailable" });
      expect(listShellTasks(dir)[0]?.backgrounded).toBe(false);
      controller.abort();
      expect((await pending).metadata?.aborted).toBe(true);
    } finally { register.mockRestore(); }
  });

  it("settles the transferred result even when foreground capture publication fails", async () => {
    const finish = vi.fn(async () => { throw new Error("capture unavailable"); });
    const pending = new BashTool().execute({ command: "yes x | head -c 20000; sleep 1", timeoutSeconds: 5 }, {
      cwd: dir, extraAllowedDirectories: [], metadata: {
        sessionId: dir,
        toolOutputCaptureFactory: () => ({ captureId: "capture", append: () => true, waitForDrain: async () => {}, finish }),
      },
    });
    await vi.waitFor(() => expect(listShellTasks(dir)[0]?.outputTruncated).toBe(true));
    expect(controlShellTask(dir, "background").ok).toBe(true);
    expect((await pending).metadata).toMatchObject({ backgrounded: true, outputCaptureFailed: true });
    expect(finish).toHaveBeenCalledOnce();
  });
});
