/**
 * The Windows sandboxed plugin child's protocol channel: one authenticated
 * loopback TCP connection instead of the child's stdin and stdout.
 *
 * WHY NOT STDIO. ASRT 0.0.76's `srt-win exec` starts the target as the
 * `srt-sandbox` account through a two-hop runner that relays the target's
 * stdout but no stdin: `echo hi | srt-win exec -- cmd /c more` prints nothing
 * (measured on a provisioned Windows 11 host, 2026-10-10). The plugin protocol
 * is framed in both directions, so on that path the host's half has nowhere to
 * go. macOS and Linux keep stdio; nothing here runs there.
 *
 * WHY THIS SHAPE. srt-win's WFP filters refuse an outbound connect from the
 * `srt-sandbox` account except to the proxy port range, so the child cannot
 * dial the host; an inbound connect from the host to a loopback listener the
 * child opened is admitted (measured, same host — the model a Windows worker's
 * TCP control channel already relies on). So the child listens on
 * `127.0.0.1:0`, announces the port and a fresh nonce on its stdout — the one
 * channel srt-win does relay, and one only the host reads — and accepts exactly
 * one connection: the first peer to send the nonce. It closes the listener on
 * that first connection whatever the peer sends, so no listener outlives the
 * handshake, and a wrong nonce ends the child rather than letting it wait for
 * another try. The nonce authenticates the HOST to the child: a local process
 * that found the port first can only make this load fail, never speak for the
 * host. It is never logged on either side.
 *
 * WHY THE ENVIRONMENT TRAVELS HERE. The same runner gives the target the
 * sandbox account's profile environment plus srt-win's own `--env` overlay
 * (PATH, PATHEXT, proxy), not the environment the host spawned `srt-win` with
 * — so the throwaway HOME and its TEMP never arrived. The child's intended
 * environment is passed as one base64url JSON argument and applied before the
 * plugin is imported; base64url keeps every byte of it out of `cmd.exe`'s
 * reach. `ELECTRON_RUN_AS_NODE` cannot travel this way — it decides what the
 * binary is before any JavaScript runs — and is set on the command line instead
 * (`confined-child.ts`, `windowsShell: "cmd"`).
 *
 * THE STDIO RELAY. A program the host does not write — a bundled hook, an MCP
 * stdio server, a plugin worker — cannot be taught this channel, yet it reads
 * its stdin (a hook its payload, a server its requests, a worker its host's
 * liveness) and needs its environment. So the same launch runs the host's own
 * runtime in relay mode instead ({@link CHILD_RELAY_TRANSPORT_ARG}): it accepts
 * the host over this channel, reads ONE request line naming the program, its
 * arguments, its environment and its working directory, starts that program
 * with a real stdin pipe, and copies the socket into it. The program inherits
 * the relay's stdout and stderr, which srt-win already carries to the host, and
 * the relay exits with the program's exit code. Both run inside the one srt-win
 * wrap — same account, same restricted token, same job object, same filesystem
 * and network fence — so the relay adds a hop, not a privilege. Because the
 * request travels over the authenticated socket, nothing the program is given
 * ever meets `cmd.exe`: only the host's own executable and entry path do.
 */
import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Longest stdout the host reads looking for the announce before refusing. */
const ANNOUNCE_SCAN_LIMIT = 4096;
const ANNOUNCE_RE = new RegExp(`^${CHILD_LISTEN_ANNOUNCE} ([0-9]{1,5}) ([0-9a-f]{${NONCE_HEX_LENGTH}})$`);

/** The child's environment, as one command-line-inert argument. */
export function encodeChildEnv(env: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(env)) assertEnvPair(name, value);
  return CHILD_ENV_ARG_PREFIX + Buffer.from(JSON.stringify(env), "utf-8").toString("base64url");
}

