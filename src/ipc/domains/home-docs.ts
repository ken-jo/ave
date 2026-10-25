// Expose pending packaged-document updates as explicit keep, apply, or merge actions.
import { ipcMain } from "electron";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import {
  discardAveHomeDocUpgradeMarker,
  isShippedAgentsMdContent,
  listAveHomeDocUpgradeMarkers,
  readAveHomeDocSource,
  readAveHomeDocUpgradeMarker,
  retireAppliedAveHomeDocUpgradeMarkers,
} from "../../main/seed-ave-home-docs.js";
import {
  AGENTS_CUSTOM_DOC_NAME,
  AGENTS_DOC_NAME,
} from "../../shared/ave-home.js";
import { errorMessage } from "../../shared/error-message.js";
import { createLogger } from "../../lib/logger.js";
import type { IpcDeps } from "../types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";

const log = createLogger("home-docs-ipc");

function displayPath(relativePath: string): string {
  return `~/.ave/${relativePath.split("\\").join("/")}`;
}

interface HomeDocUpgradeMarkerView {
  markerPath: string;
  sourcePath: string;
  markerDisplayPath: string;
  sourceDisplayPath: string;
  actionable: boolean;
}

export interface HomeDocsStatus {
  agentsDisplayPath: string;
  customDisplayPath: string;
  markers: HomeDocUpgradeMarkerView[];
  mergedContent: string | null;
}

function auditHomeDocs(auditLogger: AuditLogger, detail: Record<string, unknown>): void {
  auditLogger.log({
    timestamp: new Date().toISOString(),
    sessionId: "home-docs",
    type: "info",
    input: JSON.stringify(detail),
  });
}

