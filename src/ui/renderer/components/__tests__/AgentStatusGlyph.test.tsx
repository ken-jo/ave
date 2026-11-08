// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { t } from "../../../../i18n/runtime.js";
import { AgentStatusGlyph, agentStatusLabels, type AgentStatusBadge } from "../AgentStatusGlyph.js";
import { PendingAnswerDot } from "../PendingAnswerDot.js";
import { TerminalAttentionDot } from "../TerminalAttentionDot.js";

afterEach(cleanup);

const mark = <svg data-testid="mark" aria-hidden="true" />;

/** The owner's mapping (DESIGN.md, "Agent status slot"): what each state draws in the square and in its corner. */
const TABLE: ReadonlyArray<{ badge: AgentStatusBadge | null; tone: string | null; label: string | null }> = [
  { badge: null, tone: null, label: null },
  { badge: "waiting", tone: "bg-warning", label: "답변 대기 중" },
  { badge: "blocked", tone: "bg-destructive", label: "막힘" },
  { badge: "error", tone: "bg-destructive", label: "오류" },
  { badge: "connecting", tone: "bg-info", label: "연결 중" },
  { badge: "exited", tone: "bg-muted-foreground", label: "중지됨" },
];

describe("AgentStatusGlyph — the state-to-rendering table", () => {
  for (const working of [false, true]) {
    for (const row of TABLE) {
      it(`working=${working}, badge=${row.badge ?? "none"}`, () => {
        render(<AgentStatusGlyph mark={mark} working={working} badge={row.badge} testId="slot" badgeTestId="badge" workingTestId="loader" />);
        const slot = screen.getByTestId("slot");
        expect(slot.getAttribute("data-agent-status")).toBe(working ? "working" : "idle");
        // One fixed square whatever the state, so a change of state never moves the row.
        expect(slot.className).toContain("h-3.5 w-3.5");

        // Working: the loader in place of the mark, named; otherwise the mark.
        if (working) {
          expect(screen.queryByTestId("mark")).toBeNull();
          const loader = screen.getByTestId("loader");
          expect(loader.getAttribute("role")).toBe("img");
          expect(loader.getAttribute("aria-label")).toBe("작업 중");
          expect(loader.getAttribute("title")).toBe("작업 중");
        } else {
          expect(screen.getByTestId("mark")).toBeTruthy();
          expect(screen.queryByTestId("loader")).toBeNull();
        }

        // Idle draws no badge; every other state one corner badge, one token, labelled and titled.
        if (row.badge === null) {
          expect(screen.queryByTestId("badge")).toBeNull();
          expect(slot.getAttribute("title")).toBe(working ? "작업 중" : null);
          expect(slot.hasAttribute("data-agent-badge")).toBe(false);
          return;
        }
        const badge = screen.getByTestId("badge");
        expect(slot.getAttribute("data-agent-badge")).toBe(row.badge);
        expect(slot.contains(badge)).toBe(true);
        expect(badge.className).toContain(row.tone ?? "missing-tone");
        expect(badge.className).toContain("absolute -right-1 -top-1");
        // It overhangs the square, so it must never take a click meant for what lies under that corner.
        expect(badge.className).toContain("pointer-events-none");
        expect(badge.className).not.toContain("pointer-events-auto");
        // The square carries the state as its tooltip instead.
        expect(slot.getAttribute("title")).toBe(working ? `작업 중, ${row.label}` : row.label);
        expect(badge.getAttribute("role")).toBe("img");
        expect(badge.getAttribute("aria-label")).toBe(row.label);
        expect(badge.getAttribute("title")).toBe(row.label);
        expect(agentStatusLabels(t, working, row.badge)).toEqual(working ? ["작업 중", row.label] : [row.label]);
      });
    }
  }

  it("warning belongs to waiting alone", () => {
    for (const row of TABLE) {
      if (row.badge === "waiting" || row.badge === null) continue;
      expect(row.tone).not.toBe("bg-warning");
    }
  });

  it("stops the loader under reduced motion", () => {
    render(<AgentStatusGlyph mark={mark} working badge={null} workingTestId="loader" />);
    const svg = screen.getByTestId("loader").querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("animate-spin");
    expect(svg?.getAttribute("class")).toContain("motion-reduce:animate-none");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the mark and loader — not the badge — with markClassName", () => {
    const { rerender } = render(
      <AgentStatusGlyph mark={mark} working={false} badge="waiting" markClassName="invisible" testId="slot" badgeTestId="badge" />,
    );
    expect(screen.getByTestId("mark").parentElement?.className).toContain("invisible");
    expect(screen.getByTestId("badge").className).not.toContain("invisible");
    rerender(
      <AgentStatusGlyph mark={mark} working badge="waiting" markClassName="invisible" testId="slot" badgeTestId="badge" workingTestId="loader" />,
    );
    expect(screen.getByTestId("loader").className).toContain("invisible");
    expect(screen.getByTestId("badge").className).not.toContain("invisible");
  });

  it("leaves the accessibility tree when the surface names the state itself", () => {
    render(<AgentStatusGlyph mark={mark} working badge="error" hiddenFromAccessibility testId="slot" />);
    expect(screen.getByTestId("slot").getAttribute("aria-hidden")).toBe("true");
  });

  it("takes the md square for a 16px mark", () => {
    render(<AgentStatusGlyph mark={mark} working={false} badge={null} size="md" testId="slot" />);
    expect(screen.getByTestId("slot").className).toContain("h-4 w-4");
  });
});

describe("the shared status dot", () => {
  it("keeps PendingAnswerDot's geometry and placements", () => {
    render(
      <>
        <PendingAnswerDot testId="control" />
        <PendingAnswerDot inline testId="inline" />
      </>,
    );
    const control = screen.getByTestId("control");
    expect(control.className).toContain("h-[9px] w-[9px]");
    expect(control.className).toContain("bg-warning");
    expect(control.className).toContain("pointer-events-none absolute right-0.5 top-0.5");
    expect(control.getAttribute("aria-label")).toBe("답변 대기 중");
    expect(screen.getByTestId("inline").className).not.toContain("absolute");
  });

  it("draws the terminal's unread notice as the same dot in primary, with the message as its tooltip", () => {
    render(<TerminalAttentionDot testId="term" message="build done" />);
    const dot = screen.getByTestId("term");
    expect(dot.className).toContain("h-[9px] w-[9px]");
    expect(dot.className).toContain("bg-primary");
    expect(dot.getAttribute("aria-label")).toBe(t("mainPanels.terminalUnread"));
    expect(dot.getAttribute("title")).toBe(`${t("mainPanels.terminalUnread")}: build done`);
  });
});
