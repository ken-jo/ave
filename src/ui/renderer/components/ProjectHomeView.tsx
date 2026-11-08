import type { ReactNode } from "react";
import { Brain, ChevronRight, KanbanSquare } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { projectRootEquals, type ProjectIdentity } from "../../../shared/project-identity.js";

/** One open main surface as the home lists it. */
export interface ProjectHomeSurface {
  tabId: string;
  label: string;
  projectRoot: string;
}

export interface ProjectHomeViewProps {
  /** The selected project; undefined is the all-projects view, which lists every project's surfaces under its name. */
  project: ProjectIdentity | undefined;
  projects: readonly ProjectIdentity[];
  /** The name a project row shows (the user's label, or 기본 프로젝트 for the default). */
  projectName: (project: ProjectIdentity) => string;
  surfaces: readonly ProjectHomeSurface[];
  onOpenSurface: (tabId: string) => void;
  onOpenView: (view: "work-board" | "memory") => void;
  /** Mount point for the 확인 필요 (work approvals) stack, which the work-approvals lane renders here. Nothing is drawn when
   * absent. */
  workApprovals?: ReactNode;
}

/** The project home: what is open in the project, and the way to its work board and memory. Real data only. */
export function ProjectHomeView({ project, projects, projectName, surfaces, onOpenSurface, onOpenView, workApprovals }: ProjectHomeViewProps) {
  const { t } = useTranslation();
  const groups = project
    ? [{ project, surfaces: surfaces.filter((surface) => projectRootEquals(surface.projectRoot, project.projectRoot)) }]
    : projects
      .map((each) => ({ project: each, surfaces: surfaces.filter((surface) => projectRootEquals(surface.projectRoot, each.projectRoot)) }))
      .filter((group) => group.surfaces.length > 0);
  const openCount = groups.reduce((sum, group) => sum + group.surfaces.length, 0);
  const title = project ? projectName(project) : t("sidebar.allProjects");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" data-testid="project-home">
      <header className="min-w-0">
        <h2 className="truncate text-base font-semibold" title={title} data-testid="project-home-title">{title}</h2>
        {project ? (
          <p className="truncate font-mono text-xs text-muted-foreground" title={project.projectRoot} data-testid="project-home-path">
            {project.projectRoot}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("projectHome.allProjectsCount", { count: projects.length })}</p>
        )}
      </header>
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <div className="flex min-w-[16rem] flex-1 flex-col gap-4">
          <section aria-labelledby="project-home-open" className="rounded-xl border border-border p-3" data-testid="project-home-surfaces">
            <h3 id="project-home-open" className="mb-2 text-xs font-medium text-muted-foreground">
              {t("projectHome.openSurfaces", { count: openCount })}
            </h3>
            {openCount === 0 ? (
              <p className="text-sm text-muted-foreground">{t(project ? "projectHome.noOpenSurfaces" : "projectHome.noOpenSurfacesAll")}</p>
            ) : groups.map((group) => (
              <div key={group.project.projectRoot} className="min-w-0">
                {project ? null : (
                  <p className="mt-2 truncate text-dense font-medium text-muted-foreground first:mt-0">{projectName(group.project)}</p>
                )}
                <ul className="min-w-0">
                  {group.surfaces.map((surface) => (
                    <li key={surface.tabId} className="min-w-0">
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => onOpenSurface(surface.tabId)}
                        data-testid={`project-home-surface-${surface.tabId}`}
                      >
                        <span className="min-w-0 flex-1 truncate" title={surface.label}>{surface.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <nav aria-label={t("projectHome.linksLabel")} className="flex flex-col gap-1">
            {([
              { view: "work-board", label: t("mainToolbar.workBoard"), Icon: KanbanSquare },
              { view: "memory", label: t("mainToolbar.memory"), Icon: Brain },
            ] as const).map(({ view, label, Icon }) => (
              <button
                key={view}
                type="button"
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpenView(view)}
                data-testid={`project-home-open-${view}`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            ))}
          </nav>
        </div>
        {workApprovals ? (
          <section aria-label={t("projectHome.workApprovalsLabel")} className="min-w-[18rem] flex-1" data-testid="project-home-work-approvals">
            {workApprovals}
          </section>
        ) : null}
      </div>
    </div>
  );
}
