import { createSocket } from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export type MxcRawIpUdpSend = "sent" | "refused-local" | "unmeasured";
export type MxcRawIpUdpArrival = "arrived" | "absent" | "unmeasured";

export async function openMxcRawIpUdpListener(address: string, probeId: string, deadline: number) {
  const bindBudget = deadline - Date.now();
  if (bindBudget <= 0) return undefined;

  const socket = createSocket("udp4");
  const nonce = Buffer.from(probeId, "ascii");
  let observed: "arrived" | "unmeasured" | undefined;
  const observation = new Promise<"arrived" | "unmeasured">((resolve) => {
    socket.on("message", (message) => {
      if (observed === undefined && Date.now() < deadline && message.equals(nonce)) {
        observed = "arrived";
        resolve(observed);
      }
    });
    socket.on("error", () => {
      if (observed === undefined) {
        observed = "unmeasured";
        resolve(observed);
      }
    });
  });
  const close = () => {
    try {
      socket.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
    }
  };

  try {
    await Promise.all([
      once(socket, "listening", { signal: AbortSignal.timeout(bindBudget) }),
      Promise.resolve().then(() => socket.bind({ address, port: 0, exclusive: true })),
    ]);
    return {
      address,
      port: socket.address().port,
      async observe(send: MxcRawIpUdpSend, windowMs: number): Promise<MxcRawIpUdpArrival> {
        if (send === "refused-local") return observed === "arrived" ? "arrived" : "absent";
        if (observed !== undefined) return observed;
        if (send !== "sent") return "unmeasured";
        const waitMs = Math.min(windowMs, deadline - Date.now());
        if (waitMs <= 0) return "absent";
        const timer = new AbortController();
        try {
          return await Promise.race([observation, delay(waitMs, "absent" as const, { signal: timer.signal })]);
        } finally {
          timer.abort();
        }
      },
      close,
    };
  } catch {
    close();
    return undefined;
  }
}
