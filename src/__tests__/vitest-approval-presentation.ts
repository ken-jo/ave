import { desktopApprovalCardPresenters } from "../main/desktop-approval-presentation.js";
import { installApprovalCardPresenters } from "../permissions/approval-presentation.js";

// Host tests use fake renderers and the production card transport.
installApprovalCardPresenters(desktopApprovalCardPresenters);
