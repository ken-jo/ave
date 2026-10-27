import { StringDecoder } from "node:string_decoder";

import { CREDENTIAL_FORMAT_PREFIXES } from "../shared/dlp.js";

// Live output is display-only, coalesced and capped to prevent renderer flooding; only the bounded final result reaches the model.
export const TOOL_OUTPUT_PROGRESS_METADATA_KEY = "toolOutputProgress";

export interface ToolOutputProgressSink {
  write(text: string): void;
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

export const MASKED_RELAY_HELD_LIMIT_CHARS = 4096;
/** Tail kept back from an overlong unterminated line; longer than one-line secret shapes. */
const MASKED_RELAY_TAIL_CHARS = 512;
// Hold partial lines through short pauses so delayed credential values arrive before display.
export const MASKED_RELAY_IDLE_MS = 2_000;
const OPEN_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const SECRET_START_PREFIXES: readonly string[] = [
  ...new Set([...CREDENTIAL_FORMAT_PREFIXES.flat(), "-----BEGIN"]),
];

// Hold trailing issuer prefixes and key/value starts that could become credentials.
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

// Mask before delivery; retain partial lines and open private keys so chunk boundaries cannot reveal credentials.
// Release bounded or idle tails only at equivalent masking cuts, preserving prior-line context and never releasing an open private key.
export function createMaskedProgressRelay(
  deliver: (text: string) => void,
  mask: (text: string) => string,
  options: { maxHeldChars?: number } = {},
): ToolOutputProgressSink {
  if (options.maxHeldChars !== undefined && (!Number.isSafeInteger(options.maxHeldChars)
    || options.maxHeldChars < MASKED_RELAY_HELD_LIMIT_CHARS)) throw new Error("Invalid masked output limit.");
  let held = "";
  /** Raw text already delivered since the last line break: the context of what follows on its line. */
  let lineContext = "";
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let discarding: "line" | "private-key" | undefined;
  let discardedTail = "";

  // Mask continuations with delivered line context; if its masked prefix changes, mask new text independently because shown bytes cannot retract.
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
    // Cut overlong lines only where separate masking equals masking the combined text.
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
      if (discarding === "private-key") {
        const combined = discardedTail + text;
        const end = PRIVATE_KEY_END.exec(combined);
        if (!end) { discardedTail = combined.slice(-128); return; }
        text = combined.slice(end.index + end[0].length);
        discarding = undefined;
        discardedTail = "";
      } else if (discarding === "line") {
        const end = text.search(/[\r\n]/);
        if (end === -1) return;
        text = text.slice(end + 1);
        discarding = undefined;
      }
      // Limit each append as well as retained state; a single pipe chunk can be arbitrarily large.
      if (options.maxHeldChars !== undefined && text.length > options.maxHeldChars) {
        for (let at = 0; at < text.length; at += options.maxHeldChars) this.write(text.slice(at, at + options.maxHeldChars));
        return;
      }
      held += text;
      release();
      clearIdle();
      if (options.maxHeldChars !== undefined && held.length > options.maxHeldChars) {
        discarding = openPrivateKeyStart() === -1 ? "line" : "private-key";
        deliver(discarding === "private-key" ? "[REDACTED:PRIVATE_KEY]" : "[REDACTED:OUTPUT_LIMIT]");
        held = "";
        lineContext = "";
      }
      if (held.length > 0) {
        idleTimer = setTimeout(releaseIdle, MASKED_RELAY_IDLE_MS);
        idleTimer.unref?.();
      }
    },
    end() {
      if (ended) return;
      ended = true;
      clearIdle();
      const keyStart = openPrivateKeyStart();
      const rest = keyStart === -1 ? held : held.slice(0, keyStart);
      held = "";
      if (rest.length > 0) deliver(maskOnLine(rest));
      if (keyStart !== -1) deliver("[REDACTED:PRIVATE_KEY]");
      lineContext = "";
      discardedTail = "";
      discarding = undefined;
    },
  };
}

export const LIVE_OUTPUT_FLUSH_MS = 100;
export const LIVE_OUTPUT_FLUSH_CHARS = 4096;
export const LIVE_OUTPUT_LIMIT_CHARS = 256 * 1024;
export const LIVE_OUTPUT_LIMIT_NOTICE =
  "\n[live output limit reached; the complete result arrives when the command finishes]\n";

export interface LiveOutputStream {
  write(stream: "stdout" | "stderr", chunk: Buffer): void;
  close(): void;
}

export function createLiveOutputStream(sink: ToolOutputProgressSink): LiveOutputStream {
  // Decode each pipe separately so split code points reassemble without cross-pipe byte interleaving.
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
