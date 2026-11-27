import { act, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { approvalRequest } from "../../../../test/renderer/helpers.js";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { t } from "../../../i18n/runtime.js";
import { TEST_IDS } from "../../../shared/test-ids.js";

it("announces floating approval arrivals and advances while the composer keeps focus", async () => {
  const { container, emitApproval, emitApprovalSettled } = await renderApp({
    hasApiKey: true,
    settings: { system: { sidebarState: "hidden" } },
  });
  await waitFor(() => expect(screen.getByTestId("app-shell")).toHaveAttribute("data-sidebar-state", "hidden"));
  const composer = await screen.findByTestId(TEST_IDS.composerTextarea);
  composer.focus();
  expect(composer).toHaveFocus();

  const getStatus = () => container.querySelector('p[role="status"][aria-live="polite"][aria-atomic="true"]');
  const status = getStatus();
  const first = {
    ...approvalRequest({ source: "plugin", sourcePluginId: "example" }),
    id: "first",
    toolName: "read_item",
  };
  const second = { ...first, id: "second", toolName: "update_item" };
  const statusText = (tool: string) => `${t("toolApprovalDialog.externalActionTitle", { server: "example", tool })}. ${tool}.`;

  await act(async () => { emitApproval(first); });
  expect(screen.getByTestId("approval-lane-card")).toHaveAttribute("data-approval-request-id", first.id);
  expect(composer).toHaveFocus();
  expect(getStatus()).toBe(status);
  expect(status).toHaveTextContent(statusText(first.toolName));

  await act(async () => { emitApproval(second); });
  expect(status).toHaveTextContent(t("toolApprovalDialog.pendingCount", { count: 1 }));
  await act(async () => { emitApprovalSettled(first.id); });
  expect(screen.getByTestId("approval-lane-card")).toHaveAttribute("data-approval-request-id", second.id);
  expect(getStatus()).toBe(status);
  expect(status).toHaveTextContent(statusText(second.toolName));
  expect(status).not.toHaveTextContent(statusText(first.toolName));
  expect(composer).toHaveFocus();

  await act(async () => { emitApprovalSettled(second.id); });
  expect(screen.queryByTestId("approval-lane-card")).toBeNull();
  expect(getStatus()).toBe(status);
  expect(status).toBeEmptyDOMElement();
});
