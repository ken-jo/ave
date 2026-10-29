// @vitest-environment jsdom
/** Path grants share the common approval frame; only evidence and the allow-always pattern vary by kind. */
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { loadLocaleMessages } from "../../../../i18n/messages/index.js";
import { setLocale } from "../../../../i18n/runtime.js";

const TARGET = "C:\\ProgramData\\ave\\config.json";
const PARENT = "C:\\ProgramData\\ave";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-ood-1",
    category: "tool",
    kind: "out-of-allowed-dir",
    toolName: "read_file",
    toolCategory: "read",
    args: {},
    reason: "outside allowed directories",
    createdAt: 0,
    requireExplicit: false,
    outOfAllowedDir: {
      candidatePath: TARGET,
      suggestedParent: PARENT,
      currentAllowed: ["C:\\work"],
      adjacencyWarnings: [],
    },
    ...overrides,
  } as ApprovalRequest;
}

function renderCard(
  request = makeRequest(),
  extraProps: Partial<Parameters<typeof ToolApprovalContent>[0]> = {},
) {
  const onDecide = vi.fn();
  const record = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("ave", { userApproval: { record } });
  const view = render(
    <ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={onDecide} {...extraProps} />,
  );
  return { onDecide, record, view };
}

const panel = () => screen.getByTestId("tool-approval-panel");
const targetLine = () => screen.getByTestId("approval-decision-target").textContent ?? "";

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("ko");
});

describe("ToolApprovalContent out-of-allowed-dir — one frame, one decision row", () => {
  it("renders the shared frame: identity, headline, expander, and the generic buttons", () => {
    renderCard();
    expect(screen.getByTestId("approval-tool-identity").textContent).toContain("read_file");
    expect(screen.getByTestId("approval-impact-summary").textContent)
      .toContain("허용된 디렉터리 밖을 읽으려 합니다");
    expect(screen.getByTestId(TEST_IDS.approvalReviewDetails)).toBeTruthy();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent("거부");
    // A folder card's one lasting allow is its parent folder, so the middle button names it.
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent("이 폴더를 항상 허용");
    expect(screen.getByTestId(TEST_IDS.approveButton)).toHaveTextContent("한 번만 허용");
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "path-grant");
  });

  it("keeps what will be granted on screen as the selection moves", () => {
    renderCard();
    // Fail-closed default selection is Reject, which grants nothing.
    expect(targetLine()).toContain("거부");
    fireEvent.focus(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(targetLine()).toContain(PARENT);
    expect(targetLine()).toContain("상위 폴더 전체");
    fireEvent.focus(screen.getByTestId(TEST_IDS.approveButton));
    expect(targetLine()).toContain(TARGET);
  });

  it("allow-always carries the host-resolved parent pattern and never writes the exact-args record", async () => {
    const { onDecide, record } = renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-always", PARENT);
    expect(record).not.toHaveBeenCalled();
  });

  it("allow-once and deny stay narrow: no pattern, no record", async () => {
    const { onDecide, record } = renderCard();
    await act(async () => {
      fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    });
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined);
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
    expect(record).not.toHaveBeenCalled();
  });

  it("shows both grant paths in the shared review expander", () => {
    renderCard();
    const details = screen.getByTestId("approval-path-grant-evidence");
    expect(details.textContent).toContain(TARGET);
    expect(details.textContent).toContain(PARENT);
  });

  it.each([
    ["ko", "항상 허용하면 이 폴더가 프로젝트에 추가됩니다.", "다시 묻지 않습니다", "필수 검사는 계속 적용됩니다"],
    ["en", "Always allow adds this folder to the project.", "without asking", "mandatory checks still apply"],
  ] as const)("explains the lasting project write grant in %s", async (locale, addition, futureWrites, floors) => {
    await loadLocaleMessages(locale);
    setLocale(locale);
    renderCard();
    const hint = screen.getByTestId("approval-folder-project-hint");
    expect(hint).toHaveTextContent(addition);
    expect(hint).toHaveTextContent(futureWrites);
    expect(hint).toHaveTextContent(floors);
  });

  it("shows the adjacency warning only while the widening decision is selected", () => {
    renderCard(makeRequest({
      outOfAllowedDir: {
        candidatePath: TARGET,
        suggestedParent: PARENT,
        currentAllowed: [],
        adjacencyWarnings: ["path contains '.git' segment"],
      },
    }));
    expect(screen.queryByTestId("approval-adjacency-warning")).toBeNull();
    fireEvent.focus(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(screen.getByTestId("approval-adjacency-warning").textContent).toContain(".git");
    fireEvent.focus(screen.getByTestId(TEST_IDS.approveButton));
    expect(screen.queryByTestId("approval-adjacency-warning")).toBeNull();
  });

  it("keeps Always allow visible but disabled when the host resolved no parent", () => {
    renderCard(makeRequest({
      outOfAllowedDir: {
        candidatePath: TARGET,
        suggestedParent: null,
        currentAllowed: [],
        adjacencyWarnings: [],
      },
    }));
    const always = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute("title", "지속 허용할 안전한 검토 상위 폴더가 없습니다.");
    expect(screen.getByTestId("allow-always-unavailable-reason"))
      .toHaveTextContent("지속 허용할 안전한 검토 상위 폴더가 없습니다.");
    expect(screen.queryByTestId("approval-folder-project-hint")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
  });

  it("keeps host-forbidden persistence visible but disabled", () => {
    renderCard(makeRequest({ allowedChoices: ["allow-once", "deny-once"] }));
    const always = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute("title", "호스트가 이 요청을 일회성 결정으로 제한했습니다.");
    expect(screen.getByTestId("allow-always-unavailable-reason"))
      .toHaveTextContent("호스트가 이 요청을 일회성 결정으로 제한했습니다.");
  });

  it("a proposed choice fills the form without deciding", async () => {
    const { onDecide } = renderCard(makeRequest(), { proposedChoice: "allow-always" });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const always = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(always.dataset.proposed).toBe("true");
    expect(document.activeElement).toBe(always);
    expect(targetLine()).toContain(PARENT);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores a proposal for a decision this request does not offer", async () => {
    renderCard(
      makeRequest({ allowedChoices: ["allow-once", "deny-once"] }),
      { proposedChoice: "allow-always" },
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    const always = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(always).toBeDisabled();
    expect(always).not.toHaveAttribute("data-proposed");
    expect(screen.getByTestId(TEST_IDS.denyButton).tabIndex).toBe(0);
  });

  it("Escape denies, unless the request requires an explicit choice", () => {
    const { onDecide } = renderCard();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onDecide).toHaveBeenCalledWith("deny-once");

    const explicit = renderCard(makeRequest({ id: "req-ood-2", requireExplicit: true }));
    fireEvent.keyDown(screen.getAllByTestId("tool-approval-panel")[1]!, { key: "Escape" });
    expect(explicit.onDecide).not.toHaveBeenCalled();
  });

  it("locks every decision while an exact reject is being managed in Settings", () => {
    const { onDecide } = renderCard(makeRequest(), { interactionLocked: true });
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeDisabled();
    expect(screen.getByTestId("approval-decision-locked")).toBeTruthy();
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
  });
});
