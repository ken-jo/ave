import sonicBoom, { type SonicBoom as SonicBoomInstance, type SonicBoomOpts } from "sonic-boom";

const SonicBoom = sonicBoom as unknown as new (options: SonicBoomOpts) => SonicBoomInstance;

export function createAsyncLogDestination(options: SonicBoomOpts, onDrain?: () => void) {
  const stream = new SonicBoom(options);
  let pending = 0;
  let dropped = 0;
  let countDrop = true;
  stream.on("error", () => {});
  const recordDrop = () => {
    pending -= 1;
    if (countDrop) dropped += 1;
  };
  stream.on("drop", recordDrop);
  stream.on("drain", () => {
    pending = 0;
    onDrain?.();
  });
  return {
    stream,
    get pending() { return pending; },
    get dropped() { return dropped; },
    takeDropped(): number {
      const count = dropped;
      dropped = 0;
      return count;
    },
    write(chunk: string, countDrops = true): void {
      countDrop = countDrops;
      pending += 1;
      try { stream.write(chunk); } catch { recordDrop(); }
    },
    flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (pending === 0) {
          resolve();
          return;
        }
        try {
          stream.flush((error) => {
            if (!error) pending = 0;
            resolve();
          });
        } catch { resolve(); }
      });
    },
  };
}
