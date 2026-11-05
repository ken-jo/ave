import { useCallback, type ReactNode } from "react";
import { FolderPlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover.js";
import { useTranslation } from "../../../../i18n/react.js";
import { defaultProjectFromProjects, type ProjectIdentity } from "../../../../shared/project-identity.js";
import { SHELL_GUTTER } from "../../../../shared/shell-geometry.js";
import { ProjectCombobox, projectMatches, projectTestId, type ComboboxSection } from "./ProjectCombobox.js";
import { orderedProjects, ProjectMark, recentProjects, type ProjectMenuModel } from "./ProjectMenu.js";

export interface ProjectPickerProps {
  model: Pick<ProjectMenuModel, "projects" | "recentProjectRoots" | "projectName" | "isProjectPinned" | "onAddProject">;
  /** What is being opened, for the list's name: "새 터미널" and so on. */
  launchLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the new thing in this project. */
  onPick: (project: ProjectIdentity) => void;
  /** The launcher button; focus returns to it when the picker closes. */
  children: ReactNode;
}

/** The project to preselect: the most recently used one that is still open, else the 기본 프로젝트. */
function preselectedProject(model: Pick<ProjectMenuModel, "projects" | "recentProjectRoots">): ProjectIdentity | undefined {
  return recentProjects(model)[0] ?? defaultProjectFromProjects(model.projects);
}

/**
 * The all-projects view's launcher picker (case 06): every launch belongs to a project, so in the all-projects view each one
 * asks where. The most recent project is preselected (Enter opens there at once), the 기본 프로젝트 is always listed, and there
 * is no "no project" choice.
 */
export function ProjectPicker({ model, launchLabel, open, onOpenChange, onPick, children }: ProjectPickerProps) {
  const { t } = useTranslation();
  const preselected = preselectedProject(model);
  const sectionsFor = useCallback((query: string): ComboboxSection[] => {
    const projects = orderedProjects(model.projects, model.isProjectPinned)
      .filter((project) => projectMatches(query, model.projectName(project), project.projectRoot));
    return [
      {
        key: "projects",
        options: projects.map((project) => {
          const name = model.projectName(project);
          return {
            key: project.projectRoot,
            testId: `project-picker-project-${projectTestId(project.projectRoot, name)}`,
            label: name,
            icon: <ProjectMark project={project} name={name} />,
            detail: project.isDefault ? <span className="rounded border border-border px-1">{t("sidebar.defaultBadge")}</span> : undefined,
            onPick: () => { onOpenChange(false); onPick(project); },
          };
        }),
      },
      {
        key: "add",
        options: [{
          key: "add",
          testId: "project-picker-add",
          label: t("sidebar.projectMenuAddProject"),
          icon: <FolderPlus className="h-4 w-4" aria-hidden="true" />,
          onPick: () => { onOpenChange(false); model.onAddProject(); },
        }],
      },
    ];
  }, [model, onOpenChange, onPick, t]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent data-testid="project-picker" side="right" align="start" sideOffset={SHELL_GUTTER} className="w-72 p-2">
        <p className="px-1 pb-1.5 text-xs font-medium">{t("sidebar.projectPickerTitle", { label: launchLabel })}</p>
        <ProjectCombobox
          ariaLabel={t("sidebar.projectPickerTitle", { label: launchLabel })}
          placeholder={t("sidebar.projectMenuSearch")}
          sectionsFor={sectionsFor}
          initialActiveKey={preselected?.projectRoot}
          emptyText={t("sidebar.projectMenuNoMatch")}
        />
      </PopoverContent>
    </Popover>
  );
}
