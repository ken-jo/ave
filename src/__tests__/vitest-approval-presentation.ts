import { desktopApprovalCardPresenters } from "../main/desktop-approval-presentation.js";
import { installApprovalCardPresenters } from "../permissions/approval-presentation.js";

// Host tests use fake renderers and the production card transport.
let uninstallTestPresenters = installApprovalCardPresenters(desktopApprovalCardPresenters);

export async function withoutTestApprovalCardPresenters(run: () => Promise<void>): Promise<void> {
  uninstallTestPresenters();
  try {
    await run();
  } finally {
    uninstallTestPresenters = installApprovalCardPresenters(desktopApprovalCardPresenters);
  }
}
