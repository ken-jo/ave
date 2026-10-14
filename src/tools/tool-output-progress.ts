import { StringDecoder } from "node:string_decoder";

import { CREDENTIAL_FORMAT_PREFIXES } from "../shared/dlp.js";

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

/** Unterminated text the relay holds before releasing all but a short tail. */
export const MASKED_RELAY_HELD_LIMIT_CHARS = 4096;
/** Tail kept back from an overlong unterminated line; longer than one-line secret shapes. */
const MASKED_RELAY_TAIL_CHARS = 512;
/**
 * Quiet time after which the held partial line (a prompt waiting for input) is
 * released. Long enough that a value written after a short pause (`Bearer `,
 * then the token) still arrives while its line is held whole.
 */
export const MASKED_RELAY_IDLE_MS = 2_000;
const OPEN_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const SECRET_START_PREFIXES: readonly string[] = [
  ...new Set([...CREDENTIAL_FORMAT_PREFIXES.flat(), "-----BEGIN"]),
];

/**
 * Whether a trailing run of non-whitespace could be, or begin, a credential
 * the masker recognizes: it holds a known issuer prefix (or the start of one)
 * at a token boundary, or a key/value separator whose value may continue.
 */
function couldBeginSecret(run: string): boolean {
  if (/[=:]/.test(run)) return true;
  for (let at = 0; at < run.length; at++) {
    if (at > 0 && /[A-Za-z0-9]/.test(run[at - 1]!)) continue;
    const rest = run.slice(at);
    if (SECRET_START_PREFIXES.some((prefix) => rest.startsWith(prefix) || prefix.startsWith(rest))) return true;
  }
  return false;
}
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Masks live output with the same masker as the final display result before
 * any of it is delivered, so a credential is never shown while it streams.
 *
 * Output arrives in arbitrary chunks, so a secret can be split between two of
 * them. Every credential and PII shape the masker knows is confined to one
 * line except a PEM private key block, so the relay carries over the
 * unterminated tail after the last `\n` or `\r` (a progress bar's `\r` ends
 * its line), and everything from an unterminated private-key header onward,
 * until the rest arrives or the stream ends. A cut is used only when masking
 * the two sides separately equals masking them together; otherwise the relay
 * holds back further.
 *
 * The unterminated tail is bounded so output without line breaks still moves:
 * past {@link MASKED_RELAY_HELD_LIMIT_CHARS} all but its last
 * {@link MASKED_RELAY_TAIL_CHARS} characters are released, and after
 * {@link MASKED_RELAY_IDLE_MS} without new data (a prompt waiting) the partial
 * line is released, masked, except a trailing non-whitespace run that could
 * be the start of a credential ({@link couldBeginSecret}) or whose masking
 * depends on the text before it (a Bearer value): that run waits for the rest
 * of the secret or the end of the stream. Neither bound releases an open
 * private-key block.
 *
 * Text of a line released before its line break stays as context: what
 * follows on the same line is masked together with it (`Authorization: Bearer `
 * shown at the bound, the token after it), and only the part not yet shown is
 * delivered, so the value is masked as the final result masks the whole line.
 * The masker decides what context matters; the relay keeps no rule list.
 */
export function createMaskedProgressRelay(
  deliver: (text: string) => void,
  mask: (text: string) => string,
): ToolOutputProgressSink {
  let held = "";
  /** Raw text already delivered since the last line break: the context of what follows on its line. */
  let lineContext = "";
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `text` masked as the continuation of the delivered `lineContext`: the
   * masked line minus what was shown of it. When the masked context is no
   * longer a prefix (it would have been masked differently), the shown part
   * cannot be taken back, and `text` is masked on its own.
   */
  const maskOnLine = (text: string): string => {
    if (lineContext.length === 0) return mask(text);
    const shown = mask(lineContext);
    const whole = mask(lineContext + text);
    return whole.startsWith(shown) ? whole.slice(shown.length) : mask(text);
  };

  const advanceLineContext = (delivered: string): void => {
    const line = lineContext + delivered;
    const lineStart = Math.max(line.lastIndexOf("\n"), line.lastIndexOf("\r")) + 1;
    lineContext = line.slice(Math.max(lineStart, line.length - MASKED_RELAY_HELD_LIMIT_CHARS));
  };

  const cutIsClean = (cut: number): boolean =>
    maskOnLine(held.slice(0, cut)) + mask(held.slice(cut)) === maskOnLine(held);

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

  const emit = (cut: number): void => {
    if (cut <= 0) return;
    const raw = held.slice(0, cut);
    const text = maskOnLine(raw);
    held = held.slice(cut);
    advanceLineContext(raw);
    deliver(text);
  };

  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const release = (): void => {
    const keyStart = openPrivateKeyStart();
    let cut = previousBreak(held.length);
    if (keyStart !== -1) cut = Math.min(cut, keyStart);
    while (cut > 0 && !cutIsClean(cut)) cut = previousBreak(cut - 1);
    emit(cut);
    if (keyStart !== -1 || held.length <= MASKED_RELAY_HELD_LIMIT_CHARS) return;
    // An overlong unterminated line: release all but a short tail, stepping
    // back while the cut would split something the masker recognizes.
    cut = held.length - MASKED_RELAY_TAIL_CHARS;
    while (cut > 0 && !cutIsClean(cut)) cut -= MASKED_RELAY_TAIL_CHARS;
    emit(cut);
  };

  const releaseIdle = (): void => {
    idleTimer = undefined;
    if (ended) return;
    const keyStart = openPrivateKeyStart();
    if (keyStart !== -1) {
      emit(keyStart);
      return;
    }
    const runStart = held.search(/\S*$/);
    const run = held.slice(runStart);
    const holdRun = run.length > 0
      && (couldBeginSecret(run) || mask(run) !== run || !cutIsClean(runStart));
    emit(holdRun ? runStart : held.length);
  };

  return {
    write(text) {
      if (ended || text.length === 0) return;
      held += text;
      release();
      clearIdle();
      if (held.length > 0) {
        idleTimer = setTimeout(releaseIdle, MASKED_RELAY_IDLE_MS);
        idleTimer.unref?.();
      }
    },
    end() {
      if (ended) return;
      ended = true;
      clearIdle();
      const rest = held;
      held = "";
      if (rest.length > 0) deliver(maskOnLine(rest));
      lineContext = "";
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
