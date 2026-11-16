import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One model turn: call a tool with these arguments, or answer with text and end the turn. */
export type ScriptedStep = { tool: string; args: Record<string, unknown> } | { text: string };

export interface ScriptedModel {
  model: string;
  baseUrl: string;
  /** Tool results the app sent back, in order: what the model would have seen. */
  toolResults(): string[];
  close(): Promise<void>;
}

/**
 * A loopback OpenAI-compatible endpoint that plays a fixed script, so a spec drives REAL tool calls
 * (real permission decisions, real tool results, real cards) without a network model.
 * The step is chosen by how many tool results the request already carries, so a retried or repeated
 * request gets the same answer. Requests that offer no tools (titles, summaries) get a short text.
 */
export async function startScriptedModel(steps: readonly ScriptedStep[], model = "scripted-e2e-model"): Promise<ScriptedModel> {
  const toolResults: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role: string; content: unknown }>; tools?: unknown[];
    };
    const results = (body.messages ?? []).filter((message) => message.role === "tool")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const step: ScriptedStep = !body.tools?.length ? { text: "ok" } : steps[results.length] ?? { text: "Done." };
    if (body.tools?.length && results.length > toolResults.length) toolResults.splice(0, toolResults.length, ...results);
    if ("tool" in step) {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: `scripted-call-${results.length}`, type: "function",
        function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null);
      send(response, {}, "tool_calls");
    } else {
      send(response, { role: "assistant", content: step.text }, null);
      send(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    model,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    toolResults: () => [...toolResults],
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
