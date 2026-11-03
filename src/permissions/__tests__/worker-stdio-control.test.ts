// The host end of worker stdio control v1, driven over in-memory pipes: hello, framing, correlation, cancellation, bounds and teardown.
import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import {
  openWorkerStdioControl,
  WorkerControlFailedError,
  WorkerStdioControl,
  WORKER_CONTROL_ID_STRING_MAX,
  WORKER_CONTROL_IN_FLIGHT_MAX,
  WORKER_CONTROL_PROTOCOL,
  WORKER_CONTROL_UNCLAIMED_BYTES_MAX,
  WORKER_CONTROL_UNCLAIMED_NOTIFICATIONS_MAX,
  WORKER_CONTROL_VERSION,
  type WorkerControlEndReason,
} from "../worker-stdio-control.js";
import { WORKER_CONTROL_FRAME_BYTES_MAX, WORKER_CONTROL_METHOD, WorkerControlError } from "../../plugins/public-contract.js";
import { settle } from "../../plugins/isolation/__tests__/stream-turns.js";

type Frame = Record<string, unknown>;

interface Pipes {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly sent: Frame[];
  readonly ends: Array<{ reason: WorkerControlEndReason; detail: string }>;
  reply(frame: Frame): void;
  raw(text: string): void;
  nextSent(predicate?: (frame: Frame) => boolean): Promise<Frame>;
}

