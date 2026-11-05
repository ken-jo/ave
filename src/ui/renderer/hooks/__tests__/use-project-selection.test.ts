// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AveApi } from "../../types.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import { useProjectSelection } from "../use-project-selection.js";

const DEFAULT: ProjectIdentity = { projectRoot: "/home/u/.ave/workspace", projectName: "workspace", isDefault: true };
const ALPHA: ProjectIdentity = { projectRoot: "/work/alpha", projectName: "alpha" };
const BETA: ProjectIdentity = { projectRoot: "C:\\Work\\Beta", projectName: "Beta" };
const PROJECTS = [DEFAULT, ALPHA, BETA];

function makeApi(system: Record<string, unknown> = {}): { api: AveApi; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async () => ({ ok: true }) as never);
  const api = {
    getSettings: vi.fn(async () => ({ system }) as never),
    updateSettings: update,
  } as unknown as AveApi;
  return { api, update };
}

afterEach(() => vi.restoreAllMocks());

describe("useProjectSelection", () => {
  it("is unknown until both the settings and the project list have loaded", async () => {
    const { api } = makeApi({ projectSelection: { kind: "root", root: ALPHA.projectRoot } });
    const { result, rerender } = renderHook(({ projects }) => useProjectSelection(api, projects), { initialProps: { projects: [] as ProjectIdentity[] } });
    expect(result.current.selection).toBeUndefined();
    expect(result.current.selectedProject).toBeUndefined();
    rerender({ projects: PROJECTS });
    await waitFor(() => expect(result.current.selectedProject).toEqual(ALPHA));
    expect(result.current.selection).toEqual({ kind: "root", root: ALPHA.projectRoot });
  });

  it("starts in the 기본 프로젝트 when nothing was chosen, without writing a choice", async () => {
    const { api, update } = makeApi();
    const { result } = renderHook(() => useProjectSelection(api, PROJECTS));
    await waitFor(() => expect(result.current.selectedProject).toEqual(DEFAULT));
    expect(update).not.toHaveBeenCalled();
  });

  it("falls back to the 기본 프로젝트 when the saved project is no longer open, and saves the correction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, update } = makeApi({ projectSelection: { kind: "root", root: "/work/removed" } });
    const { result } = renderHook(() => useProjectSelection(api, PROJECTS));
    await waitFor(() => expect(result.current.selectedProject).toEqual(DEFAULT));
    expect(update).toHaveBeenCalledWith({ system: { projectSelection: { kind: "root", root: DEFAULT.projectRoot } } });
    expect(warn).toHaveBeenCalledWith("[project-selection] the saved project is no longer open; starting in the 기본 프로젝트");
  });

  it("keeps the all-projects view, which names no project", async () => {
    const { api } = makeApi({ projectSelection: { kind: "all" } });
    const { result } = renderHook(() => useProjectSelection(api, PROJECTS));
    await waitFor(() => expect(result.current.selection).toEqual({ kind: "all" }));
    expect(result.current.selectedProject).toBeUndefined();
  });

  it("moves a chosen project to the front of the recent list by root identity, capped at ten", async () => {
    const older = Array.from({ length: 10 }, (_, index) => `/work/p${index}`);
    const { api, update } = makeApi({ recentProjectRoots: ["c:/work/beta", ...older] });
    const { result } = renderHook(() => useProjectSelection(api, PROJECTS));
    await waitFor(() => expect(result.current.selectedProject).toEqual(DEFAULT));
    act(() => result.current.selectRoot(BETA.projectRoot));
    expect(result.current.selectedProject).toEqual(BETA);
    expect(result.current.recentProjectRoots).toEqual([BETA.projectRoot, ...older.slice(0, 9)]);
    expect(update).toHaveBeenLastCalledWith({ system: {
      projectSelection: { kind: "root", root: BETA.projectRoot },
      recentProjectRoots: [BETA.projectRoot, ...older.slice(0, 9)],
    } });
    act(() => result.current.selectAll());
    expect(result.current.selection).toEqual({ kind: "all" });
    expect(update).toHaveBeenLastCalledWith({ system: { projectSelection: { kind: "all" } } });
  });

  it("refuses to select a root that is not an open project", async () => {
    const { api } = makeApi();
    const { result } = renderHook(() => useProjectSelection(api, PROJECTS));
    await waitFor(() => expect(result.current.selectedProject).toEqual(DEFAULT));
    expect(() => result.current.selectRoot("/nowhere")).toThrow("project-not-open");
  });
});
