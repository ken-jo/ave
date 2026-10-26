import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { FETCH_BAD_PORTS, listenFetchLoopback } from "../fetch-loopback-listener.js";

describe("fetch loopback listener", () => {
  it("keeps the complete port-blocking table", () => {
    expect(FETCH_BAD_PORTS).toHaveLength(83);
    expect(FETCH_BAD_PORTS).toContain(0);
    expect(FETCH_BAD_PORTS).toContain(6000);
    expect(FETCH_BAD_PORTS).toContain(10080);
    expect(new Set(FETCH_BAD_PORTS).size).toBe(FETCH_BAD_PORTS.length);
  });

  it("closes a blocked first assignment before retrying", async () => {
    const server = createServer();
    const address = vi.spyOn(server, "address")
      .mockReturnValueOnce({ address: "127.0.0.1", family: "IPv4", port: 6000 })
      .mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 43210 });
    const listen = vi.spyOn(server, "listen");
    const close = vi.spyOn(server, "close");
    try {
      await expect(listenFetchLoopback(server)).resolves.toBe(43210);
      expect(listen).toHaveBeenCalledTimes(2);
      expect(listen).toHaveBeenCalledWith(0, "127.0.0.1");
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(listen.mock.invocationCallOrder[1]!);
      expect(server.listening).toBe(true);
      expect(server.listenerCount("error")).toBe(0);
    } finally {
      address.mockRestore();
      listen.mockRestore();
      close.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds blocked assignments and leaves no listener behind", async () => {
    const server = createServer();
    const listeningListeners = server.listenerCount("listening");
    const address = vi.spyOn(server, "address")
      .mockReturnValue({ address: "127.0.0.1", family: "IPv4", port: 10080 });
    const listen = vi.spyOn(server, "listen");
    const close = vi.spyOn(server, "close");
    try {
      await expect(listenFetchLoopback(server)).rejects.toThrow(/after 10 attempts/u);
      expect(listen).toHaveBeenCalledTimes(10);
      expect(close).toHaveBeenCalledTimes(10);
      expect(server.listening).toBe(false);
      expect(server.listenerCount("error")).toBe(0);
      expect(server.listenerCount("listening")).toBe(listeningListeners);
      expect(server.listenerCount("close")).toBe(0);
    } finally {
      address.mockRestore();
      listen.mockRestore();
      close.mockRestore();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
