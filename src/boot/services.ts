import type { BootHost } from "./host-runtime.js";
import { isAveHomeConfigurationOwner } from "../shared/ave-home-configuration-access.js";
/** Create core services before loading plugins. */
import type { BrowserWindow } from "electron";
import { SettingsService } from "../data/settings-store.js";
import { initPiiRedactionPolicy } from "../audit/dlp-filter.js";
import { getIsPackaged } from "./dev-flags.js";
import { installBootModelCatalog } from "../core/model-catalog/bundled.js";
import { DEFAULT_LOCALE, normalizeLocale, setLocale, tryLoadLocaleMessages,
} from "../i18n/index.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { registerShutdownHook } from "../main/app-shutdown.js";
import { MemoryCaptureService } from "../memory/memory-capture-service.js";
import { execTurnRequested } from "../main/exec-mode.js";
import { ToolRegistry } from "../tools/registry.js";
import { createFileTools } from "../tools/file-tools.js";
import { createReadToolResultChunkTool } from "../tools/tool-result-chunk.js";
import { createMemoryWriteTool } from "../tools/memory-write.js";
import { createMemoryRecallTools } from "../tools/memory-recall.js";
import { MemoryUsageLog } from "../memory/memory-usage-log.js";
import { MemorySaveNotices } from "../memory/memory-save-notices.js";
import { CHANNELS } from "../contract/app-contract.js";
import { getMainWindows } from "../main/app-state.js";
import {
  BashTool,
  PowerShellTool,
  createBashOutputTool,
  createBashKillTool,
} from "../tools/shell-tools.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import { AuditService } from "../main/audit-service.js";
import { PythonRuntimeBootstrapper } from "../main/python-runtime.js";
import { createLogger, initFileLogSink } from "../lib/logger.js";
import { LOG_RETENTION_DAYS, LOG_MAX_BYTES, reprunePersistedRetention,
} from "../lib/log-file-sink.js";
import { aveHome } from "../shared/ave-home.js";
import { getAveAppVersion } from "../shared/app-version.js";
import { join } from "node:path";
const log = createLogger("ave");

/** Packaged runs keep a file sink regardless of development flags; AVE_LOG_FILE=1 enables local diagnosis. */
function shouldEnableFileLogSink(): boolean {
  return process.env.AVE_LOG_FILE === "1" || process.env.NODE_ENV === "production" || getIsPackaged();
}

export interface CoreServices {
  pythonPath: string | undefined;
  pythonRuntime: PythonRuntimeBootstrapper;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  /** Id-only record of injected/searched/read memories for the main store. */
  memoryUsageLog: MemoryUsageLog;
  memoryCaptureService: MemoryCaptureService;
  /** Live save notices and the in-process undo records behind them. */
  memorySaveNotices: MemorySaveNotices;
  toolRegistry: ToolRegistry;
}

/** Install the live PII-policy reader during service boot so headless runs redact before IPC exists. */
export function applyBootPiiRedactionPolicy(
  settingsService: Pick<SettingsService, "get">,
): void {
  initPiiRedactionPolicy(
    () => settingsService.get("privacy")?.piiRedactEnabled === true,
  );
}

export async function applyBootLocale(
  settingsService: Pick<SettingsService, "get">,
): Promise<void> {
  // Headless prompts use the default catalog so the request determines response language.
  if (execTurnRequested(process.argv)) {
    setLocale(DEFAULT_LOCALE);
    return;
  }
  const bootLocale = normalizeLocale(settingsService.get("appearance").language,
  );
  const loaded = await tryLoadLocaleMessages(bootLocale);
  setLocale(loaded ? bootLocale : DEFAULT_LOCALE);
}

