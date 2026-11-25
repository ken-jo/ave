import net from "node:net";

// Windows retries a refused loopback connect for about two seconds; every probe settles well within this bound.
const PROBE_BOUND_MS = 5_000;

/** Settle within the probe bound, or reject naming what did not. */
export function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${PROBE_BOUND_MS} ms`)), PROBE_BOUND_MS);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

function connect(port: number, sockets: Set<net.Socket> | undefined): net.Socket {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  sockets?.add(socket);
  socket.once("close", () => sockets?.delete(socket));
  return socket;
}

const connectRequest = (authority: string, authorization: string | undefined): string =>
  `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization === undefined ? "" : `Proxy-Authorization: ${authorization}\r\n`}\r\n`;

/** What a proxy port does with a fresh CONNECT: refuse the connection, drop it unanswered, or answer it. */
export function probePort(port: number, sockets?: Set<net.Socket>): Promise<"refused" | "dropped" | "served"> {
  const socket = connect(port, sockets);
  const outcome = new Promise<"refused" | "dropped" | "served">((resolve) => {
    let served = false;
    socket.once("connect", () => socket.write(connectRequest("example.com:443", undefined)));
    socket.on("data", () => { served = true; socket.destroy(); });
    socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "ECONNREFUSED") resolve("refused"); });
    socket.once("close", () => resolve(served ? "served" : "dropped"));
  });
  return within(outcome, `probe of port ${port}`).finally(() => socket.destroy());
}

/** A parent proxy stand-in: it answers every CONNECT and then echoes, recording what reached it through a tunnel. */
export async function echoParentProxy() {
  const sockets = new Set<net.Socket>();
  const drains: Array<() => void> = [];
  let received = "";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) for (const drained of drains.splice(0)) drained();
    });
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      if (head.includes("\r\n\r\n")) {
        received += chunk.toString("latin1");
        socket.write(chunk);
        return;
      }
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get received() { return received; },
    /** Settles once no tunnel socket is open. */
    drained(): Promise<void> {
      return sockets.size === 0 ? Promise.resolve() : new Promise((resolve) => { drains.push(resolve); });
    },
    close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Open a CONNECT tunnel through a proxy port and prove it forwards both ways with one "ping". */
export async function openTunnel(port: number, options: { authority?: string; authorization?: string; sockets?: Set<net.Socket> } = {}): Promise<net.Socket> {
  const socket = connect(port, options.sockets);
  await within(new Promise<void>((resolve, reject) => {
    let response = "";
    socket.once("connect", () => socket.write(connectRequest(options.authority ?? "example.com:443", options.authorization)));
    const onData = (chunk: Buffer): void => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (response.startsWith("HTTP/1.1 200 ") || response.startsWith("HTTP/1.0 200 ")) resolve();
      else reject(new Error(`tunnel refused: ${response.split("\r\n")[0]}`));
    };
    socket.on("data", onData);
    socket.once("close", () => reject(new Error("tunnel closed while opening")));
  }), "tunnel");
  const echoed = new Promise<void>((resolve, reject) => {
    socket.once("data", () => resolve());
    socket.once("close", () => reject(new Error("tunnel closed before its echo")));
  });
  socket.write("ping");
  await within(echoed, "tunnel echo");
  return socket;
}

/** Resolve when a socket closes; a reset reaches it as an error first, which `events.once` would turn into a rejection. */
export function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) resolve();
    else socket.once("close", () => resolve());
  });
}
