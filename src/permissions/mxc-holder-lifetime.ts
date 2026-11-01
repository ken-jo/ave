/** Retain native and listener ownership until cleanup establishes termination. */
interface MxcHolderLifetime {
  readonly label: string;
  readonly cleanup: () => Promise<void>;
  pending?: Promise<void>;
}

const holders = new Set<MxcHolderLifetime>();
let admissionClosedReason: string | undefined;
let draining: Promise<void> | undefined;

export function sealMxcHolderLifetimeAdmission(reason: string): void {
  admissionClosedReason ??= reason;
}

function releaseHolder(holder: MxcHolderLifetime): Promise<void> {
  if (!holders.has(holder)) return Promise.resolve();
  if (holder.pending) return holder.pending;
  holder.pending = Promise.resolve().then(holder.cleanup).then(() => {
    holders.delete(holder);
  }).finally(() => { holder.pending = undefined; });
  return holder.pending;
}

/** Register before native creation; the closure also owns resources allocated by a failed start. */
export function registerMxcHolderLifetime(label: string, cleanup: () => Promise<void>): { release(): Promise<void> } {
  if (admissionClosedReason !== undefined) throw new Error(`Container holder admission is closed: ${admissionClosedReason}`);
  const holder: MxcHolderLifetime = { label, cleanup };
  holders.add(holder);
  return { release: () => releaseHolder(holder) };
}

/** Failed releases remain owned and are retried on the next drain. */
export function drainMxcHolderLifetimes(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    const pending = [...holders];
    const results = await Promise.allSettled(pending.map(releaseHolder));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [new Error(`Container holder cleanup is unverified: ${pending[index]!.label}`, { cause: result.reason })]
      : []);
    if (failures.length) throw new AggregateError(failures, "Container holder cleanup is unverified");
  })().finally(() => { draining = undefined; });
  return draining;
}
