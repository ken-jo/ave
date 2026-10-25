/** Resolve the reserved Suggestions title from the active locale; ignore its persisted or renamed title. */
import { describe, expect, it } from "vitest";
import {
  SUGGESTIONS_SESSION_ID,
  SUGGESTIONS_SESSION_TITLE_KEY,
  sessionDisplayTitle,
} from "../suggestions-session.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";

const inLocale = (catalog: Record<string, string>) => (key: string) => catalog[key] ?? key;

describe("sessionDisplayTitle", () => {
  it("names the Suggestions conversation in the current language, ignoring a stored title", () => {
    expect(sessionDisplayTitle(SUGGESTIONS_SESSION_ID, "Inbox", inLocale(en))).toBe("Suggestions");
    expect(sessionDisplayTitle(SUGGESTIONS_SESSION_ID, "Inbox", inLocale(ko))).toBe("제안");
    expect(sessionDisplayTitle(SUGGESTIONS_SESSION_ID, undefined, inLocale(ko))).toBe("제안");
  });

  it("leaves every other conversation's title alone", () => {
    expect(sessionDisplayTitle("11111111-1111-4111-8111-111111111111", "Inbox", inLocale(en))).toBe("Inbox");
    expect(sessionDisplayTitle("11111111-1111-4111-8111-111111111111", undefined, inLocale(en))).toBeUndefined();
  });

  it("names a key both catalogs carry", () => {
    expect(en[SUGGESTIONS_SESSION_TITLE_KEY as keyof typeof en]).toBe("Suggestions");
    expect(ko[SUGGESTIONS_SESSION_TITLE_KEY as keyof typeof ko]).toBe("제안");
  });
});
