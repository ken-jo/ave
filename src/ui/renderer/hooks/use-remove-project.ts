import { useCallback, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import type { WorkspaceRemovalCounts } from "../../../ipc/domains/workspace.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { addedOutcome, type ProjectErrorReporter } from "./use-add-project-folder.js";

/** The case 31 dialog's content: what main would end or prune, and the terminals and pages this window would close. */
export interface RemoveProjectPrompt {
  project: ProjectIdentity;
  counts: WorkspaceRemovalCounts;
  /** The project's terminals in this window; removal closes them, ending what runs in them. */
  closingTerminals: number;
  /** The project's other surfaces in this window (pages, folder and plugin views); removal closes them. */
  closingTabs: number;
}

/** One of the project's surfaces in this window's main area. */
interface ProjectSurfaceRef {
  tabId: string;
  kind: string;
}

interface RemoveProjectToast {
  severity: "success" | "warning" | "error";
  message: string;
  ttlMs: number;
  action?: { label: string; run: () => void };
}

export interface UseRemoveProjectOptions {
  /** The project's surfaces in this window's main area: exactly what removal closes. */
  surfacesIn: (projectRoot: string) => readonly ProjectSurfaceRef[];
  closeSurface: (tabId: string) => void;
  /** Drop what the window remembers about the project: recent, last view, open group. */
  forgetProject: (projectRoot: string) => void;
  refreshProjects: () => Promise<void>;
  projectName: (project: ProjectIdentity) => string;
  pushToast: (toast: RemoveProjectToast) => unknown;
  reportError: ProjectErrorReporter;
}

export interface UseRemoveProjectResult {
  /** 프로젝트 제거 (case 29): removes at once when nothing would be lost (case 30), else opens the confirmation (case 31). */
  requestRemove: (project: ProjectIdentity) => Promise<void>;
  /** The open confirmation, if any. */
  prompt: RemoveProjectPrompt | null;
  confirm: () => Promise<void>;
  cancel: () => void;
}

const TOAST_TTL_MS = 10_000;

/** Nothing would be lost: no counted loss and no conversation to unlink, so the undo toast is enough (plan decision 3). */
function losesNothing(prompt: RemoveProjectPrompt): boolean {
  return prompt.closingTerminals === 0 && prompt.closingTabs === 0 && Object.values(prompt.counts).every((count) => count === 0);
}

/**
 * Remove a project with its consequences shown first (cases 29–31). Main previews what removal would end or prune; when
 * any of it is above zero the user confirms in a dialog. After removal the window closes the project's terminals and pages
 * and forgets it, so nothing on screen still points at the folder; 되돌리기 re-adds exactly that folder through the one-time
 * token main handed back.
 */
export function useRemoveProject(options: UseRemoveProjectOptions): UseRemoveProjectResult {
  const { t } = useTranslation();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [prompt, setPrompt] = useState<RemoveProjectPrompt | null>(null);

  // A rejected IPC call is reported like a refused one, so the menu item is never a silent no-op.
  const reportThrown = useCallback((error: unknown) => {
    optionsRef.current.reportError("remove", "remove-failed", error instanceof Error ? error.message : undefined);
  }, []);

  const undo = useCallback(async (project: ProjectIdentity, undoToken: string) => {
    const { refreshProjects, projectName, pushToast, reportError } = optionsRef.current;
    const res = await window.ave.workspace.pickRoot({ ackToken: undoToken });
    if (!res.ok) {
      if (res.error === "ack-expired" || res.error === "ack-unknown") {
        pushToast({ severity: "warning", message: t("sidebar.projectRestoreExpired"), ttlMs: TOAST_TTL_MS });
      } else {
        reportError("add", res.error);
      }
      return;
    }
    const outcome = addedOutcome(res);
    if (outcome.status !== "added") {
      reportError("add", outcome.status === "failed" ? outcome.error : undefined);
      return;
    }
    await refreshProjects();
    pushToast({ severity: "success", message: t("sidebar.projectRestored", { name: projectName(project) }), ttlMs: TOAST_TTL_MS });
  }, [t]);

  const remove = useCallback(async (project: ProjectIdentity) => {
    const { surfacesIn, closeSurface, forgetProject, refreshProjects, projectName, pushToast, reportError } = optionsRef.current;
    const result = await window.ave.workspace.removeRoot(project.projectRoot);
    if (!result.ok) {
      reportError("remove", result.error, result.message);
      return;
    }
    for (const surface of surfacesIn(project.projectRoot)) closeSurface(surface.tabId);
    forgetProject(project.projectRoot);
    await refreshProjects();
    const removed = t("sidebar.projectRemoved", { name: projectName(project) });
    const undoToken = result.undoToken;
    pushToast({
      // A revocation that could not finish is reported, never asked about; it also means there is no undo.
      severity: result.cleanupPending ? "warning" : "success",
      message: result.cleanupPending ? `${removed} ${t("chatPreviewRail.removeRootCleanupPending")}` : removed,
      ttlMs: TOAST_TTL_MS,
      ...(undoToken ? { action: { label: t("sidebar.projectRemovedUndo"), run: () => void undo(project, undoToken).catch(reportThrown) } } : {}),
    });
  }, [t, undo, reportThrown]);

  const requestRemove = useCallback(async (project: ProjectIdentity) => {
    if (project.isDefault) throw new Error("project-default-not-removable: the 기본 프로젝트 has no 제거");
    let preview: Awaited<ReturnType<typeof window.ave.workspace.previewRemoveRoot>>;
    try {
      preview = await window.ave.workspace.previewRemoveRoot(project.projectRoot);
    } catch (error) {
      reportThrown(error);
      return;
    }
    if (!preview.ok) {
      optionsRef.current.reportError("remove", preview.error);
      return;
    }
    const surfaces = optionsRef.current.surfacesIn(project.projectRoot);
    const closingTerminals = surfaces.filter((surface) => surface.kind === "terminal").length;
    const next: RemoveProjectPrompt = {
      project,
      counts: preview.counts,
      closingTerminals,
      closingTabs: surfaces.length - closingTerminals,
    };
    // Removal re-validates everything it does under its own lock, so a project that gains a terminal or a turn between this
    // preview and the removal is still removed correctly; only the absent dialog is stale, which the undo toast covers.
    if (losesNothing(next)) {
      await remove(project).catch(reportThrown);
      return;
    }
    setPrompt(next);
  }, [remove, reportThrown]);

  const confirm = useCallback(async () => {
    const current = prompt;
    if (!current) return;
    setPrompt(null);
    await remove(current.project).catch(reportThrown);
  }, [prompt, remove, reportThrown]);

  const cancel = useCallback(() => setPrompt(null), []);

  return { requestRemove, prompt, confirm, cancel };
}
