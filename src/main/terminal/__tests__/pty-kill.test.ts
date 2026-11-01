import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { killPty } from "../pty-kill.js";

describe("PTY termination signals", () => {
  it("routes every manager termination site through the platform helper", () => {
    const source = readFileSync(new URL("../pty-manager.ts", import.meta.url), "utf8");
    expect(source).toContain('import { killPty } from "./pty-kill.js"');
    expect(source).not.toMatch(/\.\s*kill\s*(?:\?\.)?\s*\(/);
    expect([...source.matchAll(/\bkillPty\(([^)]*)\)/g)].map(match => match[1])).toEqual([
      'trampoline, "SIGKILL"',
      'pty, "SIGKILL"',
      'pty, "SIGKILL"',
      "session.pty",
      'session.pty, "SIGKILL"',
      'session.pty, "SIGKILL"',
    ]);
  });

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
