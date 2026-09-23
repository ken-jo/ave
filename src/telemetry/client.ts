/**
 * S12 — Client telemetry for plugin lifecycle events.
 *
 * Privacy contract:
 *   - Opt-in ONLY. Default: disabled. Events are never enqueued before user
 *     explicitly answers the first-boot consent prompt (telemetryPromptAnswered=true
 *     AND enabled=true).
 *   - No PII. Payload contains only: event type, plugin slug, plugin version,
 *     error class name (for plugin_error), device_uuid (random, locally generated).
 *   - No credential: the request carries no Authorization header and no
 *     marketplace key (design §11).
 *   - PII scrubber strips absolute paths and email addresses from any string
 *     field before it leaves the process.
 *   - Transport: POST to the `telemetry` endpoint the service document names
 *     (design §11), batched. The document parser keeps it on the service
 *     origin; with no endpoint named the client is inactive.
 *   - Concurrency: flush() is serialized by an in-flight guard so overlapping
 *     timer ticks + explicit flush() calls can't duplicate-submit a batch.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetrySettings } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("telemetry:plugin");

// ─── Event types ─────────────────────────────────────────────────────────────

export type PluginTelemetryEventName =
  | "plugin_install"
  | "plugin_uninstall"
  | "plugin_update"
  | "plugin_error";

export interface PluginTelemetryEvent {
  /** Schema version — always 1 for S12. */
  v: 1;
  /** Event type. No payload content, no PII. */
  name: PluginTelemetryEventName;
  /** Plugin slug (e.g. "com.example.plugin"). */
  slug: string;
  /** Plugin semver (e.g. "1.2.3"). */
  version: string;
  /**
   * For plugin_error: the constructor name of the Error subclass
   * (e.g. "MarketplaceInstallerError"). Never the message text.
   */
  errorClass?: string;
  /** Epoch ms of event capture. */
  t: number;
  /** Per-device random UUID generated once and stored locally. */
  device_uuid: string;
}

// ─── PII scrubber ────────────────────────────────────────────────────────────

/**
 * Strip absolute paths and email-like strings from a value.
 * Applied to every string field before emission.
 *
 * Rules:
 *   - Absolute paths (/foo/bar or C:\foo\bar) → "[path]"
 *   - Email-shaped tokens → "[email]"
 */
