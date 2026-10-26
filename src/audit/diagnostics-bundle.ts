/** Assemble diagnostics only here: allow-list settings and scrub both PII and credentials in all free text. Crash binaries require opt-in; output confidentiality follows the user-selected save location. */
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { redactForLLM, redactAuditPayload, scrubSecretsForLLM } from "./dlp-filter.js";
import { aveHome } from "../shared/ave-home.js";
import { localDateKey, localDayRange, shiftLocalDateKey } from "../shared/local-date.js";
import { parseLogFileDate } from "../lib/log-file-sink.js";
import type { AppSettings } from "../data/settings-store.js";
import { activeLlmRouteModel } from "../shared/llm-vendor-defaults.js";
import type { AuditLogger, AuditEntry } from "./audit-logger.js";
import { utcDateKey } from "../shared/local-date.js";

const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION = 1;

/** Skip entries exceeding the uncompressed byte ceiling and mark the manifest truncated. */
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

export interface CrashDumpMeta {
  /** File name only; never expose the userData directory. */
  name: string;
  mtime: string;
  size: number;
}

interface DiagnosticsBundleManifest {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  os: { platform: string; arch: string; release: string };
  runtime: { electron: string; node: string; chrome: string };
  contents: string[];
  window?: { from?: string; to?: string };
  includeCrashDumps: boolean;
  truncated: boolean;
}

export interface BuildDiagnosticsBundleOptions {
  settings: AppSettings;
  auditLogger: AuditLogger;
  appVersion: string;
  crashDumpsDir: string;
  /** Raw crash binaries require explicit opt-in; otherwise export metadata only. */
  includeCrashDumps?: boolean;
  /** Inclusive local-day range, defaulting to the last seven days. */
  dateFrom?: string;
  dateTo?: string;
  logsDir?: string;
  maxBytes?: number;
  runtime?: { electron: string; node: string; chrome: string };
  osRelease?: string;
}

/** Allow-list safe settings so newly added or legacy secret fields remain absent by default. */
export function pickRedactedSettings(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Export only provider/model shape, never credentials or unknown legacy keys.
  const llm = settings.llm;
  if (llm) {
    const vendors: Record<string, { model?: string; hasBaseUrl: boolean }> = {};
    // Preset endpoints live in the registry, so inspect the active route rather than its generic block.
    const presetRouteHasBaseUrl = Boolean(
      llm.marketplaceProviderPresetId
      && (settings.marketplace?.installedProviderPresets ?? []).some((preset) =>
        preset.providerId === llm.marketplaceProviderPresetId
        && typeof preset.baseUrl === "string" && preset.baseUrl.length > 0),
    );
    for (const [vendor, v] of Object.entries(llm.vendors ?? {})) {
      const vv = v as { model?: string; baseUrl?: string };
      vendors[vendor] = {
        model: typeof vv.model === "string" ? vv.model : undefined,
        // Export presence only; endpoint values may expose internal hostnames.
        hasBaseUrl: (typeof vv.baseUrl === "string" && vv.baseUrl.length > 0)
          || (vendor === "openai-compatible" && presetRouteHasBaseUrl),
      };
    }
    out.llm = {
      provider: llm.provider,
      // Report the active preset model rather than its generic provider-row model.
      activeModel: activeLlmRouteModel(llm),
      // Report preset presence only; package ids may be private.
      hasMarketplaceProviderPreset: Boolean(llm.marketplaceProviderPresetId),
      streamSmoothing: llm.streamSmoothing,
      compactionModel: llm.compactionModel ?? "",
      fallbackChain: llm.fallbackChain,
      vendors,
    };
  }

  if (settings.chat) out.chat = { autoCompact: settings.chat.autoCompact };
  if (settings.webSearch) out.webSearch = { provider: settings.webSearch.provider };
  if (settings.marketplace) {
    out.marketplace = {
      gitMode: settings.marketplace.git?.mode ?? "auto",
      updateCheckEnabled: settings.marketplace.updateCheckEnabled ?? true,
    };
  }
  if (settings.privacy) out.privacy = settings.privacy;
  if (settings.updates) out.updates = { autoCheckEnabled: settings.updates.autoCheckEnabled };
  if (settings.telemetry) {
    out.telemetry = {
      enabled: settings.telemetry.enabled,
      crashReportingEnabled: settings.telemetry.crashReportingEnabled,
      telemetryPromptAnswered: settings.telemetry.telemetryPromptAnswered,
    };
  }
  if (settings.audit) out.audit = settings.audit;
  if (settings.appearance) {
    out.appearance = {
      bundleId: settings.appearance.bundleId,
      language: settings.appearance.language,
      followSystem: settings.appearance.followSystem,
    };
  }
  if (settings.webView) out.webView = settings.webView;
  if (settings.system) {
    // Allow only primitive layout fields; exclude home-bearing paths.
    const s = settings.system;
    out.system = {
      closeBehavior: s.closeBehavior,
      localApiServer: s.localApiServer,
      launchAtStartup: s.launchAtStartup,
      launchMinimized: s.launchMinimized,
      turnCompletionSoundEnabled: s.turnCompletionSoundEnabled,
      sidebarActiveTab: s.sidebarActiveTab,
    };
  }
  if (settings.features) out.features = settings.features;
  if (settings.diagnostics) out.diagnostics = settings.diagnostics;
  return out;
}

