/**
 * Both halves of the sandboxed Windows child's channel, in one process over
 * real loopback sockets: the child's listen-announce-accept and the host's
 * read-connect-authenticate. Whether srt-win admits the connection between
 * the two accounts is measured on a provisioned Windows host, not here.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  acceptHostOverLoopback,
  CHILD_ENV_ARG_PREFIX,
  CHILD_LOOPBACK_TRANSPORT_ARG,
  CHILD_RELAY_TRANSPORT_ARG,
  connectToAnnouncedChild,
  encodeChildEnv,
  parseChildLaunchArgs,
  relayStdioOverLoopback,
  serveStdioRelay,
} from "../child-loopback-link.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";

const NEVER = new Promise<string>(() => undefined);

function announced(): { readonly lines: string[]; readonly announce: (line: string) => void } {
  const lines: string[] = [];
  return { lines, announce: (line) => void lines.push(line) };
}

async function nextLine(lines: string[]): Promise<{ port: number; nonce: string }> {
  for (let turn = 0; turn < 200 && lines.length === 0; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const [, port, nonce] = lines[0]!.trimEnd().split(" ");
  return { port: Number(port), nonce: nonce! };
}

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function refused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
  });
}

/**
 * The handshake's proofs, derived here from the protocol's definition (the
 * module header of `child-loopback-link.ts`) rather than imported, so a change
 * to either side's formula fails these tests.
 */
function proof(
  nonce: string,
  side: "host" | "child",
  ownPort: number,
  peerPort: number,
  ownAddress = "127.0.0.1",
  peerAddress = "127.0.0.1",
): string {
  return createHmac("sha256", Buffer.from(nonce, "hex"))
    .update(`ave-loopback ${side} ${ownAddress} ${ownPort} ${peerAddress} ${peerPort}`)
    .digest("hex");
}

/** Whether this host routes a second loopback address (Linux and Windows do; macOS has only 127.0.0.1). */
async function canBind(address: string): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, address, () => probe.close(() => resolve(true)));
  });
}
const SECOND_LOOPBACK = "127.0.0.2";
const hasSecondLoopback = await canBind(SECOND_LOOPBACK);

/** Dial `port` on 127.0.0.1 from `localAddress`. */
function dialFrom(localAddress: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Dial the child and present the host's proof for this very connection. */
async function dialAsHost(port: number, nonce: string, after = ""): Promise<Socket> {
  const socket = await dial(port);
  socket.on("error", () => undefined);
  socket.write(`${proof(nonce, "host", socket.localPort!, port)}\n${after}`);
  return socket;
}

/** A listener that does not hold the nonce: records what it is sent, answers `reply`. */
async function rogueListener(reply: (received: string, socket: Socket) => void): Promise<{ server: Server; port: number; received: () => string }> {
  let received = "";
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf-8");
      reply(received, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("rogue listener has no TCP address");
  return { server, port: address.port, received: () => received };
}

function readAll(socket: Socket, bytes: number): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    socket.on("data", (chunk: Buffer) => {
      got += chunk.toString("utf-8");
      if (got.length >= bytes) resolve(got);
    });
  });
}

