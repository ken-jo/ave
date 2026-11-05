import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AveApi } from "../types.js";
import {
  defaultProjectFromProjects,
  findWorkspaceProject,
  projectRootEquals,
  projectRootKey,
  type ProjectIdentity,
  type ProjectLastView,
  type ProjectSelection,
} from "../../../shared/project-identity.js";

/** How many recently used projects the project menu remembers; the settings store enforces the same cap. */
const RECENT_PROJECT_LIMIT = 10;

export interface UseProjectSelectionResult {
  /** The window's selection; undefined until the saved one and the project list have both loaded. */
  selection: ProjectSelection | undefined;
  /** The selected project; undefined in the all-projects view and before loading. */
  selectedProject: ProjectIdentity | undefined;
  /** Most recent first. */
  recentProjectRoots: readonly string[];
  /** Select one open project (throws `project-not-open` for any other root). */
  selectRoot: (root: string) => void;
  selectAll: () => void;
  /** Where the window last was in a project (case 10), if anywhere. */
  lastViewFor: (root: string) => ProjectLastView | undefined;
  /** Remember where the window is in a project; saved only when it changed. */
  recordLastView: (root: string, place: ProjectLastView) => void;
  /** Whether an all-projects group is open (case 05); a group not saved as open is folded. */
  isProjectExpanded: (root: string) => boolean;
  /** Open or fold an all-projects group; saved only when it changed. */
  setProjectExpanded: (root: string, expanded: boolean) => void;
  /** A removed project leaves nothing behind (case 30): its recent entry, its last view and its open group. A selection of it
   * falls back like any root that is no longer open. */
  forgetProject: (root: string) => void;
}

/** The project the window works in is the user's choice, saved in `system.projectSelection`; it never follows the focused
 * conversation on its own. A saved root that is no longer open falls back to the 기본 프로젝트, and the correction is saved. */