export function listCrashDumps(crashDumpsDir: string): CrashDumpMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(crashDumpsDir);
  } catch {
    return [];
  }
  const metas: CrashDumpMeta[] = [];
  for (const name of entries) {
    if (!/\.(dmp|dump)$/i.test(name)) continue;
    try {
      const st = statSync(join(crashDumpsDir, name));
      if (!st.isFile()) continue;
      metas.push({ name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size });
    } catch {
      /* Skip unreadable entries without failing the bundle. */
    }
  }
  return metas.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** Use host-local inclusive civil days because audit search interprets keys locally. */
function defaultWindow(): { from: string; to: string } {
  const today = localDateKey(new Date());
  return { from: shiftLocalDateKey(today, -7), to: today };
}

/** Include all UTC log files overlapping the local-day interval. Whole-file copying intentionally includes edge hours rather than losing incident context. */
function logFilesInWindow(logsDir: string, from: string, to: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return [];
  }
  const range = localDayRange(from, to);
  if (range?.start === undefined || range.end === undefined) return [];
  const firstFileDate = utcDateKey(range.start);
  const lastFileDate = utcDateKey(new Date(range.end.getTime() - 1));
  return entries
    .filter((f) => {
      const d = parseLogFileDate(f);
      return d !== null && d >= firstFileDate && d <= lastFileDate;
    })
    .sort();
}

/** Assemble in memory; the caller owns saving. Skip missing or unreadable sources and omit them from manifest contents. */
export async function buildDiagnosticsBundle(
  opts: BuildDiagnosticsBundleOptions,
): Promise<Buffer> {
  const zip = new AdmZip();
  const maxBytes = opts.maxBytes ?? MAX_BUNDLE_BYTES;
  const includeCrashDumps = opts.includeCrashDumps === true;
  const win = {
    from: opts.dateFrom ?? defaultWindow().from,
    to: opts.dateTo ?? defaultWindow().to,
  };
  const logsDir = opts.logsDir ?? join(aveHome(), "logs");

  const contents: string[] = [];
  let accountedBytes = 0;
  let truncated = false;

  const addEntry = (name: string, body: string | Buffer): boolean => {
    const len = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf-8");
    if (accountedBytes + len > maxBytes) {
      truncated = true;
      return false;
    }
    zip.addFile(name, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8"));
    accountedBytes += len;
    return true;
  };

  const redactedSettings = pickRedactedSettings(opts.settings);
  if (addEntry("settings-redacted.json", JSON.stringify(redactedSettings, null, 2))) {
    contents.push("settings-redacted.json");
  }

  try {
    await opts.auditLogger.flush();
    const { entries } = await opts.auditLogger.search({
      dateFrom: win.from,
      dateTo: win.to,
      limit: 100_000,
      offset: 0,
    });
    if (entries.length > 0) {
      // Reverse the complete newest-first result so exported JSONL is chronological.
      const lines = entries
        .slice()
        .reverse()
        .map((e) => JSON.stringify(redactAuditEntry(e)));
      if (addEntry(`audit/${win.from}_${win.to}.jsonl`, lines.join("\n") + "\n")) {
        contents.push("audit");
      }
    }
  } catch {
    /* Unreadable audit data omits this section. */
  }

  const logFiles = logFilesInWindow(logsDir, win.from, win.to);
  let anyLog = false;
  for (const fname of logFiles) {
    let raw: string;
    try {
      raw = await readFile(join(logsDir, fname), "utf-8");
    } catch {
      continue;
    }
    const redacted = raw
      .split("\n")
      .map((line) => (line.length > 0 ? redactBundleText(line) : line))
      .join("\n");
    if (addEntry(`logs/${fname}`, redacted)) anyLog = true;
  }
  if (anyLog) contents.push("logs");

  const crashMetas = listCrashDumps(opts.crashDumpsDir);
  if (crashMetas.length > 0) {
    if (addEntry("crash-dumps/index.json", JSON.stringify(crashMetas, null, 2))) {
      contents.push("crash-dumps");
    }
    if (includeCrashDumps) {
      for (const meta of crashMetas) {
        try {
          const buf = await readFile(join(opts.crashDumpsDir, meta.name));
          addEntry(`crash-dumps/${meta.name}`, buf);
        } catch {
          /* Skip unreadable dumps. */
        }
      }
    }
  }

  const manifest: DiagnosticsBundleManifest = {
    schemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
    appVersion: opts.appVersion,
    createdAt: new Date().toISOString(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: opts.osRelease ?? "",
    },
    runtime: opts.runtime ?? {
      electron: process.versions.electron ?? "",
      node: process.versions.node ?? "",
      chrome: process.versions.chrome ?? "",
    },
    contents,
    window: win,
    includeCrashDumps,
    truncated,
  };
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

  // Compress through the async thread-pool path to avoid blocking the main process on large bundles.
  return zip.toBufferPromise();
}

/** Redact path fields and apply both free-text scrubbers before serialization. */
function redactAuditEntry(entry: AuditEntry): Record<string, unknown> {
  const base = redactAuditPayload(entry) as Record<string, unknown>;
  const out = { ...base };
  if (typeof out.input === "string") out.input = redactBundleText(out.input);
  if (typeof out.output === "string") out.output = redactBundleText(out.output);
  return out;
}

/** Every log line and audit input/output requires both PII and credential scrubbing; neither pass alone is sufficient. */
function redactBundleText(text: string): string {
  return scrubSecretsForLLM(redactForLLM(text).redacted);
}
