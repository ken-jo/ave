import "../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LatestTurnSummary } from "../components/LatestTurnSummary.js";
import { deriveWorkspaceChanges } from "../preview/workspace-changes.js";
import { setLocale } from "../../../i18n/runtime.js";
function data(count = 9) {
  return deriveWorkspaceChanges({ files: [], targets: [], workspaceRoot: "/work/project", review: { sessionId: "session", turnId: "turn",
    files: Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, operation: "modify" as const,
      added: index + 1, removed: 1, countsKnown: true, bytes: 5, lineCount: 1, referenceable: true, hunks: [] })),
  } });
}
beforeEach(() => { setLocale("en"); });
describe("latest turn summary", () => {
  it("shows recorded totals, only five relative rows and the remaining count without review prose or code", () => {
    render(<LatestTurnSummary changes={data()} onReveal={vi.fn()} />);
    expect(screen.getByTestId("latest-turn-summary")).toHaveTextContent("9 files");
    expect(screen.getByTestId("latest-turn-summary")).toHaveTextContent("+45");
    expect(screen.getAllByTestId("latest-turn-summary-file")).toHaveLength(5);
    expect(screen.getByText("4 more files")).toBeVisible();
    expect(screen.getByTestId("latest-turn-summary").textContent).not.toContain("/work/project");
    expect(screen.queryByText(/Review latest turn|Inspect the latest|Reload review/)).toBeNull();
    expect(document.querySelector("[data-diff-kind]")).toBeNull();
  });
  it("always offers Show more for any changed file and reveals the first or selected row", () => {
    const onReveal = vi.fn();
    render(<LatestTurnSummary changes={data(1)} onReveal={onReveal} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(onReveal).toHaveBeenLastCalledWith("/work/project/src/file-0.ts");
    fireEvent.click(screen.getByTestId("latest-turn-summary-file"));
    expect(onReveal).toHaveBeenLastCalledWith("/work/project/src/file-0.ts");
  });
  it("collapses to a single header without losing Show more and localizes controls", () => {
    setLocale("ko");
    render(<LatestTurnSummary changes={data()} onReveal={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /최근 턴 변경/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("latest-turn-summary-file")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "더보기" })).toBeVisible();
  });
  it("omits an empty turn rather than substituting older session files", () => {
    render(<LatestTurnSummary changes={data(0)} onReveal={vi.fn()} />);
    expect(screen.queryByTestId("latest-turn-summary")).toBeNull();
  });
});
