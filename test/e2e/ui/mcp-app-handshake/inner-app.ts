// Keep the guest unmodified and use its default parent transport to detect self-echo.
import { App } from "@modelcontextprotocol/ext-apps";

console.log(`E2E_INNER PARENT_IS_SELF:${window.parent === window}`);

const app = new App({ name: "e2e-inner-app", version: "1.0.0" }, {});

app
  .connect()
  .then(async () => {
    console.log("E2E_INNER INNER_CONNECTED");
    // Send raw requests so client-side capability checks cannot supply the denial under test.
    const requests = [
      ["tools/call", { name: "status", arguments: {} }],
      ["ui/message", { role: "user", content: [{ type: "text", text: "draft" }] }],
      ["sampling/createMessage", {}],
    ] as const;
    for (const [index, [method, params]] of requests.entries()) {
      const id = `capability-${index}`;
      const response = new Promise<{ error?: { code: number }; result?: unknown }>((resolve) => {
        const listener = (event: MessageEvent) => {
          if (event.source !== window.parent || event.data?.id !== id) return;
          window.removeEventListener("message", listener);
          resolve(event.data);
        };
        window.addEventListener("message", listener);
      });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      const frame = await response;
      console.log(`E2E_INNER REQUEST_RESULT:${method}:${frame.error?.code ?? "ok"}`);
    }
  })
  .catch((err: unknown) => console.log(`E2E_INNER INNER_CONNECT_FAILED:${String(err)}`));
