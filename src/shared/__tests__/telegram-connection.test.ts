/** Match the bot username contract; overly strict validation misreports valid bots as network failures. */
import { describe, expect, it } from "vitest";

import { isTelegramBotUsername, isTelegramBotToken, isTelegramOwnerUserId, isTelegramSetOwnerUserIdInput, parseTelegramConnectionSnapshot, TELEGRAM_BOT_TOKEN_PATH_GRAMMAR } from "../telegram-connection.js";

describe("isTelegramBotUsername", () => {
  it("accepts the 5-char minimum handle (regression: 5-6 char handles were rejected)", () => {
    expect(isTelegramBotUsername("aebot")).toBe(true);
    expect(isTelegramBotUsername("a1bot")).toBe(true);
  });

  it("accepts a 6-char handle", () => {
    expect(isTelegramBotUsername("ae_bot")).toBe(true);
  });

  it("accepts the 32-char maximum handle", () => {
    expect(isTelegramBotUsername(`a${"x".repeat(28)}bot`)).toBe(true);
  });

  it("rejects a 33-char handle", () => {
    expect(isTelegramBotUsername(`a${"x".repeat(29)}bot`)).toBe(false);
  });

  it("rejects a 4-char handle even with the bot suffix", () => {
    expect(isTelegramBotUsername("abot")).toBe(false);
  });

  it("accepts a case-mixed bot suffix", () => {
    expect(isTelegramBotUsername("ave_ownerBOT")).toBe(true);
    expect(isTelegramBotUsername("ave_ownerBot")).toBe(true);
  });

  it("rejects a handle without the bot suffix", () => {
    expect(isTelegramBotUsername("ave_owner")).toBe(false);
  });

  it("rejects a leading digit or underscore", () => {
    expect(isTelegramBotUsername("1avebot")).toBe(false);
    expect(isTelegramBotUsername("_avebot")).toBe(false);
  });

  it("rejects characters outside the handle alphabet", () => {
    expect(isTelegramBotUsername("ave-ownerbot")).toBe(false);
    expect(isTelegramBotUsername("ave ownerbot")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isTelegramBotUsername(undefined)).toBe(false);
    expect(isTelegramBotUsername(42)).toBe(false);
  });
});

describe("TELEGRAM_BOT_TOKEN_PATH_GRAMMAR", () => {
  it("is the URL-safety bound: every plausible token passes it, and nothing outside the path alphabet does", () => {
    const plausible = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(isTelegramBotToken(plausible)).toBe(true);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test(plausible)).toBe(true);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("abc/../def")).toBe(false);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("a?b=c")).toBe(false);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("x".repeat(257))).toBe(false);
  });
});


describe("registered owner identity", () => {
  it.each(["1", "123456789", "4503599627370495"])("accepts a canonical numeric identity %s", value => {
    expect(isTelegramOwnerUserId(value)).toBe(true);
  });
  it.each(["", "0", "-1", "01", " 123", "123 ", "@account", "1.5", "1e5", "4503599627370496", 123, null])("rejects malformed identity %j", value => {
    expect(isTelegramOwnerUserId(value)).toBe(false);
  });
  it("requires the owner field in snapshots and rejects malformed registered identities", () => {
    const snapshot = { state: "disconnected", ownerUserId: null, botUsername: null, pairing: null, approval: null, pendingCode: null, lastErrorCode: null };
    expect(parseTelegramConnectionSnapshot(snapshot)).toEqual(snapshot);
    expect(parseTelegramConnectionSnapshot({ ...snapshot, ownerUserId: "123456789" })).toMatchObject({ ownerUserId: "123456789" });
    const { ownerUserId: _dropped, ...missingOwner } = snapshot;
    expect(parseTelegramConnectionSnapshot(missingOwner)).toBeNull();
    expect(parseTelegramConnectionSnapshot({ ...snapshot, ownerUserId: "@account" })).toBeNull();
  });
  it("requires exact owner mutation fields and live keyboard intent", () => {
    const input = { ownerUserId: "123456789", intent: { inputOrigin: "user-keyboard", userActivation: true } };
    expect(isTelegramSetOwnerUserIdInput(input)).toBe(true);
    expect(isTelegramSetOwnerUserIdInput({ ownerUserId: input.ownerUserId })).toBe(false);
    expect(isTelegramSetOwnerUserIdInput({ ...input, extra: true })).toBe(false);
    expect(isTelegramSetOwnerUserIdInput({ ...input, intent: { inputOrigin: "platform-bridge", userActivation: true } })).toBe(false);
  });
});
