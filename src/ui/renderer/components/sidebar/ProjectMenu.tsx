import { useCallback, type ReactNode } from "react";
import { Check, FolderPlus, House, LayoutGrid } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover.js";
import { useTranslation } from "../../../../i18n/react.js";
import {
  findWorkspaceProject,
  projectRootEquals,
  type ProjectIdentity,
  type ProjectSelection,
} from "../../../../shared/project-identity.js";
import { SHELL_GUTTER } from "../../../../shared/shell-geometry.js";
import { sortWithPinnedFirst } from "../../utils/pinned-sort.js";
import {
  ProjectCombobox,
  projectInitials,
  projectMatches,
  projectTestId,
  type ComboboxOption,
  type ComboboxSection,
} from "./ProjectCombobox.js";

/** How many recent projects the menu lists above the full list (case 02). */
const MENU_RECENT_COUNT = 3;

/** Everything the project menu and the launcher picker read and do. */
export interface ProjectMenuModel {
  projects: readonly ProjectIdentity[];
  selection: ProjectSelection | undefined;
  /** Most recent first. */
  recentProjectRoots: readonly string[];
  projectName: (project: ProjectIdentity) => string;
  isProjectPinned?: (projectRoot: string | undefined) => boolean;
  onSelectRoot: (projectRoot: string) => void;
  onSelectAll: () => void;
  /** Add a folder as a project (the OS folder dialog); the caller switches to it. */
  onAddProject: () => void;
}

/** The mark a project shows: a house for the 기본 프로젝트, else its initials. */
export function ProjectMark({ project, name, size = "sm" }: { project: ProjectIdentity | undefined; name: string; size?: "sm" | "md" }) {
  const box = size === "md" ? "h-7 w-7 text-[11px]" : "h-5 w-5 text-[10px]";
  if (!project) {
    return <span className={`flex ${box} items-center justify-center rounded-md bg-muted`}><LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  }
  if (project.isDefault) {
    return <span className={`flex ${box} items-center justify-center rounded-md bg-muted`}><House className="h-3.5 w-3.5" aria-hidden="true" /></span>;
  }
  return (
    <span className={`flex ${box} items-center justify-center rounded-md bg-foreground font-semibold text-background`} aria-hidden="true">
      {projectInitials(name)}
    </span>
  );
}

/** The 기본 프로젝트 first, then pinned projects, then the rest in list order. */
export function orderedProjects(projects: readonly ProjectIdentity[], isProjectPinned?: (root: string | undefined) => boolean): ProjectIdentity[] {
  const named = sortWithPinnedFirst(projects.filter((project) => !project.isDefault), (project) => Boolean(isProjectPinned?.(project.projectRoot)));
  return [...projects.filter((project) => project.isDefault), ...named];
}

export function recentProjects(model: Pick<ProjectMenuModel, "projects" | "recentProjectRoots">): ProjectIdentity[] {
  return model.recentProjectRoots
    .map((root) => findWorkspaceProject(model.projects, root))
    .filter((project): project is ProjectIdentity => project !== undefined);
}

function ProjectMenuList({ model, close }: { model: ProjectMenuModel; close: () => void }) {
  const { t } = useTranslation();
  const selectedRoot = model.selection?.kind === "root" ? model.selection.root : undefined;
  const sectionsFor = useCallback((query: string): ComboboxSection[] => {
    const pick = (run: () => void) => () => { close(); run(); };
    const projectOption = (project: ProjectIdentity, group: string): ComboboxOption => {
      const name = model.projectName(project);
      const viewing = selectedRoot !== undefined && projectRootEquals(project.projectRoot, selectedRoot);
      return {
        key: `${group}:${project.projectRoot}`,
        testId: `project-menu-${group}-${projectTestId(project.projectRoot, name)}`,
        label: name,
        icon: <ProjectMark project={project} name={name} />,
        selected: viewing,
        detail: viewing
          ? <span className="flex items-center gap-1">{t("sidebar.projectMenuViewing")}<Check className="h-3.5 w-3.5" aria-hidden="true" /></span>
          : project.isDefault ? <span className="rounded border border-border px-1">{t("sidebar.defaultBadge")}</span> : undefined,
        onPick: pick(() => model.onSelectRoot(project.projectRoot)),
      };
    };
    const filtered = orderedProjects(model.projects, model.isProjectPinned)
      .filter((project) => projectMatches(query, model.projectName(project), project.projectRoot));
    const browsing = query.trim().length === 0;
    return [
      ...(browsing ? [{
        key: "all",
        options: [{
          key: "all",
          testId: "project-menu-all",
          label: t("sidebar.allProjects"),
          icon: <ProjectMark project={undefined} name="" />,
          selected: model.selection?.kind === "all",
          detail: t("sidebar.allProjectsHint"),
          onPick: pick(model.onSelectAll),
        }],
      }, {
        key: "recent",
        heading: t("sidebar.projectMenuRecent"),
        options: recentProjects(model).slice(0, MENU_RECENT_COUNT).map((project) => projectOption(project, "recent")),
      }] : []),
      { key: "projects", heading: t("sidebar.projectMenuAllProjects", { count: model.projects.length }), options: filtered.map((project) => projectOption(project, "project")) },
      {
        key: "add",
        options: [{
          key: "add",
          testId: "project-menu-add",
          label: t("sidebar.projectMenuAddProject"),
          icon: <FolderPlus className="h-4 w-4" aria-hidden="true" />,
          detail: t("sidebar.projectMenuAddHint"),
          onPick: pick(model.onAddProject),
        }],
      },
    ];
  }, [model, selectedRoot, close, t]);
  return (
    <ProjectCombobox
      ariaLabel={t("sidebar.projectMenuAriaLabel")}
      placeholder={t("sidebar.projectMenuSearch")}
      sectionsFor={sectionsFor}
      emptyText={t("sidebar.projectMenuNoMatch")}
    />
  );
}

export interface ProjectMenuProps {
  model: ProjectMenuModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the menu opens from its trigger: right of the rail button, below the list header. */
  side: "right" | "bottom";
  /** The button that opens the menu; focus returns to it when the menu closes. */
  children: ReactNode;
}

/**
 * `#project-menu` (case 02): search, the pinned 전체 프로젝트 entry, 최근, every project, and 새 프로젝트 추가. The rail's project
 * button and the list header's name open this same menu; only one of them has it open at a time, so the id stays unique.
 */
export function ProjectMenu({ model, open, onOpenChange, side, children }: ProjectMenuProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        id="project-menu"
        data-testid="project-menu"
        side={side}
        align="start"
        sideOffset={SHELL_GUTTER}
        className="w-72 p-2"
      >
        <ProjectMenuList model={model} close={close} />
      </PopoverContent>
    </Popover>
  );
}
