// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";

const request: ApprovalRequest = {
  id: "domain-ask", category: "tool", kind: "egress-host", toolName: "bash",
  toolCategory: "network", args: { host: "downloads.example.com", port: 443 },
  reason: "A sandboxed command requested a connection", createdAt: 0,
  requireExplicit: true, allowedChoices: ["allow-once", "deny-once"],
  egressHost: { host: "downloads.example.com", port: 443, network: "public", scopes: ["once", "always"] },
};

afterEach(cleanup);

describe("domain approval dock card", () => {
  it.each(["once", "always"] as const)("returns the host offered %s domain scope without creating a tool rule", (scope) => {
    const onDecide = vi.fn();
    render(<ToolApprovalContent open request={request} conversationLabel="project session" onDecide={onDecide} />);
    expect(screen.getByTestId("egress-approval-target")).toHaveTextContent("downloads.example.com:443");
    fireEvent.click(screen.getByTestId(`egress-approval-allow-${scope}`));
    expect(onDecide).toHaveBeenCalledWith("allow-once", undefined, { egressScope: scope });
    expect(screen.queryByTestId("allow-always-exact-scope")).not.toBeInTheDocument();
  });

  it("lets the user deny the connection", () => {
    const onDecide = vi.fn();
    render(<ToolApprovalContent open request={request} conversationLabel="project session" onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId("egress-approval-deny"));
    expect(onDecide).toHaveBeenCalledWith("deny-once");
  });

  it("shows only the scopes the host offered and locks every decision while answering", () => {
    render(<ToolApprovalContent open request={{ ...request, egressHost: { ...request.egressHost!, scopes: ["once"] } }} conversationLabel="project session" interactionLocked onDecide={vi.fn()} />);
    expect(screen.getByTestId("egress-approval-allow-once")).toBeDisabled();
    expect(screen.getByTestId("egress-approval-deny")).toBeDisabled();
    expect(screen.queryByTestId("egress-approval-allow-always")).not.toBeInTheDocument();
  });
});
