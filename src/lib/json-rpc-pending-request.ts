/** Share pending-request settlement across child and SSE clients; each transport retains its own timeout policy. */
export interface PendingJsonRpcRequest<Timer = NodeJS.Timeout> {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: Timer;
}

interface PendingReply extends PendingJsonRpcRequest {
  method: string;
}

export class JsonRpcPendingRequests {
  private nextId = 1;
  private readonly requests = new Map<number, PendingReply>();

  get nextRequestId(): number {
    return this.nextId;
  }

  allocateId(): number {
    return this.nextId++;
  }

  begin(options: {
    method: string;
    timeoutMs: number;
    unrefTimer: boolean;
    timeoutError: () => Error;
    onTimeout?: () => void;
  }): { id: number; promise: Promise<unknown> } {
    const id = this.allocateId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.take(id);
        if (!pending) return;
        pending.reject(options.timeoutError());
        options.onTimeout?.();
      }, options.timeoutMs);
      if (options.unrefTimer) timer.unref?.();
      this.requests.set(id, { method: options.method, resolve, reject, timer });
    });
    return { id, promise };
  }

  take(id: number): Omit<PendingReply, "timer"> | undefined {
    const pending = this.requests.get(id);
    if (!pending) return undefined;
    this.requests.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  rejectAll(error: Error): void {
    for (const id of this.requests.keys()) this.take(id)?.reject(error);
  }
}
