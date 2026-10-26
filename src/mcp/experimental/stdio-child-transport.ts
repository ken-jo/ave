/** Isolates plugin crashes behind stdio transport; exits reject pending calls.
 * Optional OS confinement wraps spawning and is separate from the process boundary. */
import { spawn, type ChildProcess } from "node:child_process";
import { frameMessage, StdioFrameDecoder } from "../stdio-framing.js";
import type { JsonRpcMessage, JsonRpcResponse, McpTransport } from "../mcp-client.js";
import { errorMessage } from "../../shared/error-message.js";

export interface StdioChildOptions {
  /** A mandatory line cap bounds untrusted stdout before decoding. */
  maxLineBytes: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Optional spawn confinement; absent wrappers provide process isolation only. */
  sandboxWrap?: (command: string, args: string[]) => { command: string; args: string[] };
}

export class StdioChildTransport implements McpTransport {
  readonly kind = "stdio" as const;

  private child: ChildProcess | null = null;
  private alive = false;
  private readonly decoder: StdioFrameDecoder;
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly options: StdioChildOptions,
  ) {
    this.decoder = new StdioFrameDecoder(options.maxLineBytes);
  }

  async open(): Promise<void> {
    const { command, args } = this.options.sandboxWrap
      ? this.options.sandboxWrap(this.command, this.args)
      : { command: this.command, args: this.args };

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;

    child.stdout?.on("data", (chunk: Buffer) => {
      let messages: Array<Record<string, unknown>>;
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        // The child broke the framing; it is ended, not resynchronised.
        this.fail(`child framing violated: ${errorMessage(error)}`);
        child.kill("SIGKILL");
        return;
      }
      for (const message of messages) {
        this.messageHandler?.(message as unknown as JsonRpcResponse);
      }
    });
    child.on("exit", (code, signal) => this.fail(`child exited code=${code} signal=${signal}`));
    child.on("error", (err) => this.fail(`child error: ${err.message}`));
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.alive || !this.child?.stdin) {
      throw new Error("[stdio-child] transport not open");
    }
    this.child.stdin.write(frameMessage(message));
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.child?.kill("SIGTERM");
    this.closeHandler?.("closed");
  }

  isAlive(): boolean {
    return this.alive;
  }

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  private fail(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.closeHandler?.(reason);
  }
}
