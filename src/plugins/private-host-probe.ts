// Private DNS presence is a reachability hint, never authorization.
// Dedup stays tied to lookup lifetime so timed-out slow resolutions cannot multiply.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ProbePrivateHostOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;

/** Only bare hostnames reach lookup; refuse URL, port, path, userinfo and query syntax. */
const NON_BARE_HOSTNAME = /[\s/:@?#\\]/;

/** Cap distinct in-flight hosts; same-host dedup consumes no extra slot and overflow throws explicitly. */
export const MAX_INFLIGHT_DISTINCT_HOSTS = 32;

const inFlightByHost = new Map<string, Promise<boolean>>();

export async function probePrivateHost(
  host: string,
  opts: ProbePrivateHostOptions = {},
): Promise<boolean> {
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new TypeError(
      `probePrivateHost: host must be a non-empty string (got ${
        typeof host === "string" ? "empty/whitespace string" : typeof host
      })`,
    );
  }
  if (NON_BARE_HOSTNAME.test(host)) {
    throw new TypeError(
      "probePrivateHost: host must be a bare hostname (no scheme, port, path, userinfo, or whitespace)",
    );
  }
  // Reject IP literals because local numeric resolution proves no private-network presence.
  if (isIP(host) !== 0) {
    throw new TypeError(
      "probePrivateHost: host must be a bare hostname, not an IP literal (an IP resolves numerically without a DNS round-trip, defeating the corp-presence signal)",
    );
  }

  // Clamp malformed or nonpositive deadlines to safe defaults.
  const raw = opts.timeoutMs;
  const timeoutMs =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  // Dedup lives until the underlying lookup settles, not the timeout race.
  const existing = inFlightByHost.get(host);
  if (existing) return existing;

  // Refuse distinct-host overflow explicitly; false would falsely report a measured network absence.
  if (inFlightByHost.size >= MAX_INFLIGHT_DISTINCT_HOSTS) {
    throw new Error(
      `probePrivateHost: too many concurrent distinct-host probes in flight (cap ${MAX_INFLIGHT_DISTINCT_HOSTS}); retry once in-flight probes settle`,
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Defer lookup so synchronous throws are observed as false after dedup registration.
  const lookupPromise = Promise.resolve()
    .then(() => lookup(host))
    .then(() => true)
    .catch(() => false);

  const probe = (async () => {
    try {
      const timeoutPromise = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      });
      return await Promise.race([lookupPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  // Register before attaching cleanup so synchronously settled lookups cannot strand slots.
  inFlightByHost.set(host, probe);
  void lookupPromise.finally(() => {
    inFlightByHost.delete(host);
  });

  return probe;
}

/** @internal Test only — clears the same-host in-flight dedup map. */
export function __resetPrivateHostProbeInFlightForTests(): void {
  inFlightByHost.clear();
}