describe("the child's launch arguments", () => {
  it("round-trips the environment through one command-line-inert argument", () => {
    const env = { HOME: "C:\\Users\\example\\a b", TEMP: "C:\\t%x%&^!\"", LANG: "ko_KR.UTF-8" };
    const encoded = encodeChildEnv(env);
    expect(encoded.startsWith(CHILD_ENV_ARG_PREFIX)).toBe(true);
    expect(encoded.slice(CHILD_ENV_ARG_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(parseChildLaunchArgs([CHILD_LOOPBACK_TRANSPORT_ARG, encoded])).toEqual({ transport: "loopback", env });
  });

  it("reads a launch without either of its arguments as the stdio child, whatever else it carries", () => {
    expect(parseChildLaunchArgs([])).toEqual({ transport: "stdio" });
    // The plugin validator launches the stdio child with the entry path after it.
    expect(parseChildLaunchArgs(["C:\\plugins\\p\\plugin.mjs"])).toEqual({ transport: "stdio" });
  });

  it.each([
    [[CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv({}), "--unknown"], "unexpected child argument"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG], "come together"],
    [[encodeChildEnv({})], "come together"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv({})], "unexpected child argument"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}not base64!`], "not base64url"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}${Buffer.from("[1]").toString("base64url")}`], "not an object"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}${Buffer.from("{nope").toString("base64url")}`], "not JSON"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}${Buffer.from('{"A=B":"1"}').toString("base64url")}`], "not an environment variable name"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}${Buffer.from('{"A":1}').toString("base64url")}`], "is not a string"],
    [[CHILD_LOOPBACK_TRANSPORT_ARG, `${CHILD_ENV_ARG_PREFIX}${Buffer.from('{"A":"a\\u0000b"}').toString("base64url")}`], "is not a string"],
  ])("refuses %j", (args, message) => {
    expect(() => parseChildLaunchArgs(args)).toThrow(message);
  });

  it("refuses to encode what an environment cannot hold, and nothing else", () => {
    expect(() => encodeChildEnv({ "A=B": "x" })).toThrow("is not an environment variable name");
    expect(() => encodeChildEnv({ "": "x" })).toThrow("is not an environment variable name");
    expect(() => encodeChildEnv({ A: "a\0b" })).toThrow("is not a string");
    expect(parseChildLaunchArgs([CHILD_LOOPBACK_TRANSPORT_ARG, encodeChildEnv({ "ProgramFiles(x86)": "C:\\P", "1A": "x" })]))
      .toEqual({ transport: "loopback", env: { "ProgramFiles(x86)": "C:\\P", "1A": "x" } });
  });
});

describe("the child accepts exactly one authenticated host", () => {
  it("serves the peer whose proof is bound to its own connection, answers with its own, keeps bytes sent after it, and stops listening", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    expect(lines[0]).toMatch(/^AVE-CHILD-LISTEN \d+ [0-9a-f]{64}\n$/);
    const host = await dial(port);
    const answer = readAll(host, 65);
    host.write(`${proof(nonce, "host", host.localPort!, port)}\nfirst-frame`);
    const child = await accepted;
    expect(await answer).toBe(`${proof(nonce, "child", port, host.localPort!)}\n`);
    const received = readAll(child, "first-frame".length);
    child.resume();
    expect(await received).toBe("first-frame");
    expect(await refused(port)).toBe("ECONNREFUSED");
    host.destroy();
    child.destroy();
  });

  it("destroys a second peer still in its handshake once the host is in", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    const second = await dial(port);
    second.on("error", () => undefined);
    const secondClosed = new Promise((resolve) => second.once("close", resolve));
    const host = await dialAsHost(port, nonce);
    const child = await accepted;
    await secondClosed;
    expect(second.destroyed).toBe(true);
    host.destroy();
    child.destroy();
  });

  it.each([
    ["the bare nonce", (nonce: string) => nonce],
    ["a proof bound to another connection's port", (nonce: string, port: number, hostPort: number) => proof(nonce, "host", hostPort + 1, port)],
    ["the child's proof instead of the host's", (nonce: string, port: number, hostPort: number) => proof(nonce, "child", hostPort, port)],
    ["a proof under another nonce", (nonce: string, port: number, hostPort: number) => proof(nonce.replace(/^./, nonce[0] === "a" ? "b" : "a"), "host", hostPort, port)],
    ["a proof without the addresses", (nonce: string, port: number, hostPort: number) =>
      createHmac("sha256", Buffer.from(nonce, "hex")).update(`ave-loopback host ${hostPort} ${port}`).digest("hex")],
  ])("drops a peer presenting %s, answers it nothing, and keeps listening for the host", async (_what, present) => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    const intruder = await dial(port);
    intruder.on("error", () => undefined);
    let answered = "";
    intruder.on("data", (chunk: Buffer) => (answered += chunk.toString("utf-8")));
    const closed = new Promise((resolve) => intruder.once("close", resolve));
    intruder.write(`${present(nonce, port, intruder.localPort!)}\n`);
    await closed;
    expect(answered).toBe("");
    const host = await dialAsHost(port, nonce);
    const child = await accepted;
    host.destroy();
    child.destroy();
  });

  // A 127.0.0.1 listener takes connections from every 127/8 address, so a
  // peer on 127.0.0.2 can hold the very port number the host connected from.
  it.runIf(hasSecondLoopback)(
    "drops a peer on another loopback address presenting a proof for the host's port number — the earlier ports-only one, or one correct for its own address — and keeps listening",
    async () => {
      const { lines, announce } = announced();
      const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
      const { port, nonce } = await nextLine(lines);
      const presentations = [
        // What the previous handshake checked: the ports alone, as a host on
        // 127.0.0.1 with this port number would have sent it.
        (ownPort: number) => createHmac("sha256", Buffer.from(nonce, "hex")).update(`ave-loopback host ${ownPort} ${port}`).digest("hex"),
        // Correct for the peer's own endpoints; only the address check stops it.
        (ownPort: number) => proof(nonce, "host", ownPort, port, SECOND_LOOPBACK, "127.0.0.1"),
      ];
      for (const present of presentations) {
        const intruder = await dialFrom(SECOND_LOOPBACK, port);
        intruder.on("error", () => undefined);
        expect(intruder.localAddress).toBe(SECOND_LOOPBACK);
        let answered = "";
        intruder.on("data", (chunk: Buffer) => (answered += chunk.toString("utf-8")));
        const closed = new Promise((resolve) => intruder.once("close", resolve));
        intruder.write(`${present(intruder.localPort!)}\n`);
        await closed;
        expect(answered).toBe("");
      }
      const host = await dialAsHost(port, nonce);
      const child = await accepted;
      host.destroy();
      child.destroy();
    },
  );

  it("lets the host in on its second connect when its first found every handshake slot taken", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 300 });
    const { port, nonce } = await nextLine(lines);
    // Four silent peers hold the slots until their handshake time runs out.
    const squatters = await Promise.all(Array.from({ length: 4 }, () => dial(port)));
    for (const squatter of squatters) squatter.on("error", () => undefined);
    const stdout = new PassThrough();
    const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    stdout.write(`AVE-CHILD-LISTEN ${port} ${nonce}\n`);
    const host = await connecting;
    const child = await accepted;
    const received = readAll(child, 2);
    child.resume();
    host.write("ok");
    expect(await received).toBe("ok");
    host.destroy();
    child.destroy();
    for (const squatter of squatters) squatter.destroy();
  });

  it("drops a peer that sends more than a proof's length without a newline, and one that stays silent, and keeps listening", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 400 });
    const { port, nonce } = await nextLine(lines);
    const flooder = await dial(port);
    flooder.on("error", () => undefined);
    const flooderClosed = new Promise((resolve) => flooder.once("close", resolve));
    flooder.write("x".repeat(65));
    const silent = await dial(port);
    silent.on("error", () => undefined);
    const silentClosed = new Promise((resolve) => silent.once("close", resolve));
    await flooderClosed;
    await silentClosed;
    const host = await dialAsHost(port, nonce);
    const child = await accepted;
    host.destroy();
    child.destroy();
  });

  it("gives up, and stops listening, after a bounded number of failed peers", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port } = await nextLine(lines);
    let outcome: string | undefined;
    accepted.then(() => (outcome = "accepted"), (error: Error) => (outcome = error.message));
    let peers = 0;
    while (outcome === undefined && peers < 50) {
      const peer = await dial(port).catch(() => undefined);
      if (peer === undefined) break;
      peers += 1;
      peer.on("error", () => undefined);
      const closed = new Promise((resolve) => peer.once("close", resolve));
      peer.write(`${"0".repeat(64)}\n`);
      await closed;
    }
    await expect(accepted).rejects.toThrow(/peers failed to authenticate; giving up/);
    expect(peers).toBe(8);
    expect(await refused(port)).toBe("ECONNREFUSED");
  });

  it("counts peers beyond the handshakes it runs at once as failed, and survives them reset mid-flight", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    // It may give up while the peers below are still being dialled.
    const failure = accepted.then(() => undefined, (error: Error) => error);
    const { port } = await nextLine(lines);
    // Twelve at once, all silent: four take the handshake slots, the rest are
    // dropped as they arrive, and the eighth failure ends the wait.
    const peers = await Promise.all(Array.from({ length: 12 }, () => dial(port).catch(() => undefined)));
    for (const peer of peers) {
      peer?.on("error", () => undefined);
      peer?.resetAndDestroy();
    }
    expect((await failure)?.message).toMatch(/peers failed to authenticate; giving up/);
    expect(await refused(port)).toBe("ECONNREFUSED");
  });

  it("ends, and stops listening, when no host authenticates in time", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 50, handshakeTimeoutMs: 5_000 });
    const { port } = await nextLine(lines);
    await expect(accepted).rejects.toThrow("did not connect and authenticate in time");
    expect(await refused(port)).toBe("ECONNREFUSED");
  });
});

describe("the host connects to the child it spawned", () => {
  it("reads the announce past blank lines, connects, and is accepted", async () => {
    const stdout = new PassThrough();
    const accepted = acceptHostOverLoopback({
      announce: (line) => {
        stdout.write("\r\n");
        // Split mid-line, as a pipe may deliver it.
        stdout.write(line.slice(0, 10));
        stdout.write(line.slice(10));
      },
      acceptTimeoutMs: 5_000,
      handshakeTimeoutMs: 5_000,
    });
    const host = await connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    const child = await accepted;
    const received = readAll(child, 5);
    child.resume();
    host.write("hello");
    expect(await received).toBe("hello");
    // What the child sends after its proof reaches the host's first reader.
    child.write("from the child");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readAll(host, "from the child".length)).toBe("from the child");
    host.destroy();
    child.destroy();
  });

  it("refuses a first line that is not the announce", async () => {
    const stdout = new PassThrough();
    const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    stdout.write("hello from a plugin\n");
    await expect(connecting).rejects.toThrow("something other than its announce");
  });

  it.each([
    ["AVE-CHILD-LISTEN 0 " + "a".repeat(64), "impossible port"],
    ["AVE-CHILD-LISTEN 70000 " + "a".repeat(64), "impossible port"],
    ["AVE-CHILD-LISTEN 4000 " + "A".repeat(64), "something other than its announce"],
    ["AVE-CHILD-LISTEN 4000 " + "a".repeat(63), "something other than its announce"],
  ])("refuses the malformed announce %j", async (line, message) => {
    const stdout = new PassThrough();
    const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    stdout.write(`${line}\n`);
    await expect(connecting).rejects.toThrow(message);
  });

  it("refuses stdout that runs on without a newline", async () => {
    const stdout = new PassThrough();
    const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    stdout.write("x".repeat(5_000));
    await expect(connecting).rejects.toThrow("ran on without an announce");
  });

  it("refuses when the child ends first, and when the time runs out", async () => {
    await expect(connectToAnnouncedChild({
      stdout: new PassThrough(),
      exited: Promise.resolve("code=1 signal=null"),
      timeoutMs: 5_000,
    })).rejects.toThrow("ended before its channel was connected: code=1 signal=null");
    await expect(connectToAnnouncedChild({ stdout: new PassThrough(), exited: NEVER, timeoutMs: 20 }))
      .rejects.toThrow("did not announce and authenticate its listener in time");
  });

  it("refuses when nothing listens on the announced port", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 20, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    await expect(accepted).rejects.toThrow();
    const stdout = new PassThrough();
    const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 5_000 });
    stdout.write(`AVE-CHILD-LISTEN ${port} ${nonce}\n`);
    await expect(connecting).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["answers nothing", () => undefined],
    ["echoes the host's proof", (received: string, socket: Socket) => {
      if (received.endsWith("\n")) socket.write(received);
    }],
    ["answers a well-formed guess", (received: string, socket: Socket) => {
      if (received.endsWith("\n")) socket.write(`${"a".repeat(64)}\n`);
    }],
  ])("does not take a listener that does not hold the nonce for the child: one that %s gets no channel and learns no nonce", async (_what, reply) => {
    const rogue = await rogueListener(reply as (received: string, socket: Socket) => void);
    const nonce = "c3".repeat(32);
    const stdout = new PassThrough();
    try {
      const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 300 });
      stdout.write(`AVE-CHILD-LISTEN ${rogue.port} ${nonce}\n`);
      await expect(connecting).rejects.toThrow(/did not answer with the child's proof|did not announce and authenticate/);
      expect(rogue.received()).toMatch(/^[0-9a-f]{64}\n$/);
      expect(rogue.received()).not.toContain(nonce);
    } finally {
      rogue.server.close();
    }
  });

  it("gives a relay a listener took the place of nothing: the request, environment and input never reach it", async () => {
    const rogue = await rogueListener(() => undefined);
    const stdout = new PassThrough();
    const failures: Error[] = [];
    try {
      const io = relayStdioOverLoopback({
        stdout, exited: NEVER, timeoutMs: 300,
        request: { command: "server", args: [], env: { API_KEY: "sk-the-plugin-secret" } },
        onFailure: (error) => failures.push(error),
      });
      io.stdout.resume();
      const ended = new Promise((resolve) => io.stdout.once("end", resolve));
      io.stdin.write("program input");
      stdout.write(`AVE-CHILD-LISTEN ${rogue.port} ${"d4".repeat(32)}\n`);
      await ended;
      expect(failures).toHaveLength(1);
      expect(rogue.received()).toMatch(/^[0-9a-f]{64}\n$/);
      expect(rogue.received()).not.toContain("sk-the-plugin-secret");
      expect(rogue.received()).not.toContain("program input");
    } finally {
      rogue.server.close();
    }
  });

  it("binds each proof to its connection: a listener that relays the host's proof to the real child is refused by the child, and the host after it still gets in", async () => {
    // Scenario: the child announced port P with nonce N, but the host's
    // connection reached a rogue that forwards everything to the child.
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port: childPort, nonce } = await nextLine(lines);
    let forwardedClosed!: Promise<unknown>;
    let childAnswered = "";
    const rogue = await rogueListener((received, socket) => {
      if (!received.endsWith("\n") || forwardedClosed !== undefined) return;
      const upstream = connect({ host: "127.0.0.1", port: childPort }, () => upstream.write(received));
      upstream.on("error", () => undefined);
      upstream.on("data", (chunk: Buffer) => {
        childAnswered += chunk.toString("utf-8");
        socket.write(chunk);
      });
      forwardedClosed = new Promise((resolve) => upstream.once("close", resolve));
    });
    const stdout = new PassThrough();
    try {
      const connecting = connectToAnnouncedChild({ stdout, exited: NEVER, timeoutMs: 500 });
      stdout.write(`AVE-CHILD-LISTEN ${rogue.port} ${nonce}\n`);
      await expect(connecting).rejects.toThrow();
      await forwardedClosed;
      expect(childAnswered).toBe("");
      const host = await dialAsHost(childPort, nonce);
      const child = await accepted;
      host.destroy();
      child.destroy();
    } finally {
      rogue.server.close();
    }
  });
});

describe("the stdio relay's launch argument", () => {
  it("stands alone", () => {
    expect(parseChildLaunchArgs([CHILD_RELAY_TRANSPORT_ARG])).toEqual({ transport: "relay" });
    expect(() => parseChildLaunchArgs([CHILD_RELAY_TRANSPORT_ARG, "entry.mjs"])).toThrow(/takes no other child argument/);
    expect(() => parseChildLaunchArgs([CHILD_RELAY_TRANSPORT_ARG, CHILD_LOOPBACK_TRANSPORT_ARG])).toThrow(/takes no other/);
  });
});

/** A program the relay starts: Node, from this binary, running `source`. */
function nodeProgram(source: string, args: readonly string[] = []): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", source, ...args] };
}

/**
 * Play the host by hand against an in-process relay: read the announce, connect,
 * present the host's proof, send `requestLine`, and hand back the socket.
 */
async function hostBy(lines: string[], requestLine: string): Promise<Socket> {
  const { port, nonce } = await nextLine(lines);
  return dialAsHost(port, nonce, requestLine);
}

describe("the stdio relay", () => {
  it("runs the real child entry as a relay: the program gets the request's stdin, arguments and environment; the host gets its stdout and exit code", async () => {
    // The production entry in relay mode, a real process from this binary — as
    // the Windows sandboxed spawn launches it, minus srt-win. The program's
    // arguments and environment carry what `cmd.exe` could not be given.
    const relay = spawn(process.execPath, [pluginChildEntryPath(), CHILD_RELAY_TRANSPORT_ARG], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RELAY_OWN: "the relay's" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    relay.stdin.end();
    let relayStderr = "";
    relay.stderr.on("data", (chunk: Buffer) => (relayStderr += chunk.toString("utf-8")));
    const exited = new Promise<string>((resolve) => relay.once("exit", (code) => resolve(`code=${String(code)}`)));
    const failures: Error[] = [];
    const program = nodeProgram(
      `let input = ""; process.stdin.on("data", (c) => input += c); process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ input, argv: process.argv.slice(1), probe: process.env.RELAY_PROBE,
          own: process.env.RELAY_OWN, cwd: process.cwd() }) + "\\n"); process.exit(7); });`,
      ["100%", 'say "hi"', "%PATH%"],
    );
    const cwd = mkdtempSync(join(tmpdir(), "relay-cwd-"));
    try {
      const io = relayStdioOverLoopback({
        stdout: relay.stdout,
        exited,
        request: { ...program, env: { ELECTRON_RUN_AS_NODE: "1", RELAY_PROBE: '%TEMP% "quoted" & ^' }, cwd },
        timeoutMs: 20_000,
        onFailure: (error) => failures.push(error),
      });
      let out = "";
      io.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf-8")));
      const outputEnded = new Promise((resolve) => io.stdout.once("end", resolve));
      io.stdin.write("first ");
      io.stdin.end("second");
      await expect(exited.then((reason) => `${reason} ${relayStderr}`.trim())).resolves.toBe("code=7");
      await outputEnded;
      const seen = JSON.parse(out) as Record<string, unknown>;
      expect(seen).toEqual({
        input: "first second",
        argv: ["100%", 'say "hi"', "%PATH%"],
        probe: '%TEMP% "quoted" & ^',
        own: "the relay's",
        cwd: expect.any(String),
      });
      expect(failures).toEqual([]);
    } finally {
      relay.kill();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("ends the program's input when the channel goes away, and exits with its code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-eof-"));
    const marker = join(dir, "eof.txt");
    const { lines, announce } = announced();
    const diagnostics = new PassThrough();
    try {
      const served = serveStdioRelay({
        announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000,
        relayEnv: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, diagnostics,
      });
      const program = nodeProgram(
        `process.stdin.resume(); process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "eof"); process.exit(3); });`,
      );
      const socket = await hostBy(lines, `${JSON.stringify({ ...program, env: { ELECTRON_RUN_AS_NODE: "1" } })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.destroy();
      await expect(served).resolves.toBe(3);
      expect(readFileSync(marker, "utf-8")).toBe("eof");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("drops ELECTRON_RUN_AS_NODE it was launched with unless the request sets it, and a request name replaces an inherited one of any case", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-env-"));
    const out = join(dir, "env.json");
    const { lines, announce } = announced();
    try {
      const served = serveStdioRelay({
        announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000,
        relayEnv: { ...process.env, ELECTRON_RUN_AS_NODE: "1", Relay_Case: "inherited" }, diagnostics: new PassThrough(),
      });
      // The program is this binary: without ELECTRON_RUN_AS_NODE an Electron
      // binary would not run `-e`, so the probe writes only under Node itself.
      const program = nodeProgram(
        `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.entries(process.env).filter(([k]) => k.toLowerCase() === "relay_case")))`,
      );
      const socket = await hostBy(lines, `${JSON.stringify({ ...program, env: { ELECTRON_RUN_AS_NODE: "1", RELAY_CASE: "requested" } })}\n`);
      socket.end();
      await expect(served).resolves.toBe(0);
      expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual([["RELAY_CASE", "requested"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a program that cannot start, on its diagnostics and in its exit code", async () => {
    const { lines, announce } = announced();
    const diagnostics = new PassThrough();
    let said = "";
    diagnostics.on("data", (chunk: Buffer) => (said += chunk.toString("utf-8")));
    const served = serveStdioRelay({
      announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, relayEnv: {}, diagnostics,
    });
    const socket = await hostBy(lines, `${JSON.stringify({ command: join(tmpdir(), "no-such-program-here"), args: [], env: {} })}\n`);
    await expect(served).resolves.toBe(127);
    expect(said).toMatch(/relay could not start/);
    socket.destroy();
  });

  it.each([
    ["not JSON", "{nope\n", /not JSON/],
    ["an unknown field", `${JSON.stringify({ command: "x", args: [], env: {}, shell: true })}\n`, /unknown field 'shell'/],
    ["no program", `${JSON.stringify({ command: "", args: [], env: {} })}\n`, /names no program/],
    ["a non-string argument", `${JSON.stringify({ command: "x", args: [1], env: {} })}\n`, /arguments are not strings/],
    ["a bad variable name", `${JSON.stringify({ command: "x", args: [], env: { "A=B": "c" } })}\n`, /not an environment variable name/],
    ["a batch file", `${JSON.stringify({ command: "C:\\nodejs\\npx.CMD", args: [], env: {} })}\n`, /is a batch file/],
  ])("refuses a request with %s and starts nothing", async (_what, line, message) => {
    const { lines, announce } = announced();
    const served = serveStdioRelay({
      announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, relayEnv: {}, diagnostics: new PassThrough(),
    });
    const socket = await hostBy(lines, line);
    await expect(served).rejects.toThrow(message);
    socket.destroy();
  });

  it("refuses a host that leaves before its request", async () => {
    const { lines, announce } = announced();
    const served = serveStdioRelay({
      announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, relayEnv: {}, diagnostics: new PassThrough(),
    });
    const socket = await hostBy(lines, "");
    socket.end();
    await expect(served).rejects.toThrow(/left before its relay request/);
  });

  it("on the host, refuses a request it could not send, and on a failed connect ends the output, sinks the input and says why", async () => {
    expect(() => relayStdioOverLoopback({
      stdout: new PassThrough(), exited: NEVER, request: { command: "x", args: ["a\0b"], env: {} }, timeoutMs: 1_000,
      onFailure: () => undefined,
    })).toThrow(/arguments are not strings/);

    const stdout = new PassThrough();
    const failures: Error[] = [];
    const io = relayStdioOverLoopback({
      stdout, exited: NEVER, request: { command: "x", args: [], env: {} }, timeoutMs: 5_000,
      onFailure: (error) => failures.push(error),
    });
    const ended = new Promise((resolve) => io.stdout.once("end", resolve));
    io.stdout.resume();
    stdout.write("not the announce\n");
    await ended;
    expect(failures.map((error) => error.message)).toEqual([
      "[child-loopback-link] the child wrote something other than its announce first",
    ]);
    expect(() => io.stdin.write("still accepted, going nowhere")).not.toThrow();
  });
});
