// Windows sandbox runners lack usable stdin, so the child announces a loopback listener and nonce over stdout.
// Both peers require 127.0.0.1 and mutual HMACs bound to their socket four-tuple; never send the nonce over the socket or log it.
// Apply encoded environment before imports; relay mode stays in the same confinement and gives unmodified programs real stdin.
import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PassThrough, type Readable, type Writable } from "node:stream";

/** Selects the loopback channel in `plugin-child-main.ts`. Absent: stdio. */
export const CHILD_LOOPBACK_TRANSPORT_ARG = "--ave-child-transport=loopback";
/** Selects the stdio relay in `plugin-child-main.ts`; stands alone. */
export const CHILD_RELAY_TRANSPORT_ARG = "--ave-child-transport=relay";
/** Carries the child's intended environment, base64url JSON. */
export const CHILD_ENV_ARG_PREFIX = "--ave-child-env=";
/** The one stdout line the child writes before the connection exists. */
const CHILD_LISTEN_ANNOUNCE = "AVE-CHILD-LISTEN";

const NONCE_BYTES = 32;
const NONCE_HEX_LENGTH = NONCE_BYTES * 2;
/** An HMAC-SHA256 proof, hex. */
const PROOF_HEX_LENGTH = 64;
/** Peers the child drops before it gives up waiting for the host. */
const MAX_REFUSED_PEERS = 8;
/** Handshakes the child runs at once; a peer beyond them is dropped. */
const MAX_PENDING_HANDSHAKES = 4;

/** The one address both ends of the channel use: the child listens on it, the host dials from it. */
const LOOPBACK_ADDRESS = "127.0.0.1";
/** Connect attempts the host makes: the child may drop its first for want of a handshake slot. */
const HOST_CONNECT_ATTEMPTS = 2;
/** How long the host waits before its second attempt, for a slot to free. */
const HOST_RETRY_DELAY_MS = 500;

/** One end of a TCP connection, as a socket reports it, IPv4-mapped addresses unmapped. */
interface Endpoint {
  readonly address: string;
  readonly port: number;
}

function endpoints(socket: Socket): { readonly local: Endpoint; readonly remote: Endpoint } | undefined {
  const { localAddress, localPort, remoteAddress, remotePort } = socket;
  if (localAddress === undefined || localPort === undefined || remoteAddress === undefined || remotePort === undefined) {
    return undefined;
  }
  const unmapped = (address: string): string => address.replace(/^::ffff:/i, "");
  return {
    local: { address: unmapped(localAddress), port: localPort },
    remote: { address: unmapped(remoteAddress), port: remotePort },
  };
}

/** Bind each HMAC proof to nonce and both address/port endpoints in sender-first order. */
function loopbackProof(nonce: string, side: "host" | "child", own: Endpoint, peer: Endpoint): Buffer {
  return createHmac("sha256", Buffer.from(nonce, "hex"))
    .update(`ave-loopback ${side} ${own.address} ${own.port} ${peer.address} ${peer.port}`)
    .digest();
}

function proofMatches(presented: Buffer, expected: Buffer): boolean {
  if (presented.length !== PROOF_HEX_LENGTH || !/^[0-9a-f]+$/.test(presented.toString("latin1"))) return false;
  return timingSafeEqual(Buffer.from(presented.toString("latin1"), "hex"), expected);
}
/** Longest stdout the host reads looking for the announce before refusing. */
const ANNOUNCE_SCAN_LIMIT = 4096;
const ANNOUNCE_RE = new RegExp(`^${CHILD_LISTEN_ANNOUNCE} ([0-9]{1,5}) ([0-9a-f]{${NONCE_HEX_LENGTH}})$`);

/** The child's environment, as one command-line-inert argument. */
export function encodeChildEnv(env: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(env)) assertEnvPair(name, value);
  return CHILD_ENV_ARG_PREFIX + Buffer.from(JSON.stringify(env), "utf-8").toString("base64url");
}

