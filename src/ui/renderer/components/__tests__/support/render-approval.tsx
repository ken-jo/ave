import { render } from "@testing-library/react";
import { ToolApprovalContent } from "../../ToolApprovalContent.js";

type ApprovalProps = Parameters<typeof ToolApprovalContent>[0];

export function renderApproval(
  request: ApprovalProps["request"],
  onDecide: ApprovalProps["onDecide"],
) {
  return render(
    <ToolApprovalContent conversationLabel="conversation" open request={request} onDecide={onDecide} />,
  );
}