export async function bootstrapCoreServices(mainWindow: BrowserWindow | null, host: BootHost,
): Promise<CoreServices> {
  // Attach the sink before core boot logs; close it last so shutdown logs are captured.
  if (shouldEnableFileLogSink()) {
    const sink = initFileLogSink({
      retentionDays: LOG_RETENTION_DAYS,
      maxBytes: LOG_MAX_BYTES,
    });
    if (sink) {
      log.info({ file: sink.currentFile }, "boot: production log file sink attached",
      );
    }
  }

  // Install the catalog before model resolution; synchronous readers throw if boot order is wrong.
  await installBootModelCatalog();

  // Runtime assets and plugin dependencies are prepared lazily by plugins.
  const pythonRuntime = new PythonRuntimeBootstrapper({
    // The unsandboxed runtime downloader needs the same configured proxy route as host requests.
    ...(host.resolveProxy ? { resolveOsProxy: host.resolveProxy } : {}),
  });
  let pythonPath: string | undefined;
  void mainWindow;

  const bashAstValidator = new BashAstValidator({ mode: "deny" });

  const auditService = new AuditService();
  await auditService.start();

  // Seed fresh installs from supported OS language preferences; query only after app readiness.
  const settingsService = new SettingsService({
    userDataPath: host.userDataPath,
    systemLocale: host.systemLocale,
    secretPolicy: host.isPackaged ? "packaged" : "development",
    encryption: host.encryption,
    appVersion: getAveAppVersion(),
  });
  if (isAveHomeConfigurationOwner()) {
    await settingsService.migrateSecrets();

    await settingsService.deleteRetiredLlmVendorApiKeys();
  }
  applyBootPiiRedactionPolicy(settingsService);

  // Apply persisted UI locale before native surfaces are created.
  await applyBootLocale(settingsService);

  // Reapply retention after settings load; initial sink attachment uses the default window.
  try {
    reprunePersistedRetention(
      join(aveHome(), "logs"),
      settingsService.get("diagnostics").logRetentionDays,
    );
  } catch {
    /* non-fatal */
  }

  const memoryManager = new MemoryManager();
  memoryManager.load();
  memoryManager.startPersistentContextWatcher();
  registerShutdownHook("memory-manager", () => {
    memoryManager.stopPersistentContextWatcher();
    memoryManager.closeSearchIndex();
  });
  log.info("boot: memory loaded from %s", memoryManager.getDir());
  // Recover corrupt or missing search indexes from JSONL; never scan linearly as a fallback.
  await memoryManager.verifyOrRebuildSearchIndex().catch((err: unknown) => {
    log.warn("boot: search index verify/rebuild failed: %s", (err as Error).message,
    );
  });
  // Same aveDir as the main store: usage rows sit beside the memories they name.
  const memoryUsageLog = new MemoryUsageLog({ aveDir: memoryManager.getDir() });
  const memorySaveNotices = new MemorySaveNotices(memoryManager);
  // Notices carry memory titles, so they go to host main windows only; each window's strip keeps its own conversation's.
  memorySaveNotices.setSink((event) => {
    for (const win of getMainWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.memory.saveResult, event);
    }
  });
  const memoryCaptureService = new MemoryCaptureService({
    memoryManager,
    notices: memorySaveNotices,
    // Only main-store loops (primary and chat groups) receive this service; side chat and sub-agents do not.
    sessionStore: "main",
  });

  const toolRegistry = new ToolRegistry();
  // Register shell tools with canonical permission metadata so approval and AST validation apply.
  toolRegistry.register(new BashTool());
  toolRegistry.register(new PowerShellTool());
  toolRegistry.register(createReadToolResultChunkTool());
  for (const tool of createFileTools()) {
    toolRegistry.register(tool);
  }
  // Local memory saves retain explicit-deny, strict-mode, and staged-origin gates.
  toolRegistry.register(createMemoryWriteTool({ memoryManager, notices: memorySaveNotices }));
  // memory_delete removes a visible memory by id, refuses on a tainted turn, and is not auto-approved.
  for (const tool of createMemoryRecallTools({ memoryManager, memoryUsageLog, notices: memorySaveNotices })) {
    toolRegistry.register(tool);
  }
  // Background-shell lookups must stay scoped to the caller’s session.
  toolRegistry.register(createBashOutputTool());
  toolRegistry.register(createBashKillTool());

  return {
    pythonPath,
    pythonRuntime,
    bashAstValidator,
    auditService,
    settingsService,
    memoryManager,
    memoryUsageLog,
    memoryCaptureService,
    memorySaveNotices,
    toolRegistry,
  };
}
