import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export class RuntimeProcessFixture extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = -1;
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    return true;
  });
}
