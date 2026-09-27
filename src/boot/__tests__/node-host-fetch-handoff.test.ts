import { MockAgent } from "undici";
import { expect, it, vi } from "vitest";

import { createNodeHostFetchTransport } from "../node-host-runtime.js";

it("checks at the Node HTTP request-start hook before accepting a response", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get("https://api.example.test").intercept({ path: "/v1", method: "GET" }).reply(204);
  try {
    const transport = createNodeHostFetchTransport(agent);
    const beforeSend = vi.fn();
    const response = await transport.sendWithHandoff("https://api.example.test/v1", {}, beforeSend);
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(response.status).toBe(204);
  } finally {
    await agent.close();
  }
});

it("aborts the Node request when the handoff check refuses it", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get("https://api.example.test").intercept({ path: "/v1", method: "GET" }).reply(204);
  try {
    const transport = createNodeHostFetchTransport(agent);
    const beforeSend = vi.fn(() => { throw new Error("lease closed"); });
    await expect(transport.sendWithHandoff("https://api.example.test/v1", {}, beforeSend)).rejects.toMatchObject({
      cause: { message: "lease closed" },
    });
    expect(beforeSend).toHaveBeenCalledOnce();
  } finally {
    await agent.close();
  }
});

it("waits for a streaming body before checking the HTTP handoff", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get("https://api.example.test").intercept({ path: "/v1", method: "POST" }).reply(204);
  let signalPull!: () => void;
  let releasePull!: () => void;
  const pulled = new Promise<void>((resolve) => { signalPull = resolve; });
  const resume = new Promise<void>((resolve) => { releasePull = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      signalPull();
      await resume;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  try {
    const beforeSend = vi.fn();
    const pending = createNodeHostFetchTransport(agent).sendWithHandoff(
      "https://api.example.test/v1", { method: "POST", body }, beforeSend,
    );
    await pulled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(beforeSend).not.toHaveBeenCalled();
    releasePull();
    expect((await pending).status).toBe(204);
    expect(beforeSend).toHaveBeenCalledOnce();
  } finally {
    releasePull();
    await agent.close();
  }
});

it("rejects an oversized buffered body before the HTTP handoff", async () => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  try {
    const beforeSend = vi.fn();
    await expect(createNodeHostFetchTransport(agent).sendWithHandoff(
      "https://api.example.test/v1",
      { method: "POST", body: new Uint8Array(16 * 1024 * 1024 + 1) },
      beforeSend,
    )).rejects.toThrow("hostFetch body exceeds 16 MiB");
    expect(beforeSend).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});
