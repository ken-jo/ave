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
 */
import { createServer, connect, type Socket } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";

/** Selects the loopback channel in `plugin-child-main.ts`. Absent: stdio. */
export const CHILD_LOOPBACK_TRANSPORT_ARG = "--ave-child-transport=loopback";
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
  | { readonly transport: "loopback"; readonly env: Readonly<Record<string, string>> };

/**
 * Parse the child's arguments. With neither of this module's arguments it is
 * the stdio child every other launch runs, and whatever else is there is left
 * to its caller as before (the plugin validator passes the entry path). With
 * either, the launch must be exactly the loopback argument and one environment
 * argument, and anything else is refused rather than ignored.
 */
export function parseChildLaunchArgs(args: readonly string[]): ChildLaunchMode {
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
    const server = createServer();
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
      if (settled) {
        socket.destroy();
        return;
      }
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
