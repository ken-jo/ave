/** Bound inter-chunk stalls and cancel the reader on every exit to release the connection. */
import { raceWithTimeout } from "../../shared/abortable-deadline.js";

export async function* stallGuarded(
  body: ReadableStream<Uint8Array>,
  stallMs: number,
  stallError: () => Error,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await raceWithTimeout(reader.read(), stallMs, stallError);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // A cancel error changes nothing: the read already ended one way or another.
    await reader.cancel().catch(() => undefined);
  }
}
