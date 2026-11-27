import { describe, expect, it } from "vitest";
import { STAGE_TOOL_CALLS_REFUSED } from "../../shared/workflow-template-types.js";
import { SUPPORTED_LOCALES } from "../locale.js";
import { loadAllLocaleMessages } from "../messages/index.js";

const KEYS = [
  "columnPlanned", "columnInProgress", "columnReview", "columnCompleted", "emptyReview", "reviewInspector", "reviewClose",
  "resultReviewHeading", "resultReviewHint", "reviewEditDetails", "reviewComplete", "reviewChanged", "moveTitle", "moveDestination",
  "moveChoose", "moveConfirm", "moveFailed", "moveRunActive", "moveReviewDerived", "movePlanDecision", "moveResultDecision",
  "dragCard", "dragInstructions", "dragStarted", "dragEnded", "dragCancelled",
] as const;

describe("work board lifecycle labels", () => {
  it.each(SUPPORTED_LOCALES)("has actual labels in %s without fallback", async (locale) => {
    const catalogs = await loadAllLocaleMessages();
    for (const key of [...KEYS.map(label => `workBoard.${label}`), "workBoard.liveChipAwaitingReview", STAGE_TOOL_CALLS_REFUSED]) {
      expect(catalogs[locale][key], `${locale}:${key}`).toEqual(expect.stringMatching(/\S/));
    }
  });
});