export function registerHomeDocsHandlers(deps: IpcDeps): void {
  const { auditLogger, memoryManager, settingsService } = deps;

  const keepLatest = (): boolean => settingsService.get("homeDocs").keepLatest;

  ipcMain.handle(CHANNELS.homeDocs.upgradeMarkersList, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.upgradeMarkersList, event);
      return UNAUTHORIZED_FRAME;
    }
    // Re-scan markers on each request; the user may have resolved offers since boot.
    const status: HomeDocsStatus = {
      agentsDisplayPath: displayPath(AGENTS_DOC_NAME),
      customDisplayPath: displayPath(AGENTS_CUSTOM_DOC_NAME),
      markers: listAveHomeDocUpgradeMarkers().map((marker) => ({
        markerPath: marker.markerPath,
        sourcePath: marker.sourcePath,
        markerDisplayPath: displayPath(marker.markerPath),
        sourceDisplayPath: displayPath(marker.sourcePath),
        actionable: marker.sourcePath === AGENTS_DOC_NAME,
      })),
      mergedContent: deps.agentsDocMergeService?.readMerged() ?? null,
    };
    return status;
  });

  ipcMain.handle(CHANNELS.homeDocs.markerRead, (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.markerRead, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const content = readAveHomeDocUpgradeMarker(markerPath);
    if (content === null) return { ok: false, error: "unknown-upgrade-marker" } as const;
    return {
      ok: true,
      content,
      live: readAveHomeDocSource(markerPath) ?? "",
    } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.packagedApply, async (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.packagedApply, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const marker = listAveHomeDocUpgradeMarkers().find((m) => m.markerPath === markerPath);
    if (!marker) return { ok: false, error: "unknown-upgrade-marker" } as const;
    if (marker.sourcePath !== AGENTS_DOC_NAME) {
      return { ok: false, error: "unsupported-upgrade-target" } as const;
    }
    const content = readAveHomeDocUpgradeMarker(markerPath);
    if (content === null) return { ok: false, error: "unknown-upgrade-marker" } as const;

    try {
      // Preserve user sentences in agents.custom.md before replacement; do not duplicate shipped reference text there.
      const current = memoryManager.getAgentsMd();
      const movedToCustom =
        keepLatest() && current.trim().length > 0 && !isShippedAgentsMdContent(current);
      if (movedToCustom) {
        await memoryManager.updateAgentsCustomMd(current);
      }
      await memoryManager.updateAgentsMd(content);
      retireAppliedAveHomeDocUpgradeMarkers(markerPath, content);
      auditHomeDocs(auditLogger, {
        action: "apply-packaged",
        markerPath,
        keepLatest: keepLatest(),
        movedToCustom,
      });
      return { ok: true, movedToCustom } as const;
    } catch (err) {
      log.warn("apply packaged doc failed: %s", errorMessage(err));
      return { ok: false, error: "home-doc-apply-failed" } as const;
    }
  });

  ipcMain.handle(CHANNELS.homeDocs.markerKeepMine, (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.markerKeepMine, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }
    const removed = discardAveHomeDocUpgradeMarker(markerPath);
    if (!removed) return { ok: false, error: "unknown-upgrade-marker" } as const;
    auditHomeDocs(auditLogger, { action: "keep-mine", markerPath });
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.customGet, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.customGet, event);
      return UNAUTHORIZED_FRAME;
    }
    return memoryManager.getAgentsCustomMd();
  });

  ipcMain.handle(CHANNELS.homeDocs.customUpdate, async (event, content: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.customUpdate, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof content !== "string") {
      return { ok: false, error: "invalid-content" } as const;
    }
    await memoryManager.updateAgentsCustomMd(content);
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeRun, async (event, markerPath: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeRun, event);
      return UNAUTHORIZED_FRAME;
    }
    const mergeService = deps.agentsDocMergeService;
    if (!mergeService) return { ok: false, error: "agents-doc-merge-unavailable" } as const;
    if (markerPath !== undefined && typeof markerPath !== "string") {
      return { ok: false, error: "invalid-marker-path" } as const;
    }

    // Merge against custom content under keep-latest; otherwise require a newer marker for the edited live doc.
    const packaged = typeof markerPath === "string"
      ? readAveHomeDocUpgradeMarker(markerPath)
      : memoryManager.getAgentsMd();
    if (packaged === null) return { ok: false, error: "unknown-upgrade-marker" } as const;
    const custom = keepLatest()
      ? memoryManager.getAgentsCustomMd()
      : memoryManager.getAgentsMd();
    if (custom.trim().length === 0 || (packaged === custom)) {
      return { ok: false, error: "nothing-to-merge" } as const;
    }

    try {
      const result = await mergeService.merge({ packaged, custom });
      auditHomeDocs(auditLogger, {
        action: "merge",
        ...(typeof markerPath === "string" ? { markerPath } : {}),
        keepLatest: keepLatest(),
        sources: result.sources,
      });
      return {
        ok: true,
        content: result.content,
        mergedAt: result.mergedAt,
        sources: result.sources,
      } as const;
    } catch (err) {
      // Provider and source detail is host-only; the renderer gets a stable code.
      log.warn("agent-context merge failed: %s", errorMessage(err));
      return { ok: false, error: "agents-doc-merge-failed" } as const;
    }
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeApply, async (event, expectedContent: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeApply, event);
      return UNAUTHORIZED_FRAME;
    }
    const mergeService = deps.agentsDocMergeService;
    if (!mergeService) return { ok: false, error: "agents-doc-merge-unavailable" } as const;
    if (typeof expectedContent !== "string") {
      return { ok: false, error: "invalid-content" } as const;
    }
    const merged = mergeService.readMerged();
    if (merged === null) return { ok: false, error: "no-merge-artifact" } as const;

    // Compare-and-swap against the reviewed content so provider latency cannot overwrite concurrent edits.
    const applied = keepLatest()
      ? await memoryManager.updateAgentsCustomMdIfUnchanged(expectedContent, merged)
      : await memoryManager.updateAgentsMdIfUnchanged(expectedContent, merged);
    if (!applied) return { ok: false, error: "agents-doc-changed" } as const;

    mergeService.discardMerged();
    auditHomeDocs(auditLogger, { action: "apply-merged", keepLatest: keepLatest() });
    return { ok: true } as const;
  });

  ipcMain.handle(CHANNELS.homeDocs.mergeDiscard, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, CHANNELS.homeDocs.mergeDiscard, event);
      return UNAUTHORIZED_FRAME;
    }
    deps.agentsDocMergeService?.discardMerged();
    return { ok: true } as const;
  });
}
