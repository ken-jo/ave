import sonicBoom, { type SonicBoom as SonicBoomInstance, type SonicBoomOpts } from "sonic-boom";

const SonicBoom = sonicBoom as unknown as new (options: SonicBoomOpts & { maxWriteRetries: number }) => SonicBoomInstance;

export function createAsyncLogDestination(
  options: SonicBoomOpts,
  onProgress?: () => void,
  recoverFromError?: (error: NodeJS.ErrnoException) => boolean,
) {
  const stream = new SonicBoom({ ...options, maxWriteRetries: 3 });
  const pending = new Map<number, { bytes: number; counted: boolean }>();
  let pendingBytes = 0;
  let sequence = 0;
  let dropped = 0;
  let failed = false;
  let recoveredError: Error | undefined;
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (failed) return;
    if (recoverFromError?.(error)) {
      recoveredError = error;
      return;
    }
    failed = true;
    for (const record of pending.values()) {
      if (record.counted) dropped += 1;
    }
    pending.clear();
    pendingBytes = 0;
    onProgress?.();
    stream.destroy();
  });
  const recordDrop = () => {
    const record = pending.get(sequence);
    if (!record) return;
    if (record.counted) dropped += 1;
    pendingBytes -= record.bytes;
    pending.delete(sequence);
  };
  stream.on("drop", recordDrop);
  stream.on("write", (bytes: number) => {
    pendingBytes = Math.max(0, pendingBytes - bytes);
    for (const [id, record] of pending) {
      if (bytes < record.bytes) {
        record.bytes -= bytes;
        break;
      }
      bytes -= record.bytes;
      pending.delete(id);
    }
  });
  stream.on("drain", () => {
    onProgress?.();
  });
  return {
    stream,
    get pending() { return pending.size; },
    get dropped() { return dropped; },
    takeDropped(): number {
      const count = dropped;
      dropped = 0;
      return count;
    },
    write(chunk: string, countDrops = true, maxPendingBytes = Infinity): void {
      const bytes = Buffer.byteLength(chunk);
      if (failed || pendingBytes + bytes > maxPendingBytes) {
        if (countDrops) {
          dropped += 1;
          onProgress?.();
        }
        return;
      }
      pending.set(++sequence, { bytes, counted: countDrops });
      pendingBytes += bytes;
      try { stream.write(chunk); } catch { recordDrop(); }
    },
    flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (pending.size === 0) {
          resolve();
          return;
        }
        const flush = (): void => {
          try {
            stream.flush((error) => {
              if (error && error === recoveredError && pending.size > 0) flush();
              else resolve();
            });
          } catch { resolve(); }
        };
        flush();
      });
    },
  };
}
