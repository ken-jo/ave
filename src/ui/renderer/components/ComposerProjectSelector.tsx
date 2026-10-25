import { useState } from "react";
import { ChevronDown, Folder, FolderPlus } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import { projectRootEquals } from "../../../shared/project-identity.js";
import {
  useAddProjectFolder,
  addedRootDisplayName,
  type AddProjectFolderOutcome,
  type ProjectErrorReporter,
} from "../hooks/use-add-project-folder.js";

export interface ComposerProjectSelectorProps {
  /** Currently active project — drives the trigger label. */
  activeProject?: ProjectIdentity;
  /** Full known project list — the SAME source the sidebar's project group renders from (App-level `workspaceProjects`), so
   * this selector never drifts from the sidebar's list. */
  projects: ProjectIdentity[];
  /** Switch the active project — the SAME handler wired to the sidebar's project rows (`onNewChatForProject`), so selecting
   * here behaves identically to clicking a project in the sidebar. */
  onSelectProject: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list after a folder is added — the same refresh App.tsx already exposes to the sidebar's
   * context menu. */
  onRefreshProjects?: () => void | Promise<void>;
  /** Surface a refused add — the same App-level toast the sidebar's project context menu reports its own failures through. */
  onProjectError?: ProjectErrorReporter;
  /** Controls the dropdown's open state so the caller (ChatView) can force-close it when the conversation stops being empty
   * (first message sent) and the trigger unmounts. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Reuse App's project state and mutations; the bottom-docked composer opens its selector upward into available space. */
export function ComposerProjectSelector({
  activeProject,
  projects,
  onSelectProject,
  onRefreshProjects,
  onProjectError,
  open,
  onOpenChange,
}: ComposerProjectSelectorProps) {
  const { t } = useTranslation();
  const { pendingWarning, addFolder, confirmPendingFolder, cancelPendingFolder } = useAddProjectFolder();
  const [busy, setBusy] = useState(false);

  // The default/base-directory binding is never a "selected project" for
  // display purposes — only an explicit (non-default) project counts.
  // Imperative label, matching the prevailing convention for this control: a
  // "Select project" CTA until the user actually picks one; the real directory
  // name only appears once chosen. The default binding itself is untouched
  // internally (still used for tool/file access) — this is display-only.
  const hasRealSelection = Boolean(activeProject && activeProject.isDefault !== true);
  const label = hasRealSelection ? activeProject!.projectName : t("composerProjectSelector.selectProjectPlaceholder");
  // The default binding is not a pickable list entry — the dropdown only offers real, user-added projects (+ "Add new
  // project").
  const namedProjects = projects.filter((project) => project.isDefault !== true);

  const handleSelect = (project: ProjectIdentity) => {
    onOpenChange(false);
    void onSelectProject({
      ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
      projectName: project.projectName,
    });
  };

  // A refused pick reaches the user as an error rather than as the dropdown
  // simply closing: the native dialog dismissing itself looks the same whether
  // the folder was persisted or rejected. `needs-acknowledgement` is answered
  // by the warning block below, and `canceled` is the user's own decision.
  const applyAddOutcome = async (outcome: AddProjectFolderOutcome) => {
    if (outcome.status === "failed") {
      onProjectError?.("add", outcome.error);
      return;
    }
    if (outcome.status !== "added") return;
    await onRefreshProjects?.();
    const addedRoot = outcome.added ?? outcome.roots.find((r) => !r.isDefault)?.path;
    if (!addedRoot) return;
    onOpenChange(false);
    void onSelectProject({ projectRoot: addedRoot, projectName: addedRootDisplayName(addedRoot) });
  };

  const handleAddProject = async () => {
    setBusy(true);
    try {
      await applyAddOutcome(await addFolder());
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPending = async () => {
    setBusy(true);
    try {
      await applyAddOutcome(await confirmPendingFolder());
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-full px-2 text-caption text-input-bar-placeholder transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-subtle hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
          aria-label={t("composerProjectSelector.triggerAriaLabel")}
          data-testid="composer-project-selector-trigger"
          data-selected={hasRealSelection ? "true" : "false"}
        >
          <Folder className={`h-3 w-3 shrink-0 ${hasRealSelection ? "text-input-bar-action" : "text-input-bar-placeholder"}`} />
          <span
            className={[
              "max-w-[12rem] truncate",
              hasRealSelection ? "text-input-bar-foreground" : "italic text-input-bar-placeholder",
            ].join(" ")}
          >
            {label}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      {/* side="top" — the composer is bottom-docked, so the panel opens
          UPWARD into the empty conversation above it.
          forceMount + data-state transition: Radix keeps the panel mounted
          through its close so the fade/scale-out plays instead of the content
          vanishing instantly. */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        forceMount
        className="w-64 origin-bottom transition-[opacity,transform] duration-(--motion-normal) ease-(--motion-ease-out) motion-reduce:transition-none data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:scale-95 data-[state=open]:opacity-100 data-[state=open]:scale-100"
        data-testid="composer-project-selector-menu"
      >
        {namedProjects.length > 0 ? (
          <div className="px-2 py-1.5 text-caption font-semibold uppercase tracking-wider text-muted-foreground">
            {t("composerProjectSelector.projectsHeading")}
          </div>
        ) : null}
        {namedProjects.map((project) => {
          const isActive = hasRealSelection && projectRootEquals(project.projectRoot, activeProject?.projectRoot);
          return (
            <DropdownMenuItem
              key={project.projectRoot}
              data-testid="composer-project-selector-item"
              data-project-root={project.projectRoot}
              className={isActive ? "bg-primary/(--opacity-subtle) text-primary" : undefined}
              onSelect={() => handleSelect(project)}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{project.projectName}</span>
            </DropdownMenuItem>
          );
        })}
        {namedProjects.length > 0 ? <DropdownMenuSeparator /> : null}
        {pendingWarning ? (
          <div
            data-testid="composer-project-selector-root-warning"
            className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-caption"
          >
            <div className="font-medium text-destructive">{t("composerProjectSelector.rootWarningTitle")}</div>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
              {pendingWarning.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                data-testid="composer-project-selector-root-warning-confirm"
                onClick={() => void handleConfirmPending()}
              >
                {t("composerProjectSelector.rootWarningConfirm")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                data-testid="composer-project-selector-root-warning-cancel"
                onClick={cancelPendingFolder}
              >
                {t("composerProjectSelector.cancelButton")}
              </Button>
            </div>
          </div>
        ) : (
          <DropdownMenuItem
            data-testid="composer-project-selector-add"
            disabled={busy}
            onSelect={(event) => {
              // Keep the menu open across the async picker round trip — Radix closes on select by default, which would race the native
              // dialog. We close explicitly once the flow resolves.
              event.preventDefault();
              void handleAddProject();
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("composerProjectSelector.addProject")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
