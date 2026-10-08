/**
 * A response body read chunk by chunk, where a gap longer than `stallMs`
 * fails the read instead of hanging it (design §9.2, §6.2). The reader is
 * cancelled on every exit, which releases the connection of a stalled or
 * oversized body.
 */
export async function* stallGuarded(
  body: ReadableStream<Uint8Array>,
  stallMs: number,
  stallError: () => Error,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stallError()), stallMs);
      });
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // A cancel error changes nothing: the read already ended one way or another.
    await reader.cancel().catch(() => undefined);
  }
}
