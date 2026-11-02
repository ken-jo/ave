/** Child side of a host-owned worker handle: local listeners fed by host events, control traffic sent back as subscription sends. Child-safe: no host state. */
import {
  WORKER_CONTROL_METHOD,
  WorkerControlError,
  type PluginWorkerControl,
  type PluginWorkerExitInfo,
  type SpawnedPluginWorker,
  type WorkerControlRemoteError,
  type WorkerControlRequestHandler,
  type WorkerControlRequestOptions,
} from "../public-contract.js";
import { describeNonJson } from "../../shared/json-representable.js";
import { errorMessage } from "../../shared/error-message.js";
import { HostApiBoundaryError, type WireWorkerEvent, type WireWorkerSend } from "./host-api-wire.js";

const PRE_LISTENER_EVENT_MAX = 256;
const PRE_LISTENER_BYTES_MAX = 1024 * 1024;
const RPC_INTERNAL_ERROR = -32603;
const RPC_REQUEST_CANCELLED = -32800;
const RPC_METHOD_NOT_FOUND = -32601;

export interface ChildWorkerHandleDeps {
  readonly control: PluginWorkerControl;
  readonly pid: number | undefined;
  /** Send one payload for this handle; dropped by the host once the handle is gone. */
  readonly send: (payload: WireWorkerSend) => void;
  /** Close the registration on both sides (the plugin's `stop`). */
  readonly dispose: () => void;
}

export interface ChildWorkerHandle {
  readonly worker: SpawnedPluginWorker;
  /** Feed one host event; throws on a malformed one. */
  readonly deliver: (event: WireWorkerEvent) => void;
  /** Local teardown after disposal or revocation: drop listeners and settle pending calls. */
  readonly clear: () => void;
  /** Set when output arrived before any listener and overflowed the bounded buffer. */
  readonly backlogError: () => HostApiBoundaryError | undefined;
  /** The handle reached the plugin: from now on, traffic with no listener is dropped (requests are refused). */
  readonly handoffComplete: () => void;
}

function assertCall(method: string, params: unknown): void {
  if (typeof method !== "string" || !WORKER_CONTROL_METHOD.test(method)) {
    throw new TypeError(`[worker-control] method '${String(method)}' must match ${String(WORKER_CONTROL_METHOD)}`);
  }
  const nonJson = describeNonJson(params, "params");
  if (nonJson) throw new TypeError(`[worker-control] ${nonJson}`);
}

function remoteOf(error: unknown, signal: AbortSignal): WorkerControlRemoteError {
  if (error instanceof WorkerControlError && error.remote) return error.remote;
  if (signal.aborted) return { code: RPC_REQUEST_CANCELLED, message: "the worker cancelled this request" };
  return { code: RPC_INTERNAL_ERROR, message: errorMessage(error) };
}

