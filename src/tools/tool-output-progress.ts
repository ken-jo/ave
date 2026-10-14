import { StringDecoder } from "node:string_decoder";

/**
 * Live output of a running host shell tool, for display only.
 *
 * The executor places a sink under {@link TOOL_OUTPUT_PROGRESS_METADATA_KEY}
 * in the tool's context metadata when a caller subscribed to tool output. The
 * final tool_result is unaffected: it keeps its bounded form and remains the
 * only thing the model reads. The stream is coalesced and capped so a command
 * that prints without pause cannot flood the renderer.
 */
export const TOOL_OUTPUT_PROGRESS_METADATA_KEY = "toolOutputProgress";

export interface ToolOutputProgressSink {
  write(text: string): void;
  /** No more output follows; deliver anything still held. Idempotent. */
  end(): void;
}

export function toolOutputProgressFromMetadata(
  metadata: Record<string, unknown>,
): ToolOutputProgressSink | undefined {
  const sink = metadata[TOOL_OUTPUT_PROGRESS_METADATA_KEY] as Partial<ToolOutputProgressSink> | undefined;
  return typeof sink?.write === "function" && typeof sink.end === "function"
    ? sink as ToolOutputProgressSink
    : undefined;
}

/** Held text past which an unbroken line is released through the fallback window. */
export const MASKED_RELAY_MAX_HELD_CHARS = 64 * 1024;
/** Tail kept back from an overlong line, longer than any single-line secret shape. */
export const MASKED_RELAY_FALLBACK_WINDOW_CHARS = 4096;
const OPEN_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Masks live output with the same masker as the final display result before
 * any of it is delivered, so a credential is never shown while it streams.
 *
 * Output arrives in arbitrary chunks, so a secret can be split between two of
 * them. Every credential and PII shape the masker knows is confined to one
 * line except a PEM private key block, so the relay carries over the
 * unfinished last line, and everything from an unterminated private-key
 * header onward, until the rest arrives or the stream ends. A cut is used only
 * when masking the two sides separately equals masking them together; when
 * it does not, the relay holds back to an earlier line break. A line that
 * grows past {@link MASKED_RELAY_MAX_HELD_CHARS} without a break is released
 * except for its last {@link MASKED_RELAY_FALLBACK_WINDOW_CHARS} characters,
 * under the same equality check.
 */
export function createMaskedProgressRelay(
  deliver: (text: string) => void,
  mask: (text: string) => string,
): ToolOutputProgressSink {
  let held = "";
  let ended = false;

  const cutIsClean = (cut: number): boolean =>
    mask(held.slice(0, cut)) + mask(held.slice(cut)) === mask(held);

  const previousBreak = (before: number): number =>
    Math.max(held.lastIndexOf("\n", before - 1), held.lastIndexOf("\r", before - 1)) + 1;

  const openPrivateKeyStart = (): number => {
    let open = -1;
    OPEN_PRIVATE_KEY.lastIndex = 0;
    for (let match = OPEN_PRIVATE_KEY.exec(held); match; match = OPEN_PRIVATE_KEY.exec(held)) {
      if (open === -1 && !PRIVATE_KEY_END.test(held.slice(match.index))) open = match.index;
    }
    return open;
  };

  const release = (): void => {
    let cut = previousBreak(held.length);
    const keyStart = openPrivateKeyStart();
    if (keyStart !== -1) cut = Math.min(cut, keyStart);
    if (cut === 0 && keyStart === -1 && held.length > MASKED_RELAY_MAX_HELD_CHARS) {
      cut = held.length - MASKED_RELAY_FALLBACK_WINDOW_CHARS;
    }
    while (cut > 0 && !cutIsClean(cut)) cut = previousBreak(cut - 1);
    if (cut <= 0) return;
    const text = mask(held.slice(0, cut));
    held = held.slice(cut);
    deliver(text);
  };

  return {
    write(text) {
      if (ended || text.length === 0) return;
      held += text;
      release();
    },
    end() {
      if (ended) return;
      ended = true;
      const rest = held;
      held = "";
      if (rest.length > 0) deliver(mask(rest));
    },
  };
}

/** Delay before buffered text is delivered, so bursts share one frame. */
export const LIVE_OUTPUT_FLUSH_MS = 100;
/** Buffered text that is delivered at once instead of waiting for the delay. */
export const LIVE_OUTPUT_FLUSH_CHARS = 4096;
/** Text delivered per tool call before live output stops. */
export const LIVE_OUTPUT_LIMIT_CHARS = 256 * 1024;
export const LIVE_OUTPUT_LIMIT_NOTICE =
  "\n[live output limit reached; the complete result arrives when the command finishes]\n";

export interface LiveOutputStream {
  write(stream: "stdout" | "stderr", chunk: Buffer): void;
  /** Deliver what is buffered, including an incomplete trailing code point. */
  close(): void;
}

export function createLiveOutputStream(sink: ToolOutputProgressSink): LiveOutputStream {
  // One decoder per pipe: a code point split across two reads of the same
  // pipe is reassembled, never interleaved with the other pipe's bytes.
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let pending = "";
  let delivered = 0;
  let exhausted = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0 || exhausted) return;
    const room = LIVE_OUTPUT_LIMIT_CHARS - delivered;
    let text = pending;
    pending = "";
    if (text.length >= room) {
      text = text.slice(0, room) + LIVE_OUTPUT_LIMIT_NOTICE;
      exhausted = true;
    }
    delivered += text.length;
    sink.write(text);
  };

  const enqueue = (text: string): void => {
    if (text.length === 0 || exhausted || closed) return;
    pending += text;
    if (pending.length >= LIVE_OUTPUT_FLUSH_CHARS || delivered + pending.length >= LIVE_OUTPUT_LIMIT_CHARS) {
      flush();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(flush, LIVE_OUTPUT_FLUSH_MS);
      timer.unref?.();
    }
  };

  return {
    write(stream, chunk) {
      if (closed || exhausted || chunk.length === 0) return;
      enqueue(decoders[stream].write(chunk));
    },
    close() {
      if (closed) return;
      enqueue(decoders.stdout.end());
      enqueue(decoders.stderr.end());
      closed = true;
      flush();
      sink.end();
    },
  };
}