export function scrubPii(value: string): string {
  // Absolute Unix paths: /something or ~/something
  let out = value.replace(/(^|\s|["'`])(~?\/[^\s"'`]{2,})/g, "$1[path]");
  // Windows paths: C:\... or \\server\...
  out = out.replace(/(^|\s|["'`])([A-Za-z]:\\[^\s"'`]*|\\\\[^\s"'`]+)/g, "$1[path]");
  // Email-like: word@word.tld
  out = out.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email]");
  return out;
}

// ─── device_uuid persistence ──────────────────────────────────────────────────

export function loadOrCreateDeviceUuid(uuidPath: string): string {
  if (existsSync(uuidPath)) {
    try {
      const raw = readFileSync(uuidPath, "utf-8").trim();
      if (raw.length > 0) return raw;
    } catch { /* fall through to create */ }
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(uuidPath), { recursive: true });
    writeFileSync(uuidPath, id, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    log.warn("could not persist device_uuid: %s", (err as Error).message);
  }
  return id;
}

/**
 * One-time move of a persisted device_uuid from `fromPath` to `toPath`.
 *
 * The uuid IS the device's telemetry identity: leaving it behind when its
 * home moves would re-mint one and split every device across two ids. So
 * the file is carried over exactly once — only when the old file exists and
 * the new one does not — and the old parent directory is removed if the move
 * emptied it. Any failure is logged and leaves both paths untouched;
 * `loadOrCreateDeviceUuid` then proceeds from whatever `toPath` holds.
 */
export function relocateDeviceUuid(fromPath: string, toPath: string): boolean {
  if (!existsSync(fromPath) || existsSync(toPath)) return false;
  try {
    mkdirSync(dirname(toPath), { recursive: true, mode: 0o700 });
    copyFileSync(fromPath, toPath);
    unlinkSync(fromPath);
  } catch (err) {
    log.warn("could not relocate device_uuid: %s", (err as Error).message);
    return false;
  }
  try {
    rmdirSync(dirname(fromPath));
  } catch {
    // Not empty, or already gone — either way the old directory is not ours to force.
  }
  return true;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface PluginTelemetryClientDeps {
  /**
   * Accessor for telemetry settings — re-evaluated on every track() so user
   * opt-out takes effect immediately without restart.
   */
  settings: () => TelemetrySettings;
  /**
   * The telemetry endpoint of the service document (an absolute URL on the
   * service origin); null when the document names none, which makes the
   * client a no-op even when enabled; undefined while no document is in force
   * yet, when events are held (up to {@link MAX_HELD_EVENTS}) until it is.
   */
  endpoint: () => string | null | undefined;
  /**
   * Absolute path where device_uuid is stored: `~/.ave/telemetry/device-uuid`,
   * the telemetry feature namespace `post-boot.ts` opens. The path is resolved
   * there, once; this is the only other place it is named.
   */
  deviceUuidPath: string;
  /** Batch flush interval in ms (default: 5 min). */
  flushIntervalMs?: number;
  /** Override fetch for tests. */
  /**
   * The transport this client's uploads run on. REQUIRED: the ambient
   * `fetch` is Node's, which reads neither the machine's proxy configuration
   * nor its trust store, so defaulting to it sent telemetry out on a path the
   * user never chose — and, on an intercepted network, nowhere at all.
   */
  fetchImpl: typeof fetch;
}

const DEFAULT_FLUSH_MS = 5 * 60 * 1000;
/** Events kept while the endpoint is not known yet; the oldest go first. */
const MAX_HELD_EVENTS = 500;

export class PluginTelemetryClient {
  private readonly queue: PluginTelemetryEvent[] = [];
  private readonly deviceUuid: string;
  private timer: NodeJS.Timeout | undefined;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  /**
   * In-flight guard to prevent overlapping flush() calls from double-sending
   * the same batch (e.g. a manually triggered flush racing the interval tick,
   * or a long network call overlapping the next scheduled tick).
   */
  private flushInFlight: Promise<void> | null = null;

  constructor(private readonly deps: PluginTelemetryClientDeps) {
    this.deviceUuid = loadOrCreateDeviceUuid(deps.deviceUuidPath);
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.fetchImpl = deps.fetchImpl;
  }

  /**
   * Returns true only when:
   *   1. User has answered the first-boot prompt (telemetryPromptAnswered === true)
   *   2. User opted in (enabled === true)
   *   3. The service document names a telemetry endpoint
   */
  isActive(): boolean {
    const endpoint = this.consentedEndpoint();
    return typeof endpoint === "string" && endpoint.length > 0;
  }

  /** The endpoint once the user opted in; null without consent. */
  private consentedEndpoint(): string | null | undefined {
    const s = this.deps.settings();
    if (!s.telemetryPromptAnswered) return null;
    if (s.enabled !== true) return null;
    return this.deps.endpoint();
  }

  /**
   * Enqueue a plugin lifecycle event. No-op without consent or when the
   * service document names no endpoint; held while the document is not in
   * force yet. PII scrubber is applied to slug and version before queuing.
   */
  track(
    name: PluginTelemetryEventName,
    opts: { slug: string; version: string; errorClass?: string },
  ): void {
    const endpoint = this.consentedEndpoint();
    if (endpoint === null || endpoint === "") return;
    const event: PluginTelemetryEvent = {
      v: 1,
      name,
      slug: scrubPii(opts.slug),
      version: scrubPii(opts.version),
      t: Date.now(),
      device_uuid: this.deviceUuid,
    };
    if (opts.errorClass !== undefined) {
      // Only class name — never the message (may contain PII).
      event.errorClass = scrubPii(opts.errorClass);
    }
    this.queue.push(event);
    if (this.queue.length > MAX_HELD_EVENTS) this.queue.splice(0, this.queue.length - MAX_HELD_EVENTS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    // Serialize overlapping callers. If a flush is already in flight the
    // caller awaits its completion instead of starting a second one that
    // would re-POST the same batch.
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.flushOnce().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }

  private async flushOnce(): Promise<void> {
    const endpoint = this.consentedEndpoint();
    // Consent withdrawn, or the document names no endpoint: held events are not sent.
    if (endpoint === null || endpoint === "") {
      this.queue.length = 0;
      return;
    }
    if (endpoint === undefined || this.queue.length === 0) return;
    const batch = this.queue.slice(0);
    const batchLen = batch.length;
    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        log.warn(`flush non-ok HTTP ${res.status}; re-queued ${batchLen} event(s)`);
        return;
      }
      this.queue.splice(0, batchLen);
    } catch (err) {
      log.warn("flush failed (re-queued): %s", (err as Error).message);
    }
  }

  /** Exposed for testing — current queue length. */
  get queueLength(): number {
    return this.queue.length;
  }
}
