/**
 * The Windows sandboxed plugin child's protocol channel: one authenticated
 * loopback TCP connection instead of the child's stdin and stdout.
 *
 * WHY NOT STDIO. `srt-win exec` starts the target as the `srt-sandbox` account
 * through a two-hop runner that relays the target's stdout but no stdin:
 * `echo hi | srt-win exec -- cmd /c more` prints nothing (measured on ASRT
 * 0.0.76 on a provisioned Windows 11 host, 2026-10-10; through ASRT 0.0.80 the
 * srt-win source changes only in merging a batch's duplicate targets, #656, so
 * the relay is unchanged). The plugin protocol
 * is framed in both directions, so on that path the host's half has nowhere to
 * go. macOS and Linux keep stdio; nothing here runs there.
 *
 * WHY THIS SHAPE. srt-win's WFP filters refuse an outbound connect from the
 * `srt-sandbox` account except to the proxy port range — loopback included, so
 * one sandboxed process cannot dial another's listener either (measured:
 * `EACCES`) — while an inbound connect from the host to a loopback listener
 * the child opened is admitted (measured, same host). So the child listens on
 * `127.0.0.1:0` and announces the port and a fresh 32-byte nonce on its stdout:
 * the one channel srt-win does relay, and one only the host reads. The nonce
 * itself never crosses the socket and is never logged.
 *
 * MUTUAL, CHANNEL-BOUND AUTHENTICATION. Both ends prove they hold the nonce,
 * and each proof is bound to the one TCP connection it is sent on:
 *   host  → child  HMAC-SHA256(nonce, "ave-loopback host <hostAddr> <hostPort> <childAddr> <childPort>")
 *   child → host   HMAC-SHA256(nonce, "ave-loopback child <childAddr> <childPort> <hostAddr> <hostPort>")
 * where the addresses and ports are the connection's own, each side reading
 * them from its socket (IPv4-mapped addresses unmapped). The host sends its
 * proof first and treats the channel as the child's only after the child's
 * proof checks; the child accepts the host only after the host's proof checks
 * against the remote address and port it actually sees. Both ends are
 * 127.0.0.1: the host dials from it, and the child drops a peer from any other
 * address before reading a byte. Every 127/8 address reaches a 127.0.0.1
 * listener (measured on Windows: a client bound to 127.0.0.2 connected), so
 * without that a peer on 127.0.0.2 could take the host's port number and
 * replay its proof. So a peer that does not hold the nonce learns nothing from
 * either proof and can be neither end: a listener that took the host's
 * connection cannot answer it, and cannot replay the host's proof into its own
 * connection to the child, whose address or port differ (two live connections
 * never share a 4-tuple). A peer that fails is dropped and the child keeps
 * listening, for a bounded number of peers within the accept time, so a local
 * process that connects first delays the host rather than ending the load;
 * the host connects once more if the child dropped it for want of a handshake
 * slot. Whoever holds the nonce besides the two ends could only have read it
 * out of the child's own memory, which the same account can do anyway
 * (decision 64). A second bind of the child's port is refused even to the
 * same account (measured: `WSAEACCES` with `SO_REUSEADDR`), so the host's
 * connection reaches the child's listener.
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

/**
 * One side's proof that it holds `nonce`, bound to this connection: the
 * sender's own address and port first, then its peer's, each as the sender's
 * socket reports them.
 */
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

/**
 * What an environment can hold: a non-empty name without `=` or NUL, and a
 * string value without NUL. Nothing stricter — the variables travel as JSON,
 * never through a shell, and Windows admits names (`ProgramFiles(x86)`) that a
 * POSIX-shaped rule would refuse.
 */
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
 * whose peer proved it holds the nonce for that connection, after answering
 * with the child's own proof (see the module header). A peer that fails —
 * a wrong or late proof, too many bytes, an error — is dropped and the child
 * keeps listening; it gives up after {@link MAX_REFUSED_PEERS} of them or when
 * the accept time runs out. The listener is closed once the host is in, and
 * on every failure.
 */
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
      // A peer's reset must never surface as an unhandled error in the child.
      socket.on("error", () => undefined);
      if (settled || pending.size >= MAX_PENDING_HANDSHAKES) {
        socket.destroy();
        if (!settled) refuse(socket);
        return;
      }
      // The host dials from the loopback address itself; a peer bound to any
      // other (127.0.0.2, say) is not the host, whatever it sends.
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

/**
 * HOST SIDE. Read the child's stdout for its announce, connect from the
 * loopback address, send the host's proof for this connection, and resolve
 * with the socket only after the peer answered with the child's proof for it
 * (see the module header). If the child drops the connection before answering
 * — it does so to a peer beyond its handshake slots — the host connects once
 * more, after a short wait, within the same time limit. Rejects — and leaves
 * no socket open — if the child exits first, says anything else first, says
 * too much, answers wrongly, or the time runs out. Blank lines before the
 * announce are skipped; srt-win's shells may emit one.
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
    /** The child dropped `connected` before answering: try once more, or give up with `error`. */
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
      // Read the answer in paused mode, so that once this listener is gone the
      // socket is back where a fresh one starts: the caller's first `data`
      // listener starts the flow, and nothing after the answer is lost.
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
        // A connect that never reached a listener is not retried; a connection
        // the child reset during the handshake is.
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

/**
 * The program a relay starts (see the module header), sent as one JSON line
 * once the channel is authenticated. Validated on both sides; a malformed request ends the relay.
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

/**
 * A batch file, as Windows names one: `.cmd`/`.bat` in any case, trailing
 * dots and spaces ignored as the file system ignores them.
 */
const BATCH_FILE_RE = /\.(?:cmd|bat)[. ]*$/i;

/**
 * Why the relay starts no batch file. Node refuses to spawn one without a
 * shell (`EINVAL`, since the CVE-2024-27980 fix), and the only shell for it is
 * `cmd.exe`, which would put the program's arguments — a plugin's or an MCP
 * server's, not the host's — on a command line it parses. The relay exists so
 * that nothing the program is given meets `cmd.exe`; a batch file would undo
 * that, so it is refused before anything starts.
 */
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

/** The request as the line the host writes once the channel is authenticated. */
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
    const couldNotStart = (error: Error): void => {
      opts.diagnostics.write(`[plugin-child] relay could not start '${request.command}': ${error.message}\n`);
      socket.destroy();
      resolve(RELAY_START_FAILED_EXIT);
    };
    // A batch file never gets here (assertRelayRequest); any other launch
    // Node refuses synchronously rejects the relay, reported on its stderr.
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
