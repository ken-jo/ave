import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { listenFetchLoopback } from "../../shared/fetch-loopback-listener.js";
import {
  CHATGPT_PLAN_CALLBACK_HOST,
  CHATGPT_PLAN_CALLBACK_PATH,
} from "./endpoints.js";

const CALLBACK_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Ave</title>"
  + "<p>Sign-in finished. You can close this window and return to Ave.</p>";

export interface ChatGptPlanCallbackListener {
  /** The exact redirect URI for this attempt, port included. */
  readonly redirectUri: string;
  /** Resolves with the first valid callback or rejects when the listener stops first. */
  readonly callback: Promise<URL>;
  close(): void;
}

function sameState(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
      server.off("close", onClose);
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("Callback listener closed before binding"));
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Callback listener reported no TCP port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.once("close", onClose);
    try {
      server.listen(port, CHATGPT_PLAN_CALLBACK_HOST);
    } catch (error) {
      onError(error);
    }
  });
}

/**
 * Start the loopback listener before the browser opens. It binds 127.0.0.1
 * only, on an ephemeral port by default; scheme, host and path never change.
 * Only a GET to the callback path,
 * addressed to `127.0.0.1:<port>` and carrying this attempt's `state`,
 * completes it, and only once. Anything else (another page probing the port,
 * a rebinding host name, a stale or forged state) is refused and the listener
 * keeps waiting, so a web page cannot end a sign-in in progress.
 */
export async function startChatGptPlanCallbackListener(
  expectedState: string,
  preferredPort: number = 0,
): Promise<ChatGptPlanCallbackListener> {
  const server = createServer();
  let port: number;
  if (preferredPort === 0) {
    port = await listenFetchLoopback(server);
  } else {
    try {
      port = await listen(server, preferredPort);
    } catch {
      port = await listenFetchLoopback(server);
    }
  }
  let resolve!: (url: URL) => void;
  let reject!: (error: Error) => void;
  const callback = new Promise<URL>((deliver, fail) => {
    resolve = deliver;
    reject = fail;
  });
  // The owner may close the listener before a caller begins observing the callback.
  void callback.catch(() => undefined);
  let settled = false;
  let closing = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const failClosed = () => fail(new Error("chatgpt-plan callback listener closed"));
  const close = () => {
    if (closing) return;
    closing = true;
    failClosed();
    server.close();
    server.closeAllConnections?.();
  };
  // Temporary closes while selecting a Fetch-allowed port do not end the callback.
  server.once("close", () => {
    closing = true;
    failClosed();
  });
  server.on("error", error => {
    fail(error);
    close();
  });
  if (!server.listening) close();
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", `http://${CHATGPT_PLAN_CALLBACK_HOST}:${port}`);
    if (
      request.method !== "GET"
      || url.pathname !== CHATGPT_PLAN_CALLBACK_PATH
      || request.headers.host !== `${CHATGPT_PLAN_CALLBACK_HOST}:${port}`
      || !sameState(url.searchParams.get("state"), expectedState)
      || settled
    ) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    settled = true;
    resolve(url);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end(CALLBACK_PAGE);
  });
  return {
    redirectUri: `http://${CHATGPT_PLAN_CALLBACK_HOST}:${port}${CHATGPT_PLAN_CALLBACK_PATH}`,
    callback,
    close,
  };
}
