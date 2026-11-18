// Local minidumps stay local unless the user enables crash reporting to an authorized endpoint.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TelemetrySettings } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
import { telemetryLevel, validateTelemetryEndpoint } from "../shared/telemetry-policy.js";
const log = createLogger("crash-reporter");

export interface CrashReporterDeps {
  userDataPath: string;
  telemetry: TelemetrySettings;
  remoteReporting: boolean;
  isPackaged?: boolean;
  allowlistEnv?: string;
  crashReporter?: {
    start: (opts: {
      submitURL?: string;
      productName?: string;
      uploadToServer?: boolean;
      ignoreSystemCrashHandler?: boolean;
    }) => void;
    setUploadToServer: (enabled: boolean) => void;
  };
  setCrashDumpsPath?: (path: string) => void;
}

export interface CrashReporterHandle {
  dumpDir: string;
  started: boolean;
  /** Disable immediately; a different destination needs a restart because the native submit URL is boot-latched. */
  updateSettings: (telemetry: TelemetrySettings) => void;
}

export function startCrashReporter(deps: CrashReporterDeps): CrashReporterHandle {
  const dumpDir = resolve(deps.userDataPath, "crash-dumps");
  try { mkdirSync(dumpDir, { recursive: true }); } catch (err) { log.warn("mkdir dumpDir failed: %s", (err as Error).message); }
  const setPath = deps.setCrashDumpsPath ?? loadElectronSetCrashDumpsPath();
  if (setPath) {
    try { setPath(dumpDir); } catch (err) { log.warn("setPath(crashDumps) failed: %s", (err as Error).message); }
  }
  const endpoint = deps.telemetry.crashReportEndpoint;
  const endpointAuthorized = validateTelemetryEndpoint(endpoint, {
    isPackaged: deps.isPackaged ?? false,
    allowlistEnv: deps.allowlistEnv ?? process.env.AVE_TELEMETRY_ALLOWLIST,
  }).valid;
  const canUpload = (settings: TelemetrySettings) => deps.remoteReporting
    && telemetryLevel(settings) !== "off"
    && settings.crashReportingEnabled === true
    && endpointAuthorized
    && settings.crashReportEndpoint === endpoint;
  let started = false;
  const reporter = deps.crashReporter ?? loadElectronCrashReporter();
  if (reporter) {
    try {
      reporter.start({
        submitURL: deps.remoteReporting && endpointAuthorized ? endpoint : undefined,
        productName: "Ave",
        uploadToServer: canUpload(deps.telemetry),
        ignoreSystemCrashHandler: false,
      });
      started = true;
    } catch (err) { log.warn("start failed: %s", (err as Error).message); }
  }
  return {
    dumpDir,
    started,
    updateSettings: (settings) => {
      if (started && reporter) reporter.setUploadToServer(canUpload(settings));
    },
  };
}

function loadElectronCrashReporter(): CrashReporterDeps["crashReporter"] | undefined {
  try { return require("electron").crashReporter; } catch { return undefined; }
}

function loadElectronSetCrashDumpsPath(): ((path: string) => void) | undefined {
  try {
    const { app } = require("electron") as { app?: { setPath?: (name: string, p: string) => void } };
    if (app?.setPath) return (p: string) => app.setPath!("crashDumps", p);
    return undefined;
  } catch { return undefined; }
}