/** Build the plugin-facing handle for one adopted worker subscription. */
export function createChildWorkerHandle(deps: ChildWorkerHandleDeps): ChildWorkerHandle {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(info: PluginWorkerExitInfo) => void> = [];
  const notificationListeners: Array<(method: string, params: unknown) => void> = [];
  let pendingStdout: string[] = [];
  let pendingStderr: string[] = [];
  let pendingNotifications: Array<{ method: string; params: unknown }> = [];
  let pendingRequests: Array<{ id: number; method: string; params: unknown }> = [];
  let pendingBytes = 0;
  let pendingEvents = 0;
  let backlogError: HostApiBoundaryError | undefined;
  let terminalExit: PluginWorkerExitInfo | undefined;
  let requestHandler: WorkerControlRequestHandler | undefined;
  let cleared = false;
  let handedOff = false;
  let nextId = 0;
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; detach?: () => void }>();
  const workerRequests = new Map<number, AbortController>();

  const ended = (): WorkerControlError =>
    new WorkerControlError("worker-incarnation-ended", "[worker-control] the worker incarnation ended; nothing is replayed");

  const settleAll = (error: Error): void => {
    for (const call of calls.values()) {
      call.detach?.();
      call.reject(error);
    }
    calls.clear();
    for (const controller of workerRequests.values()) controller.abort(error);
    workerRequests.clear();
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    pendingStdout = [];
    pendingStderr = [];
    pendingNotifications = [];
    pendingRequests = [];
    pendingBytes = 0;
    pendingEvents = 0;
    stdoutListeners.length = 0;
    stderrListeners.length = 0;
    exitListeners.length = 0;
    notificationListeners.length = 0;
    settleAll(ended());
  };

  const overflow = (): void => {
    backlogError = new HostApiBoundaryError(
      "payload-too-large",
      "Worker output exceeded the pre-listener buffer.",
      { limit: PRE_LISTENER_BYTES_MAX },
    );
    deps.dispose();
  };

  // Only the handoff window buffers: after it, a plugin that registered no listener asked for none of this traffic.
  const buffer = (bytes: number, push: () => void): void => {
    if (backlogError || cleared || handedOff) return;
    if (pendingEvents >= PRE_LISTENER_EVENT_MAX || pendingBytes + bytes > PRE_LISTENER_BYTES_MAX) {
      overflow();
      return;
    }
    push();
    pendingBytes += bytes;
    pendingEvents += 1;
  };

  const runRequest = (id: number, method: string, params: unknown): void => {
    const controller = new AbortController();
    workerRequests.set(id, controller);
    const handler = requestHandler!;
    void Promise.resolve()
      .then(() => handler(method, params, controller.signal))
      .then(
        (result) => {
          if (workerRequests.get(id) !== controller) return;
          workerRequests.delete(id);
          const nonJson = describeNonJson(result, "result");
          deps.send(nonJson
            ? { kind: "response", id, error: { code: RPC_INTERNAL_ERROR, message: `the plugin answered with ${nonJson}` } }
            : { kind: "response", id, result: result === undefined ? null : result });
        },
        (error: unknown) => {
          if (workerRequests.get(id) !== controller) return;
          workerRequests.delete(id);
          deps.send({ kind: "response", id, error: remoteOf(error, controller.signal) });
        },
      );
  };

  const deliver = (event: WireWorkerEvent): void => {
    if (cleared) return;
    switch (event.kind) {
      case "stdout":
        if (stdoutListeners.length === 0) buffer(event.chunk.length * 2, () => pendingStdout.push(event.chunk));
        else for (const listener of stdoutListeners) listener(event.chunk);
        return;
      case "stderr":
        if (stderrListeners.length === 0) buffer(event.chunk.length * 2, () => pendingStderr.push(event.chunk));
        else for (const listener of stderrListeners) listener(event.chunk);
        return;
      case "result":
      case "error": {
        const call = calls.get(event.id);
        if (!call) return;
        calls.delete(event.id);
        call.detach?.();
        if (event.kind === "result") call.resolve(event.result);
        else call.reject(new WorkerControlError(event.error.code, event.error.message, event.error.remote));
        return;
      }
      case "request":
        if (requestHandler) runRequest(event.id, event.method, event.params);
        else if (handedOff) {
          deps.send({ kind: "response", id: event.id, error: { code: RPC_METHOD_NOT_FOUND, message: "the plugin registered no request handler" } });
        } else buffer(0, () => pendingRequests.push({ id: event.id, method: event.method, params: event.params }));
        return;
      case "notification":
        if (notificationListeners.length === 0) {
          buffer(0, () => pendingNotifications.push({ method: event.method, params: event.params }));
        } else {
          for (const listener of notificationListeners) listener(event.method, event.params);
        }
        return;
      case "cancel":
        workerRequests.get(event.id)?.abort(
          new WorkerControlError("worker-request-cancelled", "the worker cancelled this request"),
        );
        return;
      case "exit":
        if (terminalExit) return;
        terminalExit = { code: event.code, signal: event.signal as NodeJS.Signals | null, reason: event.reason };
        settleAll(ended());
        for (const listener of exitListeners) listener(terminalExit);
        // Wait for the host-owned exit notification; child listeners do not decide process lifetime.
        return;
    }
  };

  const subscribe = <T>(listeners: T[], queued: () => readonly unknown[], drain: (listener: T) => void, listener: T): void => {
    if (backlogError) throw backlogError;
    listeners.push(listener);
    const count = queued().length;
    pendingEvents -= count;
    try {
      drain(listener);
    } catch (error) {
      deps.dispose();
      throw error;
    }
  };

  const base = {
    pid: deps.pid,
    stop: deps.dispose,
    onStderr: (listener: (chunk: string) => void) =>
      subscribe(stderrListeners, () => pendingStderr, (taken) => {
        const queued = pendingStderr;
        pendingStderr = [];
        pendingBytes -= queued.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
        for (const chunk of queued) taken(chunk);
      }, listener),
    onExit: (listener: (info: PluginWorkerExitInfo) => void) => {
      if (backlogError) throw backlogError;
      exitListeners.push(listener);
      if (terminalExit) listener(terminalExit);
    },
  };

  const worker: SpawnedPluginWorker = deps.control === "output-only-v1"
    ? {
        ...base,
        control: "output-only-v1",
        onStdout: (listener) =>
          subscribe(stdoutListeners, () => pendingStdout, (taken) => {
            const queued = pendingStdout;
            pendingStdout = [];
            pendingBytes -= queued.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
            for (const chunk of queued) taken(chunk);
          }, listener),
      }
    : {
        ...base,
        control: "stdio-control-v1",
        request: (method: string, params?: unknown, options: WorkerControlRequestOptions = {}) => {
          assertCall(method, params);
          if (cleared || terminalExit) return Promise.reject(ended());
          if (options.signal?.aborted) {
            return Promise.reject(new WorkerControlError("worker-request-cancelled", `request '${method}' was cancelled`));
          }
          const id = nextId++;
          return new Promise<unknown>((resolve, reject) => {
            const call: { resolve: (value: unknown) => void; reject: (error: Error) => void; detach?: () => void } = { resolve, reject };
            calls.set(id, call);
            const signal = options.signal;
            if (signal) {
              const onAbort = (): void => {
                if (!calls.delete(id)) return;
                deps.send({ kind: "cancel", id });
                reject(new WorkerControlError("worker-request-cancelled", `request '${method}' was cancelled`));
              };
              signal.addEventListener("abort", onAbort, { once: true });
              call.detach = () => signal.removeEventListener("abort", onAbort);
            }
            deps.send({ kind: "request", id, method, ...(params !== undefined ? { params } : {}) });
          });
        },
        notify: (method: string, params?: unknown) => {
          assertCall(method, params);
          if (cleared || terminalExit) return Promise.reject(ended());
          const id = nextId++;
          return new Promise<void>((resolve, reject) => {
            calls.set(id, { resolve: () => resolve(), reject });
            deps.send({ kind: "notification", id, method, ...(params !== undefined ? { params } : {}) });
          });
        },
        onRequest: (handler: WorkerControlRequestHandler) => {
          if (typeof handler !== "function") throw new TypeError("[worker-control] onRequest needs a function");
          if (requestHandler) throw new Error("[worker-control] a request handler is already registered");
          if (backlogError) throw backlogError;
          requestHandler = handler;
          const queued = pendingRequests;
          pendingRequests = [];
          pendingEvents -= queued.length;
          for (const request of queued) runRequest(request.id, request.method, request.params);
        },
        onNotification: (listener: (method: string, params: unknown) => void) =>
          subscribe(notificationListeners, () => pendingNotifications, (taken) => {
            const queued = pendingNotifications;
            pendingNotifications = [];
            for (const { method, params } of queued) taken(method, params);
          }, listener),
      };

  return {
    worker,
    deliver,
    clear,
    backlogError: () => backlogError,
    handoffComplete: () => {
      handedOff = true;
    },
  };
}