function assertEnvPair(name: string, value: unknown): asserts value is string {
  if (!ENV_NAME_RE.test(name)) {
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

/**
 * Parse the child's arguments. With none of this module's arguments it is
 * the stdio child every other launch runs, and whatever else is there is left
 * to its caller as before (the plugin validator passes the entry path). With
 * the loopback argument, the launch must be exactly it and one environment
 * argument; with the relay argument, exactly that argument alone. Anything
 * else is refused rather than ignored.
 */
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

/**
 * CHILD SIDE. Listen on loopback, announce, and resolve with the one socket
 * that presented the nonce. The listener is closed on the first connection and
 * on every failure; a peer that sends anything but the nonce rejects.
 */
export function acceptHostOverLoopback(opts: {
  readonly announce: (line: string) => void;
  readonly acceptTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
}): Promise<Socket> {
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    // Set on the first connection, not on a verified one: a second peer that
    // arrived before the listener closed is destroyed at once, never handed a
    // handshake of its own (which could otherwise outlive the outcome).
    let accepted = false;
    const server = createServer();
    server.maxConnections = 1;
    const finish = (error: Error | undefined, socket?: Socket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(acceptTimer);
      server.close();
      if (error !== undefined) {
        socket?.destroy();
        reject(error);
      } else {
        resolve(socket!);
      }
    };
    const acceptTimer = setTimeout(
      () => finish(new Error("[child-loopback-link] the host did not connect in time")),
      opts.acceptTimeoutMs,
    );
    server.on("error", (error) => finish(error));
    server.on("connection", (socket) => {
      if (settled || accepted) {
        socket.destroy();
        return;
      }
      accepted = true;
      // The first connection ends the listening, whatever it turns out to be.
      server.close();
      clearTimeout(acceptTimer);
      let received = Buffer.alloc(0);
      const handshakeTimer = setTimeout(
        () => finish(new Error("[child-loopback-link] the host did not authenticate in time"), socket),
        opts.handshakeTimeoutMs,
      );
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        const newline = received.indexOf(0x0a);
        if (newline === -1) {
          if (received.length > NONCE_HEX_LENGTH) {
            clearTimeout(handshakeTimer);
            finish(new Error("[child-loopback-link] the peer did not present the nonce"), socket);
          }
          return;
        }
        socket.off("data", onData);
        socket.off("error", onError);
        clearTimeout(handshakeTimer);
        const presented = received.subarray(0, newline);
        const expected = Buffer.from(nonce, "utf-8");
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          finish(new Error("[child-loopback-link] the peer did not present the nonce"), socket);
          return;
        }
        socket.pause();
        const rest = received.subarray(newline + 1);
        if (rest.length > 0) socket.unshift(rest);
        finish(undefined, socket);
      };
      const onError = (error: Error): void => {
        clearTimeout(handshakeTimer);
        finish(error, socket);
      };
      socket.on("data", onData);
      socket.on("error", onError);
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

/**
 * HOST SIDE. Read the child's stdout for its announce, connect, present the
 * nonce, and resolve with the connected socket. Rejects — and leaves no socket
 * open — if the child exits first, says anything else first, says too much, or
 * the time runs out. Blank lines before the announce are skipped; srt-win's
 * shells may emit one.
 */
export function connectToAnnouncedChild(opts: {
  readonly stdout: Readable;
  readonly exited: Promise<string>;
  readonly timeoutMs: number;
}): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let scanned = "";
    let socket: Socket | undefined;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.stdout.off("data", onData);
      if (error !== undefined) {
        socket?.destroy();
        reject(error);
      } else {
        resolve(socket!);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("[child-loopback-link] the child did not announce its listener in time")),
      opts.timeoutMs,
    );
    void opts.exited.then((reason) =>
      finish(new Error(`[child-loopback-link] the child ended before its channel was connected: ${reason}`)));
    const onData = (chunk: Buffer): void => {
      if (socket !== undefined) return;
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
        const nonce = match[2]!;
        socket = connect({ host: "127.0.0.1", port }, () => {
          socket!.off("error", onConnectError);
          socket!.write(`${nonce}\n`);
          finish(undefined);
        });
        const onConnectError = (error: Error): void => finish(error);
        socket.on("error", onConnectError);
        return;
      }
      if (scanned.length > ANNOUNCE_SCAN_LIMIT) {
        finish(new Error("[child-loopback-link] the child's stdout ran on without an announce"));
      }
    };
    opts.stdout.on("data", onData);
  });
}

/**
 * The program a relay starts (see the module header), sent as one JSON line
 * after the nonce. Validated on both sides; a malformed request ends the relay.
 */
export interface RelayRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** Longest request line, environment included, either side accepts. */
const RELAY_REQUEST_LIMIT = 1024 * 1024;
/** The relay's exit code when the program could not be started at all. */
const RELAY_START_FAILED_EXIT = 127;

function assertRelayRequest(value: unknown): asserts value is RelayRequest {
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

/** The request as the line the host writes after the nonce. */
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

/**
 * HOST SIDE of the relay. Given the wrapped relay's stdout and its exit, return
 * the program's stdin and stdout as the caller will use them: `stdin` is
 * buffered until the channel exists and then copied into it, ending it ends
 * the program's input; `stdout` is the relay's stdout after the announce, which
 * is the program's own. Nothing else is read from the channel.
 *
 * On any failure to connect, `onFailure` is told — the caller ends the child —
 * `stdout` ends, and `stdin` becomes a sink, so a caller that writes before it
 * sees the exit gets no stream error. The same happens to `stdin` when the
 * channel closes later: the relay, and with it the program, is gone, and the
 * child's exit is how the caller learns it.
 */
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
      // The program starts only once its request is read, so the relay's stdout
      // carries nothing between the announce and this point: attaching here, in
      // the same turn the connection resolved, loses nothing.
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

/** CHILD SIDE: read the one request line, leaving whatever follows it unread. */
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

/**
 * CHILD SIDE of the relay: accept the host, read its request, run the program
 * with a real stdin pipe fed from the channel and with this process's stdout
 * and stderr, and resolve with the program's exit code.
 *
 * The program's environment is this process's own — the sandbox account's
 * profile and srt-win's overlay — with `ELECTRON_RUN_AS_NODE` removed (it was
 * set for this runtime, not for the program) and the request's variables laid
 * over it; a request name replaces an inherited one of any case, as Windows
 * compares them. The program's input ends when the host ends it or when the
 * channel goes away, whichever comes first: for a plugin worker that end is
 * the host-liveness signal it already reads on stdin.
 */
export async function serveStdioRelay(opts: {
  readonly announce: (line: string) => void;
  readonly acceptTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly relayEnv: NodeJS.ProcessEnv;
  readonly diagnostics: Writable;
}): Promise<number> {
  const socket = await acceptHostOverLoopback(opts);
  // From here a dropped channel is read as the end of the program's input.
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
    const program = spawn(request.command, [...request.args], {
      env,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
      shell: false,
    });
    program.stdin!.on("error", () => undefined);
    program.once("error", (error) => {
      opts.diagnostics.write(`[plugin-child] relay could not start '${request.command}': ${error.message}\n`);
      socket.destroy();
      resolve(RELAY_START_FAILED_EXIT);
    });
    program.once("exit", (code) => {
      socket.destroy();
      resolve(code ?? 1);
    });
    socket.once("close", () => program.stdin!.end());
    socket.pipe(program.stdin!);
  });
}
