import type { Server } from "node:net";

// Port-blocking table: https://fetch.spec.whatwg.org/#bad-port (2026-10-27).
export const FETCH_BAD_PORTS: readonly number[] = Object.freeze([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

const MAX_LISTEN_ATTEMPTS = 10;

/** Bind an ephemeral IPv4 loopback port that browser and Fetch clients can reach. */
export async function listenFetchLoopback(server: Server): Promise<number> {
  for (let attempt = 1; attempt <= MAX_LISTEN_ATTEMPTS; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        server.off("error", onError);
        server.off("listening", onListening);
        server.off("close", onClose);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onListening = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => onError(new Error("Loopback listener closed before listening"));
      server.once("error", onError);
      server.once("listening", onListening);
      server.once("close", onClose);
      try {
        server.listen(0, "127.0.0.1");
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    const address = server.address();
    if (address !== null && typeof address !== "string" && !FETCH_BAD_PORTS.includes(address.port)) {
      return address.port;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (address === null || typeof address === "string") {
      throw new Error("Loopback listener reported no TCP port");
    }
  }
  throw new Error(`Could not bind a Fetch-allowed loopback port after ${MAX_LISTEN_ATTEMPTS} attempts`);
}
