/** Askpass tickets bind one git call to a host and source; other hosts never receive its token.
 * Tickets expire with the process, and private helper directories are reclaimed after crashes. */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarketplaceLogger } from "../log.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import { normalizeSourceHost } from "../net/source-url.js";

const log = createMarketplaceLogger("marketplace-askpass");

/** Token authentication requires a non-empty username. */
export const TOKEN_USERNAME = "x-access-token";

const MAX_REQUEST_BYTES = 16 * 1024;
const BROKER_DIR_PREFIX = "ave-askpass-";
const SOCKET_ROOT = "/tmp";
const SOCKET_DIR_PREFIX = "ave-ask-";
const OWNER_FILE = "owner.pid";
/** A directory with no readable owner yet may be one another process is still setting up. */
const UNCLAIMED_GRACE_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 5_000;

export interface AskpassTicket {
  env: Record<string, string>;
  credentialOffered(): boolean;
  revoke(): void;
}

interface TicketState {
  host: string;
  sourceId: string;
  credentialOffered: boolean;
}

export interface AskpassBrokerOptions {
  /** Stored tokens are host-scoped; source ids restrict preview tokens to that preview. */
  getToken(host: string, sourceId: string): string | null;
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
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

/** Null for non-credential prompts or URLs without a parseable host. */
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

/** `sun_path` holds 104 bytes on macOS (108 on Linux), the closing NUL included. */
const MAX_SOCKET_PATH_BYTES = 103;

/** Long Unix socket paths use a separate short private directory, removed with the broker. */
async function brokerEndpoint(dir: string, platform: NodeJS.Platform): Promise<{ endpoint: string; socketDir: string | null }> {
  if (platform === "win32") return { endpoint: `\\\\.\\pipe\\ave-askpass-${randomBytes(12).toString("hex")}`, socketDir: null };
  const inDir = join(dir, "broker.sock");
  if (Buffer.byteLength(inDir) <= MAX_SOCKET_PATH_BYTES) return { endpoint: inDir, socketDir: null };
  const socketDir = await mkdtemp(join(SOCKET_ROOT, SOCKET_DIR_PREFIX));
  await chmod(socketDir, 0o700);
  await claim(socketDir);
  return { endpoint: join(socketDir, "b.sock"), socketDir };
}

async function claim(dir: string): Promise<void> {
  // Written aside and renamed in, so a sweep never reads a half-written owner.
  await writeFileAtomicAtPath(join(dir, OWNER_FILE), String(process.pid));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Preserve directories owned by live or reused pids; leaking one is safer than deleting a live broker. */
async function leftBehind(dir: string, modifiedMs: number): Promise<boolean> {
  let owner: string;
  try {
    owner = await readFile(join(dir, OWNER_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Date.now() - modifiedMs > UNCLAIMED_GRACE_MS;
    throw error;
  }
  const pid = Number(owner.trim());
  // An empty or garbled owner is treated as no owner: removed only once the grace has passed.
  if (owner.trim() === "" || !Number.isSafeInteger(pid) || pid <= 0) return Date.now() - modifiedMs > UNCLAIMED_GRACE_MS;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

async function sweepLeftBehind(parent: string, prefix: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") log.warn({ parent, error: (error as Error).message }, "askpass: could not look for directories left by an earlier run");
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(parent, name);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
      if (!(await leftBehind(dir, info.mtimeMs))) continue;
      await rm(dir, { recursive: true, force: true });
      log.info({ dir }, "askpass: removed a directory left by an earlier run");
    } catch (error) {
      log.warn({ dir, error: (error as Error).message }, "askpass: could not remove a directory left by an earlier run");
    }
  }
}

export class AskpassBroker {
  private readonly tickets = new Map<string, TicketState>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    private readonly socketDir: string | null,
    readonly launcherPath: string,
    readonly endpoint: string,
    private readonly getToken: (host: string, sourceId: string) => string | null,
  ) {}

  static async start(options: AskpassBrokerOptions): Promise<AskpassBroker> {
    const platform = options.platform ?? process.platform;
    const parentDir = options.parentDir ?? tmpdir();
    await sweepLeftBehind(parentDir, BROKER_DIR_PREFIX);
    if (platform !== "win32") await sweepLeftBehind(SOCKET_ROOT, SOCKET_DIR_PREFIX);
    const dir = await mkdtemp(join(parentDir, BROKER_DIR_PREFIX));
    let socketDir: string | null = null;
    try {
      await chmod(dir, 0o700);
      await claim(dir);
      const helperPath = join(dir, "askpass-helper.cjs");
      const launcherPath = join(dir, platform === "win32" ? "askpass.cmd" : "askpass.sh");
      await writeFile(helperPath, HELPER_SOURCE, { mode: 0o600 });
      await writeFile(launcherPath, launcherSource(platform, options.nodeExecPath ?? process.execPath, helperPath), {
        mode: 0o700,
      });
      const listening = await brokerEndpoint(dir, platform);
      socketDir = listening.socketDir;
      const { endpoint } = listening;
      let broker: AskpassBroker | null = null;
      const server = createServer((socket) => broker?.handle(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      broker = new AskpassBroker(server, dir, socketDir, launcherPath, endpoint, options.getToken);
      return broker;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      if (socketDir) await rm(socketDir, { recursive: true, force: true });
      throw error;
    }
  }

  hasToken(host: string, sourceId: string): boolean {
    return this.getToken(host, sourceId) !== null;
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

  answer(ticketId: string, prompt: string): string {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return "";
    const asked = promptHost(prompt);
    if (!asked || asked.host !== ticket.host) return "";
    const token = this.getToken(ticket.host, ticket.sourceId);
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
    for (const dir of this.socketDir ? [this.dir, this.socketDir] : [this.dir]) {
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn({ error: (error as Error).message }, "askpass: failed to remove broker directory");
      });
    }
  }
}
