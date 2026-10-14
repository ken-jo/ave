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

export type ToolOutputProgressSink = (text: string) => void;

export function toolOutputProgressFromMetadata(
  metadata: Record<string, unknown>,
): ToolOutputProgressSink | undefined {
  const sink = metadata[TOOL_OUTPUT_PROGRESS_METADATA_KEY];
  return typeof sink === "function" ? sink as ToolOutputProgressSink : undefined;
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
    sink(text);
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
    },
  };
}
