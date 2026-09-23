/**
 * The askpass broker (design §9.3).
 *
 * git asks for credentials by running `GIT_ASKPASS "<prompt>"` and reading
 * one line from its stdout. Ave points `GIT_ASKPASS` at a tiny helper that
 * forwards the prompt, together with a ticket, to this broker over a local
 * socket, and prints the broker's answer.
 *
 * A ticket is created for one `runGit` call and bound to one
 * (normalized host, source id). The broker answers with the stored token
 * only when git's prompt names that same host, so a redirect or a submodule
 * URL pointing somewhere else gets an empty answer, never the token. Tickets
 * are revoked when the git process exits.
 *
 * The helper runs as the app binary in Node mode (`ELECTRON_RUN_AS_NODE`),
 * so nothing extra ships with the app: the broker writes the helper script
 * and a launcher into a fresh `0700` directory when it starts and deletes
 * the directory when it closes.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { normalizeSourceHost } from "../net/source-url.js";

const log = createLogger("marketplace-askpass");

/** Username sent with a token; GitHub, GitLab and Gitea accept any non-empty name. */
export const TOKEN_USERNAME = "x-access-token";

const MAX_REQUEST_BYTES = 16 * 1024;
const CONNECTION_TIMEOUT_MS = 5_000;

export interface AskpassTicket {
  /** Environment for the git child: `AVE_ASKPASS_TICKET` and `AVE_ASKPASS_ENDPOINT`. */
  env: Record<string, string>;
  /** True once the broker has answered a password prompt with a token for this ticket. */
  credentialOffered(): boolean;
  revoke(): void;
}

interface TicketState {
  host: string;
  sourceId: string;
  credentialOffered: boolean;
}

export interface AskpassBrokerOptions {
  /** Stored token for a normalized host, or null. */
  getToken(host: string): string | null;
  /** Binary that runs the helper in Node mode; defaults to `process.execPath`. */
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
  /** Parent of the broker's private directory; defaults to the OS temp dir. */
  parentDir?: string;
}

const HELPER_SOURCE = `"use strict";
const net = require("node:net");
const endpoint = process.env.AVE_ASKPASS_ENDPOINT;
const ticket = process.env.AVE_ASKPASS_TICKET;
if (!endpoint || !ticket) process.exit(1);
let data = "";
const socket = net.createConnection(endpoint);
socket.setEncoding("utf8");
socket.setTimeout(${CONNECTION_TIMEOUT_MS}, () => { socket.destroy(); process.exit(1); });
socket.on("connect", () => {
  socket.write(JSON.stringify({ ticket, prompt: String(process.argv[2] || "") }) + "\\n");
});
socket.on("data", (chunk) => {
  data += chunk;
  if (data.length > ${MAX_REQUEST_BYTES}) { socket.destroy(); process.exit(1); }
});
socket.on("end", () => {
  let answer;
  try { answer = JSON.parse(data).answer; } catch { process.exit(1); }
  if (typeof answer !== "string") process.exit(1);
  process.stdout.write(answer + "\\n");
});
socket.on("error", () => process.exit(1));
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function launcherSource(platform: NodeJS.Platform, execPath: string, helperPath: string): string {
  if (platform === "win32") {
    if (/["%\r\n]/u.test(execPath) || /["%\r\n]/u.test(helperPath)) {
      throw new Error("askpass launcher paths must not contain quotes, percent signs or newlines");
    }
    return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${execPath}" "${helperPath}" %*\r\n`;
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\nexec ${shellQuote(execPath)} ${shellQuote(helperPath)} "$@"\n`;
}

/**
 * The host a git credential prompt names, e.g. `Password for
 * 'https://x-access-token@github.com': ` → `github.com`. Null when the prompt
 * is not a credential prompt or names no parsable URL.
 */
export function promptHost(prompt: string): { field: "username" | "password"; host: string } | null {
  const match = /^(Username|Password) for '([^']+)'/u.exec(prompt);
  if (!match) return null;
  try {
    const url = new URL(match[2]!);
    return {
      field: match[1] === "Username" ? "username" : "password",
      host: normalizeSourceHost(match[2]!, url.hostname),
    };
  } catch {
    return null;
  }
}

export class AskpassBroker {
  private readonly tickets = new Map<string, TicketState>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    readonly launcherPath: string,
    readonly endpoint: string,
    private readonly getToken: (host: string) => string | null,
  ) {}

  static async start(options: AskpassBrokerOptions): Promise<AskpassBroker> {
    const platform = options.platform ?? process.platform;
    const dir = await mkdtemp(join(options.parentDir ?? tmpdir(), "ave-askpass-"));
    try {
      await chmod(dir, 0o700);
      const helperPath = join(dir, "askpass-helper.cjs");
      const launcherPath = join(dir, platform === "win32" ? "askpass.cmd" : "askpass.sh");
      await writeFile(helperPath, HELPER_SOURCE, { mode: 0o600 });
      await writeFile(launcherPath, launcherSource(platform, options.nodeExecPath ?? process.execPath, helperPath), {
        mode: 0o700,
      });
      const endpoint = platform === "win32"
        ? `\\\\.\\pipe\\ave-askpass-${randomBytes(12).toString("hex")}`
        : join(dir, "broker.sock");
      let broker: AskpassBroker | null = null;
      const server = createServer((socket) => broker?.handle(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      broker = new AskpassBroker(server, dir, launcherPath, endpoint, options.getToken);
      return broker;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  issueTicket(binding: { host: string; sourceId: string }): AskpassTicket {
    if (this.closed) throw new Error("askpass broker is closed");
    const id = randomBytes(32).toString("base64url");
    const state: TicketState = { host: binding.host, sourceId: binding.sourceId, credentialOffered: false };
    this.tickets.set(id, state);
    return {
      env: { AVE_ASKPASS_TICKET: id, AVE_ASKPASS_ENDPOINT: this.endpoint },
      credentialOffered: () => state.credentialOffered,
      revoke: () => {
        this.tickets.delete(id);
      },
    };
  }

  /** Exposed for tests: the answer the broker gives for a ticket and prompt. */
  answer(ticketId: string, prompt: string): string {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return "";
    const asked = promptHost(prompt);
    if (!asked || asked.host !== ticket.host) return "";
    const token = this.getToken(ticket.host);
    if (!token) return "";
    if (asked.field === "username") return TOKEN_USERNAME;
    ticket.credentialOffered = true;
    return token;
  }

  private handle(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let answer = "";
      try {
        const request = JSON.parse(buffer.slice(0, newline)) as { ticket?: unknown; prompt?: unknown };
        if (typeof request.ticket === "string" && typeof request.prompt === "string") {
          answer = this.answer(request.ticket, request.prompt);
        }
      } catch {
        answer = "";
      }
      socket.end(`${JSON.stringify({ answer })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.tickets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.dir, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn({ error: (error as Error).message }, "askpass: failed to remove broker directory");
    });
  }
}