function pipes(): Pipes {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const sent: Frame[] = [];
  const waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  let buffered = "";
  stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf-8");
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffered.slice(0, newline)) as Frame;
      buffered = buffered.slice(newline + 1);
      sent.push(frame);
      for (const waiter of waiters.splice(0)) {
        if (waiter.predicate(frame)) waiter.resolve(frame);
        else waiters.push(waiter);
      }
    }
  });
  const ends: Pipes["ends"] = [];
  return {
    stdin,
    stdout,
    sent,
    ends,
    reply: (frame) => void stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`),
    raw: (text) => void stdout.write(text),
    nextSent: (predicate = () => true) => {
      const already = sent.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

const HELLO_ANSWER = { id: 0, result: { protocol: WORKER_CONTROL_PROTOCOL, version: WORKER_CONTROL_VERSION } };

async function opened(io = pipes()): Promise<{ io: Pipes; control: WorkerStdioControl }> {
  const opening = openWorkerStdioControl({
    stdin: io.stdin,
    stdout: io.stdout,
    helloMs: 5_000,
    onEnd: (reason, detail) => io.ends.push({ reason, detail }),
  });
  await io.nextSent((frame) => frame.method === "$/ave/hello");
  io.reply(HELLO_ANSWER);
  return { io, control: await opening };
}


/** A worker that reads the hello and then never reads its stdin again: every later write stays queued in the host. */
async function openedStalled(): Promise<{ io: Pipes; stdin: Writable; control: WorkerStdioControl }> {
  const io = pipes();
  let reading = true;
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!reading) return;
      io.stdin.write(chunk);
      callback();
    },
  });
  const opening = openWorkerStdioControl({
    stdin,
    stdout: io.stdout,
    helloMs: 5_000,
    onEnd: (reason, detail) => io.ends.push({ reason, detail }),
  });
  await io.nextSent((frame) => frame.method === "$/ave/hello");
  reading = false;
  io.reply(HELLO_ANSWER);
  return { io, stdin, control: await opening };
}

const QUEUE_BYTES_MAX = 2 * (WORKER_CONTROL_FRAME_BYTES_MAX + 1);


afterEach(() => {
  vi.useRealTimers();
});

describe("worker stdio control v1 — hello", () => {
  it("offers the protocol, its one version and the frame cap as request id 0", async () => {
    const { io } = await opened();
    expect(io.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "$/ave/hello",
      params: { protocol: "ave-worker-stdio-control", versions: ["1"], frameBytesMax: WORKER_CONTROL_FRAME_BYTES_MAX },
    });
    expect(io.ends).toEqual([]);
  });

  it.each([
    ["a wrong version", { id: 0, result: { protocol: WORKER_CONTROL_PROTOCOL, version: "2" } }],
    ["a wrong protocol", { id: 0, result: { protocol: "other", version: "1" } }],
    ["an extra result field", { id: 0, result: { protocol: WORKER_CONTROL_PROTOCOL, version: "1", extra: true } }],
    ["an error", { id: 0, error: { code: -32601, message: "no" } }],
    ["another id", { id: 1, result: { protocol: WORKER_CONTROL_PROTOCOL, version: "1" } }],
    ["a notification first", { method: "ready" }],
  ])("refuses %s as a control violation", async (_name, answer) => {
    const io = pipes();
    const opening = openWorkerStdioControl({ stdin: io.stdin, stdout: io.stdout, helloMs: 5_000, onEnd: (reason, detail) => io.ends.push({ reason, detail }) });
    await io.nextSent();
    io.reply(answer);
    await expect(opening).rejects.toBeInstanceOf(WorkerControlFailedError);
    await expect(opening).rejects.toMatchObject({ code: "worker-control-failed" });
    expect(io.ends.map((end) => end.reason)).toEqual(["control-violation"]);
  });

  it("refuses a log line written before the answer", async () => {
    const io = pipes();
    const opening = openWorkerStdioControl({ stdin: io.stdin, stdout: io.stdout, helloMs: 5_000, onEnd: (reason, detail) => io.ends.push({ reason, detail }) });
    io.raw("Loading model...\n");
    await expect(opening).rejects.toThrow(/stdout carried something other than a frame/);
    expect(io.ends[0]?.reason).toBe("control-violation");
  });

  it("times out a worker that never answers", async () => {
    vi.useFakeTimers();
    const io = pipes();
    const opening = openWorkerStdioControl({ stdin: io.stdin, stdout: io.stdout, helloMs: 250, onEnd: (reason, detail) => io.ends.push({ reason, detail }) });
    const settled = expect(opening).rejects.toThrow(/no answer to \$\/ave\/hello within 250ms/);
    await vi.advanceTimersByTimeAsync(251);
    await settled;
    expect(io.ends[0]?.reason).toBe("control-violation");
  });
});

describe("worker stdio control v1 — host to worker", () => {
  it("correlates responses by id, in any order, and carries the worker's error shape", async () => {
    const { io, control } = await opened();
    const first = control.request("embed", { text: "a" });
    const second = control.request("embed", { text: "b" });
    const [a, b] = await Promise.all([
      io.nextSent((frame) => (frame.params as Frame | undefined)?.text === "a"),
      io.nextSent((frame) => (frame.params as Frame | undefined)?.text === "b"),
    ]);
    io.reply({ id: b.id, error: { code: -32000, message: "model not loaded", data: { retry: true } } });
    io.reply({ id: a.id, result: [0.1, 0.2] });
    await expect(first).resolves.toEqual([0.1, 0.2]);
    const failure = await second.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkerControlError);
    expect(failure).toMatchObject({ code: "worker-request-failed", remote: { code: -32000, message: "model not loaded", data: { retry: true } } });
  });

  it("sends a notification without an id", async () => {
    const { io, control } = await opened();
    await control.notify("reindex", { scope: "all" });
    expect(await io.nextSent((frame) => frame.method === "reindex")).toEqual({ jsonrpc: "2.0", method: "reindex", params: { scope: "all" } });
  });

  it("cancels on abort, sends $/ave/cancel, and ignores the late answer without a violation", async () => {
    const { io, control } = await opened();
    const abort = new AbortController();
    const pending = control.request("search", { q: "x" }, { signal: abort.signal });
    const request = await io.nextSent((frame) => frame.method === "search");
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "worker-request-cancelled" });
    expect(await io.nextSent((frame) => frame.method === "$/ave/cancel")).toEqual({ jsonrpc: "2.0", method: "$/ave/cancel", params: { id: request.id } });
    io.reply({ id: request.id, result: "too late" });
    await settle();
    expect(io.ends).toEqual([]);
    // A second answer for the same id is not a race any more.
    io.reply({ id: request.id, result: "again" });
    await settle();
    expect(io.ends[0]?.reason).toBe("control-violation");
  });

  it("refuses a request whose signal is already aborted without writing it", async () => {
    const { io, control } = await opened();
    const abort = new AbortController();
    abort.abort();
    await expect(control.request("search", {}, { signal: abort.signal })).rejects.toMatchObject({ code: "worker-request-cancelled" });
    await settle();
    expect(io.sent.some((frame) => frame.method === "search")).toBe(false);
  });

  it("applies backpressure past the in-flight limit, counting cancelled requests until their answer", async () => {
    const { io, control } = await opened();
    const abort = new AbortController();
    const pending = Array.from({ length: WORKER_CONTROL_IN_FLIGHT_MAX }, (_, index) =>
      control.request("work", { index }, { signal: abort.signal }).catch((error: unknown) => error));
    await expect(control.request("work", {})).rejects.toMatchObject({ code: "worker-backpressure" });
    abort.abort();
    await Promise.all(pending);
    await expect(control.request("work", {})).rejects.toMatchObject({ code: "worker-backpressure" });
    const first = io.sent.find((frame) => frame.method === "work")!;
    io.reply({ id: first.id, result: null });
    await settle();
    const next = control.request("work", { index: "next" });
    const frame = await io.nextSent((candidate) => (candidate.params as Frame | undefined)?.index === "next");
    io.reply({ id: frame.id, result: "ok" });
    await expect(next).resolves.toBe("ok");
  });

  it("refuses a frame over the cap before writing it", async () => {
    const { control } = await opened();
    await expect(control.request("big", { blob: "x".repeat(WORKER_CONTROL_FRAME_BYTES_MAX) })).rejects.toMatchObject({ code: "payload-too-large" });
  });

  it.each([
    ["a method outside the name grammar", "has.dot"],
    ["a reserved host method", "$/ave/hello"],
  ])("refuses %s", async (_name, method) => {
    const { control } = await opened();
    expect(() => control.request(method)).toThrow(TypeError);
  });

  it("refuses params that are not JSON", async () => {
    const { control } = await opened();
    expect(() => control.request("work", { at: new Date() })).toThrow(TypeError);
  });
});

describe("worker stdio control v1 — worker to host", () => {
  it("queues requests until a handler registers, answers them, and maps a thrown error to an internal error", async () => {
    const { io, control } = await opened();
    io.reply({ id: "w-1", method: "egress_fetch", params: { url: "https://example.com/model" } });
    io.reply({ id: "w-2", method: "egress_fetch", params: { url: "https://example.com/fail" } });
    await settle();
    expect(io.sent.filter((frame) => frame.id === "w-1")).toEqual([]);
    control.onRequest(async (method, params) => {
      const { url } = params as { url: string };
      if (url.endsWith("fail")) throw new Error("refused by the plugin");
      return { method, status: 200 };
    });
    expect(await io.nextSent((frame) => frame.id === "w-1")).toEqual({ jsonrpc: "2.0", id: "w-1", result: { method: "egress_fetch", status: 200 } });
    expect(await io.nextSent((frame) => frame.id === "w-2")).toEqual({ jsonrpc: "2.0", id: "w-2", error: { code: -32603, message: "refused by the plugin" } });
    expect(() => control.onRequest(async () => null)).toThrow(/already registered/);
  });

  it("aborts the handler's signal on $/ave/cancel and answers request-cancelled", async () => {
    const { io, control } = await opened();
    let seen: AbortSignal | undefined;
    control.onRequest((_method, _params, signal) => new Promise((_resolve, reject) => {
      seen = signal;
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    }));
    io.reply({ id: 7, method: "slow" });
    await settle();
    io.reply({ method: "$/ave/cancel", params: { id: 7 } });
    expect(await io.nextSent((frame) => frame.id === 7)).toMatchObject({ id: 7, error: { code: -32800 } });
    expect(seen?.aborted).toBe(true);
    expect(io.ends).toEqual([]);
  });

  it("delivers notifications, replaying those that arrived before the first listener", async () => {
    const { io, control } = await opened();
    io.reply({ method: "progress", params: { done: 1 } });
    await settle();
    const seen: unknown[] = [];
    control.onNotification((method, params) => seen.push([method, params]));
    io.reply({ method: "progress", params: { done: 2 } });
    await settle();
    expect(seen).toEqual([["progress", { done: 1 }], ["progress", { done: 2 }]]);
  });

  it("ends as output-overflow past the unclaimed-notification bound", async () => {
    const { io } = await opened();
    for (let index = 0; index <= WORKER_CONTROL_UNCLAIMED_NOTIFICATIONS_MAX; index += 1) io.reply({ method: "progress", params: { index } });
    await settle();
    expect(io.ends.map((end) => end.reason)).toEqual(["output-overflow"]);
  });

  it.each([
    ["a duplicate outstanding request id", [{ id: 1, method: "a" }, { id: 1, method: "b" }]],
    ["a method outside the name grammar", [{ id: 1, method: "has.dot" }]],
    ["a frame without jsonrpc 2.0", [{ jsonrpc: "1.0", id: 1, method: "a" }]],
    ["a response for an id the host never sent", [{ id: 99, result: null }]],
    ["an unknown field", [{ id: 1, method: "a", extra: true }]],
  ])("ends on %s as a control violation and settles pending calls", async (_name, frames) => {
    const { io, control } = await opened();
    const pending = control.request("work");
    for (const frame of frames) io.reply(frame as Frame);
    await expect(pending).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    expect(io.ends.map((end) => end.reason)).toEqual(["control-violation"]);
    await expect(control.request("work")).rejects.toMatchObject({ code: "worker-incarnation-ended" });
  });

  it("ends as output-overflow when unclaimed notifications pass the byte bound", async () => {
    const { io } = await opened();
    const blob = "x".repeat(12 * 1024 * 1024);
    for (let index = 0; index < 3; index += 1) io.reply({ method: "progress", params: { blob } });
    await settle();
    expect(3 * blob.length).toBeGreaterThan(WORKER_CONTROL_UNCLAIMED_BYTES_MAX);
    expect(io.ends.map((end) => end.reason)).toEqual(["output-overflow"]);
    expect(io.ends[0]?.detail).toMatch(/before the plugin claimed them/);
  });

  it("logs a throwing notification listener and keeps delivering to the others", async () => {
    const { io, control } = await opened();
    const seen: unknown[] = [];
    control.onNotification(() => {
      throw new Error("listener bug");
    });
    control.onNotification((method) => seen.push(method));
    io.reply({ method: "progress", params: { done: 1 } });
    io.reply({ method: "progress", params: { done: 2 } });
    await settle();
    expect(seen).toEqual(["progress", "progress"]);
    expect(control.isEnded).toBe(false);
    expect(io.ends).toEqual([]);
  });

  it("ends the channel when the worker stops reading and the answers it is owed pass the queue bound", async () => {
    const { io, stdin, control } = await openedStalled();
    const blob = "x".repeat(8 * 1024 * 1024);
    control.onRequest(async () => ({ blob }));
    for (let index = 0; index < WORKER_CONTROL_IN_FLIGHT_MAX; index += 1) io.reply({ id: `w-${index}`, method: "fetch_blob" });
    await settle();
    expect(io.ends.map((end) => end.reason)).toEqual(["control-violation"]);
    expect(io.ends[0]?.detail).toBe("the worker is not reading its stdin");
    expect(control.isEnded).toBe(true);
    expect(stdin.writableLength).toBeLessThanOrEqual(QUEUE_BYTES_MAX);
  });

  it("pauses and resumes reading the worker's stdout", async () => {
    const { io, control } = await opened();
    control.pauseInput();
    expect(io.stdout.isPaused()).toBe(true);
    control.resumeInput();
    expect(io.stdout.isPaused()).toBe(false);
  });

  it("ends on a line that is not JSON after the hello", async () => {
    const { io } = await opened();
    io.raw("Traceback (most recent call last):\n");
    await settle();
    expect(io.ends.map((end) => end.reason)).toEqual(["control-violation"]);
  });
});

describe("worker stdio control v1 — teardown", () => {
  it("close sends $/ave/shutdown, ends stdin and settles every pending call without replay", async () => {
    const { io, control } = await opened();
    const ended = new Promise<void>((resolve) => io.stdin.once("end", () => resolve()));
    const pending = control.request("work");
    await io.nextSent((frame) => frame.method === "work");
    control.close();
    await expect(pending).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    expect(await io.nextSent((frame) => frame.method === "$/ave/shutdown")).toEqual({ jsonrpc: "2.0", method: "$/ave/shutdown" });
    await ended;
    await expect(control.notify("work")).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    expect(io.ends).toEqual([]);
  });

  it("close skips the shutdown frame when the worker's stdin is already full, and still ends stdin", async () => {
    const { stdin, control } = await openedStalled();
    const blob = "x".repeat(WORKER_CONTROL_FRAME_BYTES_MAX - 64);
    const first = control.request("work", { blob }).catch((error: unknown) => error);
    const second = control.request("work", { blob }).catch((error: unknown) => error);
    await settle();
    const queued = stdin.writableLength;
    expect(queued + `${JSON.stringify({ jsonrpc: "2.0", method: "$/ave/shutdown" })}\n`.length).toBeGreaterThan(QUEUE_BYTES_MAX);
    control.close();
    expect(stdin.writableLength).toBe(queued);
    expect(stdin.writableEnded).toBe(true);
    expect(control.isEnded).toBe(true);
    await expect(first).resolves.toMatchObject({ code: "worker-incarnation-ended" });
    await expect(second).resolves.toMatchObject({ code: "worker-incarnation-ended" });
  });

  it("processEnded settles pending calls and aborts handlers in flight", async () => {
    const { io, control } = await opened();
    let seen: AbortSignal | undefined;
    control.onRequest((_method, _params, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    io.reply({ id: "w", method: "slow" });
    const pending = control.request("work");
    await settle();
    control.processEnded();
    await expect(pending).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    expect(seen?.aborted).toBe(true);
    expect(control.isEnded).toBe(true);
  });
});

describe("worker stdio control v1 — published schema", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "worker-stdio-control", "1", "worker-control.schema.json"), "utf-8")) as {
    $defs: { method: { pattern: string }; id: { oneOf: Array<{ maxLength?: number }> }; hello: { properties: { params: { properties: { frameBytesMax: { const: number } } } } } };
  };
  type Validate = (data: unknown) => boolean;
  const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (options: object) => {
    addSchema(schema: object): unknown;
    getSchema(ref: string): Validate | undefined;
  };
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  const id = (schema as unknown as { $id: string }).$id;
  const validate = ajv.getSchema(id)!;
  // The first worker frame must be the hello answer: ordering is channel state, so it has its own definition.
  const validateHelloAnswer = ajv.getSchema(`${id}#/$defs/helloAnswer`)!;

  it("restates the code's constants", () => {
    expect(schema.$defs.method.pattern).toBe(WORKER_CONTROL_METHOD.source);
    expect(schema.$defs.id.oneOf.find((branch) => branch.maxLength !== undefined)?.maxLength).toBe(WORKER_CONTROL_ID_STRING_MAX);
    expect(schema.$defs.hello.properties.params.properties.frameBytesMax.const).toBe(WORKER_CONTROL_FRAME_BYTES_MAX);
  });

  it("accepts every frame the host writes", async () => {
    const { io, control } = await opened();
    control.onRequest(async () => ({ ok: true }));
    io.reply({ id: "w", method: "egress_fetch", params: { url: "https://example.com" } });
    const abort = new AbortController();
    const cancelled = control.request("work", [1, 2], { signal: abort.signal }).catch(() => undefined);
    await control.notify("ping");
    await io.nextSent((frame) => frame.id === "w");
    abort.abort();
    await cancelled;
    await io.nextSent((frame) => frame.method === "$/ave/cancel");
    control.close();
    await io.nextSent((frame) => frame.method === "$/ave/shutdown");
    expect(new Set(io.sent.map((frame) => String(frame.method ?? "response")))).toEqual(
      new Set(["$/ave/hello", "work", "ping", "response", "$/ave/cancel", "$/ave/shutdown"]),
    );
    for (const frame of io.sent) expect(validate(frame), JSON.stringify(frame)).toBe(true);
  });

  it.each([
    ["the hello answer", { jsonrpc: "2.0", ...HELLO_ANSWER }],
    ["a worker request", { jsonrpc: "2.0", id: "w-1", method: "egress_fetch", params: { url: "https://example.com" } }],
    ["a worker notification", { jsonrpc: "2.0", method: "progress", params: { done: 1 } }],
    ["a result", { jsonrpc: "2.0", id: 3, result: null }],
    ["an error", { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "no", data: { retry: true } } }],
    ["a worker cancel", { jsonrpc: "2.0", method: "$/ave/cancel", params: { id: 3 } }],
  ])("accepts %s", (_name, frame) => {
    expect(validate(frame)).toBe(true);
  });

  it.each([
    ["a dotted method", { jsonrpc: "2.0", id: 1, method: "has.dot" }],
    ["a host-reserved method from a worker", { jsonrpc: "2.0", id: 1, method: "$/ave/other" }],
    ["a response with both result and error", { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } }],
    ["an unknown field", { jsonrpc: "2.0", method: "progress", extra: true }],
    ["a negative id", { jsonrpc: "2.0", id: -1, method: "work" }],
    ["an empty string id", { jsonrpc: "2.0", id: "", method: "work" }],
    ["jsonrpc 1.0", { jsonrpc: "1.0", method: "progress" }],
  ])("rejects %s", (_name, frame) => {
    expect(validate(frame)).toBe(false);
  });

  it("holds the first worker frame to the hello answer", () => {
    expect(validateHelloAnswer({ jsonrpc: "2.0", ...HELLO_ANSWER })).toBe(true);
    expect(validateHelloAnswer({ jsonrpc: "2.0", id: 0, result: { protocol: "ave-worker-stdio-control", version: "2" } })).toBe(false);
    expect(validateHelloAnswer({ jsonrpc: "2.0", id: 0, result: { protocol: "ave-worker-stdio-control", version: "1", extra: 1 } })).toBe(false);
    expect(validateHelloAnswer({ jsonrpc: "2.0", method: "ready" })).toBe(false);
  });
});
