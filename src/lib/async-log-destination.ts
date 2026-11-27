import sonicBoom, { type SonicBoom as SonicBoomInstance, type SonicBoomOpts } from "sonic-boom";

const SonicBoom = sonicBoom as unknown as new (options: SonicBoomOpts) => SonicBoomInstance;

export function createAsyncLogDestination(options: SonicBoomOpts) {
  const stream = new SonicBoom(options);
  let pending = 0;
  stream.on("error", () => {});
  stream.on("drop", () => { pending -= 1; });
  stream.on("drain", () => { pending = 0; });
  return {
    stream,
    get pending() { return pending; },
    write(chunk: string): void {
      pending += 1;
      try { stream.write(chunk); } catch { pending -= 1; }
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
