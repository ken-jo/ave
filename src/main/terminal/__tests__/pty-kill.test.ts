import { describe, expect, it, vi } from "vitest";
import { killPty } from "../pty-kill.js";

describe("PTY termination signals", () => {
  it.each([undefined, "SIGTERM", "SIGKILL"])("omits %s on Windows", signal => {
    const pty = { kill: vi.fn() };
    killPty(pty, signal, "win32");
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["darwin", "linux"] as const)("preserves forced termination on %s", platform => {
    const pty = { kill: vi.fn() };
    killPty(pty, "SIGKILL", platform);
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("preserves graceful termination without a signal", () => {
    const pty = { kill: vi.fn() };
    killPty(pty, undefined, "linux");
    expect(pty.kill).toHaveBeenCalledExactlyOnceWith();
  });
});
