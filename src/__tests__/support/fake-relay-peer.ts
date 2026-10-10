/**
 * The relay's side of the Windows stdio relay (`child-loopback-link.ts`),
 * played by the test: announce a loopback listener on the stub child's stdout
 * the way the relay does, accept the host, and hand back the request line the
 * host sent and the program input that followed it. Lets a unit test drive
 * `spawnConfinedChild`'s relay path to the socket without a sandbox or a
 * second process.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Writable } from "node:stream";

export interface FakeRelayPeer {
  /** Resolves with the request, parsed, once the host has sent it. */
  readonly request: Promise<Record<string, unknown>>;
  /** Program input received after the request so far. */
  input(): string;
  /** Called with the program input so far, then with each piece as it arrives. */
  onInput(listener: (text: string) => void): void;
  /** Resolves when the host ends the program's input. */
  readonly inputEnded: Promise<void>;
  /** The accepted connection, once there is one. */
  socket(): Socket | undefined;
  close(): void;
}

const NONCE = "ab".repeat(32);

export async function startFakeRelayPeer(announceTo: Writable): Promise<FakeRelayPeer> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake relay peer has no TCP address");
  let accepted: Socket | undefined;
  let buffered = "";
  let afterRequest = "";
  let resolveRequest!: (request: Record<string, unknown>) => void;
  let rejectRequest!: (error: Error) => void;
  const request = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
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
  server.on("connection", (socket) => {
    accepted = socket;
    server.close();
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (requestSeen) {
        deliver(chunk.toString("utf-8"));
        return;
      }
      buffered += chunk.toString("utf-8");
      const lines = buffered.split("\n");
      if (lines.length < 3) return;
      requestSeen = true;
      if (lines[0] !== NONCE) {
        rejectRequest(new Error(`host presented '${lines[0]}' instead of the nonce`));
        return;
      }
      resolveRequest(JSON.parse(lines[1]!) as Record<string, unknown>);
      deliver(lines.slice(2).join("\n"));
    });
    socket.on("end", () => resolveEnded());
  });
  announceTo.write(`AVE-CHILD-LISTEN ${address.port} ${NONCE}\n`);
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
      server.close();
      accepted?.destroy();
    },
  };
}
