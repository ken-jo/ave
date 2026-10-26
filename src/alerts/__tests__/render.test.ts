import { describe, expect, it } from "vitest";
import type { AlertKindDeclaration } from "../../plugins/public-contract.js";
import { ALERT_KEY_RE, checkSlots, localeText, renderAlert, sanitizeSlotText } from "../render.js";

function kind(overrides: Partial<AlertKindDeclaration> = {}): AlertKindDeclaration {
  return {
    id: "reply",
    label: { en: "Mail needing a reply", ko: "답장 필요 메일" },
    description: { en: "A mail that seems to need your answer." },
    defaultEnabled: true,
    visibility: "user-visible",
    actionLabel: { en: "Draft a reply" },
    slots: {
      subject: { kind: "text", maxLength: 20 },
      senderName: { kind: "text", maxLength: 20, optional: true },
      topics: { kind: "list", maxItems: 3, maxLength: 10, optional: true },
      emailId: { kind: "ref" },
    },
    summary: { en: "{senderName} wrote: {subject} {topics}", ko: "{senderName}: {subject} {topics}" },
    prompt: { en: "From {senderName}: {subject}. Topics:{topics}" },
    ...overrides,
  };
}

function checked(slots: Record<string, string | string[]>) {
  const result = checkSlots(kind(), slots);
  if (!result.ok) throw new Error(`slots refused: ${result.field}`);
  return result.values;
}

describe("checkSlots", () => {
  it("accepts the declared slots within their caps", () => {
    expect(checkSlots(kind(), { subject: "Budget", emailId: "AAMk-1=", topics: ["a", "b"] }).ok).toBe(true);
  });

  it.each([
    ["an undeclared slot", { subject: "x", emailId: "id", extra: "y" }, "slots.extra"],
    ["a missing required slot", { emailId: "id" }, "slots.subject"],
    ["a blank required slot", { subject: "   ", emailId: "id" }, "slots.subject"],
    ["text over its cap", { subject: "x".repeat(21), emailId: "id" }, "slots.subject"],
    ["text given as a list", { subject: ["x"], emailId: "id" }, "slots.subject"],
    ["a list over its item count", { subject: "x", emailId: "id", topics: ["a", "b", "c", "d"] }, "slots.topics"],
    ["a list item over its cap", { subject: "x", emailId: "id", topics: ["x".repeat(11)] }, "slots.topics"],
    ["a ref with markup", { subject: "x", emailId: "<id>" }, "slots.emailId"],
  ])("names the field for %s", (_label, slots, field) => {
    expect(checkSlots(kind(), slots)).toEqual({ ok: false, field });
  });

  it("refuses slots that are not an object", () => {
    expect(checkSlots(kind(), ["subject"])).toEqual({ ok: false, field: "slots" });
  });

  it("measures caps in code points, so an emoji counts once", () => {
    expect(checkSlots(kind(), { subject: "😀".repeat(20), emailId: "id" }).ok).toBe(true);
  });
});

describe("the key pattern", () => {
  it("accepts a 200-character mail id and refuses markup and spaces", () => {
    expect(ALERT_KEY_RE.test(`AAMk${"a".repeat(196)}`)).toBe(true);
    expect(ALERT_KEY_RE.test("a".repeat(257))).toBe(false);
    expect(ALERT_KEY_RE.test("mail <1>")).toBe(false);
    expect(ALERT_KEY_RE.test("")).toBe(false);
  });
});

describe("sanitizeSlotText", () => {
  it("strips control, bidi and variation characters and collapses whitespace", () => {
    expect(sanitizeSlotText("a\u0000b‮c⁦d️e\n\n f", 100)).toBe("a b c d e f");
  });

  it("cuts on a code point, never inside a surrogate pair, and marks the cut", () => {
    expect(sanitizeSlotText("😀😀😀", 2)).toBe("😀😀…");
  });
});

describe("renderAlert", () => {
  it("fills the card with plain values and the prompt with wrapped ones", () => {
    const out = renderAlert(kind(), checked({ subject: "Budget <b>", senderName: "Kim", emailId: "AAMk1" }), "en");
    expect(out.title).toBe("Mail needing a reply");
    expect(out.summary).toBe("Kim wrote: Budget <b> ");
    expect(out.prompt).toContain("<untrusted-subject>Budget ＜b＞</untrusted-subject>");
    expect(out.prompt).toContain("<untrusted-senderName>Kim</untrusted-senderName>");
    expect(out.actionLabel).toBe("Draft a reply");
  });

  it("puts a ref only in the prompt's footer, wrapped", () => {
    const out = renderAlert(kind(), checked({ subject: "Budget", emailId: "AAMk1" }), "en");
    expect(out.summary).not.toContain("AAMk1");
    expect(out.prompt.split("\n").at(-1)).toBe("- emailId: <untrusted-emailId>AAMk1</untrusted-emailId>");
  });

  it("renders a list joined on the card and one line per item in the prompt", () => {
    const out = renderAlert(kind(), checked({ subject: "S", emailId: "id", topics: ["one", "two"] }), "en");
    expect(out.summary).toContain("one; two");
    expect(out.prompt).toContain("Topics:\n- <untrusted-topics>one</untrusted-topics>\n- <untrusted-topics>two</untrusted-topics>");
  });

  it("leaves an absent optional slot empty", () => {
    const out = renderAlert(kind(), checked({ subject: "S", emailId: "id" }), "en");
    expect(out.summary).toBe(" wrote: S ");
    expect(out.prompt).not.toContain("untrusted-senderName");
  });

  it("uses the kind's OS body, else its description, else its label, for the notification", () => {
    const withBody = kind({ osNotification: { defaultEnabled: false, body: { en: "Static body" } } });
    expect(renderAlert(withBody, checked({ subject: "S", emailId: "id" }), "en").notificationBody).toBe("Static body");
    expect(renderAlert(kind(), checked({ subject: "S", emailId: "id" }), "en").notificationBody)
      .toBe("A mail that seems to need your answer.");
    const bare = kind({ description: undefined });
    expect(renderAlert(bare, checked({ subject: "S", emailId: "id" }), "en").notificationBody).toBe("Mail needing a reply");
  });
});

describe("localeText", () => {
  it("resolves the exact tag, then the language, then English", () => {
    const text = { en: "hello", ko: "안녕", "pt-br": "olá" };
    expect(localeText(text, "pt-BR")).toBe("olá");
    expect(localeText(text, "ko-KR")).toBe("안녕");
    expect(localeText(text, "fr")).toBe("hello");
  });
});
