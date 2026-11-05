// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectHomeView, type ProjectHomeSurface } from "../ProjectHomeView.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";

const DEFAULT: ProjectIdentity = { projectRoot: "/Users/example/.ave/workspace", projectName: "workspace", isDefault: true };
const SHOP: ProjectIdentity = { projectRoot: "/Users/example/shop", projectName: "shop" };
const BOOK: ProjectIdentity = { projectRoot: "/Users/example/book", projectName: "book" };
const SURFACES: ProjectHomeSurface[] = [
  { tabId: "terminal:0000000a-1", label: "Terminal 1", projectRoot: SHOP.projectRoot },
  { tabId: "browser:0000000a-2", label: "Web 2", projectRoot: BOOK.projectRoot },
];
const nameOf = (project: ProjectIdentity) => project.isDefault ? "Default project" : project.projectName;

describe("ProjectHomeView", () => {
  it("names the project and its path, lists only its open surfaces, and opens one on click", () => {
    const onOpenSurface = vi.fn();
    render(
      <ProjectHomeView project={SHOP} projects={[DEFAULT, SHOP, BOOK]} projectName={nameOf} surfaces={SURFACES}
        onOpenSurface={onOpenSurface} onOpenView={vi.fn()} />,
    );
    expect(screen.getByTestId("project-home-title").textContent).toBe("shop");
    expect(screen.getByTestId("project-home-path").textContent).toBe("/Users/example/shop");
    expect(screen.queryByTestId("project-home-surface-browser:0000000a-2")).toBeNull();
    fireEvent.click(screen.getByTestId("project-home-surface-terminal:0000000a-1"));
    expect(onOpenSurface).toHaveBeenCalledWith("terminal:0000000a-1");
  });

  it("says when nothing is open, and links to the work board and memory", () => {
    const onOpenView = vi.fn();
    render(
      <ProjectHomeView project={DEFAULT} projects={[DEFAULT, SHOP]} projectName={nameOf} surfaces={SURFACES}
        onOpenSurface={vi.fn()} onOpenView={onOpenView} />,
    );
    expect(screen.getByTestId("project-home-title").textContent).toBe("Default project");
    expect(screen.getByTestId("project-home-surfaces").textContent).toContain("열린 터미널이나 페이지가 없습니다");
    fireEvent.click(screen.getByTestId("project-home-open-work-board"));
    fireEvent.click(screen.getByTestId("project-home-open-memory"));
    expect(onOpenView.mock.calls).toEqual([["work-board"], ["memory"]]);
  });

  it("says no project has anything open in the all-projects view, rather than 'this project'", () => {
    render(
      <ProjectHomeView project={undefined} projects={[DEFAULT, SHOP]} projectName={nameOf} surfaces={[]}
        onOpenSurface={vi.fn()} onOpenView={vi.fn()} />,
    );
    expect(screen.getByTestId("project-home-surfaces").textContent).toContain("어느 프로젝트에도 열린 터미널이나 페이지가 없습니다");
  });

  it("groups every project's open surfaces under its name in the all-projects view", () => {
    render(
      <ProjectHomeView project={undefined} projects={[DEFAULT, SHOP, BOOK]} projectName={nameOf} surfaces={SURFACES}
        onOpenSurface={vi.fn()} onOpenView={vi.fn()} />,
    );
    const list = screen.getByTestId("project-home-surfaces").textContent ?? "";
    expect(list.indexOf("shop")).toBeLessThan(list.indexOf("Terminal 1"));
    expect(list.indexOf("book")).toBeLessThan(list.indexOf("Web 2"));
    expect(list).not.toContain("Default project");
  });

  it("draws the work-approvals mount point only when the stack is handed to it", () => {
    const { rerender } = render(
      <ProjectHomeView project={SHOP} projects={[SHOP]} projectName={nameOf} surfaces={[]} onOpenSurface={vi.fn()} onOpenView={vi.fn()} />,
    );
    expect(screen.queryByTestId("project-home-work-approvals")).toBeNull();
    rerender(
      <ProjectHomeView project={SHOP} projects={[SHOP]} projectName={nameOf} surfaces={[]} onOpenSurface={vi.fn()} onOpenView={vi.fn()}
        workApprovals={<p>stack</p>} />,
    );
    expect(screen.getByTestId("project-home-work-approvals").textContent).toBe("stack");
  });
});
