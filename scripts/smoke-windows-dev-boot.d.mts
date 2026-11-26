import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export function createDevBootDirectories(jobRoot: string | undefined): {
  root: string;
  home: string;
  profile: string;
};

export function checkDevBoot(
  child: EventEmitter & { stdout: Readable; stderr: Readable },
  requestQuit: (url: string, signal: AbortSignal) => Promise<void>,
  options?: {
    bootTimeoutMs?: number;
    quitTimeoutMs?: number;
    onLine?: (line: string) => void;
    onRawLine?: (stream: "stdout" | "stderr", line: string) => void;
  },
): Promise<void>;
