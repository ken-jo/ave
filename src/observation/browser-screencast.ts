import { OBSERVATION_LIMITS } from "../shared/agent-observation.js";

/** The agent tab's existing in-process page session; never a new debugging endpoint. */
export interface ScreencastTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  /** Debugger detach or target destruction. A transient empty URL during a commit is not a close. */
  onClose(listener: (reason: string) => void): () => void;
}

export interface ScreencastFrame { frame: number; data: string; width: number; height: number }

export interface ScreencastCallbacks {
  frame(frame: ScreencastFrame): void;
  /** The previous real frame stays visible but is no longer current. */
  updating(): void;
  /** Called once, when the transport closes or a command fails. */
  ended(error: Error): void;
  /** A uniform (blank or black) frame, as painted at a cross-document commit. */
  isBlank(data: string): boolean;
}

export class ScreencastClosedError extends Error {
  constructor(reason: string) {
    super(`Browser preview session closed (${reason}).`);
    this.name = "ScreencastClosedError";
  }
}

const START_PARAMS = Object.freeze({
  format: "jpeg",
  quality: OBSERVATION_LIMITS.previewJpegQuality,
  maxWidth: OBSERVATION_LIMITS.previewMaxWidth,
  maxHeight: OBSERVATION_LIMITS.previewMaxHeight,
  everyNthFrame: 1,
});

/**
 * One screencast bound to one exact page session. Chromium frames are acknowledged on receipt; forwarding is bounded
 * separately by frame interval, frame size and one unrendered frame in flight.
 */
export class BrowserScreencast {
  private readonly pending = new Set<(error: Error) => void>();
  private readonly stops: (() => void)[] = [];
  private armed = false;
  private finished = false;
  private closedReason: string | undefined;
  private rearming: Promise<void> | undefined;
  private rearmAgain = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private queued: Omit<ScreencastFrame, "frame"> | undefined;
  private inFlight: number | null = null;
  private lastSentAt = -Infinity;
  private committedAt = -Infinity;
  private hasRealFrame = false;
  private frameNumber = 0;

  constructor(private readonly transport: ScreencastTransport, private readonly callbacks: ScreencastCallbacks) {}

  start(): void {
    if (this.armed || this.finished) throw new Error("Browser preview screencast already started.");
    this.armed = true;
    this.stops.push(this.transport.onEvent((method, params) => this.onEvent(method, params)));
    this.stops.push(this.transport.onClose((reason) => this.close(reason)));
    this.track(this.command("Page.startScreencast", START_PARAMS));
    this.watch();
  }

  /** Chromium invalidates the screencast client across cross-document commits; frames simply stop. */
  navigationCommitted(): void {
    if (!this.armed) return;
    this.committedAt = Date.now();
    this.callbacks.updating();
    this.rearm();
  }

  rendered(frame: number): void {
    if (!this.armed || frame !== this.inFlight) return;
    this.inFlight = null;
    this.flush();
  }

  /** Stops forwarding at once; the stop command still uses the same session unless it already closed. */
  stop(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.finish();
    if (this.closedReason !== undefined) return Promise.resolve();
    return this.command("Page.stopScreencast").then(() => undefined, (error: unknown) => {
      if (!(error instanceof ScreencastClosedError)) throw error;
    });
  }

  private onEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Page.screencastVisibilityChanged") {
      if (this.armed && params.visible === false) this.callbacks.updating();
      return;
    }
    if (method !== "Page.screencastFrame") return;
    const sessionId = params.sessionId;
    if (!Number.isSafeInteger(sessionId)) { this.fail(new Error("Invalid browser preview frame acknowledgement id.")); return; }
    // Acknowledge first, independently of renderer delivery, or Chromium throttles and then stops.
    this.track(this.command("Page.screencastFrameAck", { sessionId }));
    if (!this.armed) return;
    this.watch();
    const data = params.data;
    const metadata = params.metadata as { deviceWidth?: unknown; deviceHeight?: unknown } | undefined;
    if (typeof data !== "string" || data.length === 0) { this.fail(new Error("Invalid browser preview frame.")); return; }
    if (data.length > OBSERVATION_LIMITS.previewMaxFrameChars) { this.callbacks.updating(); return; }
    const blank = this.callbacks.isBlank(data);
    if (blank && this.hasRealFrame && Date.now() - this.committedAt < OBSERVATION_LIMITS.previewCommitBlankMs) {
      this.callbacks.updating();
      return;
    }
    if (!blank) this.hasRealFrame = true;
    const size = (value: unknown, limit: number) => typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(Math.round(value), limit) : limit;
    this.queued = { data, width: size(metadata?.deviceWidth, 100_000), height: size(metadata?.deviceHeight, 100_000) };
    this.flush();
  }

  private flush(): void {
    if (!this.armed || !this.queued || this.inFlight !== null || this.flushTimer) return;
    const wait = this.lastSentAt + OBSERVATION_LIMITS.previewMinFrameIntervalMs - Date.now();
    if (wait > 0) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, wait);
      return;
    }
    const queued = this.queued;
    this.queued = undefined;
    this.frameNumber += 1;
    this.inFlight = this.frameNumber;
    this.lastSentAt = Date.now();
    this.callbacks.frame({ frame: this.frameNumber, ...queued });
  }

  private watch(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      if (!this.armed) return;
      this.rearm();
      this.watch();
    }, OBSERVATION_LIMITS.previewSilenceMs);
  }

  private rearm(): void {
    if (this.rearming) { this.rearmAgain = true; return; }
    const run = async (): Promise<void> => {
      do {
        this.rearmAgain = false;
        await this.command("Page.stopScreencast");
        if (!this.armed) return;
        await this.command("Page.startScreencast", START_PARAMS);
      } while (this.rearmAgain && this.armed);
    };
    const current = run();
    this.rearming = current;
    this.track(current.finally(() => { if (this.rearming === current) this.rearming = undefined; }));
  }

  /** Every command settles when the session closes, with a clear closed error instead of a later timeout. */
  private command(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new ScreencastClosedError(this.closedReason));
    return new Promise((resolve, reject) => {
      const settle = (error: Error) => { this.pending.delete(settle); reject(error); };
      this.pending.add(settle);
      this.transport.send(method, params).then((value) => { this.pending.delete(settle); resolve(value); }, (error: unknown) => {
        settle(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private track(work: Promise<unknown>): void {
    work.then(undefined, (error: unknown) => {
      if (error instanceof ScreencastClosedError) return; // close() already ended this preview with the same error.
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    const error = new ScreencastClosedError(reason);
    for (const reject of [...this.pending]) reject(error);
    this.pending.clear();
    this.fail(error);
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.finish();
    this.callbacks.ended(error);
  }

  private finish(): void {
    this.finished = true;
    this.armed = false;
    this.queued = undefined;
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.watchdog = undefined;
    this.flushTimer = undefined;
    for (const stop of this.stops.splice(0)) stop();
  }
}
