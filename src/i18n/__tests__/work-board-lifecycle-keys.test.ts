import { describe, expect, it } from "vitest";
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
    for (const key of KEYS) {
      expect(catalogs[locale][`workBoard.${key}`], `${locale}:${key}`).toEqual(expect.stringMatching(/\S/));
    }
  });
});