// Environment names must be nonempty without = or NUL; values must be strings without NUL.
// They travel as JSON, so platform-valid names need no shell restrictions.
function assertEnvPair(name: string, value: unknown): asserts value is string {
  if (name.length === 0 || name.includes("=") || name.includes("\0")) {
    throw new Error(`[child-loopback-link] '${name}' is not an environment variable name`);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`[child-loopback-link] the value of '${name}' is not a string an environment can hold`);
  }
}

/** What the child was launched to do, read from its own argv. */
export type ChildLaunchMode =
  | { readonly transport: "stdio" }
  | { readonly transport: "loopback"; readonly env: Readonly<Record<string, string>> }
  | { readonly transport: "relay" };

/** No channel arguments means stdio; otherwise accept exactly one complete supported argument form. */
export function parseChildLaunchArgs(args: readonly string[]): ChildLaunchMode {
  if (args.includes(CHILD_RELAY_TRANSPORT_ARG)) {
    if (args.length !== 1) {
      throw new Error("[child-loopback-link] the relay transport takes no other child argument");
    }
    return { transport: "relay" };
  }
  if (!args.some((arg) => arg === CHILD_LOOPBACK_TRANSPORT_ARG || arg.startsWith(CHILD_ENV_ARG_PREFIX))) {
    return { transport: "stdio" };
  }
  let loopback = false;
  let encoded: string | undefined;
  for (const arg of args) {
    if (arg === CHILD_LOOPBACK_TRANSPORT_ARG && !loopback) {
      loopback = true;
    } else if (arg.startsWith(CHILD_ENV_ARG_PREFIX) && encoded === undefined) {
      encoded = arg.slice(CHILD_ENV_ARG_PREFIX.length);
    } else {
      throw new Error(`[child-loopback-link] unexpected child argument '${arg.slice(0, 64)}'`);
    }
  }
  if (!loopback || encoded === undefined) {
    throw new Error("[child-loopback-link] the loopback transport and its environment argument come together");
  }
  return { transport: "loopback", env: decodeChildEnv(encoded) };
}

function decodeChildEnv(encoded: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
    throw new Error("[child-loopback-link] the environment argument is not base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch {
    throw new Error("[child-loopback-link] the environment argument is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[child-loopback-link] the environment argument is not an object");
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    assertEnvPair(name, value);
    env[name] = value;
  }
  return env;
}

