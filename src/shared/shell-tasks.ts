export const SHELL_TASK_OUTPUT_PREVIEW_CHARS = 4_000;

/** Session-owned command snapshots. Reading a snapshot never consumes tool output. */
export interface ShellTask {
  shellId: string;
  command: string;
  startedAt: string;
  status: "running" | "exited" | "killed" | "failed";
  backgrounded: boolean;
  canBackground: boolean;
  canStop: boolean;
  output: string;
  outputTruncated: boolean;
}

export type ShellTaskAction = "background" | "stop";
export type ShellTaskActionResult =
  | { ok: true; shellId: string }
  | { ok: false; error: "shell-not-found" | "background-unavailable" | "invalid-shell-action" | "unauthorized-frame" | "session-changed" };
