import { PassThrough } from "node:stream";
import { StdioFrameDecoder } from "../stdio-framing.js";
import { EventEmitter } from "node:events";
import { McpGovernance } from "../mcp-governance.js";
import type { McpGovernancePolicy } from "../types.js";

/** Inject in-memory governance after loading default policy from a missing isolated path. */
export function governanceWithPolicy(policy: McpGovernancePolicy): McpGovernance {
  const gov = new McpGovernance("/nonexistent/mcp-policy.json");
  (gov as unknown as { policy: McpGovernancePolicy }).policy = policy;
  return gov;
}

export function stdioApproval(
  id: string,
  command: string,
  overrides: Partial<McpGovernancePolicy["servers"][number]> = {},
): McpGovernancePolicy["servers"][number] {
  return {
    id,
    name: id,
    status: "approved",
    transport: "stdio",
    allowedCommands: [command],
    requiredAuth: "none",
    tlsRequired: false,
    allowedCapabilities: ["tools"],
    maxTools: 16,
    toolNamePrefix: id,
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
    ...overrides,
  };
}

export function buildPolicy(
  approvals: McpGovernancePolicy["servers"],
): McpGovernancePolicy {
  return {
    version: "1.0-test",
    defaultPolicy: "deny",
    servers: approvals,
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      policyRefreshIntervalMs: 60_000,
    },
  };
}

/** Respond to complete newline-delimited requests; notifications receive no reply. */
export class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = {
    writable: true,
    write: (chunk: string) => {
      this.stdinBuffer += chunk;
      this.parseAndRespond();
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private stdinBuffer = "";

  responses: Record<string, (id: number) => unknown> = {};

  kill(_signal?: string): boolean {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }

  private parseAndRespond(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const lineEnd = this.stdinBuffer.indexOf("\n");
      if (lineEnd === -1) return;
      const body = this.stdinBuffer.slice(0, lineEnd);
      this.stdinBuffer = this.stdinBuffer.slice(lineEnd + 1);
      if (body.trim().length === 0) continue;
      try {
        const req = JSON.parse(body) as { method: string; id?: number };
        if (req.id === undefined) continue;
        const builder = this.responses[req.method];
        if (!builder) continue;
        const result = builder(req.id);
        const payload = JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
        const frame = `${payload}\n`;
        // Deliver after the client registers its pending request.
        queueMicrotask(() => this.stdout.write(frame));
      } catch {
      }
    }
  }
}

/** A per-call decoder detaches after one frame so sequential reads preserve pipe order. */
export function nextFramedMessage(
  stream: PassThrough,
): Promise<Record<string, unknown>> {
  const decoder = new StdioFrameDecoder(1024 * 1024);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const messages = decoder.push(chunk);
      if (messages.length > 0) {
        stream.off("data", onData);
        resolve(messages[0]);
      }
    };
    stream.on("data", onData);
  });
}
