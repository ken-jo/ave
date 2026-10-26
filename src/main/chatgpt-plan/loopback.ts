import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  /** Resolves with the first request to the callback path. */
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
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, CHATGPT_PLAN_CALLBACK_HOST);
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
  let deliver: (url: URL) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const callback = new Promise<URL>((resolve, reject) => {
    deliver = resolve;
    fail = reject;
  });
  let settled = false;
  let port = preferredPort;
  const server = createServer((request, response) => {
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
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end(CALLBACK_PAGE);
    deliver(url);
  });
  if (preferredPort === 0) {
    port = await listenFetchLoopback(server);
  } else {
    try {
      port = await listen(server, preferredPort);
    } catch {
      port = await listenFetchLoopback(server);
    }
  }
  return {
    redirectUri: `http://${CHATGPT_PLAN_CALLBACK_HOST}:${port}${CHATGPT_PLAN_CALLBACK_PATH}`,
    callback,
    close: () => {
      if (!settled) {
        settled = true;
        fail(new Error("chatgpt-plan callback listener closed"));
      }
      server.close();
      server.closeAllConnections?.();
    },
  };
}