/** Authenticate one loopback peer, close the listener on success or failure, and bound handshake time and peers. */
export function acceptHostOverLoopback(opts: {
  readonly announce: (line: string) => void;
  readonly acceptTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
}): Promise<Socket> {
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let refused = 0;
    const pending = new Set<Socket>();
    const server = createServer();
    const finish = (error: Error | undefined, socket?: Socket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptTimer);
      server.close();
      for (const other of pending) {
        if (other !== socket) other.destroy();
      }
      pending.clear();
      if (error !== undefined) reject(error);
      else resolve(socket!);
    };
    const acceptTimer = setTimeout(
      () => finish(new Error("[child-loopback-link] the host did not connect and authenticate in time")),
      opts.acceptTimeoutMs,
    );
    const refuse = (socket: Socket): void => {
      socket.destroy();
      pending.delete(socket);
      refused += 1;
      if (refused >= MAX_REFUSED_PEERS) {
        finish(new Error(`[child-loopback-link] ${refused} peers failed to authenticate; giving up on the host`));
      }
    };
    server.on("error", (error) => finish(error));
    server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      if (settled || pending.size >= MAX_PENDING_HANDSHAKES) {
        socket.destroy();
        if (!settled) refuse(socket);
        return;
      }
      // Only the designated loopback source address may authenticate as host.
      const ends = endpoints(socket);
      if (ends === undefined || ends.remote.address !== LOOPBACK_ADDRESS || ends.local.address !== LOOPBACK_ADDRESS) {
        refuse(socket);
        return;
      }
      pending.add(socket);
      let received = Buffer.alloc(0);
      const handshakeTimer = setTimeout(() => refuse(socket), opts.handshakeTimeoutMs);
      const done = (): void => {
        clearTimeout(handshakeTimer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        const newline = received.indexOf(0x0a);
        if (newline === -1) {
          if (received.length > PROOF_HEX_LENGTH) {
            done();
            refuse(socket);
          }
          return;
        }
        done();
        if (settled || !proofMatches(received.subarray(0, newline), loopbackProof(nonce, "host", ends.remote, ends.local))) {
          refuse(socket);
          return;
        }
        socket.pause();
        const rest = received.subarray(newline + 1);
        if (rest.length > 0) socket.unshift(rest);
        socket.write(`${loopbackProof(nonce, "child", ends.local, ends.remote).toString("hex")}\n`);
        pending.delete(socket);
        finish(undefined, socket);
      };
      const onError = (): void => {
        done();
        refuse(socket);
      };
      const onClose = (): void => {
        done();
        if (pending.has(socket)) refuse(socket);
      };
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        finish(new Error("[child-loopback-link] the listener has no TCP address"));
        return;
      }
      try {
        opts.announce(`${CHILD_LISTEN_ANNOUNCE} ${address.port} ${nonce}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Read announce, authenticate both connection endpoints and skip only pre-announce blank lines. */
export function connectToAnnouncedChild(opts: {
  readonly stdout: Readable;
  readonly exited: Promise<string>;
  readonly timeoutMs: number;
}): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let scanned = "";
    let socket: Socket | undefined;
    let announced = false;
    let attempts = 0;
    let retryTimer: NodeJS.Timeout | undefined;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      opts.stdout.off("data", onData);
      if (error !== undefined) {
        socket?.destroy();
        reject(error);
      } else {
        socket!.removeAllListeners("error");
        resolve(socket!);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("[child-loopback-link] the child did not announce and authenticate its listener in time")),
      opts.timeoutMs,
    );
    void opts.exited.then((reason) =>
      finish(new Error(`[child-loopback-link] the child ended before its channel was connected: ${reason}`)));
    const dropped = (connected: Socket, error: Error, port: number, nonce: string): void => {
      if (settled || connected !== socket) return;
      connected.destroy();
      if (attempts >= HOST_CONNECT_ATTEMPTS) {
        finish(error);
        return;
      }
      retryTimer = setTimeout(() => {
        if (!settled) dial(port, nonce);
      }, HOST_RETRY_DELAY_MS);
    };
    const authenticate = (connected: Socket, nonce: string, port: number): void => {
      if (settled || connected !== socket) return;
      const ends = endpoints(connected);
      if (ends === undefined || ends.local.address !== LOOPBACK_ADDRESS || ends.remote.address !== LOOPBACK_ADDRESS) {
        finish(new Error("[child-loopback-link] the connection is not between loopback addresses"));
        return;
      }
      const expected = loopbackProof(nonce, "child", ends.remote, ends.local);
      // Read the proof while paused so bytes after it remain for the first protocol reader.
      let received = Buffer.alloc(0);
      const onReadable = (): void => {
        if (settled || connected !== socket) return;
        for (;;) {
          const chunk = connected.read() as Buffer | null;
          if (chunk === null) return;
          received = Buffer.concat([received, chunk]);
          const newline = received.indexOf(0x0a);
          if (newline === -1) {
            if (received.length > PROOF_HEX_LENGTH) {
              finish(new Error("[child-loopback-link] the peer did not answer with the child's proof"));
              return;
            }
            continue;
          }
          connected.off("readable", onReadable);
          connected.off("end", onEnd);
          if (!proofMatches(received.subarray(0, newline), expected)) {
            finish(new Error("[child-loopback-link] the peer did not answer with the child's proof"));
            return;
          }
          const rest = received.subarray(newline + 1);
          if (rest.length > 0) connected.unshift(rest);
          finish(undefined);
          return;
        }
      };
      const onEnd = (): void => dropped(
        connected,
        new Error("[child-loopback-link] the peer closed before answering with the child's proof"),
        port,
        nonce,
      );
      connected.on("readable", onReadable);
      connected.on("end", onEnd);
      connected.write(`${loopbackProof(nonce, "host", ends.local, ends.remote).toString("hex")}\n`);
    };
    const dial = (port: number, nonce: string): void => {
      attempts += 1;
      let established = false;
      const connected = connect({ host: LOOPBACK_ADDRESS, port, localAddress: LOOPBACK_ADDRESS }, () => {
        established = true;
        authenticate(connected, nonce, port);
      });
      socket = connected;
      connected.on("error", (error: Error) => {
        // Retry handshake resets, never a connect that reached no listener.
        if (established) dropped(connected, error, port, nonce);
        else if (connected === socket) finish(error);
      });
    };
    const onData = (chunk: Buffer): void => {
      if (announced) return;
      scanned += chunk.toString("utf-8");
      for (;;) {
        const newline = scanned.indexOf("\n");
        if (newline === -1) break;
        const line = scanned.slice(0, newline).replace(/\r$/, "");
        scanned = scanned.slice(newline + 1);
        if (line.trim() === "") continue;
        const match = ANNOUNCE_RE.exec(line);
        if (match === null) {
          finish(new Error("[child-loopback-link] the child wrote something other than its announce first"));
          return;
        }
        const port = Number(match[1]);
        if (port < 1 || port > 65_535) {
          finish(new Error("[child-loopback-link] the child announced an impossible port"));
          return;
        }
        announced = true;
        dial(port, match[2]!);
        return;
      }
      if (scanned.length > ANNOUNCE_SCAN_LIMIT) {
        finish(new Error("[child-loopback-link] the child's stdout ran on without an announce"));
      }
    };
    opts.stdout.on("data", onData);
  });
}

/** Validate the authenticated relay request on both ends; malformed requests terminate the relay. */
export interface RelayRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

const RELAY_REQUEST_LIMIT = 1024 * 1024;
const RELAY_START_FAILED_EXIT = 127;

/** Windows treats .cmd/.bat case-insensitively and ignores trailing dots or spaces. */
const BATCH_FILE_RE = /\.(?:cmd|bat)[. ]*$/i;

/** Refuse batch files: launching them requires a command shell that would reinterpret manifest bytes. */
export function batchFileRefusal(command: string): Error {
  return new Error(
    `[child-loopback-link] '${command}' is a batch file (.cmd/.bat); a sandboxed Windows program `
      + "cannot be one, since only cmd.exe runs it and that would parse the program's arguments. "
      + "Name the executable it starts instead (for npx: node.exe with npm's npx-cli.js).",
  );
}

export function assertRelayRequest(value: unknown): asserts value is RelayRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[child-loopback-link] the relay request is not an object");
  }
  const { command, args, env, cwd, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error(`[child-loopback-link] the relay request has an unknown field '${Object.keys(rest)[0]}'`);
  }
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw new Error("[child-loopback-link] the relay request names no program");
  }
  if (BATCH_FILE_RE.test(command)) throw batchFileRefusal(command);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("[child-loopback-link] the relay request's arguments are not strings");
  }
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("[child-loopback-link] the relay request's environment is not an object");
  }
  for (const [name, entry] of Object.entries(env)) assertEnvPair(name, entry);
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0"))) {
    throw new Error("[child-loopback-link] the relay request's working directory is not a path");
  }
}

function encodeRelayRequest(request: RelayRequest): string {
  assertRelayRequest(request);
  const line = `${JSON.stringify({
    command: request.command,
    args: [...request.args],
    env: { ...request.env },
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
  })}\n`;
  if (Buffer.byteLength(line, "utf-8") > RELAY_REQUEST_LIMIT) {
    throw new Error(`[child-loopback-link] the relay request is over ${RELAY_REQUEST_LIMIT} bytes`);
  }
  return line;
}

/** Buffer stdin until relay authentication; terminate by closing the channel, not by signaling a PID. */
export function relayStdioOverLoopback(opts: {
  readonly stdout: Readable;
  readonly exited: Promise<string>;
  readonly request: RelayRequest;
  readonly timeoutMs: number;
  readonly onFailure: (error: Error) => void;
}): { readonly stdin: Writable; readonly stdout: Readable } {
  const requestLine = encodeRelayRequest(opts.request);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  connectToAnnouncedChild({ stdout: opts.stdout, exited: opts.exited, timeoutMs: opts.timeoutMs }).then(
    (socket) => {
      // Attach before sending the launch request; no program output can exist yet.
      opts.stdout.pipe(stdout);
      socket.on("error", () => undefined);
      socket.once("close", () => {
        stdin.unpipe(socket);
        stdin.resume();
      });
      socket.write(requestLine);
      stdin.pipe(socket);
    },
    (error: unknown) => {
      stdin.resume();
      stdout.end();
      opts.onFailure(error instanceof Error ? error : new Error(String(error)));
    },
  );
  return { stdin, stdout };
}

/** Read exactly one request line, leaving protocol bytes after it untouched. */
function readRelayRequest(socket: Socket, timeoutMs: number): Promise<RelayRequest> {
  return new Promise<RelayRequest>((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const done = (error: Error | undefined, request?: RelayRequest): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onClosed);
      socket.off("close", onClosed);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
      } else {
        resolve(request!);
      }
    };
    const timer = setTimeout(
      () => done(new Error("[child-loopback-link] the host sent no relay request in time")),
      timeoutMs,
    );
    const onClosed = (): void => done(new Error("[child-loopback-link] the host left before its relay request"));
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) {
        if (received.length > RELAY_REQUEST_LIMIT) {
          done(new Error(`[child-loopback-link] the relay request is over ${RELAY_REQUEST_LIMIT} bytes`));
        }
        return;
      }
      socket.pause();
      const rest = received.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, newline).toString("utf-8"));
        assertRelayRequest(parsed);
      } catch (error) {
        done(error instanceof SyntaxError
          ? new Error("[child-loopback-link] the relay request is not JSON")
          : error instanceof Error ? error : new Error(String(error)));
        return;
      }
      done(undefined, parsed);
    };
    socket.on("data", onData);
    socket.on("end", onClosed);
    socket.on("close", onClosed);
    socket.resume();
  });
}

/** Relay input to the child program and use channel EOF as its host-liveness signal. */
export async function serveStdioRelay(opts: {
  readonly announce: (line: string) => void;
  readonly acceptTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly relayEnv: NodeJS.ProcessEnv;
  readonly diagnostics: Writable;
}): Promise<number> {
  const socket = await acceptHostOverLoopback(opts);
  socket.on("error", () => undefined);
  const request = await readRelayRequest(socket, opts.handshakeTimeoutMs);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.relayEnv)) {
    if (value !== undefined && name.toLowerCase() !== "electron_run_as_node") env[name] = value;
  }
  for (const [name, value] of Object.entries(request.env)) {
    for (const inherited of Object.keys(env)) {
      if (inherited.toLowerCase() === name.toLowerCase()) delete env[inherited];
    }
    env[name] = value;
  }
  return new Promise<number>((resolve) => {
    const couldNotStart = (error: Error): void => {
      opts.diagnostics.write(`[plugin-child] relay could not start '${request.command}': ${error.message}\n`);
      socket.destroy();
      resolve(RELAY_START_FAILED_EXIT);
    };
    // Report synchronous launch failures on stderr; batch files must already have been refused.
    const program = spawn(request.command, [...request.args], {
      env,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
      shell: false,
    });
    program.stdin!.on("error", () => undefined);
    program.once("error", couldNotStart);
    program.once("exit", (code) => {
      socket.destroy();
      resolve(code ?? 1);
    });
    socket.once("close", () => program.stdin!.end());
    socket.pipe(program.stdin!);
  });
}
