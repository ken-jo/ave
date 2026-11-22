import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export function gitProbeChild(start: (complete: (stdout: string, exitCode?: number | null) => void) => void): ReturnType<typeof spawn> {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
  let completed = false;
  queueMicrotask(() => start((stdout, exitCode = 0) => {
    if (completed) return;
    completed = true;
    child.stdout.end(stdout);
    child.emit("close", exitCode);
  }));
  return child as unknown as ReturnType<typeof spawn>;
}
