import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export function createPolicyPipeHelper(child: ChildProcess) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  return { child, stdin, stdout, stderr, kill };
}
