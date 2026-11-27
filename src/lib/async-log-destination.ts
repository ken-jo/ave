import sonicBoom, { type SonicBoom as SonicBoomInstance, type SonicBoomOpts } from "sonic-boom";

const SonicBoom = sonicBoom as unknown as new (options: SonicBoomOpts) => SonicBoomInstance;

export function createAsyncLogDestination(options: SonicBoomOpts, onProgress?: () => void) {
  const stream = new SonicBoom({ ...options, maxWriteRetries: 3 });
  const pending = new Map<number, { bytes: number; counted: boolean }>();
  let sequence = 0;
  let dropped = 0;
  let failed = false;
  stream.on("error", () => {
    if (failed) return;
    failed = true;
    for (const record of pending.values()) {
      if (record.counted) dropped += 1;
    }
    pending.clear();
    onProgress?.();
    stream.destroy();
  });
  const recordDrop = () => {
    if (pending.get(sequence)?.counted) dropped += 1;
    pending.delete(sequence);
  };
  stream.on("drop", recordDrop);
  stream.on("write", (bytes: number) => {
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
    write(chunk: string, countDrops = true): void {
      if (failed) {
        if (countDrops) {
          dropped += 1;
          onProgress?.();
        }
        return;
      }
      pending.set(++sequence, { bytes: Buffer.byteLength(chunk), counted: countDrops });
      try { stream.write(chunk); } catch { recordDrop(); }
    },
    flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (pending.size === 0) {
          resolve();
          return;
        }
        try {
          stream.flush(() => resolve());
        } catch { resolve(); }
      });
    },
  };
}