export function useProjectSelection(api: AveApi, projects: readonly ProjectIdentity[]): UseProjectSelectionResult {
  // `null` = loaded, nothing saved; `undefined` = not loaded yet.
  const [saved, setSaved] = useState<ProjectSelection | null | undefined>(undefined);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const recentRef = useRef<readonly string[]>([]);
  const lastViewsRef = useRef<Record<string, ProjectLastView>>({});
  // Writing the map before the saved one is read would replace it; places recorded meanwhile are written once it arrives.
  const lastViewsLoadedRef = useRef(false);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const expandedRef = useRef<readonly string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then((settings) => {
      if (cancelled) return;
      const system = settings?.system;
      const roots = Array.isArray(system?.recentProjectRoots) ? system.recentProjectRoots : [];
      recentRef.current = roots;
      setRecent(roots);
      const open = Array.isArray(system?.expandedProjectRoots) ? system.expandedProjectRoots : [];
      expandedRef.current = open;
      setExpanded(open);
      // A place recorded this launch before the settings arrived is newer than the saved one.
      const recordedEarly = Object.keys(lastViewsRef.current).length > 0;
      lastViewsRef.current = { ...(system?.lastViewByProject ?? {}), ...lastViewsRef.current };
      lastViewsLoadedRef.current = true;
      if (recordedEarly) void api.updateSettings({ system: { lastViewByProject: lastViewsRef.current } });
      setSaved((current) => current === undefined ? system?.projectSelection ?? null : current);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.warn("[project-selection] the saved project could not be read; starting in the 기본 프로젝트", error);
      setSaved((current) => current === undefined ? null : current);
    });
    return () => { cancelled = true; };
  }, [api]);

  const defaultProject = defaultProjectFromProjects(projects);
  const savedRoot = saved?.kind === "root" ? saved.root : undefined;
  const savedProject = savedRoot === undefined ? undefined : findWorkspaceProject(projects, savedRoot);
  // A saved root that is not open (removed while Ave was closed) falls back, once the list has loaded.
  const stale = savedRoot !== undefined && projects.length > 0 && savedProject === undefined;
  useEffect(() => {
    if (!stale || !defaultProject) return;
    console.warn("[project-selection] the saved project is no longer open; starting in the 기본 프로젝트");
    const correction: ProjectSelection = { kind: "root", root: defaultProject.projectRoot };
    setSaved(correction);
    void api.updateSettings({ system: { projectSelection: correction } });
  }, [stale, defaultProject, api]);

  // Removed projects leave no trace in the open groups or the recent list (removed here or while Ave was closed): once both
  // the settings and the project list have loaded, only open projects are kept, and the pruned lists are saved.
  const settingsLoaded = saved !== undefined;
  useEffect(() => {
    if (!settingsLoaded || projects.length === 0) return;
    const open = (root: string) => findWorkspaceProject(projects, root) !== undefined;
    const nextRecent = recentRef.current.filter(open);
    const nextExpanded = expandedRef.current.filter(open);
    const recentChanged = nextRecent.length !== recentRef.current.length;
    const expandedChanged = nextExpanded.length !== expandedRef.current.length;
    if (!recentChanged && !expandedChanged) return;
    if (recentChanged) {
      recentRef.current = nextRecent;
      setRecent(nextRecent);
    }
    if (expandedChanged) {
      expandedRef.current = nextExpanded;
      setExpanded(nextExpanded);
    }
    void api.updateSettings({
      system: {
        ...(recentChanged ? { recentProjectRoots: nextRecent } : {}),
        ...(expandedChanged ? { expandedProjectRoots: nextExpanded } : {}),
      },
    });
  }, [settingsLoaded, projects, api]);

  const selection = useMemo<ProjectSelection | undefined>(() => {
    if (saved === undefined || projects.length === 0) return undefined;
    if (saved?.kind === "all") return saved;
    if (savedProject) return { kind: "root", root: savedProject.projectRoot };
    return defaultProject ? { kind: "root", root: defaultProject.projectRoot } : undefined;
  }, [saved, savedProject, defaultProject, projects.length]);
  const selectedProject = selection?.kind === "root" ? findWorkspaceProject(projects, selection.root) : undefined;

  const selectRoot = useCallback((root: string) => {
    const project = findWorkspaceProject(projects, root);
    if (!project) throw new Error("project-not-open: only an open project can be selected");
    const next: ProjectSelection = { kind: "root", root: project.projectRoot };
    const nextRecent = [project.projectRoot, ...recentRef.current.filter((each) => !projectRootEquals(each, project.projectRoot))]
      .slice(0, RECENT_PROJECT_LIMIT);
    recentRef.current = nextRecent;
    setRecent(nextRecent);
    setSaved(next);
    void api.updateSettings({ system: { projectSelection: next, recentProjectRoots: nextRecent } });
  }, [api, projects]);

  const selectAll = useCallback(() => {
    const next: ProjectSelection = { kind: "all" };
    setSaved(next);
    void api.updateSettings({ system: { projectSelection: next } });
  }, [api]);

  const lastViewFor = useCallback((root: string) => {
    const key = projectRootKey(root);
    return key === undefined ? undefined : lastViewsRef.current[key];
  }, []);

  const recordLastView = useCallback((root: string, place: ProjectLastView) => {
    const key = projectRootKey(root);
    if (key === undefined) throw new Error("project-root-invalid: a last view needs a project root");
    const current = lastViewsRef.current[key];
    if (current && current.view === place.view && current.surface === place.surface) return;
    lastViewsRef.current = { ...lastViewsRef.current, [key]: place };
    if (!lastViewsLoadedRef.current) return;
    void api.updateSettings({ system: { lastViewByProject: lastViewsRef.current } });
  }, [api]);

  const isProjectExpanded = useCallback(
    (root: string) => expanded.some((each) => projectRootEquals(each, root)),
    [expanded],
  );

  const setProjectExpanded = useCallback((root: string, open: boolean) => {
    const current = expandedRef.current;
    const isOpen = current.some((each) => projectRootEquals(each, root));
    if (isOpen === open) return;
    const next = open ? [...current, root] : current.filter((each) => !projectRootEquals(each, root));
    expandedRef.current = next;
    setExpanded(next);
    void api.updateSettings({ system: { expandedProjectRoots: next } });
  }, [api]);

  const forgetProject = useCallback((root: string) => {
    const key = projectRootKey(root);
    const nextRecent = recentRef.current.filter((each) => !projectRootEquals(each, root));
    const nextExpanded = expandedRef.current.filter((each) => !projectRootEquals(each, root));
    const { [key ?? ""]: _forgotten, ...nextLastViews } = lastViewsRef.current;
    recentRef.current = nextRecent;
    setRecent(nextRecent);
    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);
    lastViewsRef.current = nextLastViews;
    void api.updateSettings({
      system: {
        recentProjectRoots: nextRecent,
        expandedProjectRoots: nextExpanded,
        ...(lastViewsLoadedRef.current ? { lastViewByProject: nextLastViews } : {}),
      },
    });
  }, [api]);

  return {
    selection,
    selectedProject,
    recentProjectRoots: recent,
    selectRoot,
    selectAll,
    lastViewFor,
    recordLastView,
    isProjectExpanded,
    setProjectExpanded,
    forgetProject,
  };
}
