/**
 * Both halves of the sandboxed Windows child's channel, in one process over
 * real loopback sockets: the child's listen-announce-accept and the host's
 * read-connect-authenticate. Whether srt-win admits the connection between
 * the two accounts is measured on a provisioned Windows host, not here.
 */
import { describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";

import {
  acceptHostOverLoopback,
  CHILD_ENV_ARG_PREFIX,
  CHILD_LOOPBACK_TRANSPORT_ARG,
  connectToAnnouncedChild,
  encodeChildEnv,
  parseChildLaunchArgs,
} from "../child-loopback-link.js";

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
    const env = { HOME: "C:\\Users\\a b\\home", TEMP: "C:\\t%x%&^!\"", LANG: "ko_KR.UTF-8" };
    const encoded = encodeChildEnv(env);
    expect(encoded.startsWith(CHILD_ENV_ARG_PREFIX)).toBe(true);
    expect(encoded.slice(CHILD_ENV_ARG_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(parseChildLaunchArgs([CHILD_LOOPBACK_TRANSPORT_ARG, encoded])).toEqual({ transport: "loopback", env });
  });

  it("reads no arguments as the stdio child", () => {
    expect(parseChildLaunchArgs([])).toEqual({ transport: "stdio" });
  });

  it.each([
    [["--unknown"], "unexpected child argument"],
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

  it("refuses to encode what an environment cannot hold", () => {
    expect(() => encodeChildEnv({ "1A": "x" })).toThrow("is not an environment variable name");
    expect(() => encodeChildEnv({ A: "a\0b" })).toThrow("is not a string");
  });
});

describe("the child accepts exactly one authenticated host", () => {
  it("serves the peer that presents the nonce, keeps bytes sent with it, and stops listening", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    expect(lines[0]).toMatch(/^AVE-CHILD-LISTEN \d+ [0-9a-f]{64}\n$/);
    const host = await dial(port);
    host.write(`${nonce}\nfirst-frame`);
    const child = await accepted;
    const received = readAll(child, "first-frame".length);
    child.resume();
    expect(await received).toBe("first-frame");
    const echoed = readAll(host, 4);
    child.write("pong");
    expect(await echoed).toBe("pong");
    expect(await refused(port)).toBe("ECONNREFUSED");
    host.destroy();
    child.destroy();
  });

  it("ends on a wrong nonce, closes the connection, and stops listening", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port, nonce } = await nextLine(lines);
    const intruder = await dial(port);
    const closed = new Promise((resolve) => intruder.once("close", resolve));
    intruder.write(`${nonce.replace(/^./, nonce[0] === "a" ? "b" : "a")}\n`);
    await expect(accepted).rejects.toThrow("did not present the nonce");
    await closed;
    expect(await refused(port)).toBe("ECONNREFUSED");
  });

  it("ends when the first peer sends more than a nonce's length without a newline", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 });
    const { port } = await nextLine(lines);
    const intruder = await dial(port);
    intruder.on("error", () => undefined);
    intruder.write("x".repeat(65));
    await expect(accepted).rejects.toThrow("did not present the nonce");
    intruder.destroy();
  });

  it("does not wait for a second try: the first peer's silence ends it", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 5_000, handshakeTimeoutMs: 50 });
    const { port } = await nextLine(lines);
    const silent = await dial(port);
    silent.on("error", () => undefined);
    await expect(accepted).rejects.toThrow("did not authenticate in time");
    expect(await refused(port)).toBe("ECONNREFUSED");
    silent.destroy();
  });

  it("ends, and stops listening, when no host connects in time", async () => {
    const { lines, announce } = announced();
    const accepted = acceptHostOverLoopback({ announce, acceptTimeoutMs: 50, handshakeTimeoutMs: 5_000 });
    const { port } = await nextLine(lines);
    await expect(accepted).rejects.toThrow("did not connect in time");
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
      .rejects.toThrow("did not announce its listener in time");
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
});
