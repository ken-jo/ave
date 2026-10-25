/** Emulate the relay socket handshake without a sandbox or child process. */
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import { acceptHostOverLoopback } from "../../plugins/isolation/child-loopback-link.js";

export interface FakeRelayPeer {
  readonly request: Promise<Record<string, unknown>>;
  input(): string;
  onInput(listener: (text: string) => void): void;
  readonly inputEnded: Promise<void>;
  socket(): Socket | undefined;
  close(): void;
}

export async function startFakeRelayPeer(announceTo: Writable): Promise<FakeRelayPeer> {
  let accepted: Socket | undefined;
  let closed = false;
  let buffered = "";
  let afterRequest = "";
  let resolveRequest!: (request: Record<string, unknown>) => void;
  let rejectRequest!: (error: Error) => void;
  const request = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  void request.catch(() => undefined);
  let resolveEnded!: () => void;
  const inputEnded = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  let requestSeen = false;
  const listeners: Array<(text: string) => void> = [];
  const deliver = (text: string): void => {
    if (text.length === 0) return;
    afterRequest += text;
    for (const listener of listeners) listener(text);
  };
  let announced!: () => void;
  const announcedOnce = new Promise<void>((resolve) => {
    announced = resolve;
  });
  acceptHostOverLoopback({
    announce: (line) => {
      announceTo.write(line);
      announced();
    },
    acceptTimeoutMs: 30_000,
    handshakeTimeoutMs: 10_000,
  }).then(
    (socket) => {
      accepted = socket;
      if (closed) {
        socket.destroy();
        return;
      }
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        if (requestSeen) {
          deliver(chunk.toString("utf-8"));
          return;
        }
        buffered += chunk.toString("utf-8");
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        requestSeen = true;
        resolveRequest(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        deliver(buffered.slice(newline + 1));
      });
      socket.on("end", () => resolveEnded());
      socket.resume();
    },
    (error: unknown) => rejectRequest(error instanceof Error ? error : new Error(String(error))),
  );
  await announcedOnce;
  return {
    request,
    input: () => afterRequest,
    onInput: (listener) => {
      listeners.push(listener);
      if (afterRequest.length > 0) listener(afterRequest);
    },
    inputEnded,
    socket: () => accepted,
    close: () => {
      closed = true;
      accepted?.destroy();
    },
  };
}
